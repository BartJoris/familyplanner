// Gezinsplanner — request-handler (Web Fetch API: draait in Node via src/server.js)
// Leest iCloud-agenda's via CalDAV, toont een weekplanner per gezinslid en laat toe afspraken toe te voegen.
import { CalDav, CalDavError } from "./caldav.js";
import { MockCalDav } from "./mock.js";
import { expandIcs, buildIcs, updateIcs, isRecurringIcs, buildTodoIcs, updateTodoIcs } from "./ics.js";
import { zonedToUtc, parseDateStr, addDaysStr, mondayOf, todayIn, utcToZoned } from "./time.js";
import { RoutineStore, routinesConfig, stepsFor } from "./routines.js";
import { loadUsers, publicUsers, verifyUserPin } from "./users.js";
import {
  listsConfig, isListId, LocalListStore, resolveListBackends,
  sortItems, publicItem, itemsFromTodos, normalizeTitle,
} from "./lists.js";

const COOKIE = "gp_session";
const COOKIE_MAX_AGE = 400 * 24 * 3600; // maximum dat browsers toelaten

/* ───────────── config ───────────── */

const DEFAULT_CONFIG = {
  calendars: ["Bart en Margot", "Allen thuis"],
  people: [
    { name: "Bart", emoji: "☕", keywords: ["Bart"], default_calendar: "Bart en Margot" },
    { name: "Margot", emoji: "🌼", keywords: ["Margot"], default_calendar: "Bart en Margot" },
    { name: "Otis", emoji: "🐻", keywords: ["Otis"], default_calendar: "Allen thuis" },
    { name: "Janne", emoji: "🐴", keywords: ["Janne"], default_calendar: "Allen thuis" },
  ],
  fallback: { name: "Samen", emoji: "🍳", default_calendar: "Bart en Margot" },
};

function getConfig(env) {
  let cfg = DEFAULT_CONFIG;
  if (env.CONFIG) {
    cfg = typeof env.CONFIG === "string" ? JSON.parse(env.CONFIG) : env.CONFIG;
  }
  const people = (cfg.people || []).map((p) => ({
    name: p.name, emoji: p.emoji || "", color: p.color || "",
    keywords: p.keywords && p.keywords.length ? p.keywords : [p.name],
    calendars: p.calendars || [],
    default_calendar: p.default_calendar || (cfg.calendars || [])[0],
  }));
  const fallback = cfg.fallback ? { ...cfg.fallback, default_calendar: cfg.fallback.default_calendar || (cfg.calendars || [])[0] } : null;
  const calendars = [...new Set([...(cfg.calendars || []), ...people.flatMap((p) => p.calendars)])];
  return {
    people, fallback, calendars,
    tz: env.TIMEZONE || "Europe/Brussels",
    routines: routinesConfig(cfg),
    lists: listsConfig(cfg),
  };
}

/* ───────────── auth ───────────── */

const enc = new TextEncoder();

async function hmac(key, msg) {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
  return btoa(String.fromCharCode(...sig)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function safeEqual(a, b) {
  // vergelijk via HMAC zodat lengte/inhoud niet via timing lekt
  const [x, y] = await Promise.all([hmac("cmp", String(a)), hmac("cmp", String(b))]);
  if (x.length !== y.length) return false;
  let r = 0;
  for (let i = 0; i < x.length; i++) r |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return r === 0;
}

const sessionToken = (env) => hmac(env.AUTH_KEY, "gezinsplanner-session-v1");

function b64urlJson(obj) {
  return btoa(unescape(encodeURIComponent(JSON.stringify(obj))))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function jsonFromB64url(s) {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return JSON.parse(decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad))));
}
async function signSession(env, payload) {
  const body = b64urlJson(payload);
  const sig = await hmac(env.AUTH_KEY, `gezinsplanner-session-v2:${body}`);
  return `v2.${body}.${sig}`;
}
async function readSession(cookie, env) {
  if (!cookie) return null;
  if (cookie.startsWith("v2.")) {
    const parts = cookie.split(".");
    if (parts.length !== 3) return null;
    const expected = await hmac(env.AUTH_KEY, `gezinsplanner-session-v2:${parts[1]}`);
    if (!(await safeEqual(parts[2], expected))) return null;
    try {
      const p = jsonFromB64url(parts[1]);
      if (p.t === "k") return { type: "key" };
      if (p.t === "u" && p.n) {
        const users = await loadUsers(env);
        if (!users.some((u) => u.name === p.n)) return null;
        return { type: "user", name: p.n };
      }
    } catch { return null; }
    return null;
  }
  if (await safeEqual(cookie, await sessionToken(env))) return { type: "key" };
  return null;
}

