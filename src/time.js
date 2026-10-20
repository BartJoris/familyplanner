// Tijdzone-hulpjes zonder externe libs (Intl werkt in Workers).

const pad = (n) => String(n).padStart(2, "0");

const fmtCache = new Map();
function partsFormatter(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(tz, new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }));
  }
  return fmtCache.get(tz);
}

/** Muurklok-velden van een instant in tijdzone tz. */
export function utcToZoned(date, tz) {
  const p = {};
  for (const { type, value } of partsFormatter(tz).formatToParts(date)) p[type] = value;
  const y = +p.year, m = +p.month, d = +p.day, h = +p.hour % 24, mi = +p.minute;
  return {
    y, m, d, h, mi,
    date: `${y}-${pad(m)}-${pad(d)}`,
    time: `${pad(h)}:${pad(mi)}`,
  };
}

function offsetMs(date, tz) {
  const z = utcToZoned(date, tz);
  const asUtc = Date.UTC(z.y, z.m - 1, z.d, z.h, z.mi, date.getUTCSeconds());
  return asUtc - (date.getTime() - date.getUTCMilliseconds());
}

/** Muurkloktijd in tz → echte instant (Date). */
export function zonedToUtc(y, m, d, h = 0, mi = 0, tz) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let t = guess - offsetMs(new Date(guess), tz);
  const off2 = offsetMs(new Date(t), tz);
  t = guess - off2;
  return new Date(t);
}

export function parseDateStr(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
  if (!m) return null;
  return { y: +m[1], m: +m[2], d: +m[3] };
}

export function addDaysStr(s, n) {
  const { y, m, d } = parseDateStr(s);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Maandag van de week waarin datumstring s valt. */
export function mondayOf(s) {
  const { y, m, d } = parseDateStr(s);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = zondag
  return addDaysStr(s, -((dow + 6) % 7));
}

export function todayIn(tz) {
  return utcToZoned(new Date(), tz).date;
}

export function icsUtc(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export { pad };
