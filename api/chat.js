// Vercel serverless-функция: принимает сообщение с лендинга idmAI, обращается
// к GigaChat (логика запроса — как в salon_ai_bot/gigachat_client.py) и
// возвращает ответ. GigaChat-токен и системный промпт живут только в
// переменных окружения на сервере — на статичном лендинге (GitHub Pages) их
// быть не может в принципе.
const https = require("node:https");
const { randomUUID } = require("node:crypto");
const { getSystemPrompt } = require("./prompt");
const { getKnowledge } = require("./knowledge");

const OAUTH_URL = "https://ngw.devices.sberbank.ru:9443/api/v2/oauth";
const CHAT_URL = "https://gigachat.devices.sberbank.ru/api/v1/chat/completions";

// Сколько последних сообщений диалога принимаем от клиента и передаём модели.
const MAX_HISTORY_MESSAGES = 20;
const MAX_MESSAGE_LENGTH = 2000;

// Простая защита от злоупотреблений: лимит запросов на IP. Переживает только
// тёплый старт функции (сбрасывается при холодном старте) — этого достаточно
// для демо-лендинга, не рассчитанного на серьёзную нагрузку.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 20;
const rateLimitBuckets = new Map();

// Кэш access_token между вызовами функции (переживает тёплые старты).
let cachedToken = "";
let cachedTokenExpiresAt = 0;

// Сетевые ошибки, на которых имеет смысл повторить запрос: TLS/соединение
// периодически рвётся именно на стороне Сбера (тот же случай, что и
// комментарий "UNEXPECTED_EOF" в оригинальном gigachat_client.py).
const _RETRYABLE_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
]);
const _MAX_RETRIES = 3;
const _RETRY_DELAY_MS = 1500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpsRequestOnce(url, { headers = {}, body = "" } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        port: 443,
        path: `${u.pathname}${u.search}`,
        method: "POST",
        headers,
        // Сертификат GigaChat/Сбера самоподписанный, как и в оригинальном
        // Python-клиенте (verify=False).
        rejectUnauthorized: false,
        timeout: 40_000,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Таймаут запроса к GigaChat")));
    req.write(body);
    req.end();
  });
}

async function httpsRequestRaw(url, options) {
  let lastErr;
  for (let attempt = 1; attempt <= _MAX_RETRIES; attempt++) {
    try {
      return await httpsRequestOnce(url, options);
    } catch (err) {
      lastErr = err;
      const retryable = _RETRYABLE_CODES.has(err.code) || /socket hang up/i.test(err.message || "");
      console.error(`Сетевая ошибка GigaChat (попытка ${attempt}/${_MAX_RETRIES}):`, err.code || err.message);
      if (!retryable || attempt === _MAX_RETRIES) break;
      await sleep(_RETRY_DELAY_MS);
    }
  }
  throw lastErr;
}

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiresAt - 60_000) {
    return cachedToken;
  }

  const authKey = process.env.GIGACHAT_AUTH_KEY;
  if (!authKey) {
    throw new Error("Не задана переменная окружения GIGACHAT_AUTH_KEY");
  }
  const scope = process.env.GIGACHAT_SCOPE || "GIGACHAT_API_PERS";

  const { status, body } = await httpsRequestRaw(OAUTH_URL, {
    headers: {
      Authorization: `Basic ${authKey}`,
      RqUID: randomUUID(),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: `scope=${encodeURIComponent(scope)}`,
  });

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error(`GigaChat OAuth вернул нечитаемый ответ (status ${status}): ${body.slice(0, 200)}`);
  }
  if (!payload.access_token) {
    throw new Error(`Не удалось получить access_token (status ${status}): ${body.slice(0, 200)}`);
  }

  cachedToken = payload.access_token;
  cachedTokenExpiresAt = payload.expires_at ? Number(payload.expires_at) : Date.now() + 30 * 60_000;
  return cachedToken;
}

async function askGigaChat(messages) {
  const token = await getAccessToken();
  const { status, body } = await httpsRequestRaw(CHAT_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ model: "GigaChat", messages, temperature: 0.7 }),
  });

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error(`GigaChat вернул нечитаемый ответ (status ${status}): ${body.slice(0, 200)}`);
  }
  const choice = payload.choices && payload.choices[0];
  if (!choice) {
    throw new Error(`Ошибка запроса к GigaChat (status ${status}): ${body.slice(0, 300)}`);
  }
  return {
    content: String(choice.message.content || "").trim(),
    finishReason: choice.finish_reason || "",
  };
}

// Убирает служебные пометки в скобках, markdown-символы форматирования —
// клиент должен видеть только живую речь (см. bot.py _sanitize_for_client).
function sanitizeForClient(text) {
  return text
    .replace(/[([][^)\]]*[A-ZА-ЯЁ]{3,}[^)\]]*[)\]]/g, "")
    .replace(/[*#]+/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ *\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isRateLimited(ip) {
  const now = Date.now();
  const bucket = rateLimitBuckets.get(ip);
  if (!bucket || now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitBuckets.set(ip, { windowStart: now, count: 1 });
    return false;
  }
  bucket.count += 1;
  return bucket.count > RATE_LIMIT_MAX_REQUESTS;
}

function setCorsHeaders(req, res) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return "Пустой список сообщений";
  }
  for (const m of messages) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) {
      return "Недопустимая роль сообщения";
    }
    if (typeof m.content !== "string" || !m.content.trim()) {
      return "Пустое сообщение";
    }
    if (m.content.length > MAX_MESSAGE_LENGTH) {
      return "Сообщение слишком длинное";
    }
  }
  return null;
}

module.exports = async (req, res) => {
  setCorsHeaders(req, res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "Разрешён только POST" });
    return;
  }

  const ip = (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown")
    .toString()
    .split(",")[0]
    .trim();
  if (isRateLimited(ip)) {
    res.status(429).json({ error: "Слишком много запросов, попробуйте через минуту" });
    return;
  }

  const clientMessages = req.body?.messages;
  const validationError = validateMessages(clientMessages);
  if (validationError) {
    res.status(400).json({ error: validationError });
    return;
  }

  const history = clientMessages.slice(-MAX_HISTORY_MESSAGES);

  let knowledgeBase;
  try {
    knowledgeBase = await getKnowledge();
  } catch (err) {
    console.error("База знаний недоступна:", err);
    res.status(200).json({
      reply: "Секунду, уточню этот момент у администратора и вернусь к вам 🙌",
    });
    return;
  }

  const systemPrompt =
    `${getSystemPrompt()}\n\n` +
    `=== БАЗА ЗНАНИЙ САЛОНА ===\n${knowledgeBase}\n=== КОНЕЦ БАЗЫ ЗНАНИЙ ===`;
  const messages = [{ role: "system", content: systemPrompt }, ...history];

  try {
    const { content, finishReason } = await askGigaChat(messages);
    if (finishReason === "blacklist") {
      res.status(200).json({
        reply: "Секунду, уточню этот момент у администратора и вернусь к вам 🙌",
      });
      return;
    }
    res.status(200).json({ reply: sanitizeForClient(content) });
  } catch (err) {
    console.error("Ошибка GigaChat:", err);
    res.status(502).json({
      error: "Бот временно недоступен. Попробуйте ещё раз чуть позже.",
    });
  }
};
