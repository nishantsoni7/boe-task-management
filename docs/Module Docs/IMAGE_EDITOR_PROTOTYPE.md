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

2. **Local composition with `sharp`** — `composeStudioImage.ts`. Deterministic:
   the same cut-out composes to the same bytes every time.
   - 2048 × 2048 canvas, soft warm white `rgb(250, 247, 242)`
   - the product cropped to its alpha bounding box, scaled with the aspect ratio
     locked, centred, 8% margin on all four sides — so the whole product,
     including every floor-contact point, is inside the frame
   - a contact shadow whose **shape is the bottom band of the product's own
     alpha mask**, squashed flat, blurred and set to 32% opacity. That is why a
     chair casts four soft pools with floor visible between the legs rather than
     one drawn ellipse.
   - **no colour correction at all** — no brightness, white balance, saturation
     or curve. Every product pixel is the photograph's pixel, resampled once by
     the resize. A finish that looks slightly dark in the photograph looks
     slightly dark in the result, which is the correct behaviour for a catalogue
     image of a real object BOE will ship.

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
| `src/lib/imageEditor/prepareSource.ts` | EXIF orientation baked in, oversized photographs scaled to a 4096px longest edge. Server-only (sharp). |
| `src/lib/imageEditor/photoroomCutout.ts` | The only code that talks to a provider. Swapping providers means rewriting this one function. |
| `src/lib/imageEditor/composeStudioImage.ts` | The canvas, the placement and the shadow. No network. |
| `src/app/api/image-editor/studio/route.ts` | Auth, rate limit, validation, then the two steps above. Holds the API key; returns the image. |
| `src/app/image-editor/page.tsx` | The screen. |
| `src/components/layout/ImageEditorLayout.tsx` | The module shell, per the BOE Module Layout Standard. |

## Verifying against the real API

The provider step cannot be checked from tests — they stub `fetch`. To see what
PhotoRoom actually returns for a given photograph, run one round trip directly:

```bash
PHOTOROOM_API_KEY=… npx tsx scripts/image-editor-smoke.mjs chair.jpg studio.png
```

It costs one Remove Background credit, writes one PNG, and stores nothing else.
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

## Size of the finished image

A 2048 × 2048 photographic PNG measures roughly 3–7 MB, and it reaches the
browser base64-encoded inside JSON, which adds a third again. On a slow phone
connection that is the slowest part of the whole flow — the provider call and
the composition (~0.3–0.8 s) are not. Composition holds about 210 MB of RSS at
the 4096px input ceiling.
