// Minimale CalDAV-client (getest tegen het iCloud-gedrag; werkt ook met andere servers).

const DAV_ROOT = "https://caldav.icloud.com/";

const decode = (s) => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, "&");

/** Alle blokken <ns:tag ...>…</ns:tag>, ongeacht namespace-prefix. */
function blocks(xml, tag) {
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, "gi");
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}
const first = (xml, tag) => blocks(xml, tag)[0];
const has = (xml, tag) => new RegExp(`<(?:[\\w-]+:)?${tag}[\\s/>]`, "i").test(xml || "");

export class CalDavError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

export class CalDav {
  constructor(user, password, root = DAV_ROOT) {
    if (!user || !password) throw new CalDavError("ICLOUD_USER / ICLOUD_APP_PASSWORD ontbreken", 500);
    this.auth = "Basic " + btoa(unescape(encodeURIComponent(`${user}:${password}`)));
    this.root = root;
  }

  async req(method, url, { body, depth, headers = {} } = {}) {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: this.auth,
        ...(body ? { "Content-Type": headers["Content-Type"] || "application/xml; charset=utf-8" } : {}),
        ...(depth !== undefined ? { Depth: String(depth) } : {}),
        ...headers,
      },
      body,
    });
    if (res.status === 401) throw new CalDavError("iCloud weigert de login (controleer Apple ID en app-specifiek wachtwoord)", 502);
    return res;
  }

  async propfind(url, props, depth) {
    const body = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/"><d:prop>${props}</d:prop></d:propfind>`;
    const res = await this.req("PROPFIND", url, { body, depth });
    if (res.status !== 207) throw new CalDavError(`PROPFIND ${res.status}`, 502);
    return { xml: await res.text(), base: res.url || url };
  }

  /** Lijst agenda's: [{ name, url, color }] */
  async discover() {
    const p = await this.propfind(this.root, "<d:current-user-principal/>", 0);
    const principalHref = decode(first(first(p.xml, "current-user-principal") || "", "href") || "").trim();
    if (!principalHref) throw new CalDavError("Geen principal gevonden", 502);
    const principal = new URL(principalHref, p.base).toString();

    const h = await this.propfind(principal, "<c:calendar-home-set/>", 0);
    const homeHref = decode(first(first(h.xml, "calendar-home-set") || "", "href") || "").trim();
    if (!homeHref) throw new CalDavError("Geen calendar-home-set gevonden", 502);
    const home = new URL(homeHref, h.base).toString();

    const l = await this.propfind(home,
      "<d:displayname/><d:resourcetype/><c:supported-calendar-component-set/><a:calendar-color/><d:current-user-privilege-set/>", 1);
    const cals = [];
    for (const r of blocks(l.xml, "response")) {
      const okProps = blocks(r, "propstat").filter((ps) => /200/.test(first(ps, "status") || "")).join("");
      const rt = first(okProps, "resourcetype") || "";
      if (!has(rt, "calendar")) continue;
      const comps = first(okProps, "supported-calendar-component-set");
      const vevent = !comps || /VEVENT/i.test(comps);
      const vtodo = !!(comps && /VTODO/i.test(comps));
      if (!vevent && !vtodo) continue;
      const href = decode(first(r, "href") || "").trim();
      const name = decode(first(okProps, "displayname") || "").trim();
      const color = decode(first(okProps, "calendar-color") || "").trim().slice(0, 7);
      const privs = first(okProps, "current-user-privilege-set") || "";
      const writable = !privs || has(privs, "write") || has(privs, "write-content") || has(privs, "all");
      cals.push({ name, url: new URL(href, l.base).toString(), color, writable, vevent, vtodo });
    }
    return cals;
  }

  /** Events in tijdvenster: [{ href, etag, ics }] */
  async events(calUrl, startUtc, endUtc) {
    const f = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const body = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">
    <c:time-range start="${f(startUtc)}" end="${f(endUtc)}"/>
  </c:comp-filter></c:comp-filter></c:filter>
</c:calendar-query>`;
    const res = await this.req("REPORT", calUrl, { body, depth: 1 });
    if (res.status !== 207) throw new CalDavError(`REPORT ${res.status}`, 502);
    const xml = await res.text();
    const base = res.url || calUrl;
    const out = [];
    for (const r of blocks(xml, "response")) {
      const data = first(r, "calendar-data");
      if (!data) continue;
      out.push({
        href: new URL(decode(first(r, "href") || "").trim(), base).toString(),
        etag: decode(first(r, "getetag") || "").trim(),
        ics: decode(data),
      });
    }
    return out;
  }

  /** Herinneringen in een VTODO-lijst: [{ href, etag, ics }] */
  async todos(listUrl) {
    const body = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VTODO"/></c:comp-filter></c:filter>
</c:calendar-query>`;
    const res = await this.req("REPORT", listUrl, { body, depth: 1 });
    if (res.status !== 207) throw new CalDavError(`REPORT ${res.status}`, 502);
    const xml = await res.text();
    const base = res.url || listUrl;
    const out = [];
    for (const r of blocks(xml, "response")) {
      const data = first(r, "calendar-data");
      if (!data) continue;
      out.push({
        href: new URL(decode(first(r, "href") || "").trim(), base).toString(),
        etag: decode(first(r, "getetag") || "").trim(),
        ics: decode(data),
      });
    }
    return out;
  }

  async get(url) {
    const res = await this.req("GET", url);
    if (res.status === 404) throw new CalDavError("Item niet meer gevonden", 404);
    if (!res.ok) throw new CalDavError(`GET ${res.status}`, 502);
    return { ics: await res.text(), etag: res.headers.get("ETag") || "" };
  }

  async put(url, ics, { etag, create } = {}) {
    const headers = { "Content-Type": "text/calendar; charset=utf-8" };
    if (create) headers["If-None-Match"] = "*";
    else if (etag) headers["If-Match"] = etag;
    const res = await this.req("PUT", url, { body: ics, headers });
    if (res.status === 412) throw new CalDavError("Werd intussen elders gewijzigd. Herlaad en probeer opnieuw.", 409);
    if (!res.ok) throw new CalDavError(`Opslaan mislukt (${res.status})`, 502);
    return res.headers.get("ETag") || "";
  }

  async remove(url, etag) {
    const res = await this.req("DELETE", url, { headers: etag ? { "If-Match": etag } : {} });
    if (res.status === 412) throw new CalDavError("Werd intussen elders gewijzigd. Herlaad en probeer opnieuw.", 409);
    if (!res.ok && res.status !== 404) throw new CalDavError(`Verwijderen mislukt (${res.status})`, 502);
  }
}
