// Stage one: the product, separated from the factory background.
//
// SERVER ONLY. FAL_KEY is read by the route and passed in.
//
// WHY THIS STAGE EXISTS AT ALL
// ----------------------------
// Not for the cut-out's own sake — the finished catalogue image comes from
// Product Shot, which could take the original photograph directly. It exists
// because the SIZE of the product has to be known before the studio image is
// requested, and this is the only way to learn it.
//
// Bria's own schema says so, of `padding_values`: "It is recommended to first
// use the product cutout API, get the cutout and understand the size of the
// result, and then define the required padding and use the cutout as an input
// for this API." Padding is measured in pixels around the product, so without
// the product's real pixel dimensions there is no padding to compute — and
// padding is the only thing that reliably controls how big the chair comes out.
//
// That makes two billable requests per photograph, which is the price of a
// framing that is arithmetic instead of a request. The alternative, asking the
// model for a size in words, was tried twice and produced a chair at about a
// fifth of the frame.
//
// THE CONTRACT
// ------------
// Read from @fal-ai/client 1.10.1's endpoint types rather than from memory:
//
//   "fal-ai/bria/background/remove"
//     input   BGRemoveInput = { image_url: string | Blob | File; sync_mode?: boolean }
//     output  { image: Image }        // ONE image, not an array
//
// Transport, allowlisting, failure classification and the no-retry rule are all
// in falRequest.ts, shared with the studio stage.

import {
  callFal, toDataUrl, MESSAGES, NO_RETRY_FAILURES, classifyFailure, isAllowedResultUrl,
  readDataUrl, PROVIDER_MAX_IMAGE_BYTES, PROVIDER_TIMEOUT_MS, MAX_RESULT_BYTES,
  type FalFailure,
} from './falRequest'

/** The model. Never overridable from anywhere, and never a generative one. */
export const MODEL_ID = 'fal-ai/bria/background/remove'

export type CutoutFailure = FalFailure

export type CutoutResult =
  | {
      ok: true
      /** The transparent PNG, as bytes. Never a URL handed to the browser. */
      png: Buffer
      contentType: string
      requestId: string
      durationMs: number
    }
  | {
      ok: false
      reason: CutoutFailure
      message: string
      /** Safe to log: a status code, never a body. */
      status?: number
      requestId?: string
      durationMs: number
    }

export type CutoutInput = {
  /** The prepared photograph. */
  bytes: Buffer
  /** Its MIME type, as decided by validateSourceImage. */
  mimeType: string
  apiKey: string
  timeoutMs?: number
}

/** The message for an empty result here is about separation specifically, which
 *  is more useful to an employee than the generic one. */
const EMPTY_RESULT_MESSAGE =
  'The product could not be separated from that photograph. Try a photograph with the product clearly visible.'

/** The request body. Two fields, because the schema has two. */
export function buildRequestBody(dataUrl: string) {
  return {
    image_url: dataUrl,
    sync_mode: true,
  }
}

/**
 * Cut the product out of one photograph.
 *
 * Exactly one billable request per call, and no automatic retry. Never throws.
 */
export async function removeBackground(input: CutoutInput): Promise<CutoutResult> {
  const startedAt = Date.now()

  if (input.bytes.byteLength > PROVIDER_MAX_IMAGE_BYTES) {
    // Refused here rather than paid for and refused there.
    return {
      ok: false,
      reason: 'unsupported_image',
      message: 'That photograph is too large for the image service. Upload a smaller file.',
      durationMs: Date.now() - startedAt,
    }
  }

  const result = await callFal({
    modelId: MODEL_ID,
    // A data URI, so the photograph travels inside the request BOE already
    // authenticates. No public URL for it is created anywhere.
    body: buildRequestBody(toDataUrl(input.bytes, input.mimeType)),
    apiKey: input.apiKey,
    timeoutMs: input.timeoutMs ?? PROVIDER_TIMEOUT_MS,
    expect: 1,
  })

  if (!result.ok) {
    return {
      ok: false,
      reason: result.reason,
      message: result.reason === 'empty_result' ? EMPTY_RESULT_MESSAGE : result.message,
      status: result.status,
      requestId: result.requestId,
      durationMs: result.durationMs,
    }
  }

  const [image] = result.images
  return {
    ok: true,
    png: image.bytes,
    contentType: image.contentType,
    requestId: result.requestId,
    durationMs: result.durationMs,
  }
}

// Re-exported so callers and tests have one import for this stage.
export {
  NO_RETRY_FAILURES, classifyFailure, isAllowedResultUrl, readDataUrl,
  PROVIDER_MAX_IMAGE_BYTES, PROVIDER_TIMEOUT_MS,
  MAX_RESULT_BYTES as MAX_CUTOUT_BYTES,
  MESSAGES,
}
