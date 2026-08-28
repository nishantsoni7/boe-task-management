# Image Editor — Studio Image (prototype)

One page, one job: an employee uploads one factory-background furniture
photograph and gets back one catalogue-style product image.

**Bria makes the studio scene. BOE decides how big the product is in it.**

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

**Two provider calls per photograph**, and the split between them is the whole
design.

```
upload ─▶ prepareSource ─▶ [1] fal-ai/bria/background/remove ─▶ transparent cut-out
                                                                    │
   ┌────────────────────────────────────────────────────────────────┘
   ▼
 measure the product ─▶ quality gate ─▶ plan the padding
   ─▶ crop ─▶ repair the edge ─▶ scale
   ─▶ [2] fal-ai/bria/product-shot (manual_padding) ─▶ 1000 x 1000 master
```

The **scene** — background, lighting, contact and cast shadows — is the model's,
and it is the one the product owner accepted. The **size** is arithmetic.

### Why it is split that way

Three paid results drew the line:

| Attempt | What came back |
| --- | --- |
| Product Shot, first scene description | A small chair inside a **circular decorative backdrop** nobody asked for. |
| Product Shot, description rewritten to the approved reference | The circle was gone; the chair had shrunk to roughly **20% occupancy** against a required 65%. |
| Product Shot with a **reference image** and a scene description | **Accepted.** Background, lighting, shadows and the square master all approved. One defect: the chair was still too small. |

So the model is good at the studio scene and unreliable at holding a size. It
keeps the scene. It no longer decides the size — the prompt asks for no
percentage at all, because asking twice with only one of them binding is how the
second result happened.

### Why the cut-out call exists

Not for the cut-out's own sake — Product Shot can take the original photograph
directly. It exists because `padding_values` is measured **in pixels around the
product**, so the product's real pixel size has to be known before the studio
image is requested. Bria's own schema says exactly this:

> It is recommended to first use the product cutout API, get the cutout and
> understand the size of the result, and then define the required padding and
> use the cutout as an input for this API.

That is the second billable request, and it is the price of a framing that is
computed rather than requested.

### The studio request

Every field is a constant in `briaProductShot.ts` except `padding_values`, which
is computed per photograph. None is reachable from the browser.

| Field | Value | Why |
| --- | --- | --- |
| `image_url` | the prepared cut-out, as a data URI | No public URL is created for it. |
| `ref_image_url` | the approved reference, as a data URI | The accepted look, from BOE's own repository rather than an expiring fal.media URL. |
| `padding_values` | computed, `[left, right, top, bottom]` | The size and position, as arithmetic. |
| `placement_type` | `manual_padding` | The only mode that takes a size in pixels. |
| `num_results` | `1` | Bria bills per result. |
| `optimize_description` | `false` | The reference is used as given, not reinterpreted. |
| `fast` | `true` | As accepted. |
| `scene_description` | **not sent** | The schema documents it and `ref_image_url` as mutually exclusive. |
| `sync_mode` | **not sent** | Sending it would keep the result out of fal's request history. |
| `shot_size` | **not sent** | The schema: relevant only for `automatic` or `manual_placement`. Under `manual_padding` the canvas is cut-out + padding. |
| `manual_placement_selection`, `original_quality` | **not sent** | Each belongs to a different placement mode. |

#### The reference image, and nothing else

The schema is explicit:

> Either `ref_image_url` or `scene_description` has to be provided **but not
> both**.

They are documented as mutually exclusive modes, so only `ref_image_url` is sent.

The accepted request carried both. That it returned an approved picture does not
make it a supported combination — with two mutually exclusive inputs supplied,
which one fal honoured is undefined, and building on undefined behaviour means
the look can change without anything in this repository changing. The reference
image is the approved standard in its own right, and it is the input this mode is
documented to take.

**There is no prompt constant anywhere in the runtime path.** Nothing describes
the scene in words; the reference image is the description. Tests fail if a
scene-wording constant reappears in the module, or if `scene_description` appears
in the request body.

#### Why `sync_mode` is omitted

With `sync_mode: true` fal returns the image inline and, in its own words, *"the
output data won't be available in the request history"*. That history is the
record needed to audit what a run cost and to look at what came back, so it is
left off.

The consequence is that fal answers with a hosted URL. The transport downloads it
**server-side** from an allowlisted fal host, so the browser is still never handed
a provider URL — and a result hosted anywhere else is refused rather than fetched.
That download is inside the route's time budget: the worst case is
`(18s + 8s) + (20s + 8s) = 54s` against a 60s `maxDuration`, and a test asserts it
fits.

