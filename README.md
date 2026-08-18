# Figma HQ Prototype Recorder

Records the Figma inline Preview to video **at the device frame's native resolution, with the device bezel included**.

Existing recorders capture Figma's WebGL canvas, which contains the screen and nothing else — so the iPhone/Android frame around it is always missing, and the output is capped at whatever size the preview happens to be on screen. This one composites the bezel back in and records at full resolution regardless of your monitor.

## Install

No build step, no dependencies.

1. `chrome://extensions` (or `brave://extensions`)
2. Enable **Developer mode**
3. **Load unpacked** → select this folder

## Use

1. Open a Figma design and press **Shift+Space** for the inline Preview
2. Click **Record HQ** (bottom right)
3. Click through your prototype
4. Click **Stop** — the video downloads automatically

The preview briefly resizes itself to native resolution and scales back down visually. It stays the same size on screen and stays clickable while recording.

## How it works

Figma builds the Preview like this:

```
DIV.previewDeviceContainer
├── IMG.previewDeviceImage      the bezel — a plain PNG, ~1310x2710 native
└── DIV.iframeContainer         border-radius: 6%
    └── IFRAME.previewIframe
        └── CANVAS              WebGL2 — the screen, and only the screen
```

The bezel is a sibling `<img>`, not canvas pixels. So instead of recording the canvas, we draw the bezel and the screen into one canvas and record that.

Three things make it work, each verified against a live prototype:

**The canvas backing store follows the modal's layout box, not the viewport.** Setting the modal to 1310px wide produces a 1206×2622 backing store on an 1100×873 screen — and Figma genuinely renders into all of it, including the parts scrolled off screen.

**A CSS `transform: scale()` shrinks the modal visually without shrinking that layout box.** Transforms are paint-time; layout is untouched. So the recording stays native-res while the preview stays a comfortable size and clicks still land where you expect.

**`drawImage()` straight off the WebGL canvas returns blank.** Figma allocates it without `preserveDrawingBuffer`, so the buffer is already gone. `captureStream()` → `<video>` → `drawImage()` is the route that actually has pixels in it.

Screen position, size, and corner radius are all measured from the DOM at record time rather than hardcoded, so switching device frames needs no code changes.

The corner clip is elliptical, not circular. Figma uses `border-radius: 6%`, and a CSS percentage radius resolves horizontally against width but vertically against height — on a 1206x2622 screen that's 72px across and 157px down. Clipping with a single circular radius leaves the content bulging past the frame at every corner.

## Resolution ceiling

Output is the bezel PNG's native size — around 1310×2710, varying by device. The screen is rendered by Figma at that size, so it's vector-crisp; the bezel is at 1:1 with its source asset. Push beyond it and the bezel is what softens first.

## Known limits

- Chromium only (Chrome, Brave, Edge, Vivaldi). Firefox needs manifest changes.
- No audio yet.
- MP4 comes out of `MediaRecorder` fragmented. Chrome reads the duration correctly, but some other players may scrub poorly; a remux pass would fix that.
- Recording is capped at 30fps / 12 Mbps by default. Those aren't arbitrary — 60fps at 40 Mbps on a 3.5-megapixel canvas crashed the renderer outright on a two-minute take.
- Requires a device frame to be set in Figma's Prototype tab. Without one there's no bezel to composite.
- Dragging the preview window while it's scaled can feel offset — Figma's drag math doesn't know about the transform.

## Prior art

Inspired by [Figma Prototype Preview Recorder](https://chromewebstore.google.com/detail/figma-prototype-preview-r/bcdaeeofamnlimhjcnapbegkbjdkcdjo) by Fabio Piparo, which records the canvas only. No code from it is used here — that extension ships without a license. This is an independent implementation.

## License

MIT
