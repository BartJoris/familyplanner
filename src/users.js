// Gebruikers (Margot/Bart) met PIN, naast de huishoud-AUTH_KEY.
import { scrypt as scryptCb, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb);
const PIN_RE = /^\d{4,8}$/;
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const DEFAULT_EMOJI = { bart: "☕", margot: "🌼" };

let cached = null;

function stripQuotes(raw) {
  const s = String(raw || "").trim();
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) return s.slice(1, -1);
  return s;
}

async function hashPin(pin, salt = randomBytes(16)) {
  const buf = await scrypt(String(pin), salt, 32, SCRYPT_OPTS);
  return `scrypt:${salt.toString("hex")}:${buf.toString("hex")}`;
}

async function verifyPin(pin, stored) {
  if (!stored || !String(stored).startsWith("scrypt:")) return false;
  const parts = String(stored).split(":");
  if (parts.length !== 3) return false;
  const salt = Buffer.from(parts[1], "hex");
  const expected = Buffer.from(parts[2], "hex");
  if (!salt.length || expected.length !== 32) return false;
  const buf = await scrypt(String(pin), salt, 32, SCRYPT_OPTS);
  return timingSafeEqual(buf, expected);
}

/** [{ name, emoji, hash }] uit env.USERS JSON. */
export async function loadUsers(env) {
  if (cached) return cached;
  const raw = stripQuotes(env.USERS || "");
  if (!raw) {
    cached = [];
    return cached;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error("USERS is geen geldige JSON:", e.message);
    cached = [];
    return cached;
  }
  if (!Array.isArray(parsed)) {
    console.error("USERS moet een lijst van gebruikers zijn.");
    cached = [];
    return cached;
  }
  const out = [];
  for (const u of parsed) {
    const name = String(u?.name || "").trim();
    if (!name) continue;
    const pin = u.pin == null ? "" : String(u.pin);
    let hash = u.pin_hash ? String(u.pin_hash) : "";
    if (!hash && pin.startsWith("scrypt:")) hash = pin;
    if (!hash && PIN_RE.test(pin)) hash = await hashPin(pin);
    if (!hash) {
      console.warn(`Gebruiker ${name}: PIN ontbreekt of is ongeldig (4–8 cijfers).`);
      continue;
    }
    const emoji = u.emoji || DEFAULT_EMOJI[name.toLowerCase()] || "👤";
    out.push({ name, emoji, hash });
  }
  cached = out;
  return cached;
}

export function publicUsers(users) {
  return users.map((u) => ({ name: u.name, emoji: u.emoji }));
}

export async function verifyUserPin(env, name, pin) {
  const users = await loadUsers(env);
  const n = String(name || "").trim().toLowerCase();
  const u = users.find((x) => x.name.toLowerCase() === n);
  if (!u || !PIN_RE.test(String(pin || ""))) return null;
  if (!(await verifyPin(pin, u.hash))) return null;
  return u;
}
