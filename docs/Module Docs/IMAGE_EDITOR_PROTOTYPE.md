# Image Editor — Studio Image (prototype)

One page, one job: an employee uploads one factory-background furniture
photograph and gets back one catalogue-style product image.

**Bria makes the studio photograph from the original. BOE decides the framing,
SeedVR2 supplies the resolution, and a gate checks the product survived.**

> **Visually accepted for an application trial**, on a live Irvine chair run
> reviewed by hand. See [The live Irvine result](#the-live-irvine-result) for
> the measurements and for what the automated comparison could and could not
> establish.

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

**The uploaded photograph is never stored.** It is read into memory, sent to the
provider, and dropped — no bucket, no table, no file on disk.

**The generated master is stored, for you alone, for seven days.** Every studio
image you generate is saved to your own private history and appears under
*Recent results*. Mark one **Keep** and it stays until you say otherwise;
anything not kept is deleted seven days after it was generated. You can delete
any of your own results at any time. Nobody else can see them — administrators
included.

See [Recent results](#recent-results) for the retention rules and how the
deletion actually runs.

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

**Two provider calls.** Bria renders the studio photograph, SeedVR2 supplies the
resolution, and everything between and after them is local.

```
upload → prepareSource → measure the upload (ground truth for the gate)
       → [1] fal-ai/bria/product-shot   original photograph + ref_image_url
       → locate the product by edge energy → preservation gate
       → local reframe: one crop to put the product at 53% of the height
       → [2] fal-ai/seedvr/upscale/image   noise_scale 0, PNG
       → preservation gate again, and framing
       → normalise to exactly 1440 × 1440 → delivered PNG
```

### The rule

**The product must survive both models, and it is checked rather than trusted.**

That is a weaker guarantee than the previous architecture offered, and the
weakening is deliberate. It is worth setting out honestly why.

Six paid results led here:

| Attempt | What came back |
| --- | --- |
| Product Shot, scene description | A small chair inside a circular decorative backdrop. |
| Product Shot, description rewritten | The circle went; the chair shrank to ~20% of the frame. |
| Product Shot with a reference image | **Background, lighting and shadows accepted.** Chair too small. |
| Product Shot with computed padding, **fed a prepared cut-out** | Framing correct. **The fan of thin spindles under the seat came back as a dark continuous mass, the openings between them filled, edges smeared.** |
| Local composition over a drawn sweep | Geometry perfectly preserved — every product pixel was the cut-out's own. It did not look like a premium catalogue photograph. |
| **Product Shot on the ORIGINAL photograph, in the fal playground** | The accepted look, and construction that held up. |

The distinction between rows four and six is the whole basis of this
experiment, and it is easy to state wrongly. **The pipeline that destroyed the
Irvine chair's spindles fed Product Shot a prepared cut-out.** The playground
run that produced the accepted result fed it the **original photograph**, with
the approved studio image as `ref_image_url` and no scene description at all.

Those are different inputs to the same model, and the live run settled it: fed
the original photograph, **Product Shot preserved the under-seat fan.** The
individual members stayed open, no opaque block was created, and construction,
cushion, legs, arms, back members, watermark and viewing angle all came back
visually consistent. The reading that a cut-out strips the context the model
uses to understand the object — leaving it more to invent — is consistent with
that, though one accepted run does not prove the mechanism.

What can be said without a run:

- Nothing in `ProductShotInput` preserves product pixels. `original_quality` is
  about output *dimensions* under `placement_type: 'original'`; there is no
  pass-through mode. **Pixel identity is not available from this pipeline and
  no check here can manufacture it.**
- So the gate is the substitute, and it is honest about being one: it refuses
  the failures that are measurable, and says so when it cannot measure.

### The two requests

**[1] `fal-ai/bria/product-shot`** — the original photograph as `image_url`, the
approved studio image as `ref_image_url`, and **no `scene_description`**: Bria's
schema documents the two as mutually exclusive, and the accepted playground run
left the description empty. `placement_type: 'manual_placement'`,
`manual_placement_selection: 'bottom_center'`, `shot_size: [1000, 1000]`,
`num_results: 1`, `fast: true`, `optimize_description: false`. `sync_mode` is
not sent, so the run stays in fal's history with its result attached.

**[2] `fal-ai/seedvr/upscale/image`** — `upscale_mode: 'factor'` with the
smallest factor that reaches 1440 from the actual reframed size,
`output_format: 'png'` (the default is jpg, and a catalogue master is not
delivered with jpeg artefacts in the wood grain), and **`noise_scale: 0`**.

`noise_scale` is the one knob governing how much SeedVR invents; the default is
0.1 and zero is the least it will do. The brief is resolution and edge clarity,
not restoration — wood grain, cane, thin spindles and watermark text must come
back as themselves.

**The factor's accepted range is undocumented.** The contract says
`upscale_factor?: number` with a default of 2 and states no minimum, maximum or
integer constraint, and the package ships no JSON schema. So a fractional factor
such as 1.44 is neither confirmed nor ruled out. It is sent because it is the
smallest that reaches the master — and nothing downstream assumes it worked (see
[Exactly 1440 × 1440](#exactly-1440--1440)). If a live run is refused at this
stage, the factor is the first suspect and the fix is `upscale_factor: 2` with
the surplus taken off locally.

### The master

**1440 × 1440.** At 1000 a 1152px product was resampled down to 530 — 46% of its
linear detail — before anything else happened to it.

| | |
| --- | --- |
| Canvas | 1440 × 1440 |
| Product height | 53%, **763px** |
| Maximum product width | 88%, **1267px** |
| Horizontal centre | **720px** |
| Vertical split | **60:40** above/below |

A very wide product is limited by the width instead and comes back shorter than
53% and **whole**, rather than exactly 53% and cropped.

### The reframe

Product Shot returns a 1000px square with the product wherever it put it —
typically too small, which was the one defect in the accepted result. The
framing is fixed **locally**, between the two calls, by a single crop.

`planReframe` computes the crop side from `bounds.height / 0.53`, positions it so
the product sits centred horizontally with the 60:40 vertical split, then grows
the crop if it would cut the product and clamps it inside the canvas. It reports
`widthLimited` when a wide product hit the 88% ceiling and `clamped` when the
crop met an edge — both appear in the log, because either one explains a share
that is not 53%.

Cropping *before* the upscale rather than after is what makes the reframe free:
the crop throws pixels away, and SeedVR2 then puts resolution back into what is
left, instead of spending it on background that was about to be discarded.

### Finding the product without an alpha channel

Both generated images are fully opaque, so there is no alpha to measure and
colour contrast is unusable — the background is a real gradient sweep, and a
threshold against it measures the gradient. `generatedProduct.ts` uses **edge
energy** instead: a Sobel magnitude map, thresholded, with the outermost rows
and columns that contain enough edge pixels taken as the bounds.

`structureDensity` counts edge crossings per scanline over a band of the
product's height, normalised by the product's width. A fan of separate spindles
scores high; the same fan rendered as one opaque block scores almost nothing.
That number is the regression detector.

### Exactly 1440 × 1440

`upscale_factor: 1.44` on a 1000px square *should* return 1440. Nothing in the
contract promises the model rounds the way we would, and the factor's accepted
range is undocumented besides — so `normaliseSquare` inspects what actually came
back rather than assuming:

- **Square and exactly 1440** — re-encoded as PNG and delivered.
- **Square and any other size** — one proportional Lanczos resize to 1440. Never
  a crop: a crop at this point could take a foot off.
- **Not square** — **refused.** Squeezing a rectangle into a square would change
  the product's proportions, which is the one thing this pipeline exists to
  avoid.

Both the returned and the delivered dimensions are logged on every request, so a
model that quietly changed its rounding shows up in the log rather than in a
catalogue.

## The preservation gate

`preservationGate.ts` decides whether a generated image may be served. It runs
after **both** stages. It is not in the browser and it makes no network call —
it only measures.

Its ground truth is **the uploaded photograph**, which costs nothing because it
is already in memory. A segmentation mask would be better ground truth and would
cost a third billable request; the pipeline is two, so this is the best
available.

| Check | What it catches |
| --- | --- |
| Aspect ratio | A product that came back a different shape was redrawn. Tolerance 12%. |
| Structure overall | Cane, lattice and spindles anywhere. Floor 55% of the original's density. |
| **Under-seat structure** | The regression subject: 0.42–0.95 of the product's height, where "a fan of thin verticals became one opaque block" shows up as a collapse in edge crossings. **This is the check that would have caught the rejected result.** |
| Extremities | A product touching the frame edge may have been cropped. |
| Framing | The 52–55% band the reframe was supposed to achieve. |

Every threshold is deliberately loose. A generative pass always moves these
numbers a little; the gate is for obvious destruction, not for grading.

### When it cannot decide

Edge energy locates a product on a plain background and **does not** on a
cluttered one. Measured: a product on a plain sweep fills about 23% of the
frame's area; the same product on a textured factory wall measures 83%, because
the texture reaches every corner. Above 60% the upload is not usable as ground
truth.

When that happens the gate reports, and the route logs, exactly:

> Structural comparison inconclusive; manual review required.

**This is the state most real uploads reach.** BOE photographs furniture against
textured concrete, and the live Irvine run was inconclusive for exactly that
reason while the result was visually perfect. So this is not a rare edge case to
be refused — it is the normal path.

### Three outcomes, and the difference between them

| Outcome | What it means | What the route does |
| --- | --- | --- |
| **Confirmed failure** | A check ran and failed. | **422**, `noRetry`, a product-preservation message. If established after Product Shot, **SeedVR2 is never called** — paying to upscale an image already known to be wrong is money spent to produce a refusal. |
| **Inconclusive** | The comparison could not run: the upload's background defeated it. | **Continue to SeedVR2, deliver the image normally**, and mark it `manual_review_required`. |
| **Pass** | Compared, and the structure survived. | Continue normally, marked `passed`. |

A check that ran and failed is a confirmed failure whether or not *other* checks
were skipped — everything in `checks` is measured on the generated image and
reaches a verdict; only the comparison against the upload can be missing.

**An inconclusive result is not a pass, and is never presented as one.** It is a
separate field on the report rather than folded into `ok`. What it is not is a
*failure*, and the correction that made this module usable was to stop treating
it as one: refusing textured uploads would have refused most of the module's
real traffic on the strength of a check that never ran.

### How the verdict reaches the browser

A response header, and nothing else:

```
X-BOE-Image-Verification: manual_review_required
```

A header rather than a field in the body, because the body is the image and
nothing else — no bounds, no densities, no request ids, no model names. The
header carries one of two words. There is no `failed` value: a confirmed failure
is a 422 with no image, so no header accompanies it.

The card then shows a short note under the comparison panels:

> Please inspect fine product details before catalogue use.

**Download is not blocked, and the layout does not change.** An unverified image
is not a bad one — nobody has checked it, which is a different thing. An
unrecognised or missing header reads as *undefined* and the card says nothing
either way, so a mangled header can never become a silent "verified".

The smoke script prints the same warning and carries on, so a person can look at
the artefacts and judge.

### What it cannot do

It cannot prove preservation. Two generative models render the final image and
neither has a pass-through mode. It measures **edges**, so a product recoloured
entirely but structurally identical still passes — a fact asserted in the tests
so nobody reads the gate as a guarantee.

## Cost controls

- One press of Generate is **two billable requests** per photograph, and never
  more. A queue of five is ten requests, made one after another. Nothing batches
  and nothing loops — a test asserts one call site per stage and that neither is
  inside a loop.
- Everything between and after those calls is local and free: the reframe, the
  gate, the normalisation, the three download formats, any re-download.
- The adapter **never retries**, including after a timeout, because a request
  that may already have been billed must not be billed again silently. The
  `@fal-ai/client` package is deliberately not a dependency: its `run()` retries
  three times over 429/502/503/504, so one press could become four charges. The
  transport is plain `fetch`.
- The per-user rate limiter is 6 a minute, unchanged.
- **Everything that can be refused, is refused before the request that would
  pay for it.** A missing reference asset, a missing key, an image beyond fal's
  12 MB ceiling — all local, all free. A **confirmed** stage-one preservation
  failure stops the run **before** the upscale, so a photograph whose result is
  already known to be wrong costs one request rather than two. An inconclusive
  comparison is not a failure and does not stop anything.
- Each request logs fal's request id, the phase, the duration and the outcome
  category — never the image, the data URI or the key.

## Recent results

Every generated master is saved to the employee's own history and shown under
*Recent results* on `/image-editor`.

### The rules

| Rule | Detail |
| --- | --- |
| Private to the owner | A result is visible only to the account that generated it. There is no admin view, no sharing and no company-wide gallery. |
| Seven days from generation | The window is set by the database (`expires_at` defaults to `now() + interval '7 days'`) and is never written by the application. |
| Keep holds it indefinitely | A kept result is never swept, however old. |
| Unkeep restores the ORIGINAL window | It does not grant a fresh seven days. Unkeeping something already past its window makes it due immediately — the page warns before doing it. |
| Delete is real | The owner's Delete removes the storage object and the row. It is not a hide. |
| The photograph is never stored | Only the generated PNG master, plus the uploaded file's **name** so the row is recognisable. |

### What is stored

- Bucket **`image-editor-results`** — private, PNG only, 15 MB ceiling. Reads are
  one-hour signed URLs minted by the API after it has checked ownership; no
  public URL is ever constructed.
- Table **`public.image_editor_results`** — owner, object key, source file name,
  the verification verdict carried through unchanged from the generation
  response, `kept`, `created_at`, `expires_at`.
- Object key is always `<user_id>/<result_id>.png`. **The first segment is
  load-bearing:** the storage policies authorize by parsing it.

### How deletion actually runs

`GET /api/image-editor/cleanup`, once a day at 03:00 UTC, scheduled by the
`crons` entry in `vercel.json`. Vercel sends `Authorization: Bearer $CRON_SECRET`
automatically; with `CRON_SECRET` unset the route answers **503 and deletes
nothing**, so an unconfigured deployment never exposes an unauthenticated
endpoint that removes rows.

**The sweep is not load-bearing for privacy.** Expiry is enforced on *read* —
the listing filters `kept OR expires_at > now()`, the exact complement of what
the sweep selects. A cron that is late, fails, or was never scheduled costs
storage; it can never make an expired image reappear.

**Ordering: object first, then row.** Always, in both the sweep and the owner's
manual delete, which share one function so they cannot drift apart:

| Order | If the second step fails |
| --- | --- |
| object → row *(what we do)* | The row survives, is still due, and the next pass retries. Removing an object that is already gone is not an error, so the retry is harmless. |
| row → object | The only record of where the object lives is destroyed. The bytes stay in a private bucket for ever — paid for, unreachable, invisible to every future sweep. |

One failure never stops the rest: the sweep records it, moves on, and the failed
row stays due for tomorrow. It runs sequentially and in batches of 500, because a
serverless function must not open a storage call per row at once.

Saving mirrors this: object first, then row, and if the insert fails the object
it just uploaded is removed, so the orphan window stays inside one function.

### When saving fails

Persistence is **best effort and always last**. By the time it runs, two
provider requests have been paid for and a finished image is in hand, so a
storage fault must never turn that into a failed generation. It cannot throw and
cannot change the status code. The response carries `historySaved: false`, and
the result card shows an amber warning telling the employee to download now
because this image will not be in their history. The picture is delivered either
way.

### Authorization

Reading, keeping and deleting need module entry (`image_editor:view`) — **not**
`create`. `create` authorizes *spending*; requiring it here would mean an
employee whose Use access was withdrawn could no longer reach, or delete, work
they had already made.

The API routes act with the **service role, which bypasses row-level security**,
so the `.eq('user_id', …)` on every statement is the authorization, not a
defence in depth. The RLS and storage policies protect the table and bucket from
everything else. A result belonging to somebody else answers **404, not 403** —
a 403 would confirm the id exists.

This table is also the first surface the Image Editor has had for the house
`module_entry_open()` RESTRICTIVE gate, which `20261020000000` noted it could
not attach for want of a table.

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `FAL_KEY` | yes | Server-side key for fal.ai. Without it the page says the service is not set up and generates nothing. |
| `CRON_SECRET` | for cleanup | Shared secret for the daily sweep. Set it in Vercel, not only in `.env.local`. Unset ⇒ the cleanup route refuses (503) and expired results are hidden but never reclaimed. |

Get one from <https://fal.ai/dashboard/keys>. Put it in `.env.local` (or the
deployment's environment) — never in a `NEXT_PUBLIC_` variable.

And one file:

| Path | Required | Purpose |
| --- | --- | --- |
| `assets/image-editor/studio-reference.png` | yes | The approved studio look, sent to Bria as `ref_image_url`. |

It is deliberately **not** in `public/` and **not** in git: nothing in a browser
needs it, the only reader is the server on its way to fal, and it travels as a
data URI so no publicly reachable URL for it is ever created.

**Because it is gitignored, a deployment built from a git clone does not have
it.** This was verified rather than assumed — exporting `HEAD` to a clean tree
leaves only the README, and the loader returns `missing`, which would make every
generation in production fail with "reference not installed". So the server
tries two sources in order:

| Order | Source | Serves |
| --- | --- | --- |
| 1 | The local file, shipped by `outputFileTracingIncludes` | local development |
| 2 | A **private** Supabase Storage bucket, downloaded server-side with the service-role key the app already holds | **production** |

A local file always wins, and storage is not consulted when it is present — a
developer's checkout must not depend on a network round trip.

**Provisioning, once per environment:** create a Supabase Storage bucket named
`image-editor` with **Public bucket OFF**, and upload the approved PNG as
`studio-reference.png`. **No new Vercel environment variable is required** —
`NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are already set.
`IMAGE_EDITOR_REFERENCE_BUCKET` overrides the bucket name if a project needs a
different one. No storage policy is needed: the service-role key bypasses
row-level security, which is why the bucket can stay private.

With **neither** source available the route reports it and generates nothing —
**before** any billable request, so a misconfigured deployment costs nothing.
The failure names both sources, because naming one sends an operator to the
wrong system.

## The pieces

| File | What it holds |
| --- | --- |
| `src/lib/imageEditor/validation.ts` | What counts as an uploadable photograph. Used by the browser AND the route, so the two cannot disagree. |
| `src/lib/imageEditor/prepareSource.ts` | EXIF orientation baked in when required. Otherwise the original bytes, untouched, up to 8192px. Server-only (sharp). |
| `src/lib/imageEditor/falRequest.ts` | One request to fal: transport, host allowlist, failure classification, and the no-retry rule. Shared by both stages, so those rules exist once. |
| `src/lib/imageEditor/briaProductShot.ts` | Stage one. The original photograph plus the approved reference; no scene description, no `sync_mode`. |
| `src/lib/imageEditor/seedvrUpscale.ts` | Stage two, and `normaliseSquare` — which inspects what came back rather than assuming the factor worked. |
| `src/lib/imageEditor/studioReference.ts` | Loads the approved reference — local file, then private Supabase Storage — server-side, cached per root. Never substitutes a look-alike. |
| `src/lib/imageEditor/generatedProduct.ts` | Finding a product in a fully opaque image by edge energy, measuring its structure, and planning the reframe. Server-only (sharp). No network. |
| `src/lib/imageEditor/preservationGate.ts` | Whether a generated image may be served, and when that cannot be decided. No network, no model — it only measures. |
| `src/lib/imageEditor/verification.ts` | The verdict's wire format: the header name, the two statuses, the note. Client-safe and dependency-free, imported by both the route and the card so they cannot drift. |
| `src/lib/imageEditor/studioMaster.ts` | The master canvas and the framing constants. Pure — no sharp, no provider. |
| `src/lib/imageEditor/queue.ts` | The selection rules: the five-image ceiling, what a run would cost, what may be sent next, and how a result is recorded without disturbing the others. Pure. |
| `src/lib/imageEditor/downloadFormats.ts` | Which download formats exist, and the guard. Client-safe. |
| `src/lib/imageEditor/imageFormats.ts` | The sharp re-encoder behind the download menu. Server-only. |
| `src/app/api/image-editor/convert/route.ts` | Re-encodes a finished image for download. Never calls fal, holds no provider key. |
| `src/app/image-editor/QueueList.tsx`, `ResultCard.tsx` | The queue rows and the per-result actions. |
| `src/app/api/image-editor/studio/route.ts` | Auth, rate limit, validation, then the two provider calls with the reframe and the gate between them. Holds the API key; returns the image. |
| `src/app/image-editor/page.tsx` | The screen. |
| `src/components/layout/ImageEditorLayout.tsx` | The module shell, per the BOE Module Layout Standard. |
| `scripts/image-editor-smoke.mjs` | One real run from the command line, writing every artefact the acceptance review needs. Chargeable. |

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
| The product was **confirmed** not preserved | 422 `noRetry` | did not preserve the product accurately — try again, or a different photograph |
| No product locatable in the result | 422 | did not preserve the product accurately — try again, or a different photograph |
| The upscale came back the wrong shape | 422 | the upscaled image came back the wrong shape — try again |
| Anything else | 502 | could not process — try again |

### Retry, and when it is not offered

A failure a second press cannot fix is marked **`noRetry`** in the response, and
the result card then offers **Choose a different photo** instead of **Retry**.

That is a cost control, not a cosmetic one. Retry costs up to two more requests,
so it is only worth offering where the answer could actually change:

- **`noRetry`** — no key configured, a key an administrator must fix, no credit,
  a moderation refusal, and a **confirmed** preservation failure.
- **Retry offered** — busy, timed out, an unexplained provider error, and a
  generated image no product could be located in.

An **inconclusive** comparison is not in either list, because it is not a
failure: the image is delivered, and there is nothing to retry.

Nothing retries on its own, in either case. A retry is a person pressing a
button, always.

## Download formats

The delivered 1440 × 1440 PNG is the master. PNG downloads hand back exactly those bytes;
JPG and WebP are re-encoded server-side by sharp at quality 95 with no chroma
subsampling. A conversion is a format change and nothing else — same pixels,
same dimensions, asserted by tests — and it **never calls fal**, so downloading
one image in three formats costs nothing beyond the two requests that made it.

## The live Irvine result

One real run, reviewed by hand, and **visually accepted for an application
trial**.

| Stage | Measured |
| --- | --- |
| Product Shot | **16,088 ms**, returned **1024 × 1024** |
| Product share before reframe | **33.5%** |
| Product share after reframe | **52.9%** (target 53%, band 52–55%) |
| SeedVR2 | **7,452 ms**, returned **1456 × 1456** |
| Final delivery | **1440 × 1440** |
| Total | **24.4 seconds** |
| Billable requests | **two** |

What the manual review found:

- Product Shot **preserved the under-seat fan**. Individual members remain open;
  no opaque block was created.
- Construction, cushion, legs, arms, back members, watermark and viewing angle
  all remained visually consistent with the photograph.
- SeedVR2 **materially improved clarity**.
- The final 1440 × 1440 output is suitable for a catalogue trial.

Two of those numbers are worth dwelling on.

**33.5% → 52.9%.** The reframe did exactly the job it exists for. Product Shot
put the chair at a third of the frame height — the one defect in the originally
accepted result — and the local crop corrected it without a model being asked
to, and without a third request.

**1456, not 1440.** `upscale_factor` did not round the way the arithmetic
suggested, which is precisely why `normaliseSquare` inspects the result instead
of trusting it. The 16 surplus pixels came off locally, with no crop. Had the
route assumed 1440, it would have delivered a 1456 master.

### What the automated comparison could not establish

**The structural comparison was inconclusive** — the upload's textured concrete
background defeated the location step, exactly as the gate is designed to
report. So on the run that was accepted by eye, the automated check reached no
verdict at all.

That is the finding that changed the route. The gate was refusing inconclusive
results; on BOE's real photographs that would have refused most uploads,
including this one. It now delivers them marked `manual_review_required`.

**The gate did not verify this result. A person did.** Nothing here should be
read as the automated check having passed it.

### Through the app

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

The server log for the run prints both request ids, the located product bounds,
the crop, the achieved height share, and **both** the dimensions SeedVR2
returned and the dimensions delivered — so a result that looks wrong can be
traced to a stage rather than guessed at.

### The developer's tool, and the acceptance review

`scripts/image-editor-smoke.mjs` runs the same two requests without the app and
writes **every artefact the review needs**:

```bash
npx tsx scripts/image-editor-smoke.mjs "irvine chair.jpg" test-results/irvine/out.png
```

| Artefact | What it is for |
| --- | --- |
| `out-0-original.png` | The bytes actually sent, not the file on disk. |
| `out-1-shot.png` | The raw Product Shot result. |
| `out-2-reframed.png` | After the local crop to 53%. |
| `out-3-upscaled.png` | The raw SeedVR2 result, at whatever size it chose. |
| `out.png` | The delivered 1440 × 1440 PNG. |
| `out-underseat-original.png` | The fan of spindles as photographed. |
| `out-underseat-shot.png` | The same band after Product Shot. |
| `out-underseat-upscaled.png` | The same band after SeedVR2. |
| `out-underseat-*-4x.png` | All three at 4×, **nearest neighbour** — a smooth kernel would invent edges between the spindles, which is the thing under examination. |

The three under-seat crops are the review. The band is the same one the gate
measures (0.42–0.95 of the product's height), so what is looked at is what the
numbers describe. Put them side by side:

- **original → shot → upscaled.** The spindles must stay individually visible,
  with background showing through the gaps between them.
- If they merge into a dark mass at the *shot* stage, feeding the original
  photograph did not fix what the cut-out path broke, and the answer is not this
  pipeline.
- If they survive the shot and merge at the *upscale* stage, `noise_scale` is
  already at zero and the next thing to try is skipping the upscale.

It refuses before sending anything if `FAL_KEY` or the approved reference is
missing, so a misconfigured checkout costs nothing. It prints request ids, stage
timings, the returned and delivered dimensions, the framing measurement and
every preservation warning — and **never the key or any base64 data**.

It calls the result a **master** only once it has passed both the exact-size
check and the preservation gate. Otherwise it says what failed and calls it "the
SeedVR2 result", because that is all it is.

### Everything that costs nothing

```bash
npx tsx --test "src/lib/imageEditor/*.test.ts"
npx tsx --test "src/app/api/image-editor/studio/*.test.ts"
npx tsx --test src/app/image-editor/page.test.ts
```

Four are worth knowing about by name:

- **`routeBehaviour.test.ts` runs the route.** `fetch` is stubbed, which covers
  Supabase *and* fal, so the real pipeline executes end to end. The three
  outcomes are driven by the **fixtures**, not by stubbing the gate: a cluttered
  upload really does defeat the location step, and a filled-in fan really does
  collapse the structure measurement to 7% of the original. It asserts a
  textured upload reaches SeedVR2 and comes back 200 at exactly 1440 × 1440 with
  `manual_review_required`; that a confirmed destruction returns 422 having made
  **one** provider call; that a clean pair passes; and that both request bodies
  are exactly the ones the Irvine review accepted.
- `preservationGate.test.ts` builds a chair with a fan of sixteen 3px spindles
  and the same chair with that fan filled solid — the rejected result, made
  synthetically — and asserts the gate refuses the second. It also builds the
  cluttered factory background that defeats the location step, and asserts the
  gate reports that as **inconclusive** rather than passing it.
- `seedvrUpscale.test.ts` feeds `normaliseSquare` results of 1439, 1441, 1408,
  2000 and 1000 and asserts the delivered PNG is exactly 1440 × 1440 every time,
  with marks in all four corners surviving — proving nothing was cropped. A
  non-square result is asserted to be refused.
- `route.test.ts` reads the route's own source and asserts the invariants a
  running test cannot see: exactly two provider call sites, neither in a loop,
  the reframe between them, the gate after both, and the raw upscale never
  served.

`routeBehaviour.test.ts` writes a stand-in reference PNG if the checkout has
none and removes it afterwards, leaving a real one alone. Without that the route
would correctly refuse before every request and the whole file would be 503s.

### The measurement's blind spot

The gate finds the product by edge energy, so a strong contact shadow reads as a
point or two of extra height, and it cannot find a product at all against a
cluttered background — which is why the inconclusive state exists. It answers
"did the structure survive", never "is the scene clean" or "are the pixels the
same". **Look at the image as well.** That is not a formality here: the gate is
a substitute for a guarantee this pipeline cannot give.