function getCookie(req, name) {
  const c = req.headers.get("Cookie") || "";
  const m = c.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}

function sessionCookie(value, req, env, maxAge = COOKIE_MAX_AGE) {
  // COOKIE_SECURE: auto (enkel bij https), true of false. Via http op het LAN mag 'Secure' niet, anders bewaart de browser niets.
  const mode = String(env.COOKIE_SECURE || "auto").toLowerCase();
  const https = new URL(req.url).protocol === "https:";
  const secure = mode === "true" || (mode === "auto" && https);
  return `${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly;${secure ? " Secure;" : ""} SameSite=Lax`;
}

async function isAuthed(req, env, url) {
  if (!env.AUTH_KEY || env.AUTH_KEY.length < 16) throw new Error("AUTH_KEY ontbreekt of is te kort (min. 16 tekens)");
  const bearer = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (bearer && (await safeEqual(bearer, env.AUTH_KEY))) return { ok: true, type: "key" };
  const sess = await readSession(getCookie(req, COOKIE), env);
  if (sess) return { ok: true, ...sess };
  const qkey = url.searchParams.get("key");
  if (qkey && (await safeEqual(qkey, env.AUTH_KEY))) return { ok: true, type: "key", setCookie: true };
  return { ok: false };
}

function actorName(auth) {
  return auth && auth.type === "user" && auth.name ? auth.name : "";
}

const delayGuess = () => new Promise((r) => setTimeout(r, 800));

const PUBLIC_FILES = new Set([
  "/style.css", "/app.js", "/favicon.svg", "/routine.css", "/routine.js",
  "/login.js", "/lists.js", "/lists.css",
]);

function assetPathname(pathname) {
  if (pathname === "/routine") return "/routine.html";
  if (pathname === "/lists" || pathname.startsWith("/lists/")) return "/lists.html";
  return pathname;
}

/* ───────────── helpers ───────────── */

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });

function frameAncestors(env) {
  // "self" mag zonder aanhalingstekens (handig in .env-bestanden)
  return String(env.FRAME_ANCESTORS || "'self'").trim().split(/\s+/)
    .map((t) => (/^'?self'?$/i.test(t) ? "'self'" : /^'?none'?$/i.test(t) ? "'none'" : t)).join(" ");
}

function securityHeaders(env) {
  return {
    "Content-Security-Policy":
      `default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; ` +
      `img-src 'self' data:; frame-ancestors ${frameAncestors(env)}`,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
}

function client(env, cfg) {
  return env.MOCK === "1" ? new MockCalDav(cfg.tz) : new CalDav(env.ICLOUD_USER, env.ICLOUD_APP_PASSWORD);
}

const discoverCache = { at: 0, data: null, key: "" };
async function discoverAll(env, cfg) {
  const key = env.MOCK === "1" ? "mock" : env.ICLOUD_USER;
  if (discoverCache.data && discoverCache.key === key && Date.now() - discoverCache.at < 6 * 3600 * 1000) {
    return discoverCache.data;
  }
  const all = await client(env, cfg).discover();
  Object.assign(discoverCache, { at: Date.now(), data: all, key });
  return all;
}
async function calendars(env, cfg) {
  return (await discoverAll(env, cfg)).filter((c) => c.vevent !== false);
}

function selectCalendars(all, cfg) {
  const selected = [];
  const missing = [];
  for (const name of cfg.calendars) {
    const c = all.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (c) selected.push({ ...c, name }); else missing.push(name);
  }
  return { selected, missing };
}

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const kwRegex = (kw, flags) => new RegExp(`(^|[^\\p{L}])${reEsc(kw)}(?=$|[^\\p{L}])`, flags);

/** Bepaal kolommen + weer te geven tekst voor een titel. */
function assign(summary, calName, cfg) {
  const byName = [];
  let text = summary;
  cfg.people.forEach((p, i) => {
    for (const kw of p.keywords) {
      if (kwRegex(kw, "iu").test(summary)) {
        if (!byName.includes(i)) byName.push(i);
        text = text.replace(kwRegex(kw, "giu"), "$1");
      }
    }
  });
  text = text.replace(/\(\s*\)|\[\s*\]/g, "").replace(/\s{2,}/g, " ")
    .replace(/^(?:\s*(?:en(?=\s)|[&+,:\-]))+\s*/i, "")
    .replace(/(?:\s*(?:\sen|[&+,:\-]))+\s*$/i, "")
    .trim() || summary;
  if (byName.length) return { cols: byName, text };
  const owners = cfg.people
    .map((p, i) => (p.calendars.some((c) => c.toLowerCase() === calName.toLowerCase()) ? i : -1))
    .filter((i) => i >= 0);
  if (owners.length === 1) return { cols: owners, text: summary };
  if (cfg.fallback) return { cols: [cfg.people.length], text: summary };
  return { cols: owners, text: summary };
}

/** Titel samenstellen voor nieuwe/aangepaste afspraak. */
function composeSummary(text, col, calName, cfg) {
  const t = String(text || "").trim();
  const person = cfg.people[col];
  if (!person) return t; // fallback-kolom: geen naam
  const owners = cfg.people.filter((p) => p.calendars.some((c) => c.toLowerCase() === calName.toLowerCase()));
  if (owners.length === 1 && owners[0] === person) return t;
  if (kwRegex(person.keywords[0], "iu").test(t)) return t;
  return `${person.keywords[0]} ${t}`;
}

/** Kolom bepalen uit body.col (index) of body.person (naam, handig voor Home Assistant). */
function resolveCol(body, cfg) {
  if (body.person !== undefined && body.person !== null && body.person !== "") {
    const name = String(body.person).toLowerCase();
    const i = cfg.people.findIndex((p) => p.name.toLowerCase() === name || p.keywords.some((k) => k.toLowerCase() === name));
    if (i >= 0) return i;
    if (cfg.fallback && cfg.fallback.name.toLowerCase() === name) return cfg.people.length;
  }
  const n = Number(body.col);
  return Number.isInteger(n) && n >= 0 && n <= cfg.people.length ? n : cfg.people.length;
}

function defaultCalendarFor(col, cfg) {
  const p = cfg.people[col] || cfg.fallback;
  return p ? p.default_calendar : cfg.calendars[0];
}

function validTime(t) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(t || ""); }

