// Node HTTP-server rond de fetch-handler in app.js (geen frameworks nodig).
import dns from "node:dns";
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import handler from "./app.js";

// Homelab: IPv6 naar iCloud CalDAV faalt vaak (ETIMEDOUT); forceer IPv4.
dns.setDefaultResultOrder("ipv4first");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");
const PORT = Number(process.env.PORT || 3000);
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

/* ── configuratie: CONFIG (JSON-string) of CONFIG_FILE (pad naar JSON) ── */
function loadConfig() {
  if (process.env.CONFIG) return process.env.CONFIG;
  const file = process.env.CONFIG_FILE || "/config/config.json";
  if (existsSync(file)) return readFileSync(file, "utf8");
  return undefined; // ingebouwde standaard in app.js
}

const env = { ...process.env, CONFIG: loadConfig() };
try {
  if (env.CONFIG) JSON.parse(env.CONFIG);
} catch (e) {
  console.error("Ongeldige configuratie (JSON):", e.message);
  process.exit(1);
}
if (!env.AUTH_KEY || env.AUTH_KEY.length < 16) {
  console.error("AUTH_KEY ontbreekt of is korter dan 16 tekens.");
  process.exit(1);
}
if (env.MOCK !== "1" && (!env.ICLOUD_USER || !env.ICLOUD_APP_PASSWORD)) {
  console.error("ICLOUD_USER en ICLOUD_APP_PASSWORD zijn vereist (of zet MOCK=1 om te testen).");
  process.exit(1);
}

/* ── statische bestanden (zelfde rol als env.ASSETS op Cloudflare) ── */
env.ASSETS = {
  async fetch(req) {
    let p = decodeURIComponent(new URL(req.url).pathname);
    if (p.endsWith("/")) p += "index.html";
    const file = path.normalize(path.join(PUBLIC, p));
    if (!file.startsWith(PUBLIC + path.sep)) return new Response("Niet gevonden", { status: 404 });
    try {
      const st = await stat(file);
      if (!st.isFile()) throw new Error("geen bestand");
      const body = await readFile(file);
      return new Response(body, {
        headers: {
          "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
          "Cache-Control": "no-cache",
          "Last-Modified": st.mtime.toUTCString(),
        },
      });
    } catch {
      return new Response("Niet gevonden", { status: 404 });
    }
  },
};

/* ── Node req/res ↔ Web Request/Response ── */
async function toRequest(req) {
  const proto = process.env.TRUST_PROXY === "1" && req.headers["x-forwarded-proto"]
    ? String(req.headers["x-forwarded-proto"]).split(",")[0].trim() : "http";
  const host = req.headers.host || `localhost:${PORT}`;
  const url = `${proto}://${host}${req.url}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x)); else if (v !== undefined) headers.set(k, v);
  }
  let body;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 1024 * 1024) throw Object.assign(new Error("Te groot"), { status: 413 });
      chunks.push(c);
    }
    body = Buffer.concat(chunks);
  }
  return new Request(url, { method: req.method, headers, body });
}

async function send(res, response, method) {
  const headers = {};
  response.headers.forEach((v, k) => { if (k !== "set-cookie") headers[k] = v; });
  const cookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
  if (cookies.length) headers["set-cookie"] = cookies;
  res.writeHead(response.status, headers);
  if (method === "HEAD" || !response.body) return res.end();
  res.end(Buffer.from(await response.arrayBuffer()));
}

const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  try {
    const request = await toRequest(req);
    const response = await handler.fetch(request, env);
    await send(res, response, req.method);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(err.status || 500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(err.status === 413 ? "Te groot" : "Interne fout");
  } finally {
    if (process.env.LOG_REQUESTS !== "0" && req.url !== "/healthz") {
      console.log(`${req.method} ${req.url.replace(/key=[^&]+/, "key=***")} ${res.statusCode} ${Date.now() - t0}ms`);
    }
  }
});

server.listen(PORT, () => {
  console.log(`Gezinsplanner luistert op poort ${PORT}${env.MOCK === "1" ? " (MOCK-data)" : ""}`);
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); });
}
