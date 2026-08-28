# Image Editor — Studio Image (prototype)

One page, one job: an employee uploads one factory-background furniture
photograph and gets back one catalogue-style product image.

The provider removes the background. **BOE builds the picture.**

Not linked from the module launcher and not registered in `app_modules`. It is
reached directly at **`/image-editor`** and is open to any signed-in BOE user —
deliberately, so the prototype adds no Control Center permission, no migration
and no row anybody would later have to unpick.

## What it does

Choose **one to five** photographs (JPG / PNG / WebP, up to 10 MB each) → pick an
output shape → **Generate** → images are processed **one at a time**, each
appearing as it finishes → compare, download in PNG / JPG / WebP, or **Edit
another set**.

Nothing is stored. Uploads are read into memory, sent to the provider, and the
results come back in the response body as data URIs. No bucket, no table, no
file on disk, no history — closing the tab loses everything.

### The queue

| Rule | Why |
| --- | --- |
| Five images maximum | Each is a separate paid request. |
| Nothing is sent when an image is chosen | Selection does nothing until Generate is pressed; the row says "Waiting". |
| One bad file never costs a good one | A rejected file is named and dropped; the rest stay queued. |
| One request at a time, in order | Five at once is five charges racing each other and a failure that is hard to report honestly. |
| A failure never costs a success | Results are kept per item, so an image that fails fourth leaves the first three downloadable. |
| Retry is manual | A person presses it. Nothing here retries on its own, ever. |

### Generating

**Generate** starts the run directly — one press, one image each. The button
reads *Generate Studio Image* or *Generate 3 Studio Images*.

The screen says nothing about providers, requests, credits or cost: an employee
is preparing a catalogue photograph, not administering an account. The guard
against a second run is a ref rather than state, because state updates on the
next render and two presses in one frame would otherwise both start a run.
Verified in Chromium: six rapid presses on a two-image queue produce exactly two
requests.

## How the image is made

**One provider call per photograph, and it does one thing: it removes the
background.** Everything else is arithmetic, done locally.

```
upload ─▶ prepareSource ─▶ fal-ai/bria/background/remove ─▶ transparent PNG
                                                                │
                     ┌──────────────────────────────────────────┘
                     ▼
   crop to the product ─▶ quality gate ─▶ defringe ─▶ tone ─▶ scale ─▶ sharpen
                     ─▶ shadows ─▶ composite on a locally drawn sweep ─▶ PNG
```

`POST https://fal.run/fal-ai/bria/background/remove`, synchronous. The
photograph travels as a **data URI inside the request body**, so no publicly
accessible URL for it is ever created; `sync_mode: true` asks for the cut-out
the same way, which also keeps it out of fal's request history.

The request body has exactly two fields:

| Field | Value |
| --- | --- |
| `image_url` | the prepared photograph, as a data URI |
| `sync_mode` | `true` |

There is no prompt, no scene description, no placement, no `shot_size`, no
result count. There is nothing for one to be — the endpoint segments an image.

### Why the model no longer composes anything

It was asked to, twice, and it would not.

| Attempt | What came back |
| --- | --- |
| First paid Product Shot result | A small chair inside a **circular decorative backdrop** nobody asked for. |
| Second, after the scene description was rewritten to BOE's approved reference | The circle was gone; the chair had shrunk to roughly **20% occupancy** against a required 65%. |

Neither followed the composition, and the composition is the specification. So
the division of labour changed: **the model segments, which it does reliably;
BOE places, which is arithmetic.** The framing is now a set of constants in
`outputPresets.ts` applied by `composeStudioImage.ts` — the same photograph
produces the same framing every time, because the framing is no longer a request
somebody hopes will be honoured.

That also removed the whole `manual_placement` / `manual_padding` question. It
had no good answer: `padding_values` is deterministic, but it is padding around
the product **cutout**, and Bria's own note says to get the cutout first and
size the padding from it — a second billable request per image. There is nothing
left to decide, because nothing is asked for.

### Output shapes and the approved composition