/** Valideer invoer van formulier → genormaliseerd event of foutmelding. */
function normalizeInput(body) {
  const title = String(body.title || "").trim().slice(0, 200);
  if (!title) return { error: "Geef een titel op." };
  if (!parseDateStr(body.date)) return { error: "Ongeldige datum." };
  if (body.allDay) {
    const endDate = body.endDate && parseDateStr(body.endDate) && body.endDate >= body.date ? body.endDate : body.date;
    return { title, allDay: true, date: body.date, endDate: addDaysStr(endDate, 1) };
  }
  if (!validTime(body.start) || !validTime(body.end)) return { error: "Ongeldig uur." };
  const endDate = body.end <= body.start ? addDaysStr(body.date, 1) : body.date; // over middernacht
  return { title, allDay: false, date: body.date, endDate, start: body.start, end: body.end };
}

/* ───────────── API ───────────── */

async function apiWeek(url, env, cfg) {
  const start = mondayOf(parseDateStr(url.searchParams.get("start")) ? url.searchParams.get("start") : todayIn(cfg.tz));
  const { events, errors, selected } = await collectEvents(start, 7, env, cfg);
  return json({
    weekStart: start,
    today: todayIn(cfg.tz),
    columns: columnsOf(cfg),
    calendars: selected.filter((c) => c.writable).map((c) => c.name),
    events,
    errors,
  });
}

const columnsOf = (cfg) => [...cfg.people, ...(cfg.fallback ? [cfg.fallback] : [])]
  .map((p) => ({ name: p.name, emoji: p.emoji, color: p.color || "", default_calendar: p.default_calendar }));

/** Alle afspraken in [start, start+days) als genormaliseerde lijst. */
async function collectEvents(start, days, env, cfg) {
  const s = parseDateStr(start);
  const e = parseDateStr(addDaysStr(start, days));
  const rangeStart = zonedToUtc(s.y, s.m, s.d, 0, 0, cfg.tz);
  const rangeEnd = zonedToUtc(e.y, e.m, e.d, 0, 0, cfg.tz);

  const all = await calendars(env, cfg);
  const { selected, missing } = selectCalendars(all, cfg);
  const dav = client(env, cfg);
  const errors = missing.map((n) => `Agenda "${n}" niet gevonden in iCloud`);

  const lists = await Promise.all(selected.map(async (cal) => {
    try {
      const items = await dav.events(cal.url, rangeStart, rangeEnd);
      const out = [];
      for (const it of items) {
        try {
          for (const occ of expandIcs(it.ics, rangeStart, rangeEnd, cfg.tz)) {
            const { cols, text } = assign(occ.summary, cal.name, cfg);
            out.push({
              id: `${it.href}#${occ.recurrenceId || occ.startDate}`,
              href: it.href, etag: it.etag, calendar: cal.name, color: cal.color,
              summary: occ.summary, text, cols, location: occ.location,
              allDay: occ.allDay, startDate: occ.startDate, endDate: occ.endDate,
              startTime: occ.startTime, endTime: occ.endTime, recurring: occ.recurring,
            });
          }
        } catch (err) {
          console.warn("ICS kon niet gelezen worden", it.href, err);
        }
      }
      return out;
    } catch (err) {
      errors.push(`Agenda "${cal.name}": ${err.message}`);
      return [];
    }
  }));

  return { events: lists.flat(), errors, selected };
}

