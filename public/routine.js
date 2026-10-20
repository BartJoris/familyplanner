/* Routines voor de kinderen — groot, kleurrijk en zelf af te vinken. */
(function () {
  "use strict";

  var DAYS = ["maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag", "zondag"];
  var DAYS_SHORT = ["ma", "di", "wo", "do", "vr", "za", "zo"];
  var MONTHS = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"];
  var POLL_MS = 15000;
  var HOLD_MS = 700; // lang drukken = ongedaan maken (voor de ouders)

  var $ = function (s, el) { return (el || document).querySelector(s); };
  var key = null;
  try {
    var qs = new URLSearchParams(location.search);
    if (qs.get("key")) {
      key = qs.get("key");
      try { sessionStorage.setItem("gp_key", key); } catch (e) { /* ok */ }
      qs.delete("key");
      history.replaceState(null, "", location.pathname + (qs.toString() ? "?" + qs : ""));
    } else { try { key = sessionStorage.getItem("gp_key"); } catch (e) { /* ok */ } }
  } catch (e) { /* oude browser */ }

  function api(method, path, body) {
    var h = {};
    if (key) h.Authorization = "Bearer " + key;
    if (body) h["Content-Type"] = "application/json";
    return fetch(path, { method: method, headers: h, body: body ? JSON.stringify(body) : undefined, credentials: "same-origin" })
      .then(function (r) {
        if (r.status === 401) { location.href = "/login"; throw new Error("login"); }
        return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || r.status); return j; });
      });
  }

  /* ── geluid (WebAudio, geen bestanden nodig) ── */
  var ac = null;
  function audio() {
    try {
      if (!ac) ac = new (window.AudioContext || window.webkitAudioContext)();
      if (ac.state === "suspended") ac.resume();
    } catch (e) { ac = null; }
    return ac;
  }
  function tone(freq, start, dur, type, vol, slideTo) {
    var a = audio(); if (!a) return;
    var o = a.createOscillator(), g = a.createGain(), t = a.currentTime + start;
    o.type = type || "sine";
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol || 0.25, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(a.destination);
    o.start(t); o.stop(t + dur + 0.05);
  }
  function clop(start) { // paardenhoef
    var a = audio(); if (!a) return;
    var len = 0.06, buf = a.createBuffer(1, a.sampleRate * len, a.sampleRate), d = buf.getChannelData(0);
    for (var i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 4);
    var s = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
    s.buffer = buf; f.type = "bandpass"; f.frequency.value = 900; g.gain.value = 0.9;
    s.connect(f); f.connect(g); g.connect(a.destination);
    s.start(a.currentTime + start);
  }
  var SOUND = {
    pop: function (theme) {
      if (theme === "horse") { clop(0); clop(0.12); tone(880, 0.05, 0.15, "triangle", 0.15); }
      else { tone(220, 0, 0.25, "sawtooth", 0.08, 440); tone(660, 0.12, 0.12, "triangle", 0.12); }
    },
    party: function (theme) {
      var notes = [523, 659, 784, 1047, 784, 1047];
      notes.forEach(function (n, i) { tone(n, i * 0.13, 0.22, "triangle", 0.22); });
      if (theme === "horse") { for (var i = 0; i < 8; i++) clop(0.9 + i * 0.14 + (i % 2) * 0.03); tone(700, 0.9, 0.6, "sine", 0.1, 500); }
      else { tone(90, 0.85, 1.2, "sawtooth", 0.12, 420); tone(120, 0.9, 1.1, "square", 0.04, 520); }
    },
    undo: function () { tone(440, 0, 0.15, "sine", 0.12, 260); },
  };

  /* ── state ── */
  var S = { data: null, period: null, manualAt: 0, busy: {} };

  function load() {
    return api("GET", "/api/routines").then(function (d) {
      var prevDate = S.data && S.data.date;
      S.data = d;
      if (!S.period || Date.now() - S.manualAt > 10 * 60 * 1000 || prevDate !== d.date) S.period = d.period;
      render();
    }).catch(function (e) { console.warn(e); });
  }

  function stepsOf(period) { return S.data.routines[period].steps; }
  function isDone(child, period, step) {
    var st = S.data.state[child] && S.data.state[child][period];
    return !!(st && st[step]);
  }

  /* ── render ── */
  function render() {
    var d = S.data;
    var dt = new Date(d.date + "T12:00:00");
    $("#date").textContent = DAYS[(dt.getDay() + 6) % 7] + " " + dt.getDate() + " " + MONTHS[dt.getMonth()];
    Array.prototype.forEach.call(document.querySelectorAll(".seg"), function (b) {
      b.classList.toggle("on", b.dataset.period === S.period);
      b.setAttribute("aria-selected", b.dataset.period === S.period);
    });

    var wrap = $("#kids");
    d.children.forEach(function (ch, idx) {
      var el = wrap.children[idx];
      if (!el) {
        el = document.importNode($("#tpl-kid").content, true).firstElementChild;
        wrap.appendChild(el);
        $(".party", el).addEventListener("click", function () { $(".party", el).classList.add("hidden"); });
      }
      el.className = "kid " + ch.theme;
      el.style.setProperty("--c", ch.color);
      el.style.setProperty("--l", ch.light);
      $(".avatar", el).textContent = ch.avatar;
      $(".name", el).textContent = ch.name;
      $(".goal", el).textContent = ch.goal;
      $(".runner span", el).textContent = ch.runner;
      $(".party-runner span", el).textContent = ch.runner;
      renderSteps(el, ch);
      renderWeek(el, ch);
    });
  }

  function renderSteps(el, ch) {
    var steps = stepsOf(S.period);
    var box = $(".steps", el);
    if (box.dataset.sig !== S.period + steps.length) {
      box.innerHTML = "";
      steps.forEach(function (s, i) {
        var b = document.createElement("button");
        b.className = "step";
        b.dataset.step = s.id;
        b.innerHTML = '<span class="num"></span><span class="icon"></span><span class="label"></span><span class="stamp"></span><span class="check">✓</span>';
        $(".num", b).textContent = i + 1;
        $(".icon", b).textContent = s.icon;
        $(".label", b).textContent = s.label;
        $(".stamp", b).textContent = ch.reward;
        attachPress(b, ch);
        box.appendChild(b);
      });
      box.dataset.sig = S.period + steps.length;
    }
    var done = 0;
    steps.forEach(function (s) {
      var b = box.querySelector('[data-step="' + s.id + '"]');
      var on = isDone(ch.name, S.period, s.id);
      if (on) done++;
      b.classList.toggle("done", on);
      b.setAttribute("aria-pressed", on);
      b.setAttribute("aria-label", s.label + (on ? " – klaar" : ""));
    });
    var total = steps.length;
    var pct = total ? done / total : 0;
    var runner = $(".runner", el);
    runner.style.left = "calc(8px + (100% - 130px) * " + pct.toFixed(3) + ")";
    $(".progress-text", el).textContent = done === total
      ? "Alles klaar! " + ch.reward
      : (done === 0 ? "Klaar om te starten? " + S.data.routines[S.period].icon : done + " van " + total + " gedaan");
  }

  function renderWeek(el, ch) {
    var row = $(".weekrow", el);
    var wk = S.data.week[ch.name] || [];
    var keys = Object.keys(S.data.routines);
    row.innerHTML = "";
    wk.forEach(function (day, i) {
      var c = document.createElement("div");
      c.className = "wd" + (day.date === S.data.today ? " today" : "");
      var html = '<div class="d">' + DAYS_SHORT[i] + '</div><div class="slots">';
      keys.forEach(function (k) {
        html += day[k] ? "<span>" + (k === "morning" ? ch.reward : ch.avatar) + "</span>" : '<span class="off">' + S.data.routines[k].icon + "</span>";
      });
      c.innerHTML = html + "</div>";
      row.appendChild(c);
    });
  }

  /* ── tikken / lang drukken ── */
  function attachPress(b, ch) {
    var timer = null, held = false;
    function start() {
      held = false;
      timer = setTimeout(function () {
        held = true;
        if (b.classList.contains("done")) { b.classList.add("wobble"); setTimeout(function () { b.classList.remove("wobble"); }, 500); toggle(ch, b.dataset.step, false); SOUND.undo(); }
      }, HOLD_MS);
    }
    function cancel() { clearTimeout(timer); }
    b.addEventListener("pointerdown", start);
    b.addEventListener("pointerup", cancel);
    b.addEventListener("pointerleave", cancel);
    b.addEventListener("pointercancel", cancel);
    b.addEventListener("contextmenu", function (e) { e.preventDefault(); });
    b.addEventListener("click", function () {
      if (held) return;
      audio();
      if (b.classList.contains("done")) { // al gedaan: gewoon een vrolijk hupje
        b.classList.add("bump"); setTimeout(function () { b.classList.remove("bump"); }, 400);
        return;
      }
      b.classList.add("done", "bump"); setTimeout(function () { b.classList.remove("bump"); }, 400);
      SOUND.pop(ch.theme);
      toggle(ch, b.dataset.step, true);
    });
  }

  function toggle(ch, step, done) {
    var k = ch.name + step;
    if (S.busy[k]) return;
    S.busy[k] = true;
    // meteen lokaal bijwerken (snel gevoel), daarna server
    var st = (S.data.state[ch.name] = S.data.state[ch.name] || {});
    var r = (st[S.period] = st[S.period] || {});
    if (done) r[step] = new Date().toISOString(); else delete r[step];
    var idx = 0;
    S.data.children.forEach(function (c, i) { if (c.name === ch.name) idx = i; });
    var el = $("#kids").children[idx];
    renderSteps(el, ch);
    var runner = $(".runner", el);
    if (done) { runner.classList.remove("go"); void runner.offsetWidth; runner.classList.add("go"); }

    api("POST", "/api/routines/toggle", { child: ch.name, routine: S.period, step: step, done: done, date: S.data.date })
      .then(function (d) {
        S.data = Object.assign(d, { routines: d.routines });
        render();
        if (d.completedNow) party(el, ch);
      })
      .catch(function () { load(); })
      .then(function () { delete S.busy[k]; });
  }

  /* ── feest! ── */
  function party(el, ch) {
    var p = $(".party", el);
    var who = S.period === "morning" ? "Klaar voor de dag" : "Klaar voor bedje";
    $(".party-big", p).textContent = "Super gedaan, " + ch.name + "! " + ch.reward;
    var cheer = ch.cheer && ch.cheer.length ? ch.cheer[Math.floor(Math.random() * ch.cheer.length)] : "";
    $(".party-small", p).textContent = cheer + " " + who + "!";
    var conf = $(".confetti", p);
    conf.innerHTML = "";
    var colors = [ch.color, "#ffd23f", "#ffffff", ch.light, "#ff9fb8", "#7fd6a0"];
    for (var i = 0; i < 70; i++) {
      var c = document.createElement("i");
      c.style.left = Math.random() * 100 + "%";
      c.style.background = colors[i % colors.length];
      c.style.animationDuration = 2 + Math.random() * 2.5 + "s";
      c.style.animationDelay = Math.random() * 0.8 + "s";
      c.style.transform = "rotate(" + Math.random() * 360 + "deg)";
      conf.appendChild(c);
    }
    var pr = $(".party-runner", p);
    pr.style.animation = "none"; void pr.offsetWidth; pr.style.animation = "";
    p.classList.remove("hidden");
    SOUND.party(ch.theme);
    clearTimeout(p._t);
    p._t = setTimeout(function () { p.classList.add("hidden"); }, 7000);
  }

  /* ── bovenbalk ── */
  Array.prototype.forEach.call(document.querySelectorAll(".seg"), function (b) {
    b.addEventListener("click", function () {
      S.period = b.dataset.period; S.manualAt = Date.now();
      Array.prototype.forEach.call(document.querySelectorAll(".steps"), function (x) { x.dataset.sig = ""; });
      render();
    });
  });

  setInterval(function () { if (!document.hidden) load(); }, POLL_MS);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) load(); });
  load();
})();
