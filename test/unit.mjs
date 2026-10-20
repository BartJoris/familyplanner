// Snelle tests voor ICS-expansie en tijdzones: node test/unit.mjs
import assert from "node:assert/strict";
import { expandIcs, buildIcs, updateIcs, isRecurringIcs, VTIMEZONE_BRUSSELS } from "../src/ics.js";
import { zonedToUtc, utcToZoned, mondayOf } from "../src/time.js";

const TZ = "Europe/Brussels";
const range = (a, b) => [zonedToUtc(...a, 0, 0, TZ), zonedToUtc(...b, 0, 0, TZ)];
let n = 0;
const t = (name, fn) => { fn(); n++; console.log("✓", name); };

t("tijdzone zomer/winter", () => {
  assert.equal(zonedToUtc(2026, 7, 1, 14, 0, TZ).toISOString(), "2026-07-01T12:00:00.000Z");
  assert.equal(zonedToUtc(2026, 12, 1, 14, 0, TZ).toISOString(), "2026-12-01T13:00:00.000Z");
  assert.equal(utcToZoned(new Date("2026-10-25T01:30:00Z"), TZ).time, "02:30"); // na terugzetten klok
  assert.equal(mondayOf("2026-10-25"), "2026-10-19");
  assert.equal(mondayOf("2026-10-19"), "2026-10-19");
});

const weekly = [
  "BEGIN:VCALENDAR", "VERSION:2.0", VTIMEZONE_BRUSSELS,
  "BEGIN:VEVENT", "UID:w1", "DTSTAMP:20250101T000000Z",
  "DTSTART;TZID=Europe/Brussels:20250906T140000", "DTEND;TZID=Europe/Brussels:20250906T170000",
  "RRULE:FREQ=WEEKLY;BYDAY=SA", "EXDATE;TZID=Europe/Brussels:20261031T140000",
  "SUMMARY:Janne Scouts", "END:VEVENT",
  "BEGIN:VEVENT", "UID:w1", "DTSTAMP:20250101T000000Z",
  "RECURRENCE-ID;TZID=Europe/Brussels:20261024T140000",
  "DTSTART;TZID=Europe/Brussels:20261024T100000", "DTEND;TZID=Europe/Brussels:20261024T120000",
  "SUMMARY:Janne Scouts (vroeger)", "END:VEVENT",
  "END:VCALENDAR", "",
].join("\r\n");

t("herhaling + uitzondering (RECURRENCE-ID)", () => {
  const occ = expandIcs(weekly, ...range([2026, 10, 19], [2026, 10, 26]), TZ);
  assert.equal(occ.length, 1);
  assert.equal(occ[0].startDate, "2026-10-24");
  assert.equal(occ[0].startTime, "10:00");
  assert.equal(occ[0].summary, "Janne Scouts (vroeger)");
  assert.equal(occ[0].recurring, true);
});

t("herhaling + EXDATE + wintertijd", () => {
  const occ = expandIcs(weekly, ...range([2026, 10, 26], [2026, 11, 9]), TZ);
  assert.deepEqual(occ.map((o) => o.startDate + " " + o.startTime), ["2026-11-07 14:00"]); // 31/10 uitgesloten
});

t("UTC-event wordt Brusselse tijd", () => {
  const ics = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:u\r\nDTSTART:20261020T180000Z\r\nDTEND:20261020T190000Z\r\nSUMMARY:x\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
  const [o] = expandIcs(ics, ...range([2026, 10, 19], [2026, 10, 26]), TZ);
  assert.equal(o.startTime, "20:00");
  assert.equal(o.endTime, "21:00");
});

t("TZID zonder VTIMEZONE = muurklok Brussel", () => {
  const ics = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:z\r\nDTSTART;TZID=W. Europe Standard Time:20261021T090000\r\nDTEND;TZID=W. Europe Standard Time:20261021T100000\r\nSUMMARY:x\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
  const [o] = expandIcs(ics, ...range([2026, 10, 19], [2026, 10, 26]), TZ);
  assert.equal(o.startTime, "09:00");
});

t("meerdaagse hele-dag-afspraak", () => {
  const ics = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART;VALUE=DATE:20261017\r\nDTEND;VALUE=DATE:20261021\r\nSUMMARY:Bart Brussel\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
  const occ = expandIcs(ics, ...range([2026, 10, 19], [2026, 10, 26]), TZ);
  assert.equal(occ.length, 1);
  assert.equal(occ[0].allDay, true);
  assert.equal(occ[0].endDate, "2026-10-21");
  const none = expandIcs(ics, ...range([2026, 10, 21], [2026, 10, 22]), TZ);
  assert.equal(none.length, 0); // einddatum is exclusief
});

t("buildIcs → expand terug + updateIcs", () => {
  const ics = buildIcs({ uid: "n1", summary: "Janne zwemles, met; komma", allDay: false, date: "2026-10-22", endDate: "2026-10-22", start: "17:45", end: "18:30" }, TZ);
  const [o] = expandIcs(ics, ...range([2026, 10, 19], [2026, 10, 26]), TZ);
  assert.equal(o.summary, "Janne zwemles, met; komma");
  assert.equal(o.startTime, "17:45");
  assert.equal(isRecurringIcs(ics), false);
  const upd = updateIcs(ics, { summary: "Janne zwemles", allDay: true, date: "2026-10-23", endDate: "2026-10-24" }, TZ);
  const [o2] = expandIcs(upd, ...range([2026, 10, 19], [2026, 10, 26]), TZ);
  assert.equal(o2.allDay, true);
  assert.equal(o2.startDate, "2026-10-23");
  assert.match(upd, /SEQUENCE:1/);
  const upd2 = updateIcs(upd, { summary: "Janne zwemles", allDay: false, date: "2026-10-23", endDate: "2026-10-23", start: "09:00", end: "10:00" }, TZ);
  const [o3] = expandIcs(upd2, ...range([2026, 10, 19], [2026, 10, 26]), TZ);
  assert.equal(o3.startTime, "09:00");
  assert.equal(isRecurringIcs(weekly), true);
});

console.log(`\n${n} tests geslaagd`);
