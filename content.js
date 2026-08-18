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
 */
(() => {
  if (window.__figHQRecorder) return;
  window.__figHQRecorder = true;

  const FPS = 30;
  // ponytail: 30fps @ 12Mbps on a ~3.5MP canvas. Measured ceiling, not a guess —
  // 60fps @ 40Mbps crashed the renderer (SIGILL) on a two-minute take. Raise both
  // only if you also shorten the recording.
  const BITRATE = 12_000_000;
  const MIME = [
    "video/mp4;codecs=avc1",    // first choice: universal, and reliable off a WebGL canvas
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
  ];

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

  /* Figma clips the screen with `border-radius: 6%; overflow: hidden`. Left unclipped
     the square screen corners paint over the bezel's curve.

     This radius is ELLIPTICAL, and that matters. A CSS percentage radius resolves
     horizontally against width and vertically against height, so "6%" on a
     1206x2622 screen means 72px across and 157px down — the vertical radius is
     2.25x the horizontal. Clipping with a single circular 72px radius leaves the
     content bulging past the frame at every corner. Returned as fractions of the
     screen box so it survives the resize to native. */
  function cornerRadius(p) {
    const box = p.screenBox;
    if (!box) return { x: 0, y: 0 };
    const rect = box.getBoundingClientRect();
    const parts = getComputedStyle(box).borderTopLeftRadius.split(/\s+/);
    const frac = (v, base) => (v.endsWith("%") ? parseFloat(v) / 100 : parseFloat(v) / base) || 0;
    return {
      x: frac(parts[0], rect.width),
      y: frac(parts[1] ?? parts[0], rect.height),
    };
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
    if (document.hidden) return note("Bring the tab to the foreground — Figma throttles background rendering");

    const undoSize = goNative(p);
    await sleep(1200);              // let Figma reallocate and repaint the canvas

    p = parts();                    // the canvas node can be replaced by the resize
    if (!p) { undoSize(); return note("Lost the Preview while resizing"); }

    // The WebGL canvas has no readable buffer (finding 3) — go through a stream.
    const srcStream = p.canvas.captureStream(FPS);
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

    const out = document.createElement("canvas");
    out.width = bezel.width;
    out.height = bezel.height;
    const ctx = out.getContext("2d");

    const sx = g.x * out.width, sy = g.y * out.height;
    const sw = g.w * out.width,  sh = g.h * out.height;
    const radii = [{ x: g.radius.x * sw, y: g.radius.y * sh }];

    let raf = 0, last = -1e9;
    const minGap = 1000 / FPS;
    const draw = (t) => {
      raf = requestAnimationFrame(draw);
      if (t - last < minGap) return;   // compositing 3.5MP at display rate is what melted it
      last = t;
      ctx.drawImage(bezel, 0, 0, out.width, out.height);
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(sx, sy, sw, sh, radii);
      ctx.clip();
      ctx.drawImage(video, sx, sy, sw, sh);
      ctx.restore();
    };
    draw(0);

    const mime = MIME.find((m) => MediaRecorder.isTypeSupported(m));
    const rec = new MediaRecorder(out.captureStream(FPS), { mimeType: mime, videoBitsPerSecond: BITRATE });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.start(1000);

    state.rec = rec;
    state.chunks = chunks;
    state.startedAt = performance.now();
    state.stop = () => {
      cancelAnimationFrame(raf);
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
  toast.style.cssText = CHIP + ";bottom:80px;display:none";

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
  document.documentElement.append(style, pill, toast);
  paint();   // without this the label is empty until the first recording starts

  // ponytail: a 1s poll, not a MutationObserver. Figma rebuilds this subtree
  // constantly; observing it costs more than one cheap querySelector a second.
  setInterval(() => {
    pill.style.display = parts() || state.rec ? "flex" : "none";
    paint();
  }, 1000);
})();