/** Compacte samenvatting voor Home Assistant (REST-sensor): vandaag en morgen. */
async function apiHaSummary(url, env, cfg) {
  const today = todayIn(cfg.tz);
  const { events, errors } = await collectEvents(today, 2, env, cfg);
  const cols = columnsOf(cfg);
  const fmt = (t) => { const [h, m] = t.split(":"); return `${+h}u${m === "00" ? "" : m}`; };
  const dayList = (date) => {
    const out = [];
    for (const ev of events) {
      const onDay = ev.allDay ? ev.startDate <= date && date < ev.endDate
        : ev.startDate <= date && (date < ev.endDate || (date === ev.endDate && (ev.endTime > "00:00" || ev.startDate === date)));
      if (!onDay) continue;
      const first = ev.startDate === date;
      for (const c of ev.cols) {
        out.push({
          person: cols[c] ? cols[c].name : "", emoji: cols[c] ? cols[c].emoji : "",
          text: ev.text, all_day: ev.allDay,
          start: !ev.allDay && first ? ev.startTime : "", end: !ev.allDay ? ev.endTime : "",
          label: `${!ev.allDay && first ? fmt(ev.startTime) + " " : ""}${ev.text}`,
          calendar: ev.calendar,
        });
      }
    }
    out.sort((a, b) => (a.start || "00:00").localeCompare(b.start || "00:00") || a.person.localeCompare(b.person));
    return out;
  };
  const summarize = (list) => cols.map((c) => {
    const items = list.filter((x) => x.person === c.name);
    return items.length ? `${c.emoji} ${c.name}: ${items.map((x) => x.label).join(", ")}` : null;
  }).filter(Boolean).join("\n");
  const now = new Date();
  const nowTime = new Intl.DateTimeFormat("nl-BE", { timeZone: cfg.tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
  const todayList = dayList(today);
  const next = todayList.find((x) => !x.all_day && x.start >= nowTime) || null;
  const tomorrow = addDaysStr(today, 1);
  const tomorrowList = dayList(tomorrow);
  return json({
    date: today,
    count: todayList.length,
    today: todayList,
    today_text: summarize(todayList) || "Niets gepland",
    next,
    tomorrow_date: tomorrow,
    tomorrow_count: tomorrowList.length,
    tomorrow: tomorrowList,
    tomorrow_text: summarize(tomorrowList) || "Niets gepland",
    errors,
  });
}

async function ownedHref(href, env, cfg) {
  const all = await calendars(env, cfg);
  const { selected } = selectCalendars(all, cfg);
  let u;
  try { u = new URL(href); } catch { return null; }
  // enkel URL's binnen een geselecteerde agenda (geen willekeurige requests met iCloud-login)
  return selected.find((c) => {
    const base = new URL(c.url);
    return u.origin === base.origin && u.pathname.startsWith(base.pathname) && u.pathname !== base.pathname &&
      !u.pathname.slice(base.pathname.length).includes("/") && !u.pathname.includes("..");
  }) || null;
}

async function apiCreate(req, env, cfg) {
  const body = await req.json();
  const n = normalizeInput(body);
  if (n.error) return json({ error: n.error }, 400);
  const all = await calendars(env, cfg);
  const { selected } = selectCalendars(all, cfg);
  const calName = body.calendar || defaultCalendarFor(resolveCol(body, cfg), cfg);
  const cal = selected.find((c) => c.name.toLowerCase() === String(calName || "").toLowerCase() && c.writable);
  if (!cal) return json({ error: "Kies een geldige agenda." }, 400);
  const col = resolveCol(body, cfg);
  const summary = composeSummary(n.title, col, cal.name, cfg);
  const uid = `${crypto.randomUUID()}@gezinsplanner`;
  const ics = buildIcs({ uid, summary, ...n }, cfg.tz);
  const url = new URL(`${encodeURIComponent(uid)}.ics`, cal.url).toString();
  await client(env, cfg).put(url, ics, { create: true });
  return json({ ok: true, summary }, 201);
}

async function apiUpdate(req, env, cfg) {
  const body = await req.json();
  const cal = await ownedHref(body.href, env, cfg);
  if (!cal) return json({ error: "Onbekende afspraak." }, 400);
  const n = normalizeInput(body);
  if (n.error) return json({ error: n.error }, 400);
  const dav = client(env, cfg);
  const cur = await dav.get(body.href);
  if (isRecurringIcs(cur.ics)) return json({ error: "Herhalende afspraken pas je aan op je iPhone." }, 409);
  const etag = body.etag || cur.etag;
  // titel enkel herschrijven als tekst of persoon veranderde
  const orig = assign(body.originalSummary || "", cal.name, cfg);
  const col = resolveCol(body, cfg);
  const unchanged = body.originalSummary && orig.text === n.title && orig.cols.length === 1 && orig.cols[0] === col;
  const summary = unchanged ? body.originalSummary : composeSummary(n.title, col, cal.name, cfg);
  const ics = updateIcs(cur.ics, { summary, ...n }, cfg.tz);
  await dav.put(body.href, ics, { etag });
  return json({ ok: true, summary });
}

async function apiDelete(req, env, cfg) {
  const body = await req.json();
  const cal = await ownedHref(body.href, env, cfg);
  if (!cal) return json({ error: "Onbekende afspraak." }, 400);
  const dav = client(env, cfg);
  const cur = await dav.get(body.href);
  if (isRecurringIcs(cur.ics)) return json({ error: "Herhalende afspraken verwijder je op je iPhone." }, 409);
  await dav.remove(body.href, body.etag || cur.etag);
  return json({ ok: true });
}

/* ───────────── routines (kinderen) ───────────── */

let routineStore = null;
const store = (env) => (routineStore ||= new RoutineStore(env.DATA_DIR || null));

function currentPeriod(cfg) {
  const now = utcToZoned(new Date(), cfg.tz).time;
  return now >= (cfg.routines.switch_at || "13:00") ? "evening" : "morning";
}

function routinePayload(date, env, cfg) {
  const rc = cfg.routines;
  return {
    date,
    today: todayIn(cfg.tz),
    period: currentPeriod(cfg),
    children: rc.children,
    routines: rc.routines,
    state: store(env).day(date),
    week: store(env).week(date, rc),
  };
}

async function apiRoutines(url, env, cfg) {
  const q = url.searchParams.get("date");
  const date = parseDateStr(q) ? q : todayIn(cfg.tz);
  return json(routinePayload(date, env, cfg));
}

async function apiRoutineToggle(req, env, cfg) {
  const b = await req.json();
  const date = parseDateStr(b.date) ? b.date : todayIn(cfg.tz);
  let res;
  try {
    res = store(env).toggle(date, String(b.child), String(b.routine), String(b.step), !!b.done, cfg.routines);
  } catch (e) {
    return json({ error: e.message }, 400);
  }
  if (res.completedNow && env.HA_WEBHOOK_URL) {
    // feestje melden aan Home Assistant (lichtje, geluid…); fouten mogen de kinderen niet storen
    const routine = cfg.routines.routines[b.routine];
    fetch(env.HA_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ child: b.child, routine: b.routine, label: routine?.label || b.routine, date }),
      signal: AbortSignal.timeout(5000),
    }).catch((e) => console.warn("HA-webhook mislukt:", e.message));
  }
  return json({ ...routinePayload(date, env, cfg), completedNow: res.completedNow });
}