Three, and the browser chooses between them by NAME. `outputPresets.ts` is the
only place a name becomes pixels, and an unrecognised name resolves to the
default. The canvas is drawn locally, so the shape costs nothing either way.

**Landscape 3:2 is the default** — it is the shape of the approved reference.

| Preset | Canvas | Product height | Top | Feet baseline | Centre |
| --- | --- | --- | --- | --- | --- |
| **Landscape 3:2** (default) | `1200 × 800` | 520 px (65%) | 168 px (21%) | 688 px (86%) | x 600 |
| Square 1:1 | `1000 × 1000` | 650 px (65%) | 210 px (21%) | 860 px (86%) | x 500 |
| Portrait 4:5 | `900 × 1125` | 731 px (65%) | 236 px (21%) | 968 px (86%) | x 450 |

The same proportions on every shape, so a product looks the same size whichever
canvas it lands on. Verified by test on all three: the product is **placed** at
exactly 65.0% / 21.0% / 14.0%, centred to within half a pixel, touching no edge.

`measureComposition` reads that back as about **66% / 21% / 13%**, and the
difference is not a placement error — it is the contact shadow. The measurement
finds the product by contrast against the background, and the darkest part of a
grounding shadow crosses that threshold, so a few rows under the feet are
counted as product. It is the blind spot the module already documents, and it
grew slightly when the shadow was strengthened. The placement metrics are the
authority on framing; the measurement is the check that nothing has drifted.

**One product does not get the 65%.** A very wide piece — a long sideboard — is
wider than the canvas at that height, so it is limited by the width instead
(a 6% margin at each side) and comes back shorter than 65% and **whole**, rather
than exactly 65% and cut off at both ends. It still stands on the same baseline,
because the placement is anchored on the feet.

### The quality gate

A cut-out smaller than the frame has to be enlarged, and enlarging invents
nothing — it spreads the pixels the camera recorded over more of them. Measured
on real results, 2.11× enlargement cost 71% of the detail, which is what the
earlier blurry outputs were.

So enlargement is capped at **1.15×**, and a photograph whose product is too
small is **refused** rather than blurred, with the height it would have needed:

> The product is too small in this photograph to make a sharp catalogue image.
> Take the photograph closer to the product, or upload a higher-resolution
> photograph, and try again.

The refusal is marked `noRetry` — the same photograph will be the same size next
time, and each press costs a request.

### What the local composition does, and what it refuses to do

| Step | What it does | The rule it keeps |
| --- | --- | --- |
| Crop | Tight bounding box from alpha, at a low threshold with a 3-pixel density floor | A stray speck does not stretch the box; a two-pixel chair leg is inside it |
| Defringe | Replaces the RGB of soft edge pixels with the colour of the solid product just inside | **Alpha is never modified** — no erosion, no choke, no thinned cane or spindles |
| Tone | Exposure and contrast from the product's **own** statistics, over solid pixels only | Bounded 0.94×–1.35×, vetoed by the 98th percentile so white upholstery keeps its texture; an already-lit photograph receives almost nothing |
| Scale | One Lanczos resize, both axes by one factor | Nothing is ever stretched |
| Sharpen | Confined to an interior mask (the alpha, blurred and hard-thresholded) | No bright halo tracing the cut-out edge |
| Shadows | A contact smear at each foot **at its own height**, plus one soft cast pool from the footprint | Four feet cast four shadows with floor between them, not one oval that reads as a plinth |
| Background | A radial warm-neutral sweep drawn pixel by pixel | Continuous by construction — there is nothing in the function that could draw a horizon |

Nothing is rotated, warped, skewed, redrawn or invented. An existing watermark in
the source is product pixels like any other and passes through untouched.

`measureComposition` (`composition.ts`) is how a finished image is checked
against the table above: it finds the product against the plain background and
reports height, margins, feet baseline and centring. The smoke script prints it
after every real request.

### A note on sharp

sharp orders its operations internally, not by call order, and this has caused
**four** real defects in this module — enough that it is written down rather than
remembered:

