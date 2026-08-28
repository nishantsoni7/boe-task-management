// The studio stage: the cut-out goes in, the approved catalogue photograph
// comes out.
//
// SERVER ONLY. FAL_KEY is read by the route and passed in, so the key never
// crosses to the browser and the model id is unreachable from it.
//
// WHY THIS MODEL IS BACK
// ----------------------
// It was removed after two paid results ignored the composition. A third,
// with a reference image and a scene description, was accepted by the product
// owner: the background, the lighting, the contact and cast shadows and the
// square master are all approved. One defect remained — the chair was too
// small — and that is a framing problem, not a scene problem.
//
// So the division of labour changed again, and this time along the line the
// evidence actually drew: the model is good at the studio scene and bad at
// holding a size, so it keeps the scene and no longer decides the size. The
// size is padding, computed in studioMaster.ts from the real cut-out.
//
// THE CONTRACT
// ------------
// Read from @fal-ai/client 1.10.1's `ProductShotInput` rather than from memory:
//
//   fast?: boolean
//   image_url: string | Blob | File           — the product; 12MB ceiling
//   manual_placement_selection?: …            — only for placement_type=manual_placement
//   num_results?: number                      — Bria bills per result
//   optimize_description?: boolean
//   original_quality?: boolean                — only for placement_type=original
//   padding_values?: Array<number>            — [left, right, top, bottom]
//   placement_type?: 'original' | 'automatic' | 'manual_placement' | 'manual_padding'
//   ref_image_url?: string | Blob | File
//   scene_description?: string
//   shot_size?: Array<number>                 — "only relevant when
//                                               placement_type=automatic or
//                                               placement_type=manual_placement"
//   sync_mode?: boolean
//
//   output  { images: Array<Image> }          — an ARRAY, unlike background/remove
//
// Two consequences worth stating, because both change what is sent:
//
//   * `shot_size` is NOT sent. Under manual_padding the canvas is the cut-out
//     plus its padding, and shot_size is ignored — so the master's 1000 x 1000
//     comes from the padding arithmetic instead, which closes on it exactly.
//   * `manual_placement_selection`, `original_quality` and `num_results > 1`
//     belong to other modes or cost more. None is sent.
//
// THE REFERENCE IMAGE, AND NOTHING ELSE
// -------------------------------------
// The schema is explicit: "Either ref_image_url or scene_description has to be
// provided but not both." They are documented as mutually exclusive modes, so
// only ref_image_url is sent.
//
// The accepted request carried both. That it returned an approved picture does
// not make it a supported combination — with two mutually exclusive inputs
// supplied, which one fal honoured is undefined, and building on undefined
// behaviour means the look can change without anything here changing. The
// reference image is the approved standard in its own right, and it is the
// input this mode is documented to take.
//
// There is therefore no prompt constant in this file. Nothing describes the
// scene in words anywhere in the runtime path — the reference image is the
// description.

import {
  callFal, toDataUrl, MESSAGES, NO_RETRY_FAILURES,
  PROVIDER_MAX_IMAGE_BYTES, PROVIDER_TIMEOUT_MS,
  type FalFailure, type FalResult,
} from './falRequest'
import { loadStudioReference, REFERENCE_PATH } from './studioReference'
import type { PaddingPlan } from './studioMaster'

/** The model. Fixed here, unreachable from the browser, never read from a form. */
export const MODEL_ID = 'fal-ai/bria/product-shot'

/** The settings that decide what a request costs and what comes back. Every one
 *  is fixed, and none is reachable from the browser. */
export const FIXED_SETTINGS = {
  /** Bria bills per result. Ten placements is ten charges. */
  num_results: 1,
  /** Left off so the reference image is used as given, rather than being
   *  reinterpreted into a description of itself. */
  optimize_description: false,
  /** As accepted. */
  fast: true,
  /** The size is arithmetic now, not a request. */
  placement_type: 'manual_padding',
  // sync_mode is deliberately NOT sent. With it true, fal returns the image
  // inline and, in its own words, "the output data won't be available in the
  // request history" — which is exactly the record needed to audit what a run
  // cost and to look at what came back. Omitting it means fal answers with a
  // hosted URL, which the transport downloads server-side, so the browser is
  // still never handed a provider URL.
} as const

export type StudioFailure = FalFailure | 'reference_missing'

export type StudioInput = {
  /** The cut-out, already cropped to the product and resized to the plan. */
  cutoutPng: Buffer
  plan: PaddingPlan
  apiKey: string
  timeoutMs?: number
  /** Overridden by tests that put a fixture somewhere else. */
  referenceRoot?: string
}

export type StudioResult =
  | { ok: true; image: Buffer; contentType: string; requestId: string; durationMs: number }
  | { ok: false; reason: StudioFailure; message: string; status?: number; requestId?: string; durationMs: number; detail?: string }

const REFERENCE_MISSING_MESSAGE =
  'The studio reference image is not installed on this server. Ask your administrator to add it.'

/** Failures where sending the same photograph again cannot help. */
export function isNoRetry(reason: StudioFailure): boolean {
  return reason === 'reference_missing' || NO_RETRY_FAILURES.has(reason as FalFailure)
}

/**
 * The request body, whole, so a test can assert on it without a network.
 *
 * `padding_values` is the only part that varies between one photograph and the
 * next, and it arrives already computed. There is no `scene_description` and no
 * `sync_mode`: the first is the mode this one excludes, the second would hide
 * the result from fal's request history.
 */
export function buildRequestBody(
  cutoutDataUrl: string,
  referenceDataUrl: string,
  paddingValues: readonly number[],
) {
  return {
    image_url: cutoutDataUrl,
    ref_image_url: referenceDataUrl,
    padding_values: [...paddingValues],
    ...FIXED_SETTINGS,
  }
}

/**
 * Generate one studio image from one cut-out.
 *
 * Exactly one billable request per call, and no automatic retry — including
 * after a timeout, which is precisely when a charge is most likely to have
 * already happened. Never throws.
 */
export async function generateStudioShot(input: StudioInput): Promise<StudioResult> {
  const startedAt = Date.now()

  if (input.cutoutPng.byteLength > PROVIDER_MAX_IMAGE_BYTES) {
    return {
      ok: false,
      reason: 'unsupported_image',
      message: MESSAGES.unsupported_image,
      durationMs: Date.now() - startedAt,
    }
  }

  // Loaded BEFORE the request, so a missing reference costs nothing. Generating
  // without it would produce a studio image that is not the approved one and
  // that nobody could tell apart from an approved one.
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

  const result: FalResult = await callFal({
    modelId: MODEL_ID,
    body: buildRequestBody(
      toDataUrl(input.cutoutPng, 'image/png'),
      reference.dataUrl,
      input.plan.paddingValues,
    ),
    apiKey: input.apiKey,
    timeoutMs: input.timeoutMs ?? PROVIDER_TIMEOUT_MS,
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

/** Named so a failure log can say which asset an administrator has to install. */
export { REFERENCE_PATH }