async function apiRoutineReset(req, env, cfg) {
  const b = await req.json();
  const date = parseDateStr(b.date) ? b.date : todayIn(cfg.tz);
  try {
    store(env).reset(date, String(b.child), String(b.routine), cfg.routines);
  } catch (e) {
    return json({ error: e.message }, 400);
  }
  return json({ ...routinePayload(date, env, cfg), reset: true });
}

/** Compact voor Home Assistant: per kind per routine hoeveel stappen klaar zijn. */
async function apiHaRoutines(url, env, cfg) {
  const date = todayIn(cfg.tz);
  const rc = cfg.routines;
  const day = store(env).day(date);
  const out = { date, period: currentPeriod(cfg), children: {} };
  for (const ch of rc.children) {
    out.children[ch.name] = {};
    for (const key of Object.keys(rc.routines)) {
      const steps = stepsFor(rc, ch, key);
      const st = day?.[ch.name]?.[key] || {};
      const done = steps.filter((s) => st[s.id]).length;
      out.children[ch.name][key] = {
        done, total: steps.length, complete: steps.length > 0 && done === steps.length,
        todo: steps.filter((s) => !st[s.id]).map((s) => s.label),
      };
    }
  }
  return json(out);
}

/* ───────────── lijsten (boodschappen / niet vergeten) ───────────── */

