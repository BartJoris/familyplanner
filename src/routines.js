// Ochtend- en avondroutines voor de kinderen: configuratie, opslag (JSON-bestand) en statistiek.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { addDaysStr, mondayOf } from "./time.js";

export const DEFAULT_ROUTINES = {
  switch_at: "13:00", // voor dit uur = ochtend, erna = avond
  children: [
    {
      name: "Janne", theme: "horse", color: "#e8618c", light: "#ffe3ec",
      avatar: "🐴", runner: "🐎", goal: "🥕", reward: "🌹",
      cheer: ["Hop hop galop!", "Wat een kampioen!", "Je paardje is fier op jou!"],
      steps: {
        evening: [
          { id: "huiswerk", label: "Huiswerk", icon: "📚" },
          { id: "omkleden", label: "Omkleden", icon: "👕" },
          { id: "avondeten", label: "Avondeten", icon: "🍝" },
          { id: "tanden", label: "Tanden poetsen", icon: "🪥" },
        ],
      },
    },
    {
      name: "Otis", theme: "car", color: "#2f9e57", light: "#e2f6e8",
      avatar: "🚗", runner: "🏎️", goal: "🏁", reward: "🏆",
      cheer: ["Vroem vroem, gewonnen!", "Wat een racer!", "Volle gas, Otis!"],
    },
  ],
  routines: {
    morning: {
      label: "Ochtend", icon: "☀️",
      steps: [
        { id: "omkleden", label: "Omkleden", icon: "👕" },
        { id: "ontbijten", label: "Ontbijten", icon: "🥣" },
        { id: "schoenen", label: "Schoenen", icon: "👟" },
      ],
    },
    evening: {
      label: "Avond", icon: "🌙",
      steps: [
        { id: "omkleden", label: "Omkleden", icon: "👕" },
        { id: "avondeten", label: "Avondeten", icon: "🍝" },
        { id: "tanden", label: "Tanden poetsen", icon: "🪥" },
      ],
    },
  },
};

export function routinesConfig(cfg) {
  const r = cfg && cfg.routines ? cfg.routines : {};
  return {
    ...DEFAULT_ROUTINES,
    ...r,
    children: r.children || DEFAULT_ROUTINES.children,
    routines: { ...DEFAULT_ROUTINES.routines, ...(r.routines || {}) },
  };
}

/** Stappen voor één kind: optionele override op het kind, anders de gedeelde routine. */
export function stepsFor(rcfg, child, routine) {
  const ch = typeof child === "string" ? rcfg.children.find((c) => c.name === child) : child;
  const own = ch?.steps?.[routine];
  if (Array.isArray(own) && own.length) return own;
  return rcfg.routines[routine]?.steps || [];
}

/* ── opslag ── */

export class RoutineStore {
  constructor(dir) {
    this.file = dir ? path.join(dir, "routines.json") : null;
    this.data = {};
    if (this.file && existsSync(this.file)) {
      try { this.data = JSON.parse(readFileSync(this.file, "utf8")); } catch (e) { console.error("routines.json onleesbaar, start leeg", e.message); }
    }
  }

  save() {
    if (!this.file) return;
    // oude dagen (> 120 dagen) opruimen
    const keys = Object.keys(this.data).sort();
    while (keys.length > 120) delete this.data[keys.shift()];
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    renameSync(tmp, this.file);
  }

  day(date) { return this.data[date] || {}; }

  /** Zet een stap aan/uit. Geeft { completedNow } terug als de routine net volledig werd. */
  toggle(date, child, routine, step, done, rcfg) {
    const steps = stepsFor(rcfg, child, routine);
    if (!steps.some((s) => s.id === step)) throw new Error("Onbekende stap");
    if (!rcfg.children.some((c) => c.name === child)) throw new Error("Onbekend kind");
    const wasComplete = this.isComplete(date, child, routine, rcfg);
    const d = (this.data[date] ||= {});
    const c = (d[child] ||= {});
    const r = (c[routine] ||= {});
    if (done) r[step] = new Date().toISOString(); else delete r[step];
    this.save();
    const isComplete = this.isComplete(date, child, routine, rcfg);
    return { completedNow: isComplete && !wasComplete };
  }

  /** Wis alle stappen van één kind voor één routine (ochtend of avond) op die dag. */
  reset(date, child, routine, rcfg) {
    if (!rcfg.routines[routine]) throw new Error("Onbekende routine");
    if (!rcfg.children.some((c) => c.name === child)) throw new Error("Onbekend kind");
    const d = this.data[date];
    if (d?.[child]?.[routine]) {
      delete d[child][routine];
      if (Object.keys(d[child]).length === 0) delete d[child];
      if (Object.keys(d).length === 0) delete this.data[date];
      this.save();
    }
    return { reset: true };
  }

  isComplete(date, child, routine, rcfg) {
    const steps = stepsFor(rcfg, child, routine);
    const r = this.day(date)?.[child]?.[routine] || {};
    return steps.length > 0 && steps.every((s) => r[s.id]);
  }

  /** Per kind per dag van de week: welke routines volledig waren. */
  week(date, rcfg) {
    const mon = mondayOf(date);
    const out = {};
    for (const ch of rcfg.children) {
      out[ch.name] = [];
      for (let i = 0; i < 7; i++) {
        const d = addDaysStr(mon, i);
        const row = { date: d };
        for (const key of Object.keys(rcfg.routines)) row[key] = this.isComplete(d, ch.name, key, rcfg);
        out[ch.name].push(row);
      }
    }
    return out;
  }
}
