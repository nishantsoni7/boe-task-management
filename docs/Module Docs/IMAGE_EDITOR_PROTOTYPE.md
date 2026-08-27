# Image Editor — Studio Image (prototype)

One page, one job: an employee uploads one factory-background furniture
photograph and gets back one catalogue-style product image.

Not linked from the module launcher and not registered in `app_modules`. It is
reached directly at **`/image-editor`** and is open to any signed-in BOE user —
deliberately, so the prototype adds no Control Center permission, no migration
and no row anybody would later have to unpick.

## What it does

Upload (JPG / PNG / WebP, up to 10 MB) → **Generate Studio Image** → original and
result side by side → **Download Image** → **Edit Another Image**.

Nothing is stored. The upload is read into memory, sent to the provider, and the
result comes back in the response body as a data URI. No bucket, no table, no
file on disk, no history.

## How the image is made

One provider call, and nothing else.

**`fal-ai/bria/product-shot`**, called synchronously at `POST
https://fal.run/fal-ai/bria/product-shot`, re-photographs the uploaded product
into the studio scene held server-side. What it returns **is** the finished
image: no local composition, no cut-out, no drawn shadow, no resizing or
re-encoding of the result. The 1000 × 1000 the model returns is what the
employee downloads.

The photograph travels as a **data URI inside the request body**, so no publicly
accessible URL for it is ever created. `sync_mode: true` asks for the result the
same way, which also keeps it out of fal's request history.

### The fixed request

Every field that decides what the request costs or what comes back is a constant
in `src/lib/imageEditor/briaProductShot.ts`, unreachable from the browser:

| Field | Value | Why |
| --- | --- | --- |
| model | `fal-ai/bria/product-shot` | The one model. |
| `num_results` | `1` | Bria bills per result. |
| `placement_type` | `manual_placement` | `automatic` returns **ten** placements and bills for them. |
| `manual_placement_selection` | `bottom_center` | Product stands on the lower centre of the frame. |
| `shot_size` | `[1000, 1000]` | Square, ~1 MP, which is what Bria is tuned for. |
| `padding_values`, `original_quality`, `ref_image_url` | not sent | Each belongs to a different placement mode. |
| `fast` | `true` | |
| `optimize_description` | `false` | The scene description is used as written, not rewritten. |
| `sync_mode` | `true` | Result inline as a data URI; nothing left in fal's history. |

`padding_values`, `original_quality` and `ref_image_url` are never sent: each
belongs to a different `placement_type`, and mixing them is at best ignored and
at worst a rejected request.

### The scene

The **scene description** is a server-side constant
(`STUDIO_SCENE_DESCRIPTION`). No employee writes or edits it, and nothing from
the upload is interpolated into it, so an uploaded file has no text channel
through which to change what the model is asked for. It is BOE's approved
reference standard written out in full:

| | |
| --- | --- |
| Framing | One product, horizontally centred, filling ~60–65% of the image height, ~20% clear above, ~16% below the feet, balanced side margins, nothing cropped. |
| View | Front three-quarter, ~25–35° from the front, front dominant, one side visible, a slight view of the seat or top surface — **but** the uploaded angle is preserved whenever changing it would mean reconstructing or inventing detail. |
| Light | Large soft directional light from the upper-left front, gentle opposite fill, controlled highlights, natural contrast, sharp readable material texture. |
| Shadow | Compact contact shadows beneath every foot, plus one subtle soft cast shadow away from the main light. |
| Background | One continuous warm light-grey cyclorama, background and floor transitioning with no visible horizon or wall/floor division; no skirting, corner, room, architecture, props, texture, decoration, text or logo. |
| Preservation | Construction, geometry, proportions, viewing direction, legs, arms, joints, cane and rope pattern, upholstery, stitching, wood grain, metal details, finish, colours, materials and any existing product marking, all unchanged. Nothing added, removed, redesigned, reshaped, rotated, recoloured, smoothed, replaced or regenerated. |

The framing is carried by the description rather than by a padding calculation,
because `manual_placement` leaves the product's scale to the model. The
preservation clause is deliberately last: a model asked to make furniture look
good will redesign it, and that clause has to read as the final constraint
rather than as something the framing above may trade away.

### Why plain `fetch` and not `@fal-ai/client`

The official client's `run()` retries automatically — `maxRetries: 3` over 429,
502, 503 and 504 (`src/client.js`, `src/retry.js` in `@fal-ai/client` 1.10.1).
On a chargeable model call that turns one button press into as many as four
billed requests. The adapter is therefore one `POST` with no retry. The contract
it implements was read out of that same package rather than from memory:
`https://fal.run/<id>`, `Authorization: Key <credentials>`, the input as the JSON
body, `x-fal-request-id` on the response, and `ProductShotInput` /
`BlurOutput` for the shapes.

## Cost controls

- One press of Generate is one request for one result. A ref guard on the page
  blocks a second submission in the same frame, and the button is disabled while
  a request is in flight.
- The adapter **never retries** — including after a timeout, because a request
  that may already have been billed must not be billed again silently.
- The existing per-user rate limiter (6 per minute) is unchanged.
- An image beyond fal's 12 MB ceiling is refused locally rather than paid for
  and refused there.
- Each request logs fal's request id, the duration and the outcome category —
  never the image, the data URI, the scene description or the key.

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
| `src/lib/imageEditor/briaProductShot.ts` | The only code that talks to a provider: the model, the scene description, the fixed settings, and the failure mapping. |
| `src/app/api/image-editor/studio/route.ts` | Auth, rate limit, validation, then the one provider call. Holds the API key; returns the image. |
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
| Anything else | 502 | could not process — try again |

The five failures a retry cannot fix are marked `noRetry` in the response; the
page shows those in amber with **Choose a different photo** instead of **Try
Again**.

## Verifying against the real API

```bash
FAL_KEY=… npx tsx scripts/image-editor-smoke.mjs chair.jpg studio.png
```

One billable request, one PNG written, nothing else stored. It prints the fal
request id — check the fal dashboard shows exactly **one** billed result for it.