let listStore = null;
const localLists = (env) => (listStore ||= new LocalListStore(env.DATA_DIR || null));

async function listBackends(env, cfg) {
  try {
    const all = await discoverAll(env, cfg);
    return { backends: resolveListBackends(cfg.lists, all), error: null };
  } catch (err) {
    console.warn("Reminder-lijsten niet bereikbaar, lokale opslag:", err.message);
    return { backends: resolveListBackends(cfg.lists, []), error: err.message };
  }
}

function todoHref(backend, uid) {
  const base = backend.url.endsWith("/") ? backend.url : `${backend.url}/`;
  return new URL(`${encodeURIComponent(uid)}.ics`, base).toString();
}

function ownedIn(href, collections) {
  let u;
  try { u = new URL(href); } catch { return null; }
  return (collections || []).find((c) => {
    const base = new URL(c.url);
    return u.origin === base.origin && u.pathname.startsWith(base.pathname) && u.pathname !== base.pathname &&
      !u.pathname.slice(base.pathname.length).includes("/") && !u.pathname.includes("..");
  }) || null;
}

async function readListItems(env, cfg, backend) {
  if (backend.sync !== "reminders" || !backend.url) {
    return localLists(env).items(backend.id).map(publicItem);
  }
  const raw = await client(env, cfg).todos(backend.url);
  return itemsFromTodos(raw).map(publicItem);
}

function listPayload(backend, items, error) {
  return {
    id: backend.id,
    label: backend.label,
    sync: backend.sync,
    sync_label: backend.sync === "reminders" ? "Synced met Reminders" : "Alleen Familyplanner",
    items: sortItems(items),
    sync_error: error || null,
  };
}

async function apiLists(url, env, cfg) {
  const { backends, error } = await listBackends(env, cfg);
  const lists = {};
  for (const id of Object.keys(cfg.lists)) {
    const items = await readListItems(env, cfg, backends[id]);
    lists[id] = listPayload(backends[id], items, error);
  }
  const kinds = [...new Set(Object.keys(cfg.lists).map((id) => backends[id].sync))];
  return json({
    sync: kinds.length === 1 ? kinds[0] : "mixed",
    sync_error: error,
    lists,
  });
}

async function apiListGet(listId, env, cfg) {
  if (!isListId(listId, cfg.lists)) return json({ error: "Onbekende lijst." }, 404);
  const { backends, error } = await listBackends(env, cfg);
  const items = await readListItems(env, cfg, backends[listId]);
  return json(listPayload(backends[listId], items, error));
}

async function apiListAdd(listId, req, env, cfg, auth) {
  if (!isListId(listId, cfg.lists)) return json({ error: "Onbekende lijst." }, 404);
  const body = await req.json();
  const title = normalizeTitle(body.title);
  if (!title) return json({ error: "Geef een titel op." }, 400);
  const { backends, error } = await listBackends(env, cfg);
  const backend = backends[listId];
  const by = actorName(auth);
  if (backend.sync !== "reminders" || !backend.url) {
    const item = publicItem(localLists(env).add(listId, title, by));
    return json({ ok: true, item, sync: "local", sync_error: error }, 201);
  }
  const uid = `${crypto.randomUUID()}@gezinsplanner`;
  const ics = buildTodoIcs({ uid, title, created_by: by });
  const href = todoHref(backend, uid);
  const etag = await client(env, cfg).put(href, ics, { create: true });
  return json({ ok: true, item: publicItem({ id: uid, href, etag, title, completed: false, created_by: by }), sync: "reminders" }, 201);
}

