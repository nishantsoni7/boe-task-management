# Image Editor — Studio Image (prototype)

One page, one job: an employee uploads one factory-background furniture
photograph and gets back one square, catalogue-style product image.

Not linked from the module launcher and not registered in `app_modules`. It is
reached directly at **`/image-editor`** and is open to any signed-in BOE user —
deliberately, so the prototype adds no Control Center permission, no migration
and no row anybody would later have to unpick.

## What it does

Upload (JPG / PNG / WebP, up to 10 MB) → **Generate Studio Image** → original and
result side by side → **Download Image** → **Edit Another Image**.

Nothing is stored. The upload is read into memory, cut out, composed, and the
result comes back in the response body as a data URL. No bucket, no table, no
file on disk, no history.

## How the image is made

Two steps, and only the first one leaves the server.

1. **PhotoRoom Remove Background** — `POST https://sdk.photoroom.com/v1/segment`,
   key in the `x-api-key` header, the photograph as multipart `image_file`,
   asking for a transparent RGBA PNG. PhotoRoom is asked to do exactly one
   thing: separate the product from its background. It is **not** asked to
   generate a background, restage the product, or edit it — those are different
   PhotoRoom products (`/v2/edit`, instant backgrounds) and they would return a
   product PhotoRoom drew rather than the one BOE photographed.

   The photograph reaches it **untouched** unless EXIF orientation has to be
   baked in or it exceeds 8192px. No downscale, no recompression: those pixels
   are what the composition later needs.

2. **Local composition with `sharp`** — deterministic; the same cut-out composes
   to the same bytes every time.

   | Step | What happens |
   | --- | --- |
   | Crop | To the alpha bounding box. |
   | Quality gate | If the product would need more than **1.25×** enlargement to fill the frame, or is measurably out of focus, the request is **refused** — see below. |
   | Defringe | Edge pixels take the colour of the product just inside them. **Alpha is never modified**, so no cane hole, spindle or metal tip is thinned. |
   | Lighting | Exposure, midtone contrast, saturation and white balance, each measured from this product's own pixels and bounded. |
   | Scale | One Lanczos-3 resize, aspect ratio locked. |
   | Sharpen | Restrained, and confined to an eroded interior mask so the cut-out edge gains no halo. |
   | Place | Centred on the product's **mass**, lifted slightly, 8% margins. |
   | Shadow | Two alpha-derived layers at the real floor-contact points. |
   | Background | 2048 × 2048, warm white with a gentle vertical gradient. |

### The quality gate

The first version enlarged whatever it was given until it filled the frame.
Measured on a 4032 × 3024 photograph, a product occupying 30% of the frame was
enlarged 2.11× and lost 71% of its fine-detail energy. That was the blur, and no
sharpening puts back detail the sensor never recorded.

Detail retained through the whole pipeline, against the same product at 1.00×:

| 0.80× | 1.00× | 1.16× | 1.24× | 1.40× | 1.60× | 2.00× |
| --- | --- | --- | --- | --- | --- | --- |
| 102% | 100% | 75% | 67% | 61% | 50% | 28% |

`MAX_ENLARGEMENT = 1.25` in `composeStudioImage.ts` is the line drawn through
that table: it keeps two thirds of the finest texture and asks for a product
about 45% of the frame. Lowering it to 1.15 keeps three quarters and asks for
about half the frame. Past the cap the request is refused with a message asking
for a closer photograph or a tighter crop, and the measurements go to the server
log.

### Lighting and colour

Every adjustment is measured, bounded, and self-limiting. A well-exposed
photograph receives almost nothing.

- **Exposure** — from the median luminance of solid product pixels, toward a
  target of 124, capped at 1.45×.
- **Highlight veto** — the gain is reduced so the 98th percentile stays under
  246, which is what keeps texture in white upholstery. The 98th, not the 99th:
  a few specular pixels on a varnished arm must not cancel the correction for
  the whole product.
- **Midtone contrast** — a fixed, gentle S-curve that is zero at both endpoints,
  so it cannot clip anything at either end.
- **Saturation** — ×1.05, fixed and restrained.
- **White balance** — estimated only from surfaces that ought to be neutral,
  damped to 60%, capped at ±6% per channel, and **disabled entirely** when the
  product has no neutral surface. A solid teak stool is never dragged toward
  grey. A severe cast is only partly corrected, by design.

### The shadow

