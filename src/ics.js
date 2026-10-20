// ICS lezen (incl. herhalingen/uitzonderingen) en schrijven.
import ICAL from "ical.js";
import { utcToZoned, zonedToUtc, pad, icsUtc } from "./time.js";

const MAX_ITER = 5000;

function registerTimezones(vcal) {
  for (const vtz of vcal.getAllSubcomponents("vtimezone")) {
    const tzid = vtz.getFirstPropertyValue("tzid");
    if (tzid && !ICAL.TimezoneService.has(tzid)) {
      try { ICAL.TimezoneService.register(vtz); } catch { /* ongeldige VTIMEZONE: negeren */ }
    }
  }
}

/** ICAL.Time → instant (Date). Onbekende/zwevende zones = muurklok in tz. */
function toInstant(t, tz) {
  if (t.isDate) return zonedToUtc(t.year, t.month, t.day, 0, 0, tz);
  const zid = t.zone && t.zone.tzid;
  if (zid && zid !== "floating") return t.toJSDate();
  return zonedToUtc(t.year, t.month, t.day, t.hour, t.minute, tz);
}

function dateOnly(t) {
  return `${t.year}-${pad(t.month)}-${pad(t.day)}`;
}

function occurrence(item, start, end, tz, extra) {
  const allDay = start.isDate;
  let out;
  if (allDay) {
    let endStr = end ? dateOnly(end) : null;
    const startStr = dateOnly(start);
    if (!endStr || endStr <= startStr) {
      const n = start.clone(); n.day += 1; endStr = dateOnly(n);
    }
    out = { allDay: true, startDate: startStr, endDate: endStr, startTime: "", endTime: "" };
  } else {
    const s = utcToZoned(toInstant(start, tz), tz);
    const e = utcToZoned(end ? toInstant(end, tz) : toInstant(start, tz), tz);
    out = { allDay: false, startDate: s.date, startTime: s.time, endDate: e.date, endTime: e.time };
  }
  return {
    uid: item.uid,
    summary: item.summary || "(zonder titel)",
    location: item.location || "",
    ...out,
    ...extra,
  };
}

/**
 * Alle voorkomens van events in een ICS-tekst die [rangeStart, rangeEnd) overlappen.
 */
export function expandIcs(icsText, rangeStart, rangeEnd, tz) {
  const vcal = new ICAL.Component(ICAL.parse(icsText));
  registerTimezones(vcal);
  const vevents = vcal.getAllSubcomponents("vevent");
  const byUid = new Map();
  for (const ve of vevents) {
    const uid = ve.getFirstPropertyValue("uid") || crypto.randomUUID();
    if (!byUid.has(uid)) byUid.set(uid, { master: null, exceptions: [] });
    const g = byUid.get(uid);
    if (ve.hasProperty("recurrence-id")) g.exceptions.push(ve); else g.master = ve;
  }

  const out = [];
  const overlaps = (s, e) => {
    const si = toInstant(s, tz);
    let ei = e ? toInstant(e, tz) : si;
    if (s.isDate && (!e || ei <= si)) ei = new Date(si.getTime() + 86400000);
    return si < rangeEnd && (ei > rangeStart || (+ei === +si && si >= rangeStart));
  };

  for (const { master, exceptions } of byUid.values()) {
    if (!master) {
      // losse uitzonderingen zonder master in dit bestand
      for (const ex of exceptions) {
        const ev = new ICAL.Event(ex);
        if (overlaps(ev.startDate, ev.endDate)) {
          out.push(occurrence(ev, ev.startDate, ev.endDate, tz,
            { recurring: true, recurrenceId: ev.recurrenceId?.toString() || "" }));
        }
      }
      continue;
    }
    const event = new ICAL.Event(master);
    for (const ex of exceptions) {
      try { event.relateException(ex); } catch { /* negeren */ }
    }
    if (!event.isRecurring()) {
      if (overlaps(event.startDate, event.endDate)) {
        out.push(occurrence(event, event.startDate, event.endDate, tz, { recurring: false, recurrenceId: "" }));
      }
      continue;
    }
    const it = event.iterator();
    let next, n = 0;
    while ((next = it.next()) && n++ < MAX_ITER) {
      const det = event.getOccurrenceDetails(next);
      const sInst = toInstant(det.startDate, tz);
      if (sInst >= rangeEnd) break;
      if (!overlaps(det.startDate, det.endDate)) continue;
      out.push(occurrence(det.item, det.startDate, det.endDate, tz,
        { recurring: true, recurrenceId: next.toString() }));
    }
  }
  return out;
}

