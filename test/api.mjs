// Integratietest: start de server met nepdata en test de API.  node test/api.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const PORT = 3999;
const KEY = "test-sleutel-1234567890";
const B = `http://127.0.0.1:${PORT}`;
const srv = spawn(process.execPath, ["src/server.js"], {
  env: { ...process.env, PORT: String(PORT), MOCK: "1", AUTH_KEY: KEY, LOG_REQUESTS: "0", CONFIG_FILE: "/nonexistent" },
  stdio: ["ignore", "inherit", "inherit"],
});
const stop = () => srv.kill("SIGTERM");
process.on("exit", stop);

for (let i = 0; i < 50; i++) {
  try { if ((await fetch(`${B}/healthz`)).ok) break; } catch { /* nog niet klaar */ }
  await new Promise((r) => setTimeout(r, 100));
}

const auth = { Authorization: `Bearer ${KEY}` };
const jsonH = { ...auth, "Content-Type": "application/json" };
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log("✓", name); };

try {
  await t("zonder login → redirect / 401", async () => {
    const r = await fetch(`${B}/`, { redirect: "manual" });
    assert.equal(r.status, 303);
    assert.equal((await fetch(`${B}/api/week`)).status, 401);
    assert.equal((await fetch(`${B}/app.js`)).status, 200); // publiek bestand
  });

  await t("login zet cookie zonder Secure via http", async () => {
    const r = await fetch(`${B}/login`, { method: "POST", body: new URLSearchParams({ key: KEY }), redirect: "manual" });
    assert.equal(r.status, 303);
    const c = r.headers.get("set-cookie");
    assert.match(c, /gp_session=/);
    assert.doesNotMatch(c, /Secure/);
    const cookie = c.split(";")[0];
    assert.equal((await fetch(`${B}/api/week`, { headers: { Cookie: cookie } })).status, 200);
  });

  await t("week bevat afspraken per persoon", async () => {
    const d = await (await fetch(`${B}/api/week`, { headers: auth })).json();
    assert.equal(d.columns.length, 5);
    assert.ok(d.events.some((e) => e.text === "Dokter Hus" && e.cols[0] === 2));
    assert.ok(d.events.some((e) => e.recurring));
  });

  await t("toevoegen met persoonsnaam (zoals Home Assistant)", async () => {
    const today = (await (await fetch(`${B}/api/ha/summary`, { headers: auth })).json()).date;
    const r = await fetch(`${B}/api/events`, { method: "POST", headers: jsonH,
      body: JSON.stringify({ person: "janne", title: "tandarts", date: today, start: "23:10", end: "23:40" }) });
    assert.equal(r.status, 201);
    assert.equal((await r.json()).summary, "Janne tandarts");
    const s = await (await fetch(`${B}/api/ha/summary`, { headers: auth })).json();
    assert.ok(s.today.some((x) => x.person === "Janne" && x.label === "23u10 tandarts"));
    assert.match(s.today_text, /Janne: .*23u10 tandarts/);
  });

  await t("HA-samenvatting heeft vandaag/morgen", async () => {
    const s = await (await fetch(`${B}/api/ha/summary`, { headers: auth })).json();
    for (const k of ["date", "count", "today", "today_text", "tomorrow", "tomorrow_text", "tomorrow_date"]) assert.ok(k in s, k);
  });

  await t("beveiliging: CSRF, vreemde href, ?key", async () => {
    assert.equal((await fetch(`${B}/api/events`, { method: "POST", headers: auth, body: "a=b" })).status, 415);
    const r = await fetch(`${B}/api/events`, { method: "PATCH", headers: jsonH,
      body: JSON.stringify({ href: "https://evil.example/a.ics", title: "x", date: "2026-10-21", allDay: true }) });
    assert.equal(r.status, 400);
    const k = await fetch(`${B}/?key=${KEY}`);
    assert.equal(k.status, 200);
    assert.match(k.headers.get("set-cookie") || "", /gp_session=/);
    assert.equal((await fetch(`${B}/?key=fout`, { redirect: "manual" })).status, 303);
    assert.equal((await fetch(`${B}/..%2f..%2fetc/passwd`, { headers: auth })).status, 404);
  });

  console.log(`\n${n} API-tests geslaagd`);
} finally {
  stop();
}
