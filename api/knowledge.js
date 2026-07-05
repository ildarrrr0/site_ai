// Загрузка и кэширование базы знаний из тех же публичных Google-таблиц, что
// использует продакшен-бот Алины (salon_ai_bot/knowledge.py + config.py):
// реальные услуги, цены и расписание мастеров салона удаления тату и
// лазерной эпиляции. Ссылки на таблицы публичные (Google Sheets "Опубликовать
// в интернете" → CSV), секретов в них нет.
const SHEETS = {
  "Вопросы и ответы":
    "https://docs.google.com/spreadsheets/d/e/2PACX-1vT2greIg5FFayEHkr6n6sHChiwbLSr-07nm9_8GJKd1-Ot9XnQlNCQos3yTaHaPRTHA8H51Wa46-gj0/pub?gid=0&single=true&output=csv",
  "Цены и услуги":
    "https://docs.google.com/spreadsheets/d/e/2PACX-1vT_WR5IWJ93qC-WGHxsxbFriCJCwbhYHAUUYHbfWtwSsc3G9h0WvYVRYkjOC139rr19QtTCO7-2MP8o/pub?output=csv",
  "Мастера и расписание":
    "https://docs.google.com/spreadsheets/d/e/2PACX-1vSQtHYGXPueO-t3VEE_mRquwk6YPQa4KoaVJPu-vLqsNpkyG2YrFJBcgyxHn5Xr5rzpcgYrE1I4ijMT/pub?output=csv",
};

const CACHE_TTL_MS = 5 * 60 * 1000;

let cacheText = "";
let cacheTime = 0;

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r") {
      // игнорируем, перевод строки обработает \n
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim().length > 0));
}

function buildSheetText(name, rows) {
  if (rows.length === 0) {
    return `### ${name}\n(таблица пуста)\n`;
  }
  const header = rows[0];
  const lines = [`### ${name}`];
  for (const row of rows.slice(1)) {
    const pairs = [];
    row.forEach((rawCell, idx) => {
      const cell = rawCell.trim();
      if (!cell) return;
      const colName = (header[idx] || "").trim();
      pairs.push(colName ? `${colName}: ${cell}` : cell);
    });
    if (pairs.length) lines.push("- " + pairs.join("; "));
  }
  return lines.join("\n") + "\n";
}

async function fetchSheet(name, url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} при загрузке таблицы "${name}"`);
  }
  const text = await res.text();
  return buildSheetText(name, parseCsv(text));
}

async function getKnowledge() {
  const now = Date.now();
  if (cacheText && now - cacheTime < CACHE_TTL_MS) {
    return cacheText;
  }

  const names = Object.keys(SHEETS);
  const results = await Promise.allSettled(
    names.map((name) => fetchSheet(name, SHEETS[name]))
  );

  const parts = [];
  results.forEach((result, idx) => {
    if (result.status === "fulfilled") {
      parts.push(result.value);
    } else {
      console.error(`Не удалось загрузить таблицу "${names[idx]}":`, result.reason);
    }
  });

  if (parts.length === 0) {
    if (cacheText) return cacheText; // работаем на старом кэше, если он есть
    throw new Error("Не удалось загрузить ни одной таблицы базы знаний");
  }

  cacheText = parts.join("\n");
  cacheTime = now;
  return cacheText;
}

module.exports = { getKnowledge };
