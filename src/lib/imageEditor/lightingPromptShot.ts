// EXPERIMENT ONLY — not wired into the application route.
//
// SERVER ONLY. The prompt below never reaches the browser: nothing under
// src/app/image-editor/ imports this module, and a test asserts the bundle is
// clean.
//
// WHAT THIS IS
// ------------
// The accepted pipeline drives the scene with `ref_image_url` — the approved
// studio photograph — and sends no scene description at all. That result is
// good, and three things about it are not:
//
//   1. the furniture sits too close to the rear wall, with a strong shadow
//      starting immediately behind the upper product and falling onto the
//      vertical background rather than the floor;
//   2. the cast shadow sometimes travels TOWARDS the dominant light, which no
//      real light can do and which the eye reads as wrong before it can say why;
//   3. under-seat rails, rear legs, lower frames, dark wood, cane and
//      upholstery go too dark to read.
//
// A reference image cannot fix any of those, because a reference image says
// "look like this picture" and cannot say "stand further forward" or "work out
// where the light is coming from". Those are instructions, and the only channel
// for an instruction is `scene_description`.
//
// So this adapter swaps ONE thing: the scene source. `ref_image_url` out,
// `scene_description` in. Bria's schema documents them as mutually exclusive —
// "Either ref_image_url or scene_description has to be provided but not both" —
// so this is a swap, not an addition.
//
// EVERYTHING ELSE IS THE REVIEWED REQUEST
// ---------------------------------------
// `FIXED_SETTINGS` and `MODEL_ID` are IMPORTED from the accepted adapter rather
// than copied. That is deliberate: a copy can drift, and then a lighting
// comparison would be measuring two changes while reporting one. Imported, the
// placement, shot size, num_results, fast and optimize_description are the same
// objects the reviewed run used, and cannot silently differ.
//
// WHY optimize_description STAYS false
// ------------------------------------
// It is what stops Bria rewriting the prompt. With it true the model is free to
// "improve" the description, and the careful parts — infer the light direction,
// keep the shadow off the wall, lift the blacks by half a stop and no more —
// are exactly the parts a rewrite would smooth away. The prompt is sent as
// written or the experiment measures something else.
//
// WHAT THIS STILL CANNOT PROMISE
// ------------------------------
// Pixel identity. A prompt that describes lighting is still a prompt to a
// generative model that renders the whole frame, product included. The prompt
// below is written to forbid redrawing the product, which is not the same as
// preventing it. Every result goes through the same preservation gate, and a
// structural difference is a failure however good the lighting looks.

import {
  callFal, toDataUrl, MESSAGES, NO_RETRY_FAILURES,
  PROVIDER_MAX_IMAGE_BYTES, PROVIDER_TIMEOUT_MS,
  type FalFailure,
} from './falRequest'
import { MODEL_ID, FIXED_SETTINGS } from './briaProductShot'

export { MODEL_ID, FIXED_SETTINGS }

/**
 * The scene description, exactly as approved for this experiment.
 *
 * Held as one constant so there is a single authority for what was sent, and
 * so a live result can be traced to the exact words that produced it. It is
 * written as separate paragraphs and joined with blank lines, which is how it
 * was specified; the joining is done here rather than in a template literal so
 * no editor's trailing-whitespace or indentation setting can alter the text.
 *
 * Five things it is doing, in order:
 *
 *   1. PRESERVATION FIRST. Before any lighting instruction, an explicit and
 *      exhaustive list of what must not change. It comes first because a model
 *      asked to relight will otherwise relight by repainting.
 *   2. DISTANCE. "Approximately one and a half metres in front of a seamless
 *      studio cyclorama" — a physical arrangement rather than an adjective,
 *      because a shadow that lands on the floor instead of the wall is a
 *      consequence of where the product stands, not of asking for less shadow.
 *   3. LIGHT DIRECTION, INFERRED. The direction is not dictated; the model is
 *      told to read it off the highlights already on the furniture and then
 *      keep the shadow consistent with it. Dictating a direction would fight
 *      the photograph on every upload lit from the other side.
 *   4. FILL, BOUNDED. "Half to three-quarters of a photographic stop" is a
 *      quantity, and the sentence after it names the failure modes — flat,
 *      washed out, grey, glossy, plastic, artificially bright — because "lift
 *      the shadows" without a bound is how a product ends up looking like
 *      plastic.
 *   5. SHADOW SHAPE. Contact shadows touching every foot (floating feet are
 *      the giveaway of a composited image), one cast shadow, on the floor, and
 *      an explicit list of the artefacts to avoid.
 */
