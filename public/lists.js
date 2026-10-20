/* Boodschappen- en todo-lijst (bewust zonder framework en zonder ?. / ??). */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };

  var key = null;
  try {
    var qs = new URLSearchParams(location.search);
    if (qs.get("key")) {
      key = qs.get("key");
      try { sessionStorage.setItem("gp_key", key); } catch (e) { /* ok */ }
      qs.delete("key");
      history.replaceState(null, "", location.pathname + (qs.toString() ? "?" + qs : ""));
    } else {
      try { key = sessionStorage.getItem("gp_key"); } catch (e) { /* ok */ }
    }
  } catch (e) { /* oude browser */ }

  function api(method, path, body) {
    var headers = {};
    if (key) headers.Authorization = "Bearer " + key;
    if (body) headers["Content-Type"] = "application/json";
    return fetch(path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined, credentials: "same-origin" })
      .then(function (r) {
        if (r.status === 401) { location.href = "/login"; throw new Error("Niet ingelogd"); }
        return r.json().then(function (j) {
          if (!r.ok) throw new Error(j.error || ("Fout " + r.status));
          return j;
        });
      });
  }

  function listId() {
    var p = location.pathname.replace(/\/+$/, "").split("/");
    var last = p[p.length - 1];
    return last === "todo" ? "todo" : "shopping";
  }

  var state = { id: listId(), data: null, loading: false };

  function setStatus(t) { $("status").textContent = t; }
  function fail(msg) {
    $("err").textContent = msg;
    $("err").classList.remove("hidden");
  }
  function clearFail() { $("err").classList.add("hidden"); }

  function render() {
    var d = state.data;
    if (!d) return;
    document.title = d.label;
    $("nav-shopping").classList.toggle("on", state.id === "shopping");
    $("nav-todo").classList.toggle("on", state.id === "todo");
    var extra = d.sync_error ? " · " + d.sync_error : "";
    $("sync").textContent = (d.sync_label || "") + extra;
    $("add-title").placeholder = "Iets op " + d.label.toLowerCase() + "…";

    var open = [];
    var done = [];
    (d.items || []).forEach(function (it) {
      if (it.completed) done.push(it); else open.push(it);
    });
    $("open").innerHTML = open.map(itemHtml).join("") || '<li class="empty">Niets op de lijst.</li>';
    $("done").innerHTML = done.map(itemHtml).join("");
  }

  function itemHtml(it) {
    var by = it.created_by ? '<span class="by">' + esc(it.created_by) + "</span>" : "";
    return '<li class="item' + (it.completed ? " is-done" : "") + '" data-id="' + esc(it.id) + '"' +
      (it.href ? ' data-href="' + esc(it.href) + '"' : "") +
      (it.etag ? ' data-etag="' + esc(it.etag) + '"' : "") + ">" +
      '<button type="button" class="tick" data-act="toggle" aria-label="' + (it.completed ? "Opnieuw openen" : "Afvinken") + '">' +
      (it.completed ? "✓" : "") + "</button>" +
      '<span class="item-title">' + esc(it.title) + by + "</span>" +
      '<button type="button" class="trash" data-act="del" aria-label="Verwijderen">×</button>' +
      "</li>";
  }

  function load() {
    state.loading = true;
    return api("GET", "/api/lists/" + state.id)
      .then(function (d) {
        state.data = d;
        render();
        setStatus("Bijgewerkt " + new Date().toLocaleTimeString("nl-BE", { hour: "2-digit", minute: "2-digit" }));
        clearFail();
      })
      .catch(function (e) { setStatus("⚠ " + e.message); fail(e.message); })
      .then(function () { state.loading = false; });
  }

  function itemFromEl(el) {
    var li = el;
    while (li && li.tagName !== "LI") li = li.parentNode;
    if (!li || !li.dataset) return null;
    return { id: li.dataset.id, href: li.dataset.href || null, etag: li.dataset.etag || null };
  }

  $("add-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var title = $("add-title").value.trim();
    if (!title) return;
    $("add-title").disabled = true;
    api("POST", "/api/lists/" + state.id + "/items", { title: title })
      .then(function () {
        $("add-title").value = "";
        $("add-title").disabled = false;
        $("add-title").focus();
        return load();
      })
      .catch(function (err) {
        $("add-title").disabled = false;
        fail(err.message);
      });
  });

  document.addEventListener("click", function (e) {
    var t = e.target;
    while (t && t !== document.body && !(t.dataset && t.dataset.act)) t = t.parentNode;
    if (!t || !t.dataset || !t.dataset.act) return;
    var it = itemFromEl(t);
    if (!it) return;
    var path = "/api/lists/" + state.id + "/items";
    if (t.dataset.act === "toggle") {
      var done = t.parentNode.classList.contains("is-done");
      api("PATCH", path, { id: it.id, href: it.href, etag: it.etag, completed: !done })
        .then(load)
        .catch(function (err) { fail(err.message); });
    } else if (t.dataset.act === "del") {
      api("DELETE", path, { id: it.id, href: it.href, etag: it.etag })
        .then(load)
        .catch(function (err) { fail(err.message); });
    }
  });

  fetch("/api/me", { credentials: "same-origin", headers: key ? { Authorization: "Bearer " + key } : {} })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (me) {
      var el = $("whoami");
      if (el && me && me.name) el.textContent = me.name;
    })
    .catch(function () { /* ok */ });

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) load();
  });
  setInterval(function () { if (!state.loading) load(); }, 60 * 1000);

  load();
  $("add-title").focus();
})();
