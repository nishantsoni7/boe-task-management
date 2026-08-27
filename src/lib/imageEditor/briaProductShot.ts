// The one place that talks to an image provider.
//
// SERVER ONLY. FAL_KEY is read by the caller from the environment and passed
// in, so the route is the only caller and the key never crosses to the browser.
//
// THE MODEL
// ---------
// `fal-ai/bria/product-shot`, called synchronously. It takes the uploaded
// photograph and re-photographs the SAME product into a studio scene described
// by STUDIO_SCENE_DESCRIPTION below. Everything about the request that costs
// money or decides what comes back is fixed here, server-side: the model id,
// the scene description, and every generation setting. Nothing in the request
// body is derived from anything the browser sent except the image itself.
//
// WHY PLAIN `fetch` AND NOT `@fal-ai/client`
// ------------------------------------------
// The official client is a reasonable package, and its `run()` is the natural
// fit — except that it retries automatically: `maxRetries: 3` over status codes
// 429, 502, 503 and 504 (src/client.js and src/retry.js in @fal-ai/client
// 1.10.1). On a chargeable model call that turns one button press into as many
// as four billed requests, silently. There is no way to reach the sync endpoint
// through the client without that behaviour, and BOE's rule for this prototype
// is one click, one request.
//
// So this is one POST, no retry, no SDK. The contract it implements was read
// out of that same package rather than from memory: `POST https://fal.run/<id>`
// with `Authorization: Key <credentials>` (src/request.js), the input as the
// JSON body, and the request id returned in the `x-fal-request-id` header
// (src/response.js). The input and output shapes are ProductShotInput and
// BlurOutput from its endpoint types.

import {
  resolveOutputPreset,
  DEFAULT_OUTPUT_PRESET,
  type OutputPresetKey,
} from './outputPresets'

/** The model. Never overridable from anywhere. */
export const MODEL_ID = 'fal-ai/bria/product-shot'

const ENDPOINT = `https://fal.run/${MODEL_ID}`

// The output shape is the one thing about the request an employee chooses, and
// even that arrives as a key rather than as pixels — see outputPresets.ts.

/** fal returns the request id here; it is the only provider detail worth logging. */
const REQUEST_ID_HEADER = 'x-fal-request-id'

/**
 * The scene, and the single source of truth for it.
 *
 * Server-side and constant: no employee writes or edits this, and nothing from
 * the upload is interpolated into it, so an uploaded file has no text channel
 * through which to change what the model is asked for.
 *
 * It is the reference standard written out in full — framing, view, light,
 * shadow, background, and what must not change about the product — in the order
 * a photographer would set a shot up. The numbers are spelled as words because
 * Bria takes English prompts without special characters.
 *
 * The last paragraph is last on purpose. A model asked to make furniture look
 * good will happily redesign it, and the preservation clauses read as the final
 * word rather than as something the framing instructions above may trade away.
 */
export const STUDIO_SCENE_DESCRIPTION =
  'Close premium furniture catalogue packshot of one product, horizontally centred in a seamless warm light grey cyclorama studio. ' +
  'Present the complete product prominently so it occupies approximately sixty to sixty five percent of the image height, ' +
  'with around twenty percent clear space above and sixteen percent clear space below the feet. ' +
  'Keep balanced side margins and do not crop any part of the product. ' +
  'Use a natural front three quarter furniture view, approximately twenty five to thirty five degrees from the front, ' +
  'with the front dominant, one side visible, and a slight natural view of the seat or top surface. ' +
  'Preserve the uploaded viewing angle whenever changing it would require reconstructing or inventing product details. ' +
  'Use a large soft directional studio light from the upper left front, gentle opposite fill light, controlled highlights, ' +
  'natural contrast, and sharp readable material texture. ' +
  'Create compact contact shadows directly beneath every product foot and one subtle soft cast shadow extending away from the main light. ' +
  'Use one continuous warm light grey studio background and floor transition with no visible horizon, wall and floor division, ' +
  'skirting, corner, room, architecture, props, texture, decoration, text, or added logo. ' +
  'Preserve the uploaded furniture product exactly. Keep its construction, geometry, proportions, viewing direction, legs, arms, ' +
  'joints, cane pattern, rope pattern, upholstery, stitching, wood grain, metal details, finish, colours, materials, ' +
  'and any existing product marking unchanged. ' +
  'Do not add, remove, redesign, reshape, rotate, recolour, smooth, replace, or regenerate any product component.'

export const FIXED_SETTINGS = {
  num_results: 1,
  fast: true,
  optimize_description: false,
  placement_type: 'manual_placement',
  manual_placement_selection: 'bottom_center',
  sync_mode: true,
} as const

/** Bria's own ceiling for the source image. */
export const PROVIDER_MAX_IMAGE_BYTES = 12 * 1024 * 1024