Two layers, both derived from the product's own alpha: a tight contact shadow
and a wide, very soft grounding pool. Each column that reaches the floor casts
at **its own lowest pixel**, not on a shared baseline — in a three-quarter view
the back feet sit higher in the frame than the front ones while standing on the
same floor. Geometry more than 12% of the product's height above the lowest
point casts nothing, which is what keeps this a contact shadow rather than a
silhouette printed on the floor.

### Angle

No rotation, no perspective correction, no straightening. Any automatic estimate
from a single photograph would resample the product and risk its geometry for a
benefit nothing here can measure, so the uploaded angle is preserved exactly.

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `PHOTOROOM_API_KEY` | yes | Server-side key for the Remove Background API. Without it the page says the service is not set up and edits nothing. |

Get a key at <https://app.photoroom.com/api-dashboard>. Put it in `.env.local`
(or the deployment's environment) — never in a `NEXT_PUBLIC_` variable.

## The pieces

| File | What it holds |
| --- | --- |
| `src/lib/imageEditor/validation.ts` | What counts as an uploadable photograph. Used by the browser AND the route, so the two cannot disagree. |
| `src/lib/imageEditor/prepareSource.ts` | EXIF orientation baked in. Otherwise the original bytes, untouched, up to 8192px. Server-only (sharp). |
| `src/lib/imageEditor/productMetrics.ts` | Every measurement the composition decides from: bounds, mass centre, floor contact, luminance, neutral surfaces, sharpness. Pure functions. |
| `src/lib/imageEditor/enhanceProduct.ts` | What lighting and colour correction this photograph gets, and the bounds it may not exceed. |
| `src/lib/imageEditor/photoroomCutout.ts` | The only code that talks to a provider. Swapping providers means rewriting this one function. |
| `src/lib/imageEditor/composeStudioImage.ts` | The canvas, the placement and the shadow. No network. |
| `src/app/api/image-editor/studio/route.ts` | Auth, rate limit, validation, then the two steps above. Holds the API key; returns the image. |
| `src/app/image-editor/page.tsx` | The screen. |
| `src/components/layout/ImageEditorLayout.tsx` | The module shell, per the BOE Module Layout Standard. |

## Verifying against the real API

The provider step cannot be checked from tests — they stub `fetch`. To see what
PhotoRoom actually returns for a given photograph, run one round trip directly:

```bash
# One credit: calls PhotoRoom, saves the cut-out, reports, composes.
PHOTOROOM_API_KEY=… npx tsx scripts/image-editor-smoke.mjs chair.jpg out/

# Free: re-compose from the saved cut-out, as often as you like.
npx tsx scripts/image-editor-smoke.mjs --from-cutout out/chair-cutout.png out/

# Free: the measurements behind a result.
npx tsx scripts/image-editor-smoke.mjs --measure chair.jpg out/chair-cutout.png
```

Then look at the hard parts: the gaps between legs and spindles, the seat edge,
and any upholstery fringe.

`sdk.photoroom.com` has to be reachable from wherever this runs. A network
policy that blocks it answers **403**, which is indistinguishable from a rejected
key at HTTP level and so is reported as one — the logged detail is what tells
them apart.

## Failures the employee can act on

Each PhotoRoom failure is mapped to a sentence that says whether retrying is
worth their time, and PhotoRoom's own response text never reaches the browser —
it goes to the server log only.

| What happened | HTTP | What the page says |
| --- | --- | --- |
| No key configured | 200 `configured:false` | not set up yet — ask an administrator |
| Key refused (401/403) | 503 | credentials rejected — ask an administrator to check the key |
| Out of credits (402) | 503 | no processing credits left — ask an administrator to top up |
| Unreadable image (400/415/422) | 422 | try a different photograph |
| Rate limited (429) | 429 | busy — wait a moment and try again |
| Timed out | 504 | taking longer than expected — try again |
| Anything else | 502 | could not process — try again |
| Cut-out has no product in it, or a shape the composition refuses | 422 | try a photograph with the product clearly visible |
| **Product too small or too soft for a sharp result** | 422 + `quality: true` | too small / too soft — take it closer, or steady the camera. The page shows this in amber with **Choose a different photo** rather than a retry, because retrying the same photograph cannot help. |

## Size of the finished image

A 2048 × 2048 photographic PNG measures roughly 3–7 MB, and it reaches the
browser base64-encoded inside JSON, which adds a third again. On a slow phone
connection that is the slowest part of the whole flow — the provider call and
the composition (~0.3–0.8 s) are not. Composition holds about 210 MB of RSS at
the 4096px input ceiling.