export const LIGHTING_SCENE_DESCRIPTION = [
  'Create a premium professional furniture catalogue photograph in a spacious seamless studio. Preserve the complete furniture product exactly as shown in the uploaded photograph, including its viewing angle, perspective, construction, proportions, silhouette, legs, arms, rails, joints, thin members, open gaps, cane, upholstery, wood grain, finish, hardware, colours, watermark and every visible detail. Do not rotate, reshape, redesign, replace, remove, add or merge any product part.',
  'Place the furniture well forward from the rear background, as if positioned approximately one and a half metres in front of a seamless studio cyclorama. The furniture must not appear pressed against a wall. Keep the wall and floor transition continuous and subtle, with no hard dividing line.',
  'Infer the dominant illumination direction from the existing highlights and tonal brightness on the furniture. Preserve that lighting logic. If the furniture is brighter from the left or front-left, cast the soft shadow toward the right and back. If it is brighter from the right or front-right, cast the soft shadow toward the left and back. Never cast a shadow toward the dominant light source.',
  'Use a large soft diffused key light from the inferred direction and a restrained frontal fill light. Gently lift the darkest furniture areas so the under-seat structure, rear legs, lower rails, dark wood, cane and upholstery remain clearly readable. Reduce excessively black areas by approximately half to three-quarters of a photographic stop while retaining natural depth, wood tone, texture and contrast. Do not make the product flat, washed out, grey, glossy, plastic or artificially bright.',
  'Create realistic contact shadows touching every floor-standing foot. Add one restrained soft cast shadow extending away from the inferred light direction across the floor. Keep the cast shadow primarily on the floor, not on the rear background. Avoid wall shadows, dark halos, isolated shadow blobs, duplicate shadows and floating feet.',
  'Use a seamless warm-neutral light-grey studio sweep with a soft natural tonal gradient, slightly brighter behind the furniture, without a circular spotlight or obvious vignette. Produce balanced premium catalogue lighting with clear product detail, subtle modelling and natural materials. Keep the complete product visible and horizontally centred with balanced margins.',
].join('\n\n')

export type LightingShotResult =
  | { ok: true; image: Buffer; contentType: string; requestId: string; durationMs: number }
  | {
      ok: false
      reason: FalFailure
      message: string
      status?: number
      requestId?: string
      durationMs: number
      phase?: 'request' | 'body' | 'download'
    }

export type LightingShotInput = {
  /** The ORIGINAL uploaded photograph, prepared but never segmented. */
  photograph: Buffer
  mimeType: string
  apiKey: string
  timeoutMs?: number
  deadlineAt?: number
}

/** Failures where sending the same photograph again cannot help. */
export function isNoRetry(reason: FalFailure): boolean {
  return NO_RETRY_FAILURES.has(reason)
}

/**
 * The request body, whole, so a test can assert on it without a network.
 *
 * `ref_image_url` is ABSENT, not empty — the schema's "but not both" rule is
 * about the key being present, and an empty string would still be a second
 * scene source.
 */
export function buildRequestBody(photographDataUrl: string) {
  return {
    image_url: photographDataUrl,
    scene_description: LIGHTING_SCENE_DESCRIPTION,
    ...FIXED_SETTINGS,
  }
}

/**
 * One prompt-driven studio photograph from one uploaded photograph.
 *
 * Exactly one billable request per call, and no automatic retry — including
 * after a timeout, which is when a charge is most likely to have happened
 * already. Never throws.
 *
 * No reference image is loaded, so unlike the accepted adapter this one has
 * nothing to check before sending: the prompt is a constant and cannot be
 * missing from a checkout.
 */
export async function generateLightingShot(input: LightingShotInput): Promise<LightingShotResult> {
  const startedAt = Date.now()

  if (input.photograph.byteLength > PROVIDER_MAX_IMAGE_BYTES) {
    return {
      ok: false,
      reason: 'unsupported_image',
      message: MESSAGES.unsupported_image,
      durationMs: Date.now() - startedAt,
    }
  }

  const result = await callFal({
    modelId: MODEL_ID,
    body: buildRequestBody(toDataUrl(input.photograph, input.mimeType)),
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
    requestId: result.requestId,
    durationMs: result.durationMs,
  }
}
