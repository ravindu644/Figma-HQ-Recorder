/*
 * Figma HQ Prototype Recorder — records the inline Preview (Shift+Space) to video
 * at the device frame's native resolution, with the device bezel composited in.
 *
 * How Figma builds the Preview:
 *
 *   DIV.previewDeviceContainer
 *   ├── IMG.previewDeviceImage      <- the bezel. A plain PNG, ~1310x2710 native.
 *   └── DIV.iframeContainer         <- border-radius: 6%
 *       └── IFRAME.previewIframe
 *           └── CANVAS              <- WebGL2. The screen, and ONLY the screen.
 *
 * The bezel is a sibling <img>, not canvas pixels — which is why recording the
 * canvas alone (what every other tool does) can never capture the device frame.
 * We draw both into one canvas and record that instead.
 *
 * Three findings this is built on, all verified against a live prototype:
 *
 *  1. The canvas backing store follows the modal's LAYOUT box and ignores the
 *     viewport. Setting the modal to 1310px wide gives a 1206x2622 backing on an
 *     1100x873 screen, and Figma really does render into all of it.
 *  2. A CSS `transform: scale()` shrinks the modal on screen WITHOUT shrinking
 *     that layout box. So we record at native res while the user still sees and
 *     clicks a normal-sized preview. Transforms are paint-time; layout is untouched.
 *  3. drawImage() straight off the WebGL canvas returns BLANK — Figma allocates it
 *     without preserveDrawingBuffer, so the buffer is gone by the time we'd read it.
 *     captureStream() -> <video> -> drawImage is the route that actually has pixels.
 *  4. The bezel PNG is 89% transparent, and the Dynamic Island is baked into it as an
 *     opaque shape INSIDE the screen cutout — the asset is meant to be drawn OVER the
 *     screen. So the screen goes down first and the frame on top of it, which makes
 *     the inner edge and the island exact for free.
 *     That alone is not enough: the cutout and the area outside the device are BOTH
 *     alpha 0, so an unclipped screen leaks out through the rounded outer corners.
 *     Measured on this frame — content over the frame / leak outside the device:
 *       frame first, circular clip    64784 px  <- the visible bulge
 *       frame first, elliptical clip  59804 px
 *       screen first, no clip             0 / 4460 px
 *       screen first, elliptical clip     0 / 0 px
 *     Hence both: clip the screen, then lay the frame over it.
 *     The cutout measures x 52..1257, y 44..2665 — exactly the DOM-derived rect.
 */
