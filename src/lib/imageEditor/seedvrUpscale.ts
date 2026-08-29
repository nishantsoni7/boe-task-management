// Stage two: resolution, from SeedVR2.
//
// SERVER ONLY. The key is passed in by the route.
//
// THE CONTRACT
// ------------
// Read from @fal-ai/client 1.10.1's `SeedVRImageInput` rather than from memory:
//
//   "fal-ai/seedvr/upscale/image"
//     image_url          string | Blob | File     (required)
//     noise_scale?       number                   default 0.1
//     output_format?     "png" | "jpg" | "webp"   default "jpg"
//     seed?              number
//     sync_mode?         boolean
//     target_resolution? "720p"|"1080p"|"1440p"|"2160p"   default "1080p"
//     upscale_factor?    number                   default 2
//     upscale_mode?      "target" | "factor"      default "factor"
//
//     output  { image: ImageFile; seed: number }   — ONE image, not an array
//
// WHAT IS SENT, AND WHY
// ---------------------
//   * `output_format: 'png'` — the default is jpg, and a catalogue master is
//     not delivered with jpeg artefacts baked into the wood grain.
//   * `upscale_mode: 'factor'` with a factor computed from the actual reframed
//     size, rather than `target_resolution`. "1440p" conventionally means a
//     1440-pixel HEIGHT on a 16:9 frame, and what it does to a square input is
//     not stated anywhere in the contract. A factor is arithmetic we control.
//
//     THE ACCEPTED RANGE OF THAT FACTOR IS NOT DOCUMENTED. The contract says
//     `upscale_factor?: number` with a default of 2 and states no minimum,
//     maximum or integer constraint, and the package carries no JSON schema to
//     check against. So a fractional factor such as 1.44 is neither confirmed
//     nor ruled out. It is sent because it is the smallest that reaches the
//     master, rounded to two decimals rather than left at full precision, and
//     NOTHING DOWNSTREAM ASSUMES IT WORKED: `normaliseSquare` below inspects
//     what actually came back. If a live run is refused at this stage, the
//     factor is the first suspect and the fix is `upscale_factor: 2` with the
//     surplus taken off locally.
//   * `noise_scale: 0` — the default is 0.1, and this is the one knob that
//     governs how much the model invents. Zero is the least it will do. The
//     brief asks for resolution and edge clarity, not restoration: wood grain,
//     cane, thin spindles and watermark text must come back as themselves.
//   * `sync_mode` is NOT sent, so the run stays in fal's request history with
//     its result.
//
// WHAT THIS CANNOT PROMISE
// ------------------------
// Pixel identity. SeedVR is a generative restorer; even at `noise_scale: 0` it
// is a model, not a resampler. Its output is checked downstream rather than
// trusted.

import sharp from 'sharp'
import {
  callFal, toDataUrl, MESSAGES, NO_RETRY_FAILURES,
  PROVIDER_MAX_IMAGE_BYTES, PROVIDER_TIMEOUT_MS,
  type FalFailure,
} from './falRequest'

export const MODEL_ID = 'fal-ai/seedvr/upscale/image'

/** The least invention the contract allows. The default is 0.1. */
export const NOISE_SCALE = 0

/** fal rejects an unreasonable factor and a huge one costs time for nothing. */
export const MAX_UPSCALE_FACTOR = 4

export type UpscaleFailure = FalFailure

export type UpscaleInput = {
  image: Buffer
  mimeType: string
  /** The square side the result must reach. */
  targetSide: number
  /** The square side going in. */
  sourceSide: number
  apiKey: string
  timeoutMs?: number
  deadlineAt?: number
}

export type UpscaleResult =
  | { ok: true; image: Buffer; contentType: string; factor: number; requestId: string; durationMs: number }
  | {
      ok: false
      reason: UpscaleFailure
      message: string
      status?: number
      requestId?: string
      durationMs: number
      phase?: 'request' | 'body' | 'download'
    }

export { NO_RETRY_FAILURES }

/**
 * The smallest factor that reaches the target.
 *
 * Rounded up to two decimals so it cannot land a pixel short, clamped so a
 * pathologically small input cannot ask for a 20x upscale. An input already at
 * or above the target still asks for 1 — the model is not skipped silently,
 * because the caller decides that, not this.
 */