async function apiListPatch(listId, req, env, cfg) {
  if (!isListId(listId, cfg.lists)) return json({ error: "Onbekende lijst." }, 404);
  const body = await req.json();
  const id = String(body.id || body.uid || "").trim();
  if (!id) return json({ error: "Onbekend item." }, 400);
  if (body.title !== undefined && !normalizeTitle(body.title)) return json({ error: "Geef een titel op." }, 400);
  const { backends, error } = await listBackends(env, cfg);
  const backend = backends[listId];
  if (backend.sync !== "reminders" || !backend.url) {
    let item;
    try { item = localLists(env).patch(listId, id, { title: body.title, completed: body.completed }); }
    catch (e) { return json({ error: e.message }, 400); }
    if (!item) return json({ error: "Onbekend item." }, 404);
    return json({ ok: true, item: publicItem(item), sync: "local", sync_error: error });
  }
  const href = String(body.href || todoHref(backend, id));
  if (!ownedIn(href, [backend])) return json({ error: "Onbekend item." }, 400);
  const dav = client(env, cfg);
  const cur = await dav.get(href);
  const ics = updateTodoIcs(cur.ics, {
    title: body.title !== undefined ? normalizeTitle(body.title) : undefined,
    completed: body.completed,
  });
  const etag = await dav.put(href, ics, { etag: body.etag || cur.etag });
  const parsed = itemsFromTodos([{ href, etag, ics }])[0];
  return json({ ok: true, item: publicItem(parsed), sync: "reminders" });
}

async function apiListDelete(listId, req, env, cfg) {
  if (!isListId(listId, cfg.lists)) return json({ error: "Onbekende lijst." }, 404);
  const body = await req.json();
  const id = String(body.id || body.uid || "").trim();
  if (!id) return json({ error: "Onbekend item." }, 400);
  const { backends, error } = await listBackends(env, cfg);
  const backend = backends[listId];
  if (backend.sync !== "reminders" || !backend.url) {
    if (!localLists(env).remove(listId, id)) return json({ error: "Onbekend item." }, 404);
    return json({ ok: true, sync: "local", sync_error: error });
  }
  const href = String(body.href || todoHref(backend, id));
  if (!ownedIn(href, [backend])) return json({ error: "Onbekend item." }, 400);
  const dav = client(env, cfg);
  const cur = await dav.get(href);
  await dav.remove(href, body.etag || cur.etag);
  return json({ ok: true, sync: "reminders" });
}

/* ───────────── login-pagina ───────────── */

const escHtml = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));

async function loginPage(env, error = "") {
  const users = publicUsers(await loadUsers(env));
  const err = error ? `<p class="login-err" id="login-err">${escHtml(error)}</p>` : `<p class="login-err hidden" id="login-err"></p>`;
  const userBlock = users.length ? `
<form method="post" action="/login" class="user-form" id="user-form">
<p class="login-lead">Wie ben je?</p>
<input type="hidden" name="user" id="user" value="">
<div class="login-users">
${users.map((u) => `<button type="button" class="user-btn" data-user="${escHtml(u.name)}"><span class="ue">${escHtml(u.emoji)}</span>${escHtml(u.name)}</button>`).join("")}
</div>
<label for="pin">Code</label>
<input id="pin" name="pin" type="password" inputmode="numeric" pattern="[0-9]{4,8}" maxlength="8" autocomplete="current-password" required>
${err}
<button type="submit">Inloggen</button>
</form>` : "";
  const keyBlock = users.length ? `
<details class="login-key">
<summary>Toegangssleutel</summary>
<form method="post" action="/login" class="key-form">
<label for="key">Sleutel</label>
<input id="key" name="key" type="password" autocomplete="off">
<button type="submit">Inloggen met sleutel</button>
</form>
</details>` : `
<form method="post" action="/login" class="key-form">
<label for="key">Toegangssleutel</label>
<input id="key" name="key" type="password" autocomplete="current-password" autofocus required>
${err}
<button type="submit">Inloggen</button>
</form>`;
  return `<!doctype html><html lang="nl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Gezinsplanner</title>
<link rel="stylesheet" href="/style.css"></head>
<body class="login"><div class="login-box">
<h1>Gezinsplanner</h1>
${userBlock}
${keyBlock}
</div>
${users.length ? `<script src="/login.js"></script>` : ""}
</body></html>`;
}