(() => {
  if (window.__figHQRecorder) return;
  window.__figHQRecorder = true;

  /* MP4/H.264 leads deliberately: it is the most portable, and VP8 can silently
     capture an empty clip off a WebGL canvas. Anything the browser can't encode is
     dropped from the list rather than offered and then failing at record time. */
  const CODECS = [
    { mime: "video/mp4;codecs=avc1", label: "MP4 · H.264" },
    { mime: "video/webm;codecs=vp9", label: "WebM · VP9" },
    { mime: "video/webm;codecs=av01", label: "WebM · AV1" },
    { mime: "video/webm;codecs=vp8", label: "WebM · VP8" },
  ].filter((c) => window.MediaRecorder && MediaRecorder.isTypeSupported(c.mime));

  /* Defaults are a measured ceiling, not a guess: 60fps @ 40Mbps on a ~3.5MP canvas
     crashed the renderer outright (SIGILL) on a two-minute take. The sliders can go
     higher — the panel warns when the combination gets there. localStorage rather
     than chrome.storage keeps this a zero-permission, zero-chrome.* content script. */
  const STORE = "figHQRecorder.settings";
  const DEFAULTS = { fps: 30, mbps: 12, mime: CODECS[0] && CODECS[0].mime, taps: true };
  const TAP_MS = 520;      // ripple lifetime
  const TAP_R = 0.075;     // max radius, as a fraction of screen width
  const cfg = { ...DEFAULTS };
  try { Object.assign(cfg, JSON.parse(localStorage.getItem(STORE) || "{}")); } catch (e) {}
  if (!CODECS.some((c) => c.mime === cfg.mime)) cfg.mime = DEFAULTS.mime;   // codec dropped by a browser update
  const saveCfg = () => { try { localStorage.setItem(STORE, JSON.stringify(cfg)); } catch (e) {} };

  const SEL = {
    modal: '[class*="inline_preview_modal--previewModal"]',
    bezel: 'img[class*="previewDeviceImage"]',
    iframe: 'iframe[class*="previewIframe"]',
    screenBox: '[class*="iframeContainer"]',
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* Figma keeps the Preview modal in the DOM after it's closed, so presence isn't
     enough — it has to be actually visible. */
  function parts() {
    const modal = document.querySelector(SEL.modal);
    if (!modal || getComputedStyle(modal).visibility === "hidden" || !modal.offsetWidth) return null;
    const iframe = modal.querySelector(SEL.iframe);
    if (!iframe) return null;
    const bezel = modal.querySelector(SEL.bezel);   // null when no device frame is set
    let canvas = null;
    try { canvas = iframe.contentDocument.querySelector("canvas"); } catch (e) { /* same-origin; shouldn't happen */ }
    if (!canvas) return null;
    return { modal, bezel, iframe, canvas, screenBox: modal.querySelector(SEL.screenBox) };
  }

  /* Where the screen sits inside the bezel, as fractions. Measured live rather than
     hardcoded per device, so it follows whatever frame the user picks — and it is
     scale-invariant, which matters because we read it while transformed. */
  function geometry(p) {
    const b = p.bezel.getBoundingClientRect();
    const f = p.iframe.getBoundingClientRect();
    return {
      x: (f.x - b.x) / b.width,
      y: (f.y - b.y) / b.height,
      w: f.width / b.width,
      h: f.height / b.height,
      radius: cornerRadius(p),
    };
  }

  /* The screen must be clipped before it's drawn, because the bezel's alpha alone
     can't do the job: the screen cutout and the area OUTSIDE the device are both
     fully transparent, so an unclipped screen leaks out through the rounded outer
     corners (measured: 4460px on this frame).

     The radius is ELLIPTICAL and that matters. A CSS percentage radius resolves
     horizontally against width and vertically against height, so Figma's "6%" is
     72px across but 157px down at native size. Clipping with a single circular
     radius leaves content bulging at every corner. Returned as fractions of the
     screen box so it survives the resize to native. */
  function cornerRadius(p) {
    const box = p.screenBox;
    if (!box) return { x: 0, y: 0 };
    const rect = box.getBoundingClientRect();
    const parts = getComputedStyle(box).borderTopLeftRadius.split(/\s+/);
    const frac = (v, base) => (v.endsWith("%") ? parseFloat(v) / 100 : parseFloat(v) / base) || 0;
    return { x: frac(parts[0], rect.width), y: frac(parts[1] ?? parts[0], rect.height) };
  }

  /* Grow the modal's layout box to the bezel's native size, then scale it back down
     visually so it still fits on screen. Returns an undo. */
  function goNative(p) {
    const m = p.modal;
    const before = {
      width: m.style.width, height: m.style.height,
      maxWidth: m.style.maxWidth, maxHeight: m.style.maxHeight,
      transform: m.style.transform, transformOrigin: m.style.transformOrigin,
      left: m.style.left, top: m.style.top,
    };
    const W = p.bezel.naturalWidth;
    const H = p.bezel.naturalHeight + 80;   // + the modal's own header; trimmed by the fit-up below
    const scale = Math.min(1, (innerHeight - 96) / H, (innerWidth - 96) / W);

    Object.assign(m.style, {
      maxWidth: "none", maxHeight: "none",
      width: W + "px", height: H + "px",
      transformOrigin: "top left",
      transform: `scale(${scale})`,
      left: "24px", top: "64px",
    });
    return () => Object.assign(m.style, before);
  }

  /* captureStream() emits nothing until the canvas is actually drawn to, and Figma
     doesn't repaint a prototype that's sitting still. So a static preview delivers
     zero frames: video.play() never resolves (awaiting it hangs forever) and the
     screen records black until the user happens to touch something.
     Synthetic mouse events do NOT reliably wake it — tested, the canvas stayed dark.
     Resizing by a pixel does, every time: it forces Figma to re-render. */
  async function nudge(p) {
    const w = parseFloat(p.modal.style.width);
    p.modal.style.width = w - 1 + "px";
    await sleep(250);
    p.modal.style.width = w + "px";
    await sleep(250);
  }

  const firstFrame = (v) => new Promise((done) => {
    if (v.readyState >= 2) return done();
    // ponytail: bounded wait. If the nudge somehow didn't take, record anyway —
    // the draw loop fills the screen in as soon as frames start arriving.
    const t = setTimeout(done, 3000);
    v.onloadeddata = () => { clearTimeout(t); done(); };
  });

  /* ---- recording ------------------------------------------------------- */

  const state = { rec: null, chunks: null, stop: null, startedAt: 0 };

  async function start() {
    let p = parts();
    if (!p) return note("Open the Preview first (Shift+Space)");
    if (!p.bezel) return note("No device frame — pick one in Figma's Prototype tab");
    if (!CODECS.length) return note("This browser can't record video");
    if (document.hidden) return note("Bring the tab to the foreground — Figma throttles background rendering");

    const fps = cfg.fps;              // snapshot: the panel is hidden while recording,
    const mime = cfg.mime;            // but never let a live edit tear a running encode
    const bitrate = cfg.mbps * 1e6;

    const undoSize = goNative(p);
    await sleep(1200);              // let Figma reallocate and repaint the canvas

    p = parts();                    // the canvas node can be replaced by the resize
    if (!p) { undoSize(); return note("Lost the Preview while resizing"); }

    // The WebGL canvas has no readable buffer (finding 3) — go through a stream.
    const srcStream = p.canvas.captureStream(fps);
    const video = document.createElement("video");
    video.srcObject = srcStream;
    video.muted = true;
    video.playsInline = true;
    video.play().catch(() => {});   // never await this — see nudge()
    await nudge(p);
    await firstFrame(video);

    p = parts();                    // measure only once the jiggle has settled
    if (!p) { undoSize(); return note("Lost the Preview while starting"); }
    const g = geometry(p);

    let bezel;
    try {
      bezel = await createImageBitmap(await (await fetch(p.bezel.src)).blob());
    } catch (e) {
      undoSize();
      return note("Couldn't load the device frame image");
    }

    /* The cursor is never in the canvas — Figma renders content only — so taps have to
       be drawn. The preview iframe is same-origin, and coordinates measured inside it
       are in its own unscaled viewport, so our outer transform doesn't distort them.
       Capture phase, so the prototype's own handlers can't swallow the event. */
    const taps = [];
    const tapDoc = p.iframe.contentDocument;
    const onTap = (e) => taps.push({ x: e.clientX, y: e.clientY, t: performance.now() });
    if (cfg.taps) tapDoc.addEventListener("pointerdown", onTap, true);

    const out = document.createElement("canvas");
    out.width = bezel.width;
    out.height = bezel.height;
    const ctx = out.getContext("2d");

    const sx = g.x * out.width, sy = g.y * out.height;
    const sw = g.w * out.width,  sh = g.h * out.height;
    const radii = [{ x: g.radius.x * sw, y: g.radius.y * sh }];
    const inner = p.iframe.contentWindow;
    const tapX = sw / (inner.innerWidth || sw), tapY = sh / (inner.innerHeight || sh);

    const ripple = TAP_R * sw;
    const drawTaps = (ctx2, now) => {
      for (let i = taps.length - 1; i >= 0; i--) {
        const k = (now - taps[i].t) / TAP_MS;
        if (k >= 1) { taps.splice(i, 1); continue; }       // expired; list stays short
        const cx = sx + taps[i].x * tapX, cy = sy + taps[i].y * tapY;
        const fade = 1 - k;
        ctx2.beginPath();
        ctx2.arc(cx, cy, ripple * (0.35 + 0.65 * k), 0, Math.PI * 2);
        ctx2.fillStyle = "rgba(255,255,255," + (0.16 * fade).toFixed(3) + ")";
        ctx2.fill();
        ctx2.lineWidth = Math.max(2, sw * 0.005);
        ctx2.strokeStyle = "rgba(255,255,255," + (0.85 * fade).toFixed(3) + ")";
        ctx2.stroke();
      }
    };

    let raf = 0, last = -1e9;
    const minGap = 1000 / fps;
    const draw = (t) => {
      raf = requestAnimationFrame(draw);
      if (t - last < minGap) return;   // compositing 3.5MP at display rate is what melted it
      last = t;
      ctx.clearRect(0, 0, out.width, out.height);
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(sx, sy, sw, sh, radii);
      ctx.clip();
      ctx.drawImage(video, sx, sy, sw, sh);               // screen, clipped inside the outline...
      drawTaps(ctx, performance.now());                                   // ripples ride inside the same clip
      ctx.restore();
      ctx.drawImage(bezel, 0, 0, out.width, out.height);  // ...then the frame over the top of it
    };
    draw(0);

    const rec = new MediaRecorder(out.captureStream(fps), { mimeType: mime, videoBitsPerSecond: bitrate });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.start(1000);

    state.rec = rec;
    state.chunks = chunks;
    state.startedAt = performance.now();
    state.stop = () => {
      cancelAnimationFrame(raf);
      try { tapDoc.removeEventListener("pointerdown", onTap, true); } catch (e) {}
      srcStream.getTracks().forEach((t) => t.stop());
      video.remove();
      bezel.close();
      undoSize();
    };

    // The clip is junk if the Preview closes mid-record — bail rather than save black frames.
    state.watch = setInterval(() => { if (!parts()) finish(true); }, 1000);
    paint();
  }

  function finish(discard) {
    const { rec, chunks } = state;
    if (!rec) return;
    clearInterval(state.watch);
    rec.onstop = () => {
      state.stop();
      const blob = new Blob(chunks, { type: rec.mimeType });
      Object.assign(state, { rec: null, chunks: null, stop: null, watch: null });
      paint();
      if (discard) return note("Preview closed — recording discarded");
      if (!blob.size) return note("Empty recording — try again with the prototype animating");
      save(blob);
    };
    rec.stop();
  }

  function save(blob) {
    const ext = blob.type.includes("mp4") ? "mp4" : "webm";
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `figma-prototype-${stamp}.${ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    note(`Saved ${(blob.size / 1e6).toFixed(1)} MB`);
  }

  /* ---- UI --------------------------------------------------------------
     A fixed pill, deliberately OUTSIDE the modal: anything inside it would get
     shrunk by the scale transform along with the preview. */

  const CHIP = [
    "position:fixed", "z-index:2147483647", "right:24px",
    "align-items:center", "gap:10px",
    "padding:10px 16px", "border-radius:999px",
    "background:#1e1e1e", "color:#fff", "border:1px solid #383838",
    "font:500 13px/1 Inter,system-ui,sans-serif",
    "box-shadow:0 6px 24px rgba(0,0,0,.4)", "user-select:none",
  ].join(";");

  const pill = document.createElement("div");
  pill.style.cssText = CHIP + ";bottom:24px;cursor:pointer;display:none";
  pill.onclick = () => (state.rec ? finish(false) : start());

  const dot = document.createElement("span");
  dot.style.cssText = "width:10px;height:10px;border-radius:50%;background:#ff4d4d;display:inline-block";
  const label = document.createElement("span");
  pill.append(dot, label);

  const toast = document.createElement("div");
  toast.style.cssText = CHIP + ";top:24px;display:none";

  /* Settings panel, above the pill. It simply hides while recording, which doubles as
     the "locked during a take" affordance without any disabled-state code. Native
     <input type=range> and <select> — no custom widgets to style or keyboard-proof. */
  const panel = document.createElement("div");
  panel.style.cssText = CHIP +
    ";bottom:76px;display:none;flex-direction:column;align-items:stretch;gap:10px" +
    ";padding:14px 16px;width:268px;cursor:default;border-radius:14px";   // CHIP's 999px is a pill, wrong for a panel

  const mkRow = (name) => {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:10px";
    const l = document.createElement("span");
    l.textContent = name;
    l.style.cssText = "opacity:.65;width:78px;flex:none;white-space:nowrap";
    row.append(l);
    panel.append(row);
    return row;
  };

  const mkSlider = (name, key, min, max, step, fmt) => {
    const row = mkRow(name);
    const input = document.createElement("input");
    input.type = "range";
    input.min = min; input.max = max; input.step = step; input.value = cfg[key];
    input.style.cssText = "flex:1;min-width:0;accent-color:#ff4d4d";
    const valEl = document.createElement("span");
    valEl.style.cssText = "width:64px;flex:none;text-align:right;font-variant-numeric:tabular-nums";
    const sync = () => { valEl.textContent = fmt(cfg[key]); };
    input.oninput = () => { cfg[key] = +input.value; sync(); info(); saveCfg(); };
    sync();
    row.append(input, valEl);
  };

  mkSlider("Frame rate", "fps", 15, 60, 5, (v) => v + " fps");
  mkSlider("Quality", "mbps", 4, 40, 2, (v) => v + " Mbps");

  const codecSel = document.createElement("select");
  codecSel.style.cssText =
    "flex:1;min-width:0;background:#2a2a2a;color:#fff;border:1px solid #444;border-radius:6px;padding:5px 6px;font:inherit";
  for (const c of CODECS) {
    const o = document.createElement("option");
    o.value = c.mime;
    o.textContent = c.label;
    codecSel.append(o);
  }
  codecSel.value = cfg.mime;
  codecSel.onchange = () => { cfg.mime = codecSel.value; saveCfg(); };
  mkRow("Codec").append(codecSel);

  const tapsRow = document.createElement("label");
  tapsRow.style.cssText = "display:flex;align-items:center;gap:10px;cursor:pointer;opacity:.85";
  const tapsBox = document.createElement("input");
  tapsBox.type = "checkbox";
  tapsBox.checked = !!cfg.taps;
  tapsBox.style.cssText = "accent-color:#ff4d4d;width:15px;height:15px;flex:none;margin:0";
  tapsBox.onchange = () => { cfg.taps = tapsBox.checked; saveCfg(); };
  tapsRow.append(tapsBox, document.createTextNode("Show taps"));
  panel.append(tapsRow);

  const hint = document.createElement("div");
  hint.style.cssText = "font-size:11px;line-height:1.4";
  function info() {
    if (!CODECS.length) {
      hint.textContent = "This browser can't record video.";
      hint.style.color = "#ffb454";
      return;
    }
    // The warning is not decoration: 60fps at 40Mbps really did take the renderer out.
    const risky = cfg.fps >= 50 && cfg.mbps >= 28;
    const perMin = Math.round((cfg.mbps / 8) * 60);
    hint.textContent = risky
      ? "~" + perMin + " MB/min — this can crash the tab on a long take"
      : "~" + perMin + " MB/min";
    hint.style.color = risky ? "#ffb454" : "#fff";
    hint.style.opacity = risky ? "1" : ".55";
  }
  info();
  panel.append(hint);

  function note(msg) {
    toast.textContent = msg;
    toast.style.display = "flex";
    clearTimeout(note.t);
    note.t = setTimeout(() => (toast.style.display = "none"), 4000);
  }

  function paint() {
    if (!state.rec) { label.textContent = "Record HQ"; dot.style.animation = ""; return; }
    const s = Math.floor((performance.now() - state.startedAt) / 1000);
    label.textContent = `Stop  ${String((s / 60) | 0).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
    dot.style.animation = "fighqPulse 1s infinite";
  }

  const style = document.createElement("style");
  style.textContent = "@keyframes fighqPulse{50%{opacity:.25}}";
  document.documentElement.append(style, pill, panel, toast);
  paint();   // without this the label is empty until the first recording starts

  // ponytail: a 1s poll, not a MutationObserver. Figma rebuilds this subtree
  // constantly; observing it costs more than one cheap querySelector a second.
  setInterval(() => {
    const open = !!parts();
    pill.style.display = open || state.rec ? "flex" : "none";
    panel.style.display = open && !state.rec ? "flex" : "none";
    paint();
  }, 1000);
})();
