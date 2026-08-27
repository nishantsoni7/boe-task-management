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

Nothing is stored. The upload is read into memory, sent to the provider, and the
result comes back in the response body as a data URL. No bucket, no table, no
file on disk, no history.

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `GEMINI_API_KEY` | yes | Server-side key for the image model. Without it the page says the service is not set up and edits nothing. |
| `GEMINI_IMAGE_MODEL` | no | Overrides the model. Default `gemini-3.1-flash-image` (2048×2048 square). `gemini-3-pro-image` for maximum fidelity; `gemini-2.5-flash-image` if the key has no Gemini 3 image access — the resolution field is dropped automatically for that model. |

Get a key at <https://aistudio.google.com/apikey>; image models need billing
enabled on the Google Cloud project behind it. Put it in `.env.local` (or the
deployment's environment) — never in a `NEXT_PUBLIC_` variable.

## The pieces

| File | What it holds |
| --- | --- |
| `src/lib/imageEditor/validation.ts` | What counts as an uploadable photograph. Used by the browser AND the route, so the two cannot disagree. |
| `src/lib/imageEditor/studioPrompt.ts` | The instruction sent with the photograph. This file is where BOE's rules about what may and may not change live. |
| `src/lib/imageEditor/prepareSource.ts` | EXIF orientation baked in, oversized photographs scaled to a 2048px longest edge. Server-only (sharp). |
| `src/lib/imageEditor/geminiStudioImage.ts` | The only code that talks to a provider. Swapping providers means rewriting this one function. |
| `src/app/api/image-editor/studio/route.ts` | Auth, rate limit, validation, and the call. Holds the API key; returns the image. |
| `src/app/image-editor/page.tsx` | The screen. |
| `src/components/layout/ImageEditorLayout.tsx` | The module shell, per the BOE Module Layout Standard. |

## What the result is asked to preserve

The full instruction is in `studioPrompt.ts`. In short: remove the factory
background, place the product on a soft warm-white studio backdrop with a subtle
contact shadow, correct exposure and white balance — and change nothing about the
product itself: construction, proportions, materials, texture, upholstery,
stitching, joints, legs, arms, finish and colour all stay as photographed. No
part added, none removed, no substitution with a similar design. The uploaded
viewing angle is kept; the preferred front three-quarter view is approached only
when the photograph is already close to it.

How well a given model honours that is a property of the model, not of this code,
and is only knowable by running real photographs through it with a real key.