- `linear` after extract+resize did not apply at all;
- `flatten` chained onto `composite` ran **before** the compositing it was meant
  to follow, leaving an alpha channel on an image that would print black;
- `removeAlpha` chained with `joinChannel` dropped alpha;
- a shadow built as `create` → `joinChannel` → `extend` → `blur` came out
  *fainter* when its opacity was raised.

There is a fifth, different trap in the same family: sharp reads a raw
**single-channel** buffer as sRGB and hands back **three** channels, so `mask[i]`
afterwards is the red channel of pixel `i/3`. Two masks hit this — the defringe's
weight mask and the sharpening guard — and neither failure was visible in the
output: the defringe quietly stopped defringing and the guard quietly stopped
guarding. Where order or channel count matters, each step is now its own
pipeline, and `blurMask` is the one way a mask is blurred.

### Why plain `fetch` and not `@fal-ai/client`

The official client's `run()` retries automatically — `maxRetries: 3` over 429,
502, 503 and 504 (`src/client.js`, `src/retry.js` in `@fal-ai/client` 1.10.1).
On a chargeable call that turns one button press into as many as four billed
requests. The adapter is therefore one `POST` with no retry. The contract it
implements was read out of that same package rather than from memory:
`https://fal.run/<id>`, `Authorization: Key <credentials>`, the input as the JSON
body, `x-fal-request-id` on the response, and `BGRemoveInput` / `BGRemoveOutput`
for the shapes — one image back, not an array.

## Cost controls

- One press of Generate is **one background-removal request** per photograph.
  The composition that follows is local and costs nothing, so the output shape,
  the three download formats and any re-download are all free.
- A ref guard on the page blocks a second submission in the same frame, and the
  button is disabled while a request is in flight. Verified in Chromium: six
  rapid presses on a two-image queue produce exactly two requests.
- The adapter **never retries** — including after a timeout, because a request
  that may already have been billed must not be billed again silently.
- The existing per-user rate limiter (6 per minute) is unchanged.
- An image beyond fal's 12 MB ceiling is refused locally rather than paid for
  and refused there.
- A quality refusal is marked `noRetry`, so the page offers a different
  photograph rather than another paid attempt at the same one.
- Each request logs fal's request id, the duration and the outcome category —
  never the image, the data URI or the key.

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `FAL_KEY` | yes | Server-side key for fal.ai. Without it the page says the service is not set up and generates nothing. |

Get one from <https://fal.ai/dashboard/keys>. Put it in `.env.local` (or the
deployment's environment) — never in a `NEXT_PUBLIC_` variable.

## The pieces

| File | What it holds |
| --- | --- |
| `src/lib/imageEditor/validation.ts` | What counts as an uploadable photograph. Used by the browser AND the route, so the two cannot disagree. |
| `src/lib/imageEditor/prepareSource.ts` | EXIF orientation baked in when required. Otherwise the original bytes, untouched, up to 8192px. Server-only (sharp). |
| `src/lib/imageEditor/briaBackgroundRemove.ts` | The only code that talks to a provider: the endpoint, the two-field body, and the failure mapping. Nothing generative. |
| `src/lib/imageEditor/cutoutGeometry.ts` | Where the product is, how big it may be drawn, and whether it may be enlarged. Pure — no sharp, no provider. |
| `src/lib/imageEditor/productTone.ts` | The exposure and contrast decision, measured from the product's own pixels. Pure. |
| `src/lib/imageEditor/composeStudioImage.ts` | The studio image itself: background, placement, shadows, sharpening. Server-only (sharp). No network. |
| `src/lib/imageEditor/composition.ts` | Measures a finished image against the approved composition. Used by tests and the smoke script, never in the request path. |
| `src/lib/imageEditor/outputPresets.ts` | The three output shapes. The only place a preset name becomes pixels. |
| `src/lib/imageEditor/queue.ts` | The selection rules: the five-image ceiling, what a run would cost, what may be sent next, and how a result is recorded without disturbing the others. Pure. |
| `src/lib/imageEditor/downloadFormats.ts` | Which download formats exist, and the guard. Client-safe. |
| `src/lib/imageEditor/imageFormats.ts` | The sharp re-encoder behind the download menu. Server-only. |
| `src/app/api/image-editor/convert/route.ts` | Re-encodes a finished image for download. Never calls fal, holds no provider key. |
| `src/app/image-editor/QueueList.tsx`, `ResultCard.tsx` | The queue rows and the per-result actions. |
| `src/app/api/image-editor/studio/route.ts` | Auth, rate limit, validation, the one provider call, then the local composition. Holds the API key; returns the image. |
| `src/lib/imageEditor/noProductShot.test.ts` | Walks the whole runtime tree and fails if the generative endpoint reappears in any spelling. |
| `src/app/image-editor/page.tsx` | The screen. |
| `src/components/layout/ImageEditorLayout.tsx` | The module shell, per the BOE Module Layout Standard. |
| `scripts/image-editor-smoke.mjs` | One real request from the command line. Chargeable. |

