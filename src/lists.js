// Gedeelde boodschappen- en todo-lijsten: lokaal JSON, of iCloud Reminders (CalDAV VTODO).
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { parseTodo } from "./ics.js";

export const DEFAULT_LISTS = {
  shopping: { label: "Boodschappen", reminder_list: "Boodschappen" },
  todo: { label: "Niet vergeten", reminder_list: "Niet vergeten" },
};

export function listsConfig(cfg) {
  const src = cfg && cfg.lists ? cfg.lists : {};
  const out = {};
  for (const id of Object.keys(DEFAULT_LISTS)) {
    const d = DEFAULT_LISTS[id];
    const o = src[id] || {};
    out[id] = {
      id,
      label: o.label || d.label,
      reminder_list: o.reminder_list || d.reminder_list,
    };
  }
  return out;
}

export function isListId(id, lists) {
  return !!lists[id];
}

export function normalizeTitle(title) {
  const t = String(title || "").trim().slice(0, 200);
  return t || null;
}

export class LocalListStore {
  constructor(dir) {
    this.file = dir ? path.join(dir, "lists.json") : null;
    this.data = {};
    if (this.file && existsSync(this.file)) {
      try { this.data = JSON.parse(readFileSync(this.file, "utf8")); } catch (e) {
        console.error("lists.json onleesbaar, start leeg", e.message);
      }
    }
  }

  save() {
    if (!this.file) return;
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    renameSync(tmp, this.file);
  }

  items(listId) {
    return Array.isArray(this.data[listId]) ? this.data[listId] : [];
  }

  add(listId, title, createdBy) {
    const t = normalizeTitle(title);
    if (!t) throw new Error("Geef een titel op.");
    const item = {
      id: crypto.randomUUID(),
      href: null,
      etag: null,
      title: t,
      completed: false,
      created_by: createdBy || "",
      created_at: new Date().toISOString(),
    };
    (this.data[listId] ||= []).push(item);
    this.save();
    return item;
  }

  patch(listId, id, { title, completed } = {}) {
    const items = this.data[listId] || [];
    const it = items.find((x) => x.id === id);
    if (!it) return null;
    if (title !== undefined) {
      const t = normalizeTitle(title);
      if (!t) throw new Error("Geef een titel op.");
      it.title = t;
    }
    if (completed !== undefined) {
      it.completed = !!completed;
      it.completed_at = it.completed ? new Date().toISOString() : null;
    }
    this.save();
    return it;
  }

  remove(listId, id) {
    const items = this.data[listId] || [];
    const i = items.findIndex((x) => x.id === id);
    if (i < 0) return false;
    items.splice(i, 1);
    this.save();
    return true;
  }
}

export function matchReminderList(collections, name) {
  const n = String(name || "").toLowerCase();
  if (!n) return null;
  return (collections || []).find((c) => c.vtodo && String(c.name || "").toLowerCase() === n) || null;
}

export function resolveListBackends(listCfg, collections) {
  const out = {};
  for (const id of Object.keys(listCfg)) {
    const spec = listCfg[id];
    const cal = matchReminderList(collections, spec.reminder_list);
    out[id] = cal
      ? { id, label: spec.label, sync: "reminders", url: cal.url.endsWith("/") ? cal.url : `${cal.url}/`, writable: cal.writable !== false }
      : { id, label: spec.label, sync: "local", url: null, writable: true };
  }
  return out;
}

export function sortItems(items) {
  return items.slice().sort((a, b) => Number(!!a.completed) - Number(!!b.completed)
    || String(a.title || "").localeCompare(String(b.title || ""), "nl"));
}

export function publicItem(it) {
  return {
    id: it.id,
    href: it.href || null,
    etag: it.etag || null,
    title: it.title,
    completed: !!it.completed,
    created_by: it.created_by || "",
  };
}

export function itemsFromTodos(raws) {
  const out = [];
  for (const raw of raws || []) {
    try {
      const t = parseTodo(raw.ics);
      if (!t) continue;
      out.push({
        id: t.uid,
        href: raw.href,
        etag: raw.etag,
        title: t.title,
        completed: t.completed,
        created_by: t.created_by || "",
      });
    } catch (err) {
      console.warn("VTODO kon niet gelezen worden", raw.href, err.message);
    }
  }
  return out;
}