/* ───────────── router ───────────── */

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cfg = getConfig(env);
    const sec = securityHeaders(env);

    try {
      if (url.pathname === "/healthz") return new Response("ok");
      // publieke bestanden zonder gegevens (nodig voor login-pagina en iframes zonder cookie)
      if (PUBLIC_FILES.has(url.pathname)) return env.ASSETS.fetch(req);

      if (url.pathname === "/login") {
        if (req.method === "POST") {
          const form = await req.formData();
          const key = String(form.get("key") || "");
          const user = String(form.get("user") || "").trim();
          const pin = String(form.get("pin") || "");
          const html401 = { status: 401, headers: { "Content-Type": "text/html; charset=utf-8", ...sec } };
          if (key) {
            if (env.AUTH_KEY && (await safeEqual(key, env.AUTH_KEY))) {
              return new Response(null, { status: 303, headers: { Location: "/", "Set-Cookie": sessionCookie(await signSession(env, { t: "k" }), req, env) } });
            }
            await delayGuess();
            return new Response(await loginPage(env, "Verkeerde sleutel."), html401);
          }
          if (user || pin) {
            const u = await verifyUserPin(env, user, pin);
            if (u) {
              return new Response(null, { status: 303, headers: { Location: "/", "Set-Cookie": sessionCookie(await signSession(env, { t: "u", n: u.name }), req, env) } });
            }
            await delayGuess();
            return new Response(await loginPage(env, "Verkeerde code."), html401);
          }
          return new Response(await loginPage(env, "Kies wie je bent en vul je code in."), html401);
        }
        return new Response(await loginPage(env), { headers: { "Content-Type": "text/html; charset=utf-8", ...sec } });
      }
      if (url.pathname === "/logout") {
        return new Response(null, { status: 303, headers: { Location: "/login", "Set-Cookie": sessionCookie("", req, env, 0) } });
      }

      const auth = await isAuthed(req, env, url);
      if (!auth.ok) {
        if (url.pathname.startsWith("/api/")) return json({ error: "Niet ingelogd" }, 401);
        return Response.redirect(new URL("/login", url).toString(), 303);
      }

      if (url.pathname.startsWith("/api/")) {
        if (req.method !== "GET" && !(req.headers.get("Content-Type") || "").includes("application/json")) {
          return json({ error: "Content-Type moet application/json zijn" }, 415);
        }
        if (url.pathname === "/api/me" && req.method === "GET") {
          return json({ type: auth.type || "key", name: auth.name || null });
        }
        if (url.pathname === "/api/week" && req.method === "GET") return await apiWeek(url, env, cfg);
        if (url.pathname === "/api/ha/summary" && req.method === "GET") return await apiHaSummary(url, env, cfg);
        if (url.pathname === "/api/ha/routines" && req.method === "GET") return await apiHaRoutines(url, env, cfg);
        if (url.pathname === "/api/routines" && req.method === "GET") return await apiRoutines(url, env, cfg);
        if (url.pathname === "/api/routines/toggle" && req.method === "POST") return await apiRoutineToggle(req, env, cfg);
        if (url.pathname === "/api/routines/reset" && req.method === "POST") return await apiRoutineReset(req, env, cfg);
        if (url.pathname === "/api/events" && req.method === "POST") return await apiCreate(req, env, cfg);
        if (url.pathname === "/api/events" && req.method === "PATCH") return await apiUpdate(req, env, cfg);
        if (url.pathname === "/api/events" && req.method === "DELETE") return await apiDelete(req, env, cfg);
        if (url.pathname === "/api/lists" && req.method === "GET") return await apiLists(url, env, cfg);
        const listM = url.pathname.match(/^\/api\/lists\/([a-z]+)(?:\/(items))?$/);
        if (listM) {
          const listId = listM[1];
          const items = listM[2] === "items";
          if (!items && req.method === "GET") return await apiListGet(listId, env, cfg);
          if (items && req.method === "POST") return await apiListAdd(listId, req, env, cfg, auth);
          if (items && req.method === "PATCH") return await apiListPatch(listId, req, env, cfg);
          if (items && req.method === "DELETE") return await apiListDelete(listId, req, env, cfg);
        }
        if (url.pathname === "/api/refresh" && req.method === "POST") { discoverCache.data = null; return json({ ok: true }); }
        return json({ error: "Niet gevonden" }, 404);
      }

      // statische bestanden (index.html, app.js, …)
      const assetReq = assetPathname(url.pathname) !== url.pathname
        ? new Request(new URL(assetPathname(url.pathname), url), req) : req;
      const res = await env.ASSETS.fetch(assetReq);
      const out = new Response(res.body, res);
      for (const [k, v] of Object.entries(sec)) out.headers.set(k, v);
      out.headers.set("Cache-Control", "no-cache");
      if (auth.setCookie) out.headers.append("Set-Cookie", sessionCookie(await signSession(env, { t: "k" }), req, env));
      return out;
    } catch (err) {
      const status = err instanceof CalDavError ? err.status : 500;
      console.error(err);
      if (url.pathname.startsWith("/api/")) return json({ error: err.message || "Fout" }, status);
      return new Response(`Fout: ${err.message}`, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
  },
};