### The master, and how big the product is in it

One canvas: **1000 × 1000**, which is exactly the 1,000,000 pixels Bria calls
optimal and the shape the accepted result came back in. There is no output-shape
chooser any more — landscape and portrait are a crop of this master, made later
by somebody who can see the picture, rather than three separate paid generations.

The product fills **53%** of the canvas height, the middle of the 52–55% the
product owner asked for.

```
scale        = min( 530 / cutoutHeight ,  880 / cutoutWidth )
placedWidth  = round(cutoutWidth  × scale)
placedHeight = round(cutoutHeight × scale)

left   = floor((1000 − placedWidth) / 2)
right  = 1000 − placedWidth − left            ← the odd pixel, so the sum is exact
top    = round((1000 − placedHeight) × 0.6)
bottom = (1000 − placedHeight) − top
```

- `530` is 53% of the canvas height. `880` is the canvas less a 6% margin at
  each side.
- **`min` is what contains a wide product.** At 53% height a 3:1 sideboard would
  be 1590px wide on a 1000px canvas; the width binds first, so it comes back
  **shorter than 53% and whole** rather than exactly 53% and cropped. The plan
  reports `widthLimited: true` when that happens.
- `0.6` is 21:14 — the above-to-below ratio of the composition BOE approved
  before the product height changed. Keeping the ratio keeps that balance while
  the space a smaller product frees goes to both sides, which is what leaves
  room to crop.
- Both axes close exactly: `left + product + right = 1000` and
  `top + product + bottom = 1000`, so the master is 1000 × 1000 whatever arrives.

Nothing here was tuned against one chair. Every number is derived from the
cut-out's own width and height, and the tests run it over a dining chair, a
lounge chair, a tall cabinet, a low bench, a square stool, a long sideboard and
a narrow lamp.

### The quality gate

Enlargement is capped at **1.15×**. A cut-out too small to fill the master is
refused — before the second request is paid for — with the height the photograph
would have needed. Because the product is now 53% of the canvas rather than 65%,
this gate is more forgiving than it was: a product about **461px** tall suffices.

### The edge repair

The first real master passed composition review and failed full-resolution edge
review: a thin dark, sometimes jagged fringe around the top rail, the spindles,
the seat perimeter and the outside of the legs.

**Root cause.** Background removal assigns alpha; it does not repaint. At an
antialiased boundary the stored RGB is still the photograph's own pixel — already
a mix of product and dark factory background — while alpha merely says how much
of that pixel the product covers. Composited onto a light studio sweep, the
leftover share of factory background reads as a rim. Measured on a pale product
over a dark background, a boundary pixel at alpha 163 composited **20.6 levels
darker** than the same coverage of clean product.

It was invisible in the browser preview because the preview is scaled down and
averages the rim away. It is a one-pixel defect, and one pixel is what a
1000 × 1000 master is inspected at.

**The repair** (`decontaminateEdges.ts`) replaces the RGB of partly transparent
pixels with the colour of nearby *opaque* product: a blurred copy of the solid
pixels' colour divided by a blurred copy of the solid mask, which is a
normalised average of the product just inside the edge. Only solid pixels donate
— including the rim in its own replacement would average the contamination back
in.

What it may not do, and does not:

| | |
| --- | --- |
| Alpha | **Never written.** The silhouette that arrives is the silhouette that leaves. Eroding alpha is the usual way to kill a fringe, and on furniture it thins the cane, the spindles and the metal tips. |
| Fully opaque pixels | **Byte-identical.** Interior, wood grain and watermark are untouched. |
| Fully transparent pixels | **Byte-identical.** The gaps between the legs stay gaps. |
| Thin structures | A one-pixel bar keeps its core and gets its shoulders repaired. Where there is too little product within reach to borrow from, the pixel is left exactly as it arrived rather than guessed at. |
| Sharpening, blurring, moving | None. This recolours pixels in place. |

It runs **before** the resize, and that order matters: repairing first means the
downscale averages clean product colour, while repairing after means every
boundary pixel has already had contaminated neighbours averaged into it. Cost is
43–130 ms for a 1–5 MP cut-out, against a 38 s provider budget.

Measured on the fixtures: worst boundary error **20.6 → 2.2** levels on an
ellipse, **21.0 → 2.6** on a chair with rail, spindles and legs; mean absolute
error 6.9 → 0.8. After the resize the only opaque pixels that differ are the
single row adjacent to the silhouette, by at most 7/255 — the resize legitimately
averaging repaired neighbours in.

