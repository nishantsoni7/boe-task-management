// Stage one: the studio photograph, from Bria Product Shot.
//
// SERVER ONLY. FAL_KEY is read by the route and passed in, so the key never
// crosses to the browser and the model id is unreachable from it.
//
// WHAT IS SENT, AND WHY EXACTLY THAT
// ----------------------------------
// The playground run whose result was accepted establishes three facts, and the
// request below carries those three and nothing invented:
//
//   * the ORIGINAL uploaded photograph is the main image;
//   * the approved studio photograph is supplied through `ref_image_url`;
//   * Scene Description was EMPTY.
//
// So no `scene_description` is sent. The reference image is what drives the
// scene, and the schema is explicit that the two are alternatives: "Either
// ref_image_url or scene_description has to be provided but not both."
//
// The remaining settings come from the last accepted REQUEST RECORD rather than
// from a guess about hidden playground defaults: `num_results: 1`, `fast: true`,
// `placement_type: 'manual_placement'`, `manual_placement_selection:
// 'bottom_center'`, `shot_size: [1000, 1000]`. Nothing else is sent —
// `padding_values` belongs to a different placement mode and `original_quality`
// to another again.
//
// `optimize_description: false`, as required, so the reference is used as given.
//
// THE CONTRACT
// ------------
// Read from @fal-ai/client 1.10.1's `ProductShotInput` rather than from memory:
//
//   fast?, image_url, manual_placement_selection?, num_results?,
//   optimize_description?, original_quality?, padding_values?, placement_type?,
//   ref_image_url?, scene_description?, shot_size?, sync_mode?
//
//   output  { images: Array<Image> }        — an ARRAY
//
// `sync_mode` is deliberately not sent: with it true the result is inline and
// "the output data won't be available in the request history", which is the
// record needed to audit what a run cost and to look at what came back.
//
// WHAT CHANGED, AND WHAT IS BEING TESTED
// --------------------------------------
// The application pipeline that was rejected was:
//
//     background removal -> prepared CUT-OUT -> Product Shot
//
// and its result merged the fan of thin spindles under the Irvine chair's seat
// into an opaque block. The successful direct playground run was:
//
//     ORIGINAL photograph -> Product Shot with ref_image_url
//
// That difference — what the model is given to work from — is the whole basis
// of this experiment. This adapter sends the original photograph, as the
// playground did. Whether it preserves the chair better than the cut-out path
// did is exactly the open question, and it is unanswered until a real run is
// compared.
//
// WHAT THIS CANNOT PROMISE
// ------------------------
// Pixel identity. This is a generative model and it renders the whole image,
// the product included — there is no pass-through mode in the contract.
// Everything downstream of here is checked rather than trusted; see
// preservationGate.ts.

import {
  callFal, toDataUrl, MESSAGES, NO_RETRY_FAILURES,
  PROVIDER_MAX_IMAGE_BYTES, PROVIDER_TIMEOUT_MS,
  type FalFailure,
} from './falRequest'
import { loadStudioReference, REFERENCE_PATH } from './studioReference'

/** The model. Fixed here, unreachable from the browser, never read from a form. */
export const MODEL_ID = 'fal-ai/bria/product-shot'

/**
 * The settings that decide what a request costs and what comes back.
 *
 * From the accepted request record. Every one is fixed and none is reachable
 * from the browser.
 */
export const FIXED_SETTINGS = {
  /** Bria bills per result. Ten placements would be ten charges. */
  num_results: 1,
  /** The reference is used as given, not reinterpreted into a description. */
  optimize_description: false,
  fast: true,
  placement_type: 'manual_placement',
  manual_placement_selection: 'bottom_center',
  shot_size: [1000, 1000],
} as const

export type ProductShotFailure = FalFailure | 'reference_missing'

export type ProductShotInput = {
  /** The ORIGINAL uploaded photograph, prepared but not segmented. */
  photograph: Buffer
  mimeType: string
  apiKey: string
  timeoutMs?: number
  deadlineAt?: number
  /** Overridden by tests that put a fixture somewhere else. */
  referenceRoot?: string
}

export type ProductShotResult =
  | { ok: true; image: Buffer; contentType: string; requestId: string; durationMs: number }
  | {
      ok: false
      reason: ProductShotFailure
      message: string
      status?: number
      requestId?: string
      durationMs: number
      detail?: string
      phase?: 'request' | 'body' | 'download'
    }

const REFERENCE_MISSING_MESSAGE =
  'The studio reference image is not installed on this server. Ask your administrator to add it.'

/** Failures where sending the same photograph again cannot help. */
export function isNoRetry(reason: ProductShotFailure): boolean {
  return reason === 'reference_missing' || NO_RETRY_FAILURES.has(reason as FalFailure)
}

/**
 * The request body, whole, so a test can assert on it without a network.
 *
 * There is no `scene_description` key and no `sync_mode` key — not empty
 * strings, absent. An empty scene description is still a scene description as
 * far as the "but not both" rule is concerned.
 */
export function buildRequestBody(photographDataUrl: string, referenceDataUrl: string) {
  return {
    image_url: photographDataUrl,
    ref_image_url: referenceDataUrl,
    ...FIXED_SETTINGS,
  }
}

/**
 * Generate one studio photograph from one uploaded photograph.
 *
 * Exactly one billable request per call, and no automatic retry — including
 * after a timeout, which is when a charge is most likely to have happened
 * already. Never throws.
 */
export async function generateProductShot(input: ProductShotInput): Promise<ProductShotResult> {
  const startedAt = Date.now()

  if (input.photograph.byteLength > PROVIDER_MAX_IMAGE_BYTES) {
    return {
      ok: false,
      reason: 'unsupported_image',
      message: MESSAGES.unsupported_image,
      durationMs: Date.now() - startedAt,
    }
  }

  // Loaded BEFORE the request, so a missing reference costs nothing. Generating
  // without it would produce a studio image that is not the approved look and
  // that nobody downstream could tell apart from one that is.
  const reference = await loadStudioReference(input.referenceRoot)
  if (!reference.ok) {
    return {
      ok: false,
      reason: 'reference_missing',
      message: REFERENCE_MISSING_MESSAGE,
      detail: reference.detail,
      durationMs: Date.now() - startedAt,
    }
  }

  const result = await callFal({
    modelId: MODEL_ID,
    body: buildRequestBody(toDataUrl(input.photograph, input.mimeType), reference.dataUrl),
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

export { REFERENCE_PATH }
