/* Gezinsplanner — frontend (bewust zonder framework en zonder ?. / ?? voor oudere tablets) */
(function () {
  "use strict";

  var DAY_NAMES = ["MAANDAG", "DINSDAG", "WOENSDAG", "DONDERDAG", "VRIJDAG", "ZATERDAG", "ZONDAG"];
  var MONTHS = ["JANUARI", "FEBRUARI", "MAART", "APRIL", "MEI", "JUNI", "JULI", "AUGUSTUS", "SEPTEMBER", "OKTOBER", "NOVEMBER", "DECEMBER"];
  var REFRESH_MS = 5 * 60 * 1000;

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  var pad = function (n) { return (n < 10 ? "0" : "") + n; };

  function parseD(s) { var p = s.split("-"); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])); }
  function fmtD(d) { return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()); }
  function addDays(s, n) { var d = parseD(s); d.setUTCDate(d.getUTCDate() + n); return fmtD(d); }
  function isoWeek(s) {
    var t = parseD(s); var day = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - day);
    var y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    return Math.ceil(((t - y0) / 86400000 + 1) / 7);
  }
  function fmtTime(t) { var p = t.split(":"); return (+p[0]) + "u" + (p[1] === "00" ? "" : p[1]); }

  /* ── auth: sleutel uit URL (?key=) bewaren voor iframes, en uit de adresbalk halen ── */
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

  /* ── state ── */
  var state = { weekStart: null, today: null, data: null, loading: false };

  function load(weekStart) {
    state.loading = true;
    $("grid").classList.add("loading");
    return api("GET", "/api/week" + (weekStart ? "?start=" + weekStart : ""))
      .then(function (d) {
        state.data = d; state.weekStart = d.weekStart; state.today = d.today;
        render();
        setStatus("Bijgewerkt " + new Date().toLocaleTimeString("nl-BE", { hour: "2-digit", minute: "2-digit" }));
      })
      .catch(function (e) { setStatus("⚠ " + e.message); })
      .then(function () { state.loading = false; $("grid").classList.remove("loading"); });
  }

  function setStatus(t) { $("status").textContent = t; }

  /* ── weekrooster ── */
  function eventDays(ev) {
    var days = [];
    var d = ev.startDate;
    var guard = 0;
    while (guard++ < 60) {
      if (ev.allDay) { if (d >= ev.endDate) break; }
      else {
        if (d > ev.endDate) break;
        if (d === ev.endDate && d !== ev.startDate && ev.endTime === "00:00") break;
      }
      days.push(d);
      d = addDays(d, 1);
    }
    return days;
  }

  function buildGrid() {
    var cols = state.data.columns.length;
    var grid = [];
    for (var i = 0; i < 7; i++) { var row = []; for (var c = 0; c < cols; c++) row.push([]); grid.push(row); }
    state.byId = {};
    state.data.events.forEach(function (ev) {
      state.byId[ev.id] = ev;
      eventDays(ev).forEach(function (day) {
        var idx = Math.round((parseD(day) - parseD(state.weekStart)) / 86400000);
        if (idx < 0 || idx > 6) return;
        var first = day === ev.startDate;
        var item = {
          id: ev.id, text: ev.text, allDay: ev.allDay, recurring: ev.recurring, color: ev.color,
          time: !ev.allDay && first ? fmtTime(ev.startTime) : "",
          sort: ev.allDay || !first ? -1 : (+ev.startTime.slice(0, 2)) * 60 + (+ev.startTime.slice(3)),
        };
        ev.cols.forEach(function (c) { if (grid[idx][c]) grid[idx][c].push(item); });
      });
    });
    grid.forEach(function (r) { r.forEach(function (cell) { cell.sort(function (a, b) { return a.sort - b.sort || (a.text < b.text ? -1 : 1); }); }); });
    return grid;
  }

  function render() {
    var d = state.data;
    var cols = d.columns;
    var grid = buildGrid();
    var g = $("grid");
    g.style.gridTemplateColumns = "minmax(88px, 0.9fr) repeat(" + cols.length + ", minmax(0, 2fr))";

    var html = '<div class="corner" data-act="today"><div class="month">' +
      MONTHS[parseD(addDays(state.weekStart, 3)).getUTCMonth()] + '</div><div class="week">WEEK ' + isoWeek(state.weekStart) + "</div></div>";
    cols.forEach(function (p) {
      html += '<div class="person"><span class="emoji">' +
        esc(p.emoji) + '</span><span class="pname">' + esc(p.name) + "</span></div>";
    });
    for (var r = 0; r < 7; r++) {
      var date = addDays(state.weekStart, r);
      var isToday = date === state.today;
      var cls = (isToday ? " today" : "") + (r === 5 ? " wkstart" : "");
      var dd = parseD(date);
      html += '<div class="day d' + r + cls + '"><div class="dn">' + DAY_NAMES[r] +
        '</div><div class="dd">' + pad(dd.getUTCDate()) + "/" + pad(dd.getUTCMonth() + 1) + "</div></div>";
      for (var c = 0; c < cols.length; c++) {
        html += '<div class="cell' + cls + '" data-date="' + date + '" data-col="' + c + '">';
        grid[r][c].forEach(function (it) {
          html += '<div class="ev' + (it.allDay ? " allday" : "") + '" data-id="' + esc(it.id) + '">' +
            (it.time ? '<span class="t">' + it.time + "</span> " : "") + esc(it.text) +
            (it.recurring ? '<span class="rec">↻</span>' : "") + "</div>";
        });
        html += "</div>";
      }
    }
    g.innerHTML = html;
    var heads = g.querySelectorAll(".person");
    cols.forEach(function (p, i) { if (p.color && heads[i]) heads[i].style.color = p.color; }); // via CSSOM (CSP-veilig)

    $("btn-today").classList.toggle("hidden", state.weekStart === mondayOf(state.today));
    var errs = $("errors");
    errs.classList.toggle("hidden", !d.errors.length);
    errs.textContent = d.errors.join(" · ");
  }

  function mondayOf(s) { var dow = parseD(s).getUTCDay(); return addDays(s, -((dow + 6) % 7)); }

  /* ── interactie rooster ── */
  $("grid").addEventListener("click", function (e) {
    var t = e.target;
    while (t && t !== this && !(t.dataset && (t.dataset.id || t.dataset.col || t.dataset.act))) t = t.parentNode;
    if (!t || t === this) return;
    if (t.dataset.act === "today") { load(mondayOf(state.today)); return; }
    if (t.dataset.id) { openEdit(state.byId[t.dataset.id]); return; }
    if (t.dataset.col) openNew(+t.dataset.col, t.dataset.date);
  });
  $("btn-prev").onclick = function () { load(addDays(state.weekStart, -7)); };
  $("btn-next").onclick = function () { load(addDays(state.weekStart, 7)); };
  $("btn-today").onclick = function () { load(mondayOf(state.today)); };
  $("btn-add").onclick = function () {
    var inWeek = state.today >= state.weekStart && state.today < addDays(state.weekStart, 7);
    openNew(state.data.columns.length - 1, inWeek ? state.today : state.weekStart);
  };

  /* ── dialoog ── */
  var form = { mode: "new", col: 0, ev: null, deleteArmed: false };

  function nextHour() {
    var n = new Date(); var h = Math.min(n.getHours() + 1, 22);
    return pad(h) + ":00";
  }
  function plusHour(t) { var p = t.split(":"); var h = Math.min(+p[0] + 1, 23); return pad(h) + ":" + p[1]; }

  function renderPeople() {
    var html = "";
    state.data.columns.forEach(function (p, i) {
      html += '<button type="button" data-col="' + i + '" class="' + (i === form.col ? "sel" : "") + '">' + esc(p.emoji) + " " + esc(p.name) + "</button>";
    });
    $("f-people").innerHTML = html;
  }
  $("f-people").addEventListener("click", function (e) {
    var b = e.target.closest ? e.target.closest("button") : e.target;
    if (!b || b.dataset.col === undefined) return;
    form.col = +b.dataset.col;
    renderPeople();
    if (form.mode === "new") setDefaultCalendar();
  });

  function setDefaultCalendar() {
    var def = state.data.columns[form.col] && state.data.columns[form.col].default_calendar;
    var sel = $("f-cal");
    if (def && state.data.calendars.indexOf(def) >= 0) sel.value = def;
  }

  function fillCalendars(selected, includeReadOnly) {
    var list = state.data.calendars.slice();
    if (includeReadOnly && selected && list.indexOf(selected) < 0) list.push(selected);
    $("f-cal").innerHTML = list.map(function (c) { return "<option>" + esc(c) + "</option>"; }).join("");
    if (selected) $("f-cal").value = selected;
  }

  function toggleAllDay() {
    var ad = $("f-allday").checked;
    $("times").classList.toggle("hidden", ad);
    $("enddate-row").classList.toggle("hidden", !ad);
  }
  $("f-allday").onchange = toggleAllDay;
  $("f-start").onchange = function () {
    if (form.mode === "new" || $("f-end").value <= $("f-start").value) $("f-end").value = plusHour($("f-start").value);
  };

  function showDialog() {
    $("f-err").classList.add("hidden");
    form.deleteArmed = false;
    $("f-delete").classList.remove("confirm");
    $("f-delete").textContent = "Verwijderen";
    $("dlg").classList.remove("hidden");
  }
  function closeDialog() { $("dlg").classList.add("hidden"); }

  function openNew(col, date) {
    form = { mode: "new", col: col, ev: null };
    $("dlg-title").textContent = "Nieuwe afspraak";
    $("form").classList.remove("readonly");
    $("ro-note").classList.add("hidden");
    renderPeople();
    fillCalendars(null);
    $("f-cal").disabled = false;
    setDefaultCalendar();
    $("f-title").readOnly = false;
    $("f-title").value = "";
    $("f-date").value = date;
    $("f-enddate").value = date;
    $("f-allday").checked = false;
    var s = nextHour();
    $("f-start").value = s; $("f-end").value = plusHour(s);
    toggleAllDay();
    $("f-delete").classList.add("hidden");
    $("f-save").classList.remove("hidden");
    showDialog();
    setTimeout(function () { $("f-title").focus(); }, 50);
  }

  function openEdit(ev) {
    if (!ev) return;
    form = { mode: "edit", col: ev.cols[0] || 0, ev: ev };
    var ro = ev.recurring;
    $("dlg-title").textContent = ro ? "Herhalende afspraak" : "Afspraak aanpassen";
    $("form").classList.toggle("readonly", ro);
    $("ro-note").classList.toggle("hidden", !ro);
    $("ro-note").textContent = ro ? "Dit is een herhalende afspraak (" + ev.summary + "). Aanpassen of verwijderen doe je op je iPhone." : "";
    renderPeople();
    fillCalendars(ev.calendar, true);
    $("f-cal").disabled = true; // verplaatsen naar andere agenda: niet ondersteund
    $("f-title").value = ev.text;
    $("f-title").readOnly = ro;
    $("f-date").value = ev.startDate;
    $("f-allday").checked = ev.allDay;
    $("f-enddate").value = ev.allDay ? addDays(ev.endDate, -1) : ev.startDate;
    $("f-start").value = ev.allDay ? nextHour() : ev.startTime;
    $("f-end").value = ev.allDay ? plusHour(nextHour()) : ev.endTime;
    toggleAllDay();
    $("f-delete").classList.toggle("hidden", ro);
    $("f-save").classList.toggle("hidden", ro);
    showDialog();
  }

  $("f-cancel").onclick = closeDialog;
  $("dlg").addEventListener("click", function (e) { if (e.target === this) closeDialog(); });

  function payload() {
    return {
      col: form.col,
      title: $("f-title").value.trim(),
      date: $("f-date").value,
      allDay: $("f-allday").checked,
      endDate: $("f-enddate").value,
      start: $("f-start").value,
      end: $("f-end").value,
      calendar: $("f-cal").value,
    };
  }

  function fail(e) {
    $("f-err").textContent = e.message;
    $("f-err").classList.remove("hidden");
    $("f-save").disabled = false; $("f-delete").disabled = false;
  }

  $("form").addEventListener("submit", function (e) {
    e.preventDefault();
    var p = payload();
    if (!p.title) return fail(new Error("Geef een titel op."));
    $("f-save").disabled = true;
    var req;
    if (form.mode === "new") req = api("POST", "/api/events", p);
    else {
      p.href = form.ev.href; p.etag = form.ev.etag; p.originalSummary = form.ev.summary;
      req = api("PATCH", "/api/events", p);
    }
    req.then(function () {
      $("f-save").disabled = false;
      closeDialog();
      load(state.weekStart);
    }).catch(fail);
  });

  $("f-delete").onclick = function () {
    if (!form.deleteArmed) {
      form.deleteArmed = true;
      this.classList.add("confirm");
      this.textContent = "Zeker? Tik opnieuw";
      return;
    }
    this.disabled = true;
    api("DELETE", "/api/events", { href: form.ev.href, etag: form.ev.etag })
      .then(function () { $("f-delete").disabled = false; closeDialog(); load(state.weekStart); })
      .catch(fail);
  };

  /* ── automatisch verversen ── */
  var lastDay = new Date().toDateString();
  setInterval(function () {
    if (!$("dlg").classList.contains("hidden") || state.loading) return;
    var nowDay = new Date().toDateString();
    if (nowDay !== lastDay) { lastDay = nowDay; load(); return; } // nieuwe dag → naar huidige week
    load(state.weekStart);
  }, REFRESH_MS);
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && $("dlg").classList.contains("hidden")) load(state.weekStart);
  });

  load();
})();