### What is done locally, and what is not

Local: decode, EXIF orientation, validation, finding the product by its alpha,
the padding arithmetic, the edge repair, one proportional crop-and-resize, and
the safe PNG encoding of what comes back.

**Not local: the background, the lighting and the shadows.** Those were
generated locally with sharp in the previous iteration, and that whole path is
retired. The accepted result's scene is Bria's, and recreating it locally would
be recreating something a person has already approved.

## Cost controls

- One press of Generate is **two billable requests** per photograph: the cut-out
  and the studio image. A queue of five is ten requests, made one after another.
  Nothing batches and nothing loops — a test asserts there is exactly one call
  site for each stage and that neither sits inside a loop.
- The composition that follows costs nothing, so re-downloading a result and
  converting it between PNG, JPG and WebP are all free.
- Neither adapter **ever retries** — including after a timeout, because a request
  that may already have been billed must not be billed again silently.
- The per-user rate limiter is 6 calls a minute, unchanged. It is deliberately
  left where it was even though a call now costs two requests: it is exactly the
  five-image queue plus one, so the ceiling still admits the largest run the page
  can start.
- A missing studio reference is detected **before** the studio request, so it
  costs nothing.
- A product too small in the frame is refused after the cut-out and **before**
  the studio call, so a photograph that cannot work costs one request rather
  than two.
- An image beyond fal's 12 MB ceiling is refused locally rather than paid for
  and refused there.
- Each stage logs fal's request id, the duration and the outcome category —
  never the image, the data URI, the scene description or the key. Both ids are
  logged on success, so a two-request press can be reconciled against the fal
  dashboard.

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `FAL_KEY` | yes | Server-side key for fal.ai. Without it the page says the service is not set up and generates nothing. |

Get one from <https://fal.ai/dashboard/keys>. Put it in `.env.local` (or the
deployment's environment) — never in a `NEXT_PUBLIC_` variable.

### The approved studio reference

`assets/image-editor/studio-reference.png` — **required**. It is sent as
`ref_image_url` on every studio generation, and it is what keeps results
consistent with the look the product owner accepted.

It is deliberately **not** in `public/`: nothing in a browser needs it, the only
reader is the server on its way to fal, and it travels as a data URI so no
publicly reachable URL for it is ever created. `outputFileTracingIncludes` in
`next.config.ts` is what puts it into a deployment.

With the file missing, the route answers 503 and the page says the reference is
not installed. **Nothing is substituted and nothing is regenerated** — a
plausible studio image that is not the approved one is worse than a visible
failure, because nobody downstream could tell it apart.

## The pieces

| File | What it holds |
| --- | --- |
| `src/lib/imageEditor/validation.ts` | What counts as an uploadable photograph. Used by the browser AND the route, so the two cannot disagree. |
| `src/lib/imageEditor/prepareSource.ts` | EXIF orientation baked in when required. Otherwise the original bytes, untouched, up to 8192px. Server-only (sharp). |
| `src/lib/imageEditor/falRequest.ts` | One request to fal: transport, host allowlist, failure classification, and the no-retry rule. Shared by both stages, so those rules exist once. |
| `src/lib/imageEditor/briaBackgroundRemove.ts` | Stage one. Exists to learn the product's pixel size, which is what padding needs. |
| `src/lib/imageEditor/briaProductShot.ts` | Stage two: the model id, the approved scene description, the fixed settings and the request body. |
| `src/lib/imageEditor/studioReference.ts` | Loads the approved reference from disk and turns it into a data URI. Never substitutes one. |
| `src/lib/imageEditor/studioMaster.ts` | The master canvas and the padding arithmetic. Pure — no sharp, no provider. |
| `src/lib/imageEditor/cutoutGeometry.ts` | Where the product is in a cut-out, read from raw alpha. Pure. |
| `src/lib/imageEditor/prepareCutout.ts` | Crop to the product, repair its edge, scale it to the planned size. Server-only (sharp). Nothing creative. |
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
| Timed out | 504 | taking longer than expected — try again |
| Empty or malformed result | 422 | no image returned — try again |
| Product too small in the frame | 422 `noRetry` | too small to make a sharp image — take it closer |
| Nothing could be separated out | 422 `noRetry` | try a photograph with the product clearly visible |
| Studio reference not installed | 503 `noRetry` | the reference image is not installed — ask an administrator |
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
