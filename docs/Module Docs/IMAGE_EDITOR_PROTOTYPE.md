# Image Editor — Studio Image (prototype)

One page, one job: an employee uploads one factory-background furniture
photograph and gets back one catalogue-style product image.

**Bria separates the product. BOE draws everything else.**

Not linked from the module launcher and not registered in `app_modules`. It is
reached directly at **`/image-editor`** and is open to any signed-in BOE user —
deliberately, so the prototype adds no Control Center permission, no migration
and no row anybody would later have to unpick.

## What it does

Choose **one to five** photographs (JPG / PNG / WebP, up to 10 MB each) → pick an
**Generate** → images are processed **one at a time**, each appearing as it
finishes → compare, download in PNG / JPG / WebP, or **Edit another set**.

There is no output shape to choose: the master is square, with enough
surrounding background to crop a landscape or portrait from later.

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

**One provider call.** It removes the background. Everything else is local.

```
upload → prepareSource → [1] fal-ai/bria/background/remove → transparent cut-out
       → measure alpha → quality gate → plan the padding
       → decontaminate the edge → one proportional resize → edge-safe sharpen
       → composite over a locally drawn sweep, with locally drawn shadows
       → 1440 × 1440 master
```

### The rule

**The final visible furniture is the cut-out and nothing else.** It is the top
layer; the background and shadows are drawn beneath it. Every opaque product
pixel in the master is the cut-out's own pixel, and every transparent opening in
the cut-out shows background through it.

That is not a preference. Four paid results settled it:

| Attempt | What came back |
| --- | --- |
| Product Shot, scene description | A small chair inside a circular decorative backdrop. |
| Product Shot, description rewritten | The circle went; the chair shrank to ~20% of the frame. |
| Product Shot with a reference image | **Background, lighting and shadows accepted.** Chair too small. |
| Product Shot with computed padding | Framing correct. **The fan of thin spindles under the seat came back as a dark continuous mass, the openings between them filled, edges smeared.** |

Nothing in `ProductShotInput` preserves product pixels — `original_quality` is
about output *dimensions* under `placement_type: 'original'`, and nothing else
comes close. Placing a product into a generated scene means harmonising it with
that scene's light, and harmonising is repainting. A fan of 3px spindles is
exactly what a generative pass collapses: a plausible dark mass is cheaper to
render than twelve thin separations.

So the model segments, and BOE draws everything else.

### The master

**1440 × 1440**, up from 1000. At 1000 a 1152px product was resampled down to
530 — 46% of its linear detail — before anything else happened to it. The
product is composited locally now, so there is no provider megapixel guidance to
sit under and no reason to throw that away.

| | |
| --- | --- |
| Canvas | 1440 × 1440 |
| Product height | 53%, **763px** |
| Maximum product width | 88%, **1267px** |
| Horizontal centre | **720px** |
| Vertical split | **60:40** above/below — 406px and 271px for a full-height product |

A very wide product is limited by the width instead and comes back shorter than
53% and **whole**, rather than exactly 53% and cropped.

### The background

Drawn pixel by pixel, calibrated against the accepted real outputs. The earlier
local sweep was a near-flat 235/232/227 and read as too cream, too bright and
too flat; this one has somewhere to go.

```
tone(nx, ny) = WALL + (FLOOR − WALL) · smoothstep(0.52, 0.98, ny)     wall into floor
             + LIFT · exp(−(dx² + dy²) / (2 · 0.46² · 0.5))            behind the product
             − FALLOFF · edgeness^1.7                                  corners and sides

  dx = nx − 0.5,  dy = ny − 0.38
  edgeness = min(1, √(0.85·sideness² + 0.95·topness²))
  sideness = min(1, 2|dx|),  topness = max(0, 2(0.5 − ny))

  WALL 178   FLOOR 212   LIFT 17   FALLOFF 32
  warm offsets: r +4, g 0, b −6
```

Measured on the finished sweep:

| Region | Measured | Target |
| --- | --- | --- |
| Upper corners | 148 | 140–160 |
| Side edges, mid height | 155 | 140–160 |
| Centre, behind the product | 187 | 180–190 |
| Floor, centre | 214 | 195–220 |
| Floor, left | 201 | 195–220 |

Warm-neutral throughout (r > g > b, 10 levels of separation — warm, not yellow).
Largest step between adjacent rows: **1 level**, which is quantisation. There is
no wall/floor line because nothing in the function could draw one.

### The shadows

Both are built from the cut-out's own alpha and both sit **behind** it.

