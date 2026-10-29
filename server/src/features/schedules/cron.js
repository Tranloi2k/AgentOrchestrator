/**
 * Minimal 5-field cron ("minute hour day-of-month month day-of-week"), evaluated in the server's
 * local time. Supports *, numbers, ranges (1-5), lists (1,15), steps (*\/15, 8-18/2) and the
 * common shortcuts (@hourly, @daily, @weekly, @monthly). Day-of-week 0 and 7 are both Sunday.
 * As in standard cron, when both day-of-month and day-of-week are restricted, either may match.
 */

const FIELDS = [
  { name: "phút", min: 0, max: 59 },
  { name: "giờ", min: 0, max: 23 },
  { name: "ngày", min: 1, max: 31 },
  { name: "tháng", min: 1, max: 12 },
  { name: "thứ", min: 0, max: 7 },
];

const SHORTCUTS = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
};

function parseField(text, { name, min, max }) {
  const values = new Set();
  for (const part of text.split(",")) {
    const m = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!m) throw new Error(`Trường ${name} không hợp lệ: "${part}"`);
    const step = m[2] ? Number(m[2]) : 1;
    if (step < 1) throw new Error(`Bước nhảy ở trường ${name} phải ≥ 1`);
    let lo = min;
    let hi = max;
    if (m[1] !== "*") {
      const [a, b] = m[1].split("-").map(Number);
      lo = a;
      hi = b === undefined ? (m[2] ? max : a) : b;
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`Trường ${name} phải trong khoảng ${min}-${max}: "${part}"`);
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return values;
}

/** Parses a cron expression; throws an Error with a readable message when it's invalid. */
export function parseCron(expr) {
  const text = SHORTCUTS[String(expr || "").trim().toLowerCase()] || String(expr || "").trim();
  const parts = text.split(/\s+/);
  if (parts.length !== 5) throw new Error("Cron cần đúng 5 trường: phút giờ ngày tháng thứ (vd: 0 7 * * 1-5).");
  const [minute, hour, dom, month, dow] = parts.map((p, i) => parseField(p, FIELDS[i]));
  if (dow.has(7)) dow.add(0);
  return { minute, hour, dom, month, dow, domAny: parts[2] === "*", dowAny: parts[4] === "*" };
}

export function cronMatches(cron, date) {
  if (!cron.minute.has(date.getMinutes()) || !cron.hour.has(date.getHours()) || !cron.month.has(date.getMonth() + 1)) return false;
  const domOk = cron.dom.has(date.getDate());
  const dowOk = cron.dow.has(date.getDay());
  if (cron.domAny && cron.dowAny) return true;
  if (cron.domAny) return dowOk;
  if (cron.dowAny) return domOk;
  return domOk || dowOk;
}

/** The next `count` times (after `from`) the expression fires, for previews. */
export function nextRuns(expr, count = 3, from = new Date()) {
  const cron = parseCron(expr);
  const out = [];
  const d = new Date(from);
  d.setSeconds(0, 0);
  // A year of minutes is enough for any expression that can fire at all (e.g. 29 Feb aside).
  for (let i = 0; i < 366 * 24 * 60 && out.length < count; i++) {
    d.setMinutes(d.getMinutes() + 1);
    if (cronMatches(cron, d)) out.push(new Date(d));
  }
  return out;
}
