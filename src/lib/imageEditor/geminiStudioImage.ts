// The one place that talks to an image-editing provider.
//
// SERVER ONLY. The API key is read by the caller from the environment and passed
// in; nothing here is importable into a client bundle without the key going with
// it, so the route is the only caller and the key never crosses to the browser.
//
// WHY GEMINI
// ----------
// BOE already calls Anthropic for text (src/app/api/payroll/ask/route.ts), but no
// Anthropic model edits an image, so this prototype needs a second provider. It
// is deliberately ONE file behind one function: swapping providers later means
// rewriting `generateStudioImage` and nothing else. The route knows about
// `StudioImageResult`, not about Gemini.
//
// The call is a plain `fetch` against the REST endpoint — no SDK, no new
// dependency. The request is: the instruction from studioPrompt.ts, plus the
// photograph as inline base64, asking for one square image back.

import { buildStudioPrompt } from './studioPrompt'

/** Nano Banana 2 — fast, and the 1:1 output is 2048×2048 at `2K`. Override with
 *  GEMINI_IMAGE_MODEL if the key has access to a different image model. */
export const DEFAULT_IMAGE_MODEL = 'gemini-3.1-flash-image'

/** Square, per the prototype brief: one high-quality image, one shape. */
export const OUTPUT_ASPECT_RATIO = '1:1'

/** 2048×2048 at 1:1. Only the Gemini 3 image models accept this field, so it is
 *  sent only to them — see `supportsImageSize`. Everything else falls back to
 *  the model's own default (1024×1024 on gemini-2.5-flash-image). */
export const OUTPUT_IMAGE_SIZE = '2K'

/** Under the route's own 60s ceiling, leaving room to serialise the reply. */
export const PROVIDER_TIMEOUT_MS = 55_000

const ENDPOINT_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

export type StudioImageFailure =
  /** No API key configured. The page says so; it never pretends to have edited. */
  | 'not_configured'
  /** The provider did not answer in time. Retrying is reasonable. */
  | 'timeout'
  /** The provider answered with an error, or something unreadable. */
  | 'provider_error'
  /** The provider answered, but with no image — a safety block, or text only. */
  | 'no_image'

export type StudioImageResult =
  | { ok: true; image: { base64: string; mimeType: string } }
  | { ok: false; reason: StudioImageFailure; message: string; detail?: string }

export type StudioImageInput = {
  /** The photograph, base64-encoded, with no data: prefix. */
  base64: string
  /** Its MIME type, as decided by validateSourceImage. */
  mimeType: string
  apiKey: string
  model?: string
  timeoutMs?: number
}

/** `imageSize` is a Gemini 3 image-model field. Sending it to gemini-2.5-flash-image
 *  buys nothing and risks a rejected request, so the model decides. */
export function supportsImageSize(model: string): boolean {
  return model.startsWith('gemini-3')
}

/** The request body, exported so a test can assert on it without a network call. */
export function buildRequestBody(input: Pick<StudioImageInput, 'base64' | 'mimeType'>, model: string) {
  return {
    contents: [{
      role: 'user',
      parts: [
        { text: buildStudioPrompt() },
        { inlineData: { mimeType: input.mimeType, data: input.base64 } },
      ],
    }],
    generationConfig: {
      responseModalities: ['IMAGE'],
      imageConfig: supportsImageSize(model)
        ? { aspectRatio: OUTPUT_ASPECT_RATIO, imageSize: OUTPUT_IMAGE_SIZE }
        : { aspectRatio: OUTPUT_ASPECT_RATIO },
    },
  }
}

/** A response part carrying an image, under either casing. The REST API answers
 *  in camelCase; the snake_case reading is cheap insurance. */
type LooseBlob = { mimeType?: string; mime_type?: string; data?: string }
type LoosePart = { inlineData?: LooseBlob; inline_data?: LooseBlob; text?: string }

function firstImagePart(data: unknown): { base64: string; mimeType: string } | null {
  const candidates = (data as { candidates?: Array<{ content?: { parts?: LoosePart[] } }> })?.candidates ?? []
  for (const candidate of candidates) {
    for (const part of candidate?.content?.parts ?? []) {
      const blob = part?.inlineData ?? part?.inline_data
      const mimeType = blob?.mimeType ?? blob?.mime_type ?? ''
      if (blob?.data && mimeType.startsWith('image/')) {
        return { base64: blob.data, mimeType }
      }
    }
  }
  return null
}

/** Why the provider returned no image, in words an employee can act on. */
function noImageMessage(data: unknown): string {
  const blockReason = (data as { promptFeedback?: { blockReason?: string } })?.promptFeedback?.blockReason
  const finishReason = (data as { candidates?: Array<{ finishReason?: string }> })?.candidates?.[0]?.finishReason

  if (blockReason || (finishReason && /SAFETY|PROHIBITED|BLOCKLIST|RECITATION|SPII/.test(finishReason))) {
    return 'The image service declined to edit this photograph. Try a different photograph of the product.'
  }
  return 'The image service did not return an edited image. Please try again.'
}

/**
 * Edit one furniture photograph into one square studio image.
 *
 * Never throws: every failure comes back as `{ ok: false }` with a reason the
 * route maps to a status code and a message the page can show. Provider error
 * text is returned in `detail` for the SERVER LOG only — the route does not put
 * it in the response, because it can echo request content.
 */
export async function generateStudioImage(input: StudioImageInput): Promise<StudioImageResult> {
  const model = (input.model || DEFAULT_IMAGE_MODEL).trim()
  const timeoutMs = input.timeoutMs ?? PROVIDER_TIMEOUT_MS

  if (!input.apiKey) {
    return {
      ok: false,
      reason: 'not_configured',
      message: 'The image service is not configured.',
    }
  }

  let response: Response
  try {
    response = await fetch(`${ENDPOINT_BASE}/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // The key travels in a header, never in the URL: a query-string key ends
        // up in access logs and error traces.
        'x-goog-api-key': input.apiKey,
      },
      body: JSON.stringify(buildRequestBody(input, model)),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')
    return timedOut
      ? {
          ok: false,
          reason: 'timeout',
          message: 'The image is taking longer than expected. Please try again.',
        }
      : {
          ok: false,
          reason: 'provider_error',
          message: 'Could not reach the image service. Please try again.',
          detail: e instanceof Error ? e.message : String(e),
        }
  }

  if (!response.ok) {
    return {
      ok: false,
      reason: 'provider_error',
      message: 'The image service could not process this photograph. Please try again.',
      detail: `${response.status} ${await response.text().catch(() => '')}`.slice(0, 500),
    }
  }

  let data: unknown
  try {
    data = await response.json()
  } catch {
    return {
      ok: false,
      reason: 'provider_error',
      message: 'The image service returned an unreadable response. Please try again.',
    }
  }

  const image = firstImagePart(data)
  if (!image) {
    return { ok: false, reason: 'no_image', message: noImageMessage(data) }
  }

  return { ok: true, image }
}