export function upscaleFactorFor(sourceSide: number, targetSide: number): number {
  if (sourceSide <= 0) return 1
  const needed = targetSide / sourceSide
  return Math.min(MAX_UPSCALE_FACTOR, Math.max(1, Math.ceil(needed * 100) / 100))
}

/** The request body, whole, so a test can assert on it without a network. */
export function buildRequestBody(imageDataUrl: string, factor: number) {
  return {
    image_url: imageDataUrl,
    upscale_mode: 'factor',
    upscale_factor: factor,
    output_format: 'png',
    noise_scale: NOISE_SCALE,
  }
}

/**
 * Upscale one image. Exactly one billable request, and no automatic retry.
 * Never throws.
 */
export async function upscaleImage(input: UpscaleInput): Promise<UpscaleResult> {
  const startedAt = Date.now()

  if (input.image.byteLength > PROVIDER_MAX_IMAGE_BYTES) {
    return {
      ok: false,
      reason: 'unsupported_image',
      message: MESSAGES.unsupported_image,
      durationMs: Date.now() - startedAt,
    }
  }

  const factor = upscaleFactorFor(input.sourceSide, input.targetSide)

  const result = await callFal({
    modelId: MODEL_ID,
    body: buildRequestBody(toDataUrl(input.image, input.mimeType), factor),
    apiKey: input.apiKey,
    timeoutMs: input.timeoutMs ?? PROVIDER_TIMEOUT_MS,
    deadlineAt: input.deadlineAt,
    expect: 1,
  })

  if (!result.ok) {
    return {
      ok: false,
      reason: result.reason,
      message: result.message,
      status: result.status,
      requestId: result.requestId,
      durationMs: result.durationMs,
      phase: result.phase,
    }
  }

  const [image] = result.images
  return {
    ok: true,
    image: image.bytes,
    contentType: image.contentType,
    factor,
    requestId: result.requestId,
    durationMs: result.durationMs,
  }
}

// ─── Delivering exactly the master size ───────────────────────────────────────

export type NormaliseResult =
  | {
      ok: true
      image: Buffer
      /** What SeedVR2 actually returned. */
      returned: { width: number; height: number }
      /** What is delivered. Always the master, exactly. */
      delivered: { width: number; height: number }
      /** True when a local resize was needed to get there. */
      resized: boolean
    }
  | { ok: false; error: string; returned?: { width: number; height: number } }

const NOT_SQUARE =
  'The upscaled image came back the wrong shape. Please try again.'

/**
 * Make the upscaled image exactly the master size, without changing its shape.
 *
 * `upscale_factor: 1.44` on a 1000px square SHOULD give 1440, but nothing in
 * the contract promises the model rounds the way we would, and the factor's
 * accepted range is undocumented besides. So the result is inspected rather
 * than assumed.
 *
 * A non-square result is refused, not corrected: squeezing a rectangle into a
 * square would change the product's proportions, which is the one thing this
 * whole pipeline exists to avoid. Anything square but off-size is resized —
 * never cropped, because a crop at this point could take a foot off.
 */
export async function normaliseSquare(image: Buffer, side: number): Promise<NormaliseResult> {
  let width = 0
  let height = 0
  try {
    const meta = await sharp(image, { failOn: 'error' }).metadata()
    width = meta.width ?? 0
    height = meta.height ?? 0
  } catch {
    return { ok: false, error: 'The upscaled image could not be read. Please try again.' }
  }
  if (!width || !height) {
    return { ok: false, error: 'The upscaled image could not be read. Please try again.' }
  }
  if (width !== height) {
    return { ok: false, error: NOT_SQUARE, returned: { width, height } }
  }

  const returned = { width, height }
  if (width === side) {
    // Already exact: re-encoded as PNG so the delivered bytes are always PNG,
    // whatever the model chose to hand back.
    const png = await sharp(image).png({ compressionLevel: 9 }).toBuffer()
    return { ok: true, image: png, returned, delivered: { width: side, height: side }, resized: false }
  }

  const png = await sharp(image)
    // One proportional resize of a square to a square: the aspect ratio cannot
    // change, and nothing is cropped.
    .resize(side, side, { kernel: 'lanczos3', fit: 'fill' })
    .png({ compressionLevel: 9 })
    .toBuffer()

  return { ok: true, image: png, returned, delivered: { width: side, height: side }, resized: true }
}