/** Under the route's 60s ceiling, leaving room to return the image. */
export const PROVIDER_TIMEOUT_MS = 55_000

/** How long the result download may take when fal answers with a URL instead
 *  of inline data, and the most it may be. */
const RESULT_FETCH_TIMEOUT_MS = 20_000
const RESULT_MAX_BYTES = 32 * 1024 * 1024

/** Hosts a result may be downloaded from. fal answers with its own storage, and
 *  a URL from anywhere else is not a result this route will fetch. */
const RESULT_HOSTS = ['fal.media', 'fal.ai', 'fal.run']

export type ProductShotFailure =
  /** No API key configured. The page says so; it never pretends to have edited. */
  | 'not_configured'
  /** The key was refused. An administrator has to fix it — retrying will not. */
  | 'invalid_key'
  /** The fal account is out of credit. Also not a retry. */
  | 'insufficient_credit'
  /** Too many requests. Worth retrying shortly. */
  | 'rate_limited'
  /** fal could not read this image, or refused its size or format. */
  | 'unsupported_image'
  /** Content moderation refused the image. A different photograph, not a retry. */
  | 'moderation'
  /** No answer in time. NOT retried automatically: the request may have been
   *  billed, and a silent second attempt would bill again. */
  | 'timeout'
  /** A 200 that carried no usable image. */
  | 'empty_result'
  /** Anything else. */
  | 'provider_error'

export type ProductShotResult =
  | {
      ok: true
      /** The finished image, ready to hand to the browser. */
      image: { dataUrl: string; contentType: string; width?: number; height?: number }
      requestId: string
      durationMs: number
    }
  | {
      ok: false
      reason: ProductShotFailure
      message: string
      /** Safe to log: a status code, never a body. */
      status?: number
      requestId?: string
      durationMs: number
    }

export type ProductShotInput = {
  /** The prepared photograph. */
  bytes: Buffer
  /** Its MIME type, as decided by validateSourceImage. */
  mimeType: string
  apiKey: string
  /** Which of the three output shapes. A KEY, never dimensions: the pixels come
   *  from outputPresets.ts, so no caller can ask for an arbitrary canvas. */
  preset?: OutputPresetKey
  timeoutMs?: number
}

/** What the employee is told, per failure. Each says whether trying again is
 *  worth their time, because "please try again" on a dead key or a moderation
 *  refusal is a lie that costs somebody twenty minutes. */
const MESSAGES: Record<ProductShotFailure, string> = {
  not_configured:      'The image service is not set up yet. Ask your administrator to configure it.',
  invalid_key:         'The image service rejected this site’s credentials. Ask your administrator to check the key.',
  insufficient_credit: 'The image service has no credit left. Ask your administrator to top up the account.',
  rate_limited:        'The image service is busy right now. Wait a moment and try again.',
  unsupported_image:   'That photograph could not be processed. Try a different photograph of the product.',
  moderation:          'The image service declined to process this photograph. Try a different photograph of the product.',
  timeout:             'The image is taking longer than expected. Please try again.',
  empty_result:        'The image service did not return an image. Please try again.',
  provider_error:      'The image service could not process this photograph. Please try again.',
}

/** Failures where trying the same photograph again cannot help. The page uses
 *  this to offer "choose a different photo" instead of "try again". */
export const NO_RETRY_FAILURES: ReadonlySet<ProductShotFailure> = new Set<ProductShotFailure>([
  'not_configured', 'invalid_key', 'insufficient_credit', 'unsupported_image', 'moderation',
])

/**
 * Which failure a response represents.
 *
 * The body is read ONLY to tell an exhausted balance apart from a bad key, and
 * a moderation refusal apart from an ordinary rejection — both distinctions the
 * status code alone does not carry. Nothing from it is returned or logged.
 */
export function classifyFailure(status: number, body: string): ProductShotFailure {
  const text = body.toLowerCase()

  if (/moderation|nsfw|content policy|safety|inappropriate/.test(text)) return 'moderation'
  if (status === 401) return 'invalid_key'
  if (status === 402) return 'insufficient_credit'
  if (status === 403) {
    return /balance|credit|quota|exhaust|billing/.test(text) ? 'insufficient_credit' : 'invalid_key'
  }
  if (status === 429) return 'rate_limited'
  if (status === 400 || status === 413 || status === 415 || status === 422) return 'unsupported_image'
  return 'provider_error'
}

/** The request body. Exported so a test can read it without a network call. */
export function buildRequestBody(dataUrl: string, preset: OutputPresetKey = DEFAULT_OUTPUT_PRESET) {
  return {
    image_url: dataUrl,
    scene_description: STUDIO_SCENE_DESCRIPTION,
    ...FIXED_SETTINGS,
    // Resolved through the table rather than passed through: an unrecognised
    // value becomes Square, never dimensions of somebody else's choosing.
    shot_size: [...resolveOutputPreset(preset).shotSize],
  }
}

