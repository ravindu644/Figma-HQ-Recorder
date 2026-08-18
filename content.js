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

  const FPS = 60;
  const BITRATE = 40_000_000;   // ponytail: one constant, not a settings page. Raise it if 3.5MP@60 looks soft.
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
    const bezel = modal.querySelector(SEL.bezel);
    const iframe = modal.querySelector(SEL.iframe);
    if (!bezel || !iframe) return null;
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

  /* Figma rounds the screen with a percentage radius. Left unclipped, the square
     corners of the screen paint over the bezel's rounded ones. */
  function cornerRadius(p) {
    const box = p.screenBox;
    if (!box) return 0;
    const raw = getComputedStyle(box).borderTopLeftRadius;
    const pct = parseFloat(raw);
    if (!pct) return 0;
    // ponytail: CSS makes this an ellipse (6% of width x 6% of height); we use one
    // circular radius off the width. Visually identical at these corner sizes.
    return raw.includes("%") ? pct / 100 : pct / box.getBoundingClientRect().width;
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

  /* ---- recording ------------------------------------------------------- */

  const state = { rec: null, chunks: null, stop: null, startedAt: 0 };

  async function start() {
    let p = parts();
    if (!p) return note("Open the Preview first (Shift+Space)");
    if (document.hidden) return note("Bring the tab to the foreground — Figma throttles background rendering");

    const undoSize = goNative(p);
    await sleep(1200);              // let Figma reallocate and repaint the canvas

    p = parts();                    // the canvas node can be replaced by the resize
    if (!p) { undoSize(); return note("Lost the Preview while resizing"); }

    const g = geometry(p);
    let bezel;
    try {
      bezel = await createImageBitmap(await (await fetch(p.bezel.src)).blob());
    } catch (e) {
      undoSize();
      return note("Couldn't load the device frame image");
    }

    // The WebGL canvas has no readable buffer (finding 3) — go through a stream.
    const srcStream = p.canvas.captureStream(FPS);
    const video = document.createElement("video");
    video.srcObject = srcStream;
    video.muted = true;
    video.playsInline = true;
    await video.play();

    const out = document.createElement("canvas");
    out.width = bezel.width;
    out.height = bezel.height;
    const ctx = out.getContext("2d");

    const sx = g.x * out.width, sy = g.y * out.height;
    const sw = g.w * out.width,  sh = g.h * out.height;
    const r = g.radius * sw;

    let raf = 0;
    const draw = () => {
      ctx.drawImage(bezel, 0, 0, out.width, out.height);
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(sx, sy, sw, sh, r);
      ctx.clip();
      ctx.drawImage(video, sx, sy, sw, sh);
      ctx.restore();
      raf = requestAnimationFrame(draw);
    };
    draw();

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

  const pill = document.createElement("div");
  pill.style.cssText = [
    "position:fixed", "z-index:2147483647", "right:24px", "bottom:24px",
    "display:none", "align-items:center", "gap:10px",
    "padding:10px 16px", "border-radius:999px",
    "background:#1e1e1e", "color:#fff", "border:1px solid #383838",
    "font:500 13px/1 Inter,system-ui,sans-serif", "cursor:pointer",
    "box-shadow:0 6px 24px rgba(0,0,0,.4)", "user-select:none",
  ].join(";");
  pill.onclick = () => (state.rec ? finish(false) : start());

  const dot = document.createElement("span");
  dot.style.cssText = "width:10px;height:10px;border-radius:50%;background:#ff4d4d;display:inline-block";
  const label = document.createElement("span");
  pill.append(dot, label);

  const toast = document.createElement("div");
  toast.style.cssText = pill.style.cssText
    .replace("bottom:24px", "bottom:80px")
    .replace("display:none", "display:none")
    .replace("cursor:pointer", "cursor:default");

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

  // ponytail: a 1s poll, not a MutationObserver. Figma rebuilds this subtree
  // constantly; observing it costs more than one cheap querySelector a second.
  setInterval(() => {
    pill.style.display = parts() || state.rec ? "flex" : "none";
    if (state.rec) paint();
  }, 1000);
})();