/** Is het event in deze ICS herhalend (of een uitzondering)? */
export function isRecurringIcs(icsText) {
  const vcal = new ICAL.Component(ICAL.parse(icsText));
  const ves = vcal.getAllSubcomponents("vevent");
  return ves.length !== 1 || ves.some((v) => v.hasProperty("rrule") || v.hasProperty("rdate") || v.hasProperty("recurrence-id"));
}

/* ───────────── schrijven ───────────── */

export const VTIMEZONE_BRUSSELS = [
  "BEGIN:VTIMEZONE",
  "TZID:Europe/Brussels",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:+0100",
  "TZOFFSETTO:+0200",
  "TZNAME:CEST",
  "DTSTART:19700329T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:+0200",
  "TZOFFSETTO:+0100",
  "TZNAME:CET",
  "DTSTART:19701025T030000",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
].join("\r\n");

const escText = (s) => String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

function fold(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out = [];
  let cur = "";
  for (const ch of line) {
    if (enc.encode(cur + ch).length > (out.length ? 74 : 75)) { out.push(cur); cur = ""; }
    cur += ch;
  }
  out.push(cur);
  return out.join("\r\n ");
}

const compact = (dateStr) => dateStr.replace(/-/g, "");
const compactTime = (t) => t.replace(":", "") + "00";

/**
 * Nieuwe ICS voor één afspraak.
 * ev = { uid, summary, location?, allDay, date, endDate?, start, end }  (date = YYYY-MM-DD, start/end = HH:MM)
 */
export function buildIcs(ev, tz) {
  const now = icsUtc(new Date());
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Gezinsplanner//Cloudflare Worker//NL", "CALSCALE:GREGORIAN"];
  const useTz = tz === "Europe/Brussels";
  if (!ev.allDay && useTz) lines.push(VTIMEZONE_BRUSSELS);
  lines.push("BEGIN:VEVENT", `UID:${ev.uid}`, `DTSTAMP:${now}`, `CREATED:${now}`, `LAST-MODIFIED:${now}`,
    `SUMMARY:${escText(ev.summary)}`);
  if (ev.location) lines.push(`LOCATION:${escText(ev.location)}`);
  lines.push(...dtLines(ev, tz));
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

function dtLines(ev, tz) {
  if (ev.allDay) {
    return [`DTSTART;VALUE=DATE:${compact(ev.date)}`, `DTEND;VALUE=DATE:${compact(ev.endDate)}`];
  }
  if (tz === "Europe/Brussels") {
    return [`DTSTART;TZID=Europe/Brussels:${compact(ev.date)}T${compactTime(ev.start)}`,
      `DTEND;TZID=Europe/Brussels:${compact(ev.endDate || ev.date)}T${compactTime(ev.end)}`];
  }
  const [sy, sm, sd] = ev.date.split("-").map(Number);
  const [ey, em, ed] = (ev.endDate || ev.date).split("-").map(Number);
  const [sh, smi] = ev.start.split(":").map(Number);
  const [eh, emi] = ev.end.split(":").map(Number);
  return [`DTSTART:${icsUtc(zonedToUtc(sy, sm, sd, sh, smi, tz))}`, `DTEND:${icsUtc(zonedToUtc(ey, em, ed, eh, emi, tz))}`];
}

/** Bestaande (niet-herhalende) ICS aanpassen: titel en tijden. */
export function updateIcs(icsText, ev, tz) {
  const vcal = new ICAL.Component(ICAL.parse(icsText));
  const ve = vcal.getFirstSubcomponent("vevent");
  if (ev.summary !== undefined) ve.updatePropertyWithValue("summary", ev.summary);
  if (ev.date) {
    for (const name of ["dtstart", "dtend", "duration"]) ve.removeAllProperties(name);
    for (const line of dtLines(ev, tz)) ve.addProperty(ICAL.Property.fromString(line));
    if (!ev.allDay && tz === "Europe/Brussels" &&
      !vcal.getAllSubcomponents("vtimezone").some((v) => v.getFirstPropertyValue("tzid") === "Europe/Brussels")) {
      vcal.addSubcomponent(new ICAL.Component(ICAL.parse(VTIMEZONE_BRUSSELS)));
    }
  }
  const nowT = ICAL.Time.fromJSDate(new Date(), true);
  ve.updatePropertyWithValue("dtstamp", nowT);
  ve.updatePropertyWithValue("last-modified", nowT.clone());
  ve.updatePropertyWithValue("sequence", (Number(ve.getFirstPropertyValue("sequence")) || 0) + 1);
  return vcal.toString().replace(/\r?\n/g, "\r\n") + "\r\n";
}
