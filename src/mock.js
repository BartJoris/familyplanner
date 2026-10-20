// Nep-CalDAV voor lokaal testen (MOCK=1). Zelfde interface als CalDav.
import { buildIcs, buildTodoIcs, VTIMEZONE_BRUSSELS } from "./ics.js";
import { CalDavError } from "./caldav.js";
import { addDaysStr, mondayOf, todayIn } from "./time.js";

const store = new Map(); // url -> { ics, etag }
let seeded = false;
const BASE = "https://mock.local/cal/";

function seed(tz) {
  if (seeded) return;
  seeded = true;
  const mon = mondayOf(todayIn(tz));
  const d = (n) => addDaysStr(mon, n);
  const add = (cal, summary, day, start, end, extra = {}) => {
    const uid = crypto.randomUUID();
    const ev = start
      ? { uid, summary, allDay: false, date: d(day), start, end }
      : { uid, summary, allDay: true, date: d(day), endDate: d(day + (extra.days || 1)) };
    store.set(`${BASE}${cal}/${uid}.ics`, { ics: buildIcs(ev, tz), etag: `"${uid}-1"` });
  };
  add("allen-thuis", "Otis Dokter Hus", 0, "09:30", "10:00");
  add("allen-thuis", "Janne ponyrijden", 0, "16:30", "17:30");
  add("allen-thuis", "Janne zwemles school", 1);
  add("allen-thuis", "Verjaardag Lily (Janne)", 2);
  add("allen-thuis", "Janne Podiumkriebels", 2, "14:00", "16:00");
  add("allen-thuis", "Janne ponyrijden", 3, "16:30", "17:30");
  add("allen-thuis", "Janne turnles school", 3);
  add("allen-thuis", "Janne Tekenacademie", 4, "16:00", "17:00");
  add("allen-thuis", "Janne zwemles Ellen", 4, "17:45", "18:30");
  add("allen-thuis", "Verjaardag Mila - Janne", 6);
  add("bart-en-margot", "Margot Roosje", 2, "09:00", "10:00");
  add("bart-en-margot", "Bart Brussel", 3, null, null, { days: 2 });
  add("bart-en-margot", "Margot Cine", 4, "20:00", "22:00");
  add("bart-en-margot", "Etentje bij oma", 6, "12:00", "15:00");
  add("winkel", "Winkel open", 5, "10:00", "18:00");

  const addTodo = (list, title, completed = false) => {
    const uid = crypto.randomUUID();
    store.set(`${BASE}${list}/${uid}.ics`, { ics: buildTodoIcs({ uid, title, completed }), etag: `"${uid}-1"` });
  };
  addTodo("boodschappen", "Brood");
  addTodo("niet-vergeten", "Pakket ophalen");

  // herhalend: scouts elke zaterdag 14u–17u, met één uitzondering (vorige week verplaatst)
  const uid = "scouts-janne-weekly";
  const ics = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Mock//NL", VTIMEZONE_BRUSSELS,
    "BEGIN:VEVENT", `UID:${uid}`, "DTSTAMP:20250901T000000Z",
    "DTSTART;TZID=Europe/Brussels:20250906T140000", "DTEND;TZID=Europe/Brussels:20250906T170000",
    "RRULE:FREQ=WEEKLY;BYDAY=SA", "SUMMARY:Janne Scouts", "END:VEVENT",
    "BEGIN:VEVENT", `UID:${uid}`, "DTSTAMP:20250901T000000Z",
    `RECURRENCE-ID;TZID=Europe/Brussels:${d(-2).replace(/-/g, "")}T140000`,
    `DTSTART;TZID=Europe/Brussels:${d(-2).replace(/-/g, "")}T100000`,
    `DTEND;TZID=Europe/Brussels:${d(-2).replace(/-/g, "")}T120000`,
    "SUMMARY:Janne Scouts (vroeger!)", "END:VEVENT",
    "END:VCALENDAR", "",
  ].join("\r\n");
  store.set(`${BASE}allen-thuis/${uid}.ics`, { ics, etag: '"scouts-1"' });

  // UTC-event om tijdzoneconversie te testen: 18:00Z = 20u Brussel (zomertijd) / 19u (wintertijd)
  const uid2 = crypto.randomUUID();
  store.set(`${BASE}bart-en-margot/${uid2}.ics`, {
    ics: ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", `UID:${uid2}`, "DTSTAMP:20250901T000000Z",
      `DTSTART:${d(1).replace(/-/g, "")}T180000Z`, `DTEND:${d(1).replace(/-/g, "")}T190000Z`,
      "SUMMARY:Ouderavond school", "END:VEVENT", "END:VCALENDAR", ""].join("\r\n"),
    etag: '"utc-1"',
  });
}

export class MockCalDav {
  constructor(tz) { this.tz = tz; seed(tz); }
  async discover() {
    return [
      { name: "Bart en Margot", url: `${BASE}bart-en-margot/`, color: "#ff2968", writable: true, vevent: true, vtodo: false },
      { name: "Allen thuis", url: `${BASE}allen-thuis/`, color: "#63da38", writable: true, vevent: true, vtodo: false },
      { name: "Winkel", url: `${BASE}winkel/`, color: "#1badf8", writable: true, vevent: true, vtodo: false },
      { name: "Boodschappen", url: `${BASE}boodschappen/`, color: "#e8a817", writable: true, vevent: false, vtodo: true },
      { name: "Niet vergeten", url: `${BASE}niet-vergeten/`, color: "#5b7c99", writable: true, vevent: false, vtodo: true },
    ];
  }
  async events(calUrl) {
    return [...store.entries()].filter(([u]) => u.startsWith(calUrl)).map(([href, v]) => ({ href, ...v }));
  }
  async todos(listUrl) {
    return [...store.entries()].filter(([u]) => u.startsWith(listUrl)).map(([href, v]) => ({ href, ...v }));
  }
  async get(url) {
    const v = store.get(url);
    if (!v) throw new CalDavError("Item niet meer gevonden", 404);
    return { ...v };
  }
  async put(url, ics, { etag, create } = {}) {
    const cur = store.get(url);
    if (create && cur) throw new CalDavError("bestaat al", 409);
    if (!create && etag && cur && cur.etag !== etag) throw new CalDavError("Werd intussen elders gewijzigd. Herlaad en probeer opnieuw.", 409);
    const newTag = `"${crypto.randomUUID()}"`;
    store.set(url, { ics, etag: newTag });
    return newTag;
  }
  async remove(url, etag) {
    const cur = store.get(url);
    if (cur && etag && cur.etag !== etag) throw new CalDavError("Werd intussen elders gewijzigd. Herlaad en probeer opnieuw.", 409);
    store.delete(url);
  }
}
