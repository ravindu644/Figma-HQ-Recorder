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
2. Set frame rate, quality, and codec in the panel (bottom right)
3. Click **Record HQ**
4. Click through your prototype
5. Click **Stop** — the video downloads automatically

The panel hides while recording, since the encode is already running. Choices persist in `localStorage`.

| control | range | default |
|---|---|---|
| Frame rate | 15-60 fps | 30 |
| Quality | 4-40 Mbps | 12 |
| Codec | whichever of MP4/H.264, WebM/VP9, WebM/AV1, WebM/VP8 the browser supports | MP4/H.264 |
| Show taps | on/off | on |

MP4/H.264 leads for a reason: it's the most portable, and VP8 can silently capture an empty clip off a WebGL canvas. Codecs the browser can't encode are dropped from the list rather than offered and then failing at record time.

The panel shows an estimated MB/min and turns amber past 50fps/28Mbps — 60fps at 40Mbps on a 3.5-megapixel canvas crashed the renderer outright on a two-minute take.

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

### Taps

The mouse cursor is never in the canvas — Figma renders content only — so taps are drawn rather than captured. The preview iframe is same-origin, so a capture-phase `pointerdown` listener on it records each tap, and the draw loop composites an expanding ripple that fades over ~520ms. Ripples are drawn inside the same clip as the screen, so they can't spill onto the bezel.

Coordinates need no correction. The iframe's internal viewport is the unscaled layout size, and the outer `transform: scale()` doesn't affect measurements taken inside it — so a tap at `(clientX, clientY)` maps 1:1 into the composite. Verified with a real click through a 0.2785 transform: expected (603, 918), captured (601.5, 917.0).

Ripples appear in the recording only, not in the live preview.

### Getting the corners right

This took two fixes, not one.

The bezel PNG is 89% transparent, and the Dynamic Island is baked into it as an opaque shape *inside* the screen cutout — the asset is meant to be drawn **over** the screen. So the screen is drawn first and the frame on top of it, which makes the inner edge and the island exact for free.

That alone isn't enough. The screen cutout and the area *outside* the device are both `alpha == 0`, so an unclipped screen leaks out through the rounded outer corners. The screen also has to be clipped first — with an **elliptical** radius, because Figma's `border-radius: 6%` resolves horizontally against width and vertically against height: 72px across but 157px down at native size.

Measured on this device frame — content painted over the frame / content leaking outside the device:

| draw order | clip | artifact |
|---|---|---|
| frame first, screen on top | circular 72 | 64,784 px |
| frame first, screen on top | elliptical 72x157 | 59,804 px |
| screen first, frame on top | none | 4,460 px |
| **screen first, frame on top** | **elliptical 72x157** | **0** |

The cutout measures x 52..1257, y 44..2665 — exactly the rect derived from the DOM.

## Resolution ceiling

Output is the bezel PNG's native size — around 1310×2710, varying by device. The screen is rendered by Figma at that size, so it's vector-crisp; the bezel is at 1:1 with its source asset. Push beyond it and the bezel is what softens first.

## Known limits

- Chromium only (Chrome, Brave, Edge, Vivaldi). Firefox needs manifest changes.
- No audio yet.
- MP4 comes out of `MediaRecorder` fragmented. Chrome reads the duration correctly, but some other players may scrub poorly; a remux pass would fix that.
- Defaults are 30fps / 12 Mbps. Not arbitrary — see above. The sliders go higher and warn you when they get there.
- Requires a device frame to be set in Figma's Prototype tab. Without one there's no bezel to composite.
- The Dynamic Island is drawn over your content, because it's part of the frame asset. Figma's own preview hides it behind the screen; a real phone doesn't.
- Dragging the preview window while it's scaled can feel offset — Figma's drag math doesn't know about the transform.

## Prior art

Inspired by [Figma Prototype Preview Recorder](https://chromewebstore.google.com/detail/figma-prototype-preview-r/bcdaeeofamnlimhjcnapbegkbjdkcdjo) by Fabio Piparo, which records the canvas only. No code from it is used here — that extension ships without a license. This is an independent implementation.

## License

MIT