/** True for a URL this route is willing to download a result from. */
export function isAllowedResultUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  return RESULT_HOSTS.some(host => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`))
}

type FalImage = {
  url?: string
  content_type?: string
  width?: number
  height?: number
}

/**
 * Generate one studio photograph from one product photograph.
 *
 * Exactly one billable request per call, and no automatic retry of any kind.
 * Never throws: every failure comes back as `{ ok: false }` with a reason the
 * route maps to a status code and a message the page can show.
 */
export async function generateProductShot(input: ProductShotInput): Promise<ProductShotResult> {
  const startedAt = Date.now()
  const since = () => Date.now() - startedAt

  if (!input.apiKey) {
    return { ok: false, reason: 'not_configured', message: MESSAGES.not_configured, durationMs: since() }
  }

  if (input.bytes.byteLength > PROVIDER_MAX_IMAGE_BYTES) {
    // Refused here rather than paid for and refused there.
    return {
      ok: false,
      reason: 'unsupported_image',
      message: 'That photograph is too large for the image service. Upload a smaller file.',
      durationMs: since(),
    }
  }

  // A data URI, so the photograph travels inside the request BOE already
  // authenticates. No public URL for it is created anywhere.
  const dataUrl = `data:${input.mimeType};base64,${input.bytes.toString('base64')}`

  let response: Response
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        // The key travels in a header, never in the URL: a query-string key
        // ends up in access logs and error traces.
        Authorization: `Key ${input.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(buildRequestBody(dataUrl, input.preset)),
      signal: AbortSignal.timeout(input.timeoutMs ?? PROVIDER_TIMEOUT_MS),
    })
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')
    const reason: ProductShotFailure = timedOut ? 'timeout' : 'provider_error'
    return { ok: false, reason, message: MESSAGES[reason], durationMs: since() }
  }

  const requestId = response.headers.get(REQUEST_ID_HEADER) ?? ''

  if (!response.ok) {
    // Read to CLASSIFY, not to report: no part of this reaches the browser or
    // the log.
    const body = await response.text().catch(() => '')
    const reason = classifyFailure(response.status, body)
    return {
      ok: false, reason, message: MESSAGES[reason],
      status: response.status, requestId, durationMs: since(),
    }
  }

  let payload: { images?: FalImage[] }
  try {
    payload = await response.json()
  } catch {
    return {
      ok: false, reason: 'empty_result', message: MESSAGES.empty_result,
      status: response.status, requestId, durationMs: since(),
    }
  }

  const first = payload?.images?.[0]
  const url = typeof first?.url === 'string' ? first.url : ''
  if (!url) {
    return {
      ok: false, reason: 'empty_result', message: MESSAGES.empty_result,
      status: response.status, requestId, durationMs: since(),
    }
  }

  // `sync_mode: true` asks for the image inline, which is the path that keeps
  // the result out of fal's request history as well as off any public URL.
  if (url.startsWith('data:')) {
    return {
      ok: true,
      image: {
        dataUrl: url,
        contentType: first?.content_type ?? 'image/png',
        width: first?.width,
        height: first?.height,
      },
      requestId,
      durationMs: since(),
    }
  }

  // fal answered with a temporary URL anyway. Fetched HERE, so the browser is
  // never sent a provider URL and the image still arrives through BOE's own
  // authenticated route.
  if (!isAllowedResultUrl(url)) {
    return {
      ok: false, reason: 'empty_result', message: MESSAGES.empty_result,
      status: response.status, requestId, durationMs: since(),
    }
  }

  try {
    const download = await fetch(url, { signal: AbortSignal.timeout(RESULT_FETCH_TIMEOUT_MS) })
    if (!download.ok) {
      return {
        ok: false, reason: 'provider_error', message: MESSAGES.provider_error,
        status: download.status, requestId, durationMs: since(),
      }
    }

    const contentType = download.headers.get('content-type') ?? first?.content_type ?? 'image/png'
    if (!contentType.startsWith('image/')) {
      return {
        ok: false, reason: 'empty_result', message: MESSAGES.empty_result,
        requestId, durationMs: since(),
      }
    }

    const bytes = Buffer.from(await download.arrayBuffer())
    if (bytes.byteLength === 0 || bytes.byteLength > RESULT_MAX_BYTES) {
      return {
        ok: false, reason: 'empty_result', message: MESSAGES.empty_result,
        requestId, durationMs: since(),
      }
    }

    return {
      ok: true,
      image: {
        dataUrl: `data:${contentType};base64,${bytes.toString('base64')}`,
        contentType,
        width: first?.width,
        height: first?.height,
      },
      requestId,
      durationMs: since(),
    }
  } catch {
    return {
      ok: false, reason: 'provider_error', message: MESSAGES.provider_error,
      requestId, durationMs: since(),
    }
  }
}