## Failures the employee can act on

fal's own response text never reaches the browser or the log — only a category,
a status code and the request id.

| What happened | HTTP | What the page says |
| --- | --- | --- |
| No key configured | 200 `configured:false` | not set up yet — ask an administrator |
| Key refused (401 / 403) | 503 | credentials rejected — ask an administrator |
| Out of credit (402, or 403 naming a balance) | 503 | no credit left — ask an administrator to top up |
| Unreadable or oversized image (400 / 413 / 415 / 422) | 422 | try a different photograph |
| Moderation refusal | 422 | the service declined this photograph — try another |
| Rate limited (429) | 429 | busy — wait a moment and try again |
| Timed out | 504 | taking longer than expected — try again |
| Empty or malformed result | 422 | no image returned — try again |
| Product too small in the frame | 422 `noRetry` | too small to make a sharp image — take it closer |
| Nothing could be separated out | 422 `noRetry` | try a photograph with the product clearly visible |
| Anything else | 502 | could not process — try again |

### Retry, and when it is not offered

A failure a second press cannot fix is marked **`noRetry`** in the response, and
the result card then offers **Choose a different photo** instead of **Retry**.

That is a cost control, not a cosmetic one. Retry costs another background
removal, so it is only worth offering where the answer could actually change:

- **`noRetry`** — no key configured, a key an administrator must fix, no credit,
  a moderation refusal, and **every local composition refusal**. The local half
  of the pipeline is deterministic: the same photograph segments the same way, a
  product too small in the frame is the same size next time, and an opaque
  cut-out is opaque again. A retry buys a second charge and the identical
  sentence.
- **Retry offered** — busy, timed out, an unexplained provider error. These can
  genuinely differ on the next press.

Nothing retries on its own, in either case. A retry is a person pressing a
button, always.

## Download formats

The locally composed image is the master. PNG downloads hand back exactly those bytes;
JPG and WebP are re-encoded server-side by sharp at quality 95 with no chroma
subsampling. A conversion is a format change and nothing else — same pixels,
same dimensions, asserted by tests — and it **never calls fal**, so downloading
one image in three formats costs one request, not three.

## Verifying against the real API

```bash
FAL_KEY=… npx tsx scripts/image-editor-smoke.mjs chair.jpg studio.png
```

One billable request. It writes the finished PNG, and the intermediate cut-out
alongside it as `<name>-cutout.png` so the two stages can be told apart when a
result looks wrong. It prints the fal request id — check the fal dashboard shows
exactly **one** billed request for it — and then the measured composition, so a
framing regression is a number rather than an impression.

Everything that does not need the provider runs without a key or a network:

```bash
npx tsx --test "src/lib/imageEditor/*.test.ts"          # 190 tests
npx tsx --test src/app/api/image-editor/studio/route.test.ts
```

`composeStudioImage.test.ts` composes real images end to end from cut-outs drawn
in the test file — including a two-pixel leg, a soft edge, feet at different
heights and a product too small for the frame — and measures the result. That is
where a composition change is caught, not in review.