**Contact** — the lowest opaque pixel of each column that reaches the floor,
smeared over a short band at *its own height* and blurred. Not one shared
baseline: in a three-quarter view the back feet sit higher than the front ones,
and a shadow on one line under all of them reads as a plinth. Biased down by 0.8
of its half-thickness, so it is not mostly hidden behind the product but still
overlaps the foot and *touches* it. Measured 51 levels deep 4px under a foot,
and 12 levels in the open gap between legs.

**Cast** — one pool from the footprint, leaning right and back. Each foot's
influence spreads sideways as a gaussian (σ = 14% of the product width) and is
clipped to the footprint's own span, so the per-leg pools merge into **one
coherent shadow** that is still denser under the feet than between them. Before
that spread existed, one row below the feet contained **seven separate dark
runs** — detached blobs. It is now two.

Neither is a rectangle and neither is the silhouette: the cast shadow comes from
the columns that touch the floor, never from the whole product.

### Resize and sharpening

One proportional Lanczos resize, both axes by one factor. Nothing is rotated,
stretched, warped or cropped. Then a restrained unsharp (σ 0.8, m1 0.4, **m2
1.2**) confined to an interior mask — the alpha, blurred and hard-thresholded —
so sharpening never crosses the edge and no pale outline forms.

**No tone correction.** The product's colour is the photograph's. The only things
permitted to change a product pixel are the edge decontamination, the
interpolation of that one resize, and the bounded sharpening. Nothing invents
detail; there is no upscaler and no restoration model.

### The enlargement gate

1440 asks for a 763px product where 1000 asked for 530, so the old 1.15× cap was
re-measured rather than carried over. Detail retained against a
native-resolution render, mean absolute Laplacian over a subject with 1px
spindles and a cane lattice:

| | | | |
| --- | --- | --- | --- |
| 1.10× 85.2% | 1.20× 80.8% | **1.30× 77.7% ← the cap** | 1.75× 63.3% ← the cliff |
| 1.15× 82.5% | 1.25× 78.6% | 1.50× 72.1% | 2.00× 57.3% |

**The cap is 1.30×, chosen from real source material rather than from the curve
alone.** BOE's product photographs are around 1000px, and the Irvine chair used
for acceptance testing cut out to **549 × 609**. Reaching 763 from 609 is
**1.253×**, so a cap of 1.20 — or even 1.25 — would refuse the exact photograph
the approved result was built from. A gate that rejects its own reference
subject is a bug, not a quality control.

77.7% retention at 1.30× is a real cost, accepted knowingly. What the cap still
buys is the collapse beyond it: the curve falls away fastest between 1.5 and
1.75, reaching 63%. Severe enlargement is still refused, with the take-it-closer
message. **The cap must not go above 1.30.**

A product must be **588px** tall in the cut-out to pass — the gate works from the
unrounded 763.2, not the placed 763. The enlargement ratio is logged on every
request.

## Verifying the framing

`composition.ts` measures a finished master against the approved composition,
for tests and the smoke script. It is never in the request path.

It measures from **the cut-out's alpha and the placement plan**, not from colour.
The previous version found the product by contrast against the four corners,
which worked while the background was near-flat and broke the moment it became a
real sweep: with corners at 148 and floor at 214, most of the background differs
from the corners by more than the threshold, and it reported a known 53.0%
placement as **71.8%** — it was measuring the gradient.

Alpha has none of that trouble. It says exactly which pixels are product; it
says nothing about the background, whatever the background is doing; it excludes
shadows, because a shadow is not in the cut-out; and it excludes the gaps
between spindles, because those are transparent. A background change cannot move
the numbers, which is the property a verification tool needs.

It answers "is the framing right". It never looks at the background, so it
cannot answer "is the scene clean" — a master still has to be looked at.

## Cost controls

- One press of Generate is **one billable request** per photograph. A queue of
  five is five requests, made one after another. Nothing batches and nothing
  loops — a test asserts one call site and that it is not inside a loop.
- Everything after that call is local and free: the composition, the three
  download formats, any re-download.
- The adapter **never retries**, including after a timeout, because a request
  that may already have been billed must not be billed again silently.
- The per-user rate limiter is 6 a minute, unchanged.
- A product too small for the master is refused **after** the cut-out and
  before anything else, so a photograph that cannot work costs one request.
