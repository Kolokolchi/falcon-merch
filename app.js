(() => {
  "use strict";

  const ITEMS = window.FALCON_ITEMS;
  const N = ITEMS.length;
  const STEP = 0.38;               // угол между соседями на дуге, рад
  const THICK = 18;                // «толщина» плоской вырезки, px
  const LAYERS = 5;
  const CH_ANGLE = [8, 26, 44];    // поворот объекта в каждом разделе, градусы. Только вперёд от исходной позы:
                                   // отрицательные углы попадают в конец ролика, где модель «доворачивает» объект
  const CHAPTERS = CH_ANGLE.length;

  const $ = (id) => document.getElementById(id);
  const app = $("app"), stage = $("stage");
  const pedTop = document.querySelector(".pedestal-top"), pedBottom = document.querySelector(".pedestal-bottom");

  const S = {
    pos: 0, target: 0,      // позиция очереди (дробная) и цель
    active: -1,             // индекс объекта в режиме презентации
    chapter: 0,
    g: 0,                   // 0 — очередь, 1 — презентация
    shown: -1,              // индекс, подписанный внизу
    W: 0, H: 0, mobile: false, size: 0, R: 0,
  };

  // ---------- сборка сцены ----------
  const turnQueue = [];   // объекты, чьи кадры оборота ещё не загружены
  let turnBusy = false;
  const nodes = ITEMS.map((it, i) => {
    const el = document.createElement("div");
    el.className = "item";
    el.dataset.i = i;
    const layers = it.glass ? 1 : LAYERS;   // у прозрачного объекта тёмная «толщина» просвечивала бы
    for (let k = 0; k < layers; k++) {
      const img = new Image();
      img.src = it.img;
      img.alt = k === 0 ? it.name : "";
      img.decoding = "async";
      img.draggable = false;
      const z = layers === 1 ? 0 : THICK / 2 - (THICK * k) / (LAYERS - 1);
      img.style.transform = `translateZ(${z}px)`;
      if (k > 0 && k < LAYERS - 1) img.className = "mid";
      el.appendChild(img);
    }
    const sh = document.createElement("div");
    sh.className = "shadow";
    stage.append(sh, el);
    const node = { el, sh, h: 0, rot: 0, rotT: 0, rotGoal: 0, rotFrom: 0, rotT0: 0, rotDur: 1, w: 0, hgt: 0, heroK: 1, turn: null };
    if (it.turn) loadTurn(node, it.turn);
    return node;
  });

  // Объект с «вертушкой» (it.turn): вместо плоской вырезки — кадры настоящего оборота,
  // снятые с ролика. Номер кадра задаётся углом поворота, поэтому объект реально вращается.
  // Загрузка в два прохода: сначала у всех объектов кадры около исходной позы (объект сразу «оживает»),
  // потом остальные кадры оборота — начиная с объектов ближе к центру.
  function loadTurn(node, turn) { turnQueue.push({ node, turn, phase: 1 }); }
  const frameUrl = (turn, k) => `${turn.dir}/${String(k).padStart(3, "0")}.webp`;
  function nextTurn() {
    if (turnBusy || !turnQueue.length) return;
    turnQueue.sort((p, q) => p.phase - q.phase || dist(p.node) - dist(q.node));
    const job = turnQueue.shift(), { node, turn } = job;
    turnBusy = true;
    let work;
    if (job.phase === 1) {
      const ks = restFrames(turn.n);
      work = fetchAll(ks.map((k) => frameUrl(turn, k))).then(async (got) => {
        const canvas = document.createElement("canvas");
        canvas.className = "turn";
        canvas.width = turn.fw; canvas.height = turn.fh;
        const t = { ...turn, canvas, ctx: canvas.getContext("2d"), blobs: new Array(turn.n), lo: new Array(turn.n), hi: new Array(turn.n),
                    complete: false, full: false, busy: false, drop: false, dirty: true, shown: null };
        ks.forEach((k, j) => { t.blobs[k] = got[j]; });
        await decodeRest(t);
        node.turn = t;
        node.el.append(canvas);
        node.el.classList.add("turning");
        layout();
        turnQueue.push({ node, turn, phase: 2 });
      });
    } else {
      const t = node.turn, ks = [];
      for (let k = 0; k < t.n; k++) if (!t.blobs[k]) ks.push(k);
      work = fetchAll(ks.map((k) => frameUrl(turn, k))).then((got) => {
        ks.forEach((k, j) => { t.blobs[k] = got[j]; });
        t.complete = true;
      });
    }
    work.catch(() => { if ((job.tries = (job.tries || 0) + 1) < 3) turnQueue.push(job); })   // не вышло — попробуем позже
        .finally(() => { turnBusy = false; nextTurn(); });
  }

  // Загрузка кадров: не больше 8 запросов сразу и до 4 попыток на файл — по сети отдельные запросы срываются.
  async function fetchAll(urls) {
    const out = new Array(urls.length);
    let next = 0;
    const one = async (u) => {
      for (let attempt = 0; ; attempt++) {
        try { const r = await fetch(u); if (r.ok) return await r.blob(); throw new Error(r.status); }
        catch (err) { if (attempt >= 3) throw err; await new Promise((res) => setTimeout(res, 400 * (attempt + 1))); }
      }
    };
    const worker = async () => { while (next < urls.length) { const k = next++; out[k] = await one(urls[k]); } };
    await Promise.all(Array.from({ length: 8 }, worker));
    return out;
  }

  // Кадры хранятся сжатыми, а распаковываются заранее, чтобы вращение не запиналось на декодировании:
  //  • у каждого объекта — кадры около исходной позы в половинном размере (их хватает для очереди);
  //  • у объекта в центре и у выбранного — весь оборот в полном размере; когда объект уходит, они освобождаются.
  const REST = 20;
  const restFrames = (n) => { const ks = []; for (let j = -2; j <= REST; j++) ks.push(mod(j, n)); return ks; };
  async function decodeRest(t) {
    const half = Math.max(1, Math.round(t.fw / 2));
    await Promise.all(restFrames(t.n).map(async (k) => { t.lo[k] = await createImageBitmap(t.blobs[k], { resizeWidth: half, resizeQuality: "high" }); }));
  }
  async function decodeFull(t) {
    if (t.full || t.busy || !t.complete) return;
    t.busy = true;
    for (let s = 0; s < t.n && !t.drop; s += 12) {
      const ks = [];
      for (let k = s; k < Math.min(t.n, s + 12); k++) if (!t.hi[k]) ks.push(k);
      await Promise.all(ks.map(async (k) => { t.hi[k] = await createImageBitmap(t.blobs[k]); }));
      t.dirty = true;
    }
    t.busy = false;
    if (t.drop) freeFull(t); else t.full = true;
  }
  function freeFull(t) {
    for (const b of t.hi) if (b) b.close();
    t.hi = new Array(t.n); t.full = false; t.drop = false; t.dirty = true;
  }
  function frameOf(t, k) {
    if (t.hi[k]) return t.hi[k];
    if (t.lo[k]) return t.lo[k];
    for (let j = 1; j < t.n; j++) {         // нужный кадр ещё не распакован — берём ближайший готовый
      const a = mod(k - j, t.n), b = mod(k + j, t.n);
      if (t.hi[a] || t.lo[a]) return t.hi[a] || t.lo[a];
      if (t.hi[b] || t.lo[b]) return t.hi[b] || t.lo[b];
    }
    return null;
  }

  const dist = (node) => { const i = nodes.indexOf(node); return i === S.active ? -1 : Math.abs(wrap(i - S.pos)); };

  // ---------- геометрия ----------
  function layout() {
    S.W = window.innerWidth; S.H = window.innerHeight;
    S.mobile = S.W <= 820;
    S.size = S.mobile ? Math.min(S.W * 0.44, S.H * 0.3) : Math.min(S.H * 0.3, S.W * 0.2);
    S.R = S.size / STEP * (S.mobile ? 1.15 : 1.02);
    const boxW = S.mobile ? S.W * 0.72 : S.W * 0.4;
    const boxH = S.mobile ? S.H * 0.29 : S.H * 0.62;
    ITEMS.forEach((it, i) => {
      const n = nodes[i];
      const long = Math.max(it.w, it.h), short = Math.min(it.w, it.h);
      const k = (S.size / long) * Math.min(1.28, Math.pow(long / short, 0.3));
      n.w = it.w * k; n.hgt = it.h * k;
      n.el.style.width = n.w + "px"; n.el.style.height = n.hgt + "px";
      n.el.style.margin = `${-n.hgt / 2}px 0 0 ${-n.w / 2}px`;
      n.heroK = Math.min(boxW / n.w, boxH / n.hgt);
      if (n.turn) {   // совмещаем объект в кадре с рамкой вырезки
        const t = n.turn, q = n.hgt / t.oh, c = t.canvas.style;
        c.width = t.fw * q + "px"; c.height = t.fh * q + "px";
        c.left = (n.w - t.ow * q) / 2 - t.ox * q + "px"; c.top = -t.oy * q + "px";
      }
    });
    const cy = S.H * 0.44;
    pedTop.style.top = cy - S.size * 0.92 + "px";
    pedBottom.style.top = cy + S.size * 0.74 + "px";
  }

  const mod = (a, n) => ((a % n) + n) % n;
  const wrap = (d) => { d = mod(d, N); return d > N / 2 ? d - N : d; };
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const smooth = (t) => t * t * (3 - 2 * t);
  const pad = (n) => String(n).padStart(2, "0");

  // ---------- кадр ----------
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    const t = now / 1000;
    const { W, H, size, R } = S;

    S.pos += (S.target - S.pos) * (1 - Math.exp(-dt * 7));
    S.g += ((S.active >= 0 ? 1 : 0) - S.g) * (1 - Math.exp(-dt * 5));

    const heroX = S.mobile ? 0 : W * 0.19;
    const heroY = S.mobile ? -H * 0.255 : H * 0.03;
    const baseY = -H * 0.06;

    for (let i = 0; i < N; i++) {
      const n = nodes[i];
      n.h = clamp(n.h + (i === S.active ? dt / 1.15 : -dt / 0.85), 0, 1);
      if (n.rotT !== n.rotGoal) {            // новая цель — новый отрезок движения
        n.rotGoal = n.rotT; n.rotFrom = n.rot; n.rotT0 = t;
        n.rotDur = clamp((Math.abs(n.rotT - n.rot) / 360) * 2.1, 0.7, 2.4);
      }
      const u = clamp((t - n.rotT0) / n.rotDur, 0, 1);
      n.rot = lerp(n.rotFrom, n.rotT, u * u * u * (u * (u * 6 - 15) + 10));
      if (n.h === 0 && u === 1) { n.rot = n.rotT = n.rotGoal = n.rotFrom = 0; }
      const e = ease(n.h);

      // положение в очереди
      const d = wrap(i - S.pos), ad = Math.abs(d), ang = d * STEP;
      const near = smooth(clamp(1 - ad, 0, 1));
      let x = Math.sin(ang) * R;
      let z = (Math.cos(ang) - 1) * R * 0.8;
      let y = baseY + Math.sin(t * 0.9 + i * 1.3) * size * 0.04 * (1 - near * 0.6);
      let sc = 0.8 + 0.42 * near;
      let rz = (Math.sin(i * 2.1) * 10 + Math.sin(t * 0.5 + i) * 3.5) * (1 - near * 0.9);
      // Объекты с кадрами оборота поворачиваются только вперёд от исходной позы (конец ролика бывает неровным)
      // и без покачивания по углу: кадр должен меняться только при настоящем повороте.
      let ry = n.turn ? (Math.abs(ang) * 0.3 * 180) / Math.PI
                      : (-ang * 0.3 * 180) / Math.PI + Math.sin(t * 0.4 + i * 0.7) * 5 * (1 - near);
      let op = clamp((4.3 - ad) / 1.2, 0, 1);

      // остальные объекты отступают, когда один выбран
      const away = S.g * (1 - e);
      op *= 1 - away;
      z -= away * 520;
      y += away * H * 0.06;

      // подлёт к камере
      if (e > 0) {
        const arc = Math.sin(e * Math.PI);
        x = lerp(x, heroX, e);
        y = lerp(y, heroY + Math.sin(t * 1.1) * 7, e) - arc * H * 0.05;
        z = lerp(z, 60, e) + arc * 300;
        sc = lerp(sc, n.heroK, e);
        rz = lerp(rz, -6 + Math.sin(t * 0.7) * 1.4, e);
        ry = lerp(ry, n.turn ? 0 : Math.sin(t * 0.6) * 5, e);
        op = lerp(op, 1, e);
      }
      ry += n.rot;

      if (n.turn) {   // полный набор кадров держим только у объекта в центре и у выбранного
        const tt = n.turn, want = i === S.active || n.h > 0 || (S.active < 0 && ad < 0.6);
        if (want) { tt.drop = false; if (!tt.full && !tt.busy) decodeFull(tt); }
        else if (ad > 1.6) { if (tt.busy) tt.drop = true; else if (tt.full || tt.hi.some(Boolean)) freeFull(tt); }
      }

      const vis = op > 0.01;
      n.el.style.visibility = n.sh.style.visibility = vis ? "visible" : "hidden";
      if (!vis) continue;
      n.el.style.opacity = op;
      n.el.style.zIndex = e > 0 ? 5 : 1;
      n.el.style.pointerEvents = op > 0.5 ? "auto" : "none";
      if (n.turn) {
        const t = n.turn;
        // Всегда один чёткий кадр — ближайший к углу. Смешивать соседние кадры нельзя: там, где позы
        // различаются, смесь выглядит как полупрозрачный двойной контур.
        const k = mod(Math.round((ry / 360) * t.n), t.n);
        const img = frameOf(t, k);
        if (img && (t.dirty || img !== t.shown)) {
          t.shown = img; t.dirty = false;
          t.ctx.clearRect(0, 0, t.fw, t.fh);
          t.ctx.drawImage(img, 0, 0, t.fw, t.fh);
        }
        n.el.style.transform = `translate3d(${x}px,${y}px,${z}px) rotateZ(${rz}deg) scale(${sc})`;
        n.sh.style.visibility = "hidden";   // тень уже есть в кадрах
        continue;
      }
      n.el.style.transform = `translate3d(${x}px,${y}px,${z}px) rotateZ(${rz}deg) rotateY(${ry}deg) scale(${sc})`;

      const flat = Math.abs(Math.cos((ry * Math.PI) / 180));
      const sy = lerp(baseY + size * 0.78, heroY + (n.hgt * n.heroK) / 2 + 34, e);
      const sw = (n.w * sc * (0.25 + 0.75 * flat)) / 100;
      n.sh.style.opacity = op * lerp(0.9, 0.55, e);
      n.sh.style.transform = `translate3d(${x}px,${sy}px,${z - 2}px) scale(${sw},${0.26 * sc})`;
    }

    const idx = mod(Math.round(S.pos), N);
    if (idx !== S.shown) showCaption(idx);
    requestAnimationFrame(frame);
  }

  // ---------- подписи ----------
  const capName = $("capName"), capSet = $("capSet");
  function showCaption(idx) {
    S.shown = idx;
    const it = ITEMS[idx];
    capName.textContent = it.name; capSet.textContent = it.set;
    for (const el of [capName, capSet]) { el.classList.remove("swap"); void el.offsetWidth; el.classList.add("swap"); }
    $("count").textContent = `${pad(idx + 1)} / ${pad(N)}`;
    $("railDot").style.left = (idx / (N - 1)) * 100 + "%";
  }

  const rows = (list) => list.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
  function fillPanel(i) {
    const it = ITEMS[i];
    $("dNum").textContent = pad(i + 1);
    $("dSet").textContent = it.set;
    $("dTitle").textContent = it.name;
    $("dText").textContent = it.text;
    $("dKit").innerHTML = it.kit.map((k) => `<li>${k}</li>`).join("");
    $("dMat").innerHTML = rows(it.material);
    $("dBrand").innerHTML = rows(it.brand);
  }

  // ---------- действия ----------
  const hint = $("hint");
  const touched = () => hint.classList.add("off");

  function go(dir) { S.target = Math.round(S.target) + dir; touched(); }

  function setChapter(c, spin = true) {
    c = clamp(c, 0, CHAPTERS - 1);
    const n = nodes[S.active];
    if (n && c !== S.chapter) n.rotT += (c > S.chapter ? 360 : -360) * (spin ? 1 : 0) + CH_ANGLE[c] - CH_ANGLE[S.chapter];
    S.chapter = c;
    app.dataset.chapter = c;
    $("more").style.visibility = c === CHAPTERS - 1 ? "hidden" : "visible";
  }

  function release(i) {
    const n = nodes[i];
    n.rotT = Math.round(n.rot / 360) * 360;   // объект доворачивается лицом и уходит в очередь
  }

  function open(i) {
    i = mod(i, N);
    if (S.active === i) return;
    if (S.active >= 0) release(S.active);
    S.target = Math.round(S.pos + wrap(i - S.pos));
    S.active = i;
    S.chapter = 0;
    const n = nodes[i];
    n.rotT = Math.round(n.rot / 360) * 360 + 360 + CH_ANGLE[0];
    fillPanel(i);
    setChapter(0, false);
    app.dataset.mode = "detail";
    touched();
  }

  function close() {
    if (S.active < 0) return;
    release(S.active);
    S.active = -1;
    app.dataset.mode = "browse";
  }

  // ---------- ввод ----------
  let wheelLock = 0;
  window.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    const now = performance.now();
    const delta = Math.abs(ev.deltaY) > Math.abs(ev.deltaX) ? ev.deltaY : ev.deltaX;
    if (Math.abs(delta) < 4 || now < wheelLock) return;
    const dir = delta > 0 ? 1 : -1;
    if (S.active >= 0) {
      wheelLock = now + 650;
      const c = S.chapter + dir;
      if (c < 0 || c >= CHAPTERS) close(); else setChapter(c);
    } else {
      wheelLock = now + 170;
      go(dir);
    }
  }, { passive: false });

  // Объект под курсором ищем по его экранному прямоугольнику: боковые объекты стоят
  // глубже плоскости сцены, и обычный hit-test браузера до них не доходит.
  function pick(px, py) {
    let best = -1, bestD = Infinity;
    for (let i = 0; i < N; i++) {
      const el = nodes[i].el;
      if (el.style.visibility === "hidden" || +el.style.opacity < 0.5) continue;
      const r = el.getBoundingClientRect();
      if (px < r.left || px > r.right || py < r.top || py > r.bottom) continue;
      const d = i === S.active ? -1 : Math.abs(wrap(i - S.pos));
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  let drag = null;
  stage.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    drag = { x: ev.clientX, y: ev.clientY, start: S.target, moved: false, hit: pick(ev.clientX, ev.clientY), id: ev.pointerId };
    stage.setPointerCapture(ev.pointerId);
  });
  stage.addEventListener("pointermove", (ev) => {
    if (!drag) return;
    const dx = ev.clientX - drag.x;
    if (!drag.moved && Math.hypot(dx, ev.clientY - drag.y) > 7) { drag.moved = true; stage.classList.add("dragging"); touched(); }
    if (drag.moved && S.active < 0) S.target = drag.start - dx / (S.R * STEP);
  });
  stage.addEventListener("mousemove", (ev) => { if (!drag) stage.style.cursor = pick(ev.clientX, ev.clientY) >= 0 ? "pointer" : ""; });
  const endDrag = (ev) => {
    if (!drag) return;
    const d = drag; drag = null;
    stage.classList.remove("dragging");
    if (d.moved) {
      if (S.active >= 0) { const dx = ev.clientX - d.x; if (Math.abs(dx) > 60) open(S.active + (dx < 0 ? 1 : -1)); }
      else S.target = Math.round(S.target);
    } else if (d.hit >= 0) {
      if (S.active === d.hit) close(); else open(d.hit);
    }
  };
  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);

  window.addEventListener("keydown", (ev) => {
    const k = ev.key;
    if (S.active >= 0) {
      if (k === "Escape" || k === "Backspace") close();
      else if (k === "ArrowRight") open(S.active + 1);
      else if (k === "ArrowLeft") open(S.active - 1);
      else if (k === "ArrowDown" || k === " " || k === "PageDown") { ev.preventDefault(); S.chapter === CHAPTERS - 1 ? close() : setChapter(S.chapter + 1); }
      else if (k === "ArrowUp" || k === "PageUp") { ev.preventDefault(); S.chapter === 0 ? close() : setChapter(S.chapter - 1); }
    } else {
      if (k === "ArrowRight") go(1);
      else if (k === "ArrowLeft") go(-1);
      else if (k === "Enter" || k === " ") { ev.preventDefault(); open(Math.round(S.target)); }
    }
  });

  $("prev").addEventListener("click", () => go(-1));
  $("next").addEventListener("click", () => go(1));
  $("openBtn").addEventListener("click", () => open(Math.round(S.target)));
  $("back").addEventListener("click", close);
  $("more").addEventListener("click", () => setChapter(S.chapter + 1));
  $("dPrev").addEventListener("click", () => open(S.active - 1));
  $("dNext").addEventListener("click", () => open(S.active + 1));
  $("dots").addEventListener("click", (ev) => { const b = ev.target.closest("button"); if (b) setChapter(+b.dataset.ch); });

  window.addEventListener("resize", layout);
  layout();
  nextTurn();
  app.dataset.chapter = 0;
  requestAnimationFrame(frame);

  // для проверки из консоли
  window.falcon = { open, close, go, setChapter, state: S };
})();