- An image beyond fal's 12 MB ceiling is refused locally rather than paid for.
- Each request logs fal's request id, the phase, the duration and the outcome
  category — never the image, the data URI or the key.

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
| `src/lib/imageEditor/falRequest.ts` | One request to fal: transport, host allowlist, failure classification, and the no-retry rule. Shared by both stages, so those rules exist once. |
| `src/lib/imageEditor/briaBackgroundRemove.ts` | The one provider call. |
| `src/lib/imageEditor/studioScene.ts` | The sweep, the shadows and the composite. Server-only (sharp). No network. |
| `src/lib/imageEditor/studioMaster.ts` | The master canvas and the padding arithmetic. Pure — no sharp, no provider. |
| `src/lib/imageEditor/cutoutGeometry.ts` | Where the product is in a cut-out, read from raw alpha. Pure. |
| `src/lib/imageEditor/prepareCutout.ts` | Crop to the product, repair its edge, scale it, sharpen inside it. Server-only (sharp). Nothing creative. |
| `src/lib/imageEditor/decontaminateEdges.ts` | Takes the factory background's colour out of partly transparent boundary pixels. Never writes alpha. |
| `src/lib/imageEditor/composition.ts` | Measures a finished image against the intended framing. Used by tests and the smoke script, never in the request path. |
| `src/lib/imageEditor/queue.ts` | The selection rules: the five-image ceiling, what a run would cost, what may be sent next, and how a result is recorded without disturbing the others. Pure. |
| `src/lib/imageEditor/downloadFormats.ts` | Which download formats exist, and the guard. Client-safe. |
| `src/lib/imageEditor/imageFormats.ts` | The sharp re-encoder behind the download menu. Server-only. |
| `src/app/api/image-editor/convert/route.ts` | Re-encodes a finished image for download. Never calls fal, holds no provider key. |
| `src/app/image-editor/QueueList.tsx`, `ResultCard.tsx` | The queue rows and the per-result actions. |
| `src/app/api/image-editor/studio/route.ts` | Auth, rate limit, validation, then the two provider calls with the padding arithmetic between them. Holds the API key; returns the image. |
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
| Timed out (request, body or download) | 504 | took too long — try again in a few minutes |
| Empty or malformed result from the service | 422 | no image returned — try again |
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

The live check is **the app**. `FAL_KEY` is already in `.env.local`, so there is
nothing to type and no key on a command line.

```
npm run dev
```

Then:

1. open `/image-editor`
2. upload the same chair
3. generate **exactly once**

That is **two billable requests**. The fal dashboard should show exactly two for
the run, both with their results attached — which is the point of leaving
`sync_mode` off.

What to look at, in order:

- **The chair should now fill about 53% of the frame height.** That is the one
  defect in the accepted result, and the only thing this change was meant to fix.
- The background, lighting and shadows should be the accepted scene, unchanged.
- There should be clear space on all four sides to crop a landscape or portrait
  from later.
- The product itself — construction, angle, cane, finish, watermark — should be
  the uploaded chair, untouched.

The server log for the run prints both request ids, the computed padding and the
planned height share, so a result that looks wrong can be traced to a stage
rather than guessed at.

### The developer's tool

`scripts/image-editor-smoke.mjs` runs the same two requests without the app and
writes the intermediates — the raw cut-out, the cropped and scaled cut-out that
was actually sent, and the master — which is what to reach for when a result
looks wrong and the stage responsible is not obvious. It reads the key from
`.env.local` too.

```bash
npx tsx scripts/image-editor-smoke.mjs chair.jpg test-results/studio.png
```

It refuses to send anything if the approved reference is missing, so a
misconfigured checkout costs nothing.

### Everything that costs nothing

```bash
npx tsx --test "src/lib/imageEditor/*.test.ts"
npx tsx --test src/app/api/image-editor/studio/route.test.ts
npx tsx --test src/app/image-editor/page.test.ts
```

Two of those are worth knowing about by name:

- `studioMaster.test.ts` runs the padding arithmetic over seven furniture shapes
  — dining chair, lounge chair, tall cabinet, low bench, square stool, long
  sideboard, narrow lamp — and asserts the 52–55% band, exact centring, no
  negative padding for any width/height combination, and that both axes close on
  1000 × 1000.
- `studioPipeline.test.ts` runs the real local path through sharp on cut-outs
  drawn in the test file, including thin legs and an off-centre product in an
  oversized frame, and asserts that the image sent to Bria is exactly the size
  the padding plan assumed. Every defect in this feature so far has been in the
  joins rather than in the pieces, which is what that test is for.

### The measurement's blind spot

`measureComposition` finds the product by contrast against the background, so a
strong contact shadow reads as a point or two of extra height, and a decorative
backdrop would be measured *as* the product. It answers "is the framing right",
never "is the scene clean". Look at the image as well.
