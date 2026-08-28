// The one place that talks to a provider, and the only thing it asks for is a
// cut-out.
//
// SERVER ONLY. FAL_KEY is read by the caller from the environment and passed in,
// so the route is the only caller and the key never crosses to the browser.
//
// WHY THIS IS ALL THE PROVIDER DOES NOW
// -------------------------------------
// The previous architecture asked a generative model to produce the whole
// catalogue photograph. Two paid results settled it: the first invented a
// circular decorative backdrop, the second removed the circle and shrank the
// chair to about a fifth of the frame. Wording cannot hold a composition — the
// model is free to ignore it, and did, twice.
//
// So the provider is now asked for one thing it is reliable at: separating the
// product from its background. Everything after that — canvas, placement,
// scale, background, shadows, tone — is arithmetic in composeStudioImage.ts,
// which means the same photograph produces the same image every time and the
// composition is a number rather than a request.
//
// THE CONTRACT
// ------------
// Read from @fal-ai/client 1.10.1's endpoint types rather than from memory:
//
//   "fal-ai/bria/background/remove"
//     input   BGRemoveInput = { image_url: string | Blob | File; sync_mode?: boolean }
//     output  { image: Image }        // ONE image, not an array
//     Image   { url: string; content_type?; file_name?; file_size?; width?; height? }
//
// and the transport, from src/request.js and src/response.js of that package:
// `POST https://fal.run/<id>`, `Authorization: Key <credentials>`, the input as
// the JSON body, the request id in the `x-fal-request-id` response header.
//
// `sync_mode: true` returns the cut-out as a data URI and, in fal's own words,
// keeps "the output data … not available in the request history" — which is the
// privacy answer as well as the simple one.
//
// One request per photograph. No retry of any kind, including after a timeout:
// a request that may already have been billed is not quietly billed again.

/** The model. Never overridable from anywhere, and never a generative one. */
export const MODEL_ID = 'fal-ai/bria/background/remove'

const ENDPOINT = `https://fal.run/${MODEL_ID}`

/** fal returns the request id here; it is the only provider detail worth logging. */
const REQUEST_ID_HEADER = 'x-fal-request-id'

/** Bria's ceiling for the source image. */
export const PROVIDER_MAX_IMAGE_BYTES = 12 * 1024 * 1024

/** A cut-out of a megapixel photograph is a few MB; this is a sanity ceiling on
 *  what will be pulled into memory, not a limit anybody should reach. */
export const MAX_CUTOUT_BYTES = 32 * 1024 * 1024

/** Under the route's 60s ceiling, leaving room to compose and return. */
export const PROVIDER_TIMEOUT_MS = 45_000

const RESULT_FETCH_TIMEOUT_MS = 20_000

/** Hosts a result may be downloaded from, when fal answers with a URL rather
 *  than inline data. */
const RESULT_HOSTS = ['fal.media', 'fal.ai', 'fal.run']

export type CutoutFailure =
  | 'not_configured'
  | 'invalid_key'
  | 'insufficient_credit'
  | 'rate_limited'
  | 'unsupported_image'
  | 'moderation'
  | 'timeout'
  /** A 200 that carried no usable cut-out — missing, unreadable, or opaque. */
  | 'empty_result'
  | 'provider_error'

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

const MESSAGES: Record<CutoutFailure, string> = {
  not_configured:      'The image service is not set up yet. Ask your administrator to configure it.',
  invalid_key:         'The image service rejected this site’s credentials. Ask your administrator to check the key.',
  insufficient_credit: 'The image service has no credit left. Ask your administrator to top up the account.',
  rate_limited:        'The image service is busy right now. Wait a moment and try again.',
  unsupported_image:   'That photograph could not be processed. Try a different photograph of the product.',
  moderation:          'The image service declined to process this photograph. Try a different photograph of the product.',
  timeout:             'The image is taking longer than expected. Please try again.',
  empty_result:        'The product could not be separated from that photograph. Try a photograph with the product clearly visible.',
  provider_error:      'The image service could not process this photograph. Please try again.',
}

/** Failures where trying the same photograph again cannot help. */
export const NO_RETRY_FAILURES: ReadonlySet<CutoutFailure> = new Set<CutoutFailure>([
  'not_configured', 'invalid_key', 'insufficient_credit', 'unsupported_image', 'moderation', 'empty_result',
])

/**
 * Which failure a response represents.
 *
 * The body is read ONLY to tell an exhausted balance apart from a bad key, and
 * a moderation refusal apart from an ordinary rejection. Nothing from it is
 * returned or logged.
 */
export function classifyFailure(status: number, body: string): CutoutFailure {
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

/** The request body. Two fields, because the schema has two. */
export function buildRequestBody(dataUrl: string) {
  return {
    image_url: dataUrl,
    sync_mode: true,
  }
}

/** True for a URL this adapter is willing to download a cut-out from. */
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

/** Parse a data URI into its type and bytes, or null if it is not one. */
function readDataUrl(url: string): { contentType: string; bytes: Buffer } | null {
  // No `s` flag: the project targets ES2017, where it is unavailable. `[^]`
  // matches any character including a newline, which is what base64 payloads
  // occasionally contain.
  const match = /^data:([^;,]+)(;base64)?,([^]*)$/.exec(url)
  if (!match) return null
  const [, contentType, base64, payload] = match
  try {
    return {
      contentType,
      bytes: base64 ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'binary'),
    }
  } catch {
    return null
  }
}

/**
 * Cut the product out of one photograph.
 *
 * Exactly one billable request per call, and no automatic retry. Never throws:
 * every failure comes back as `{ ok: false }` with a reason the route maps to a
 * status code and a message the page can show.
 */
export async function removeBackground(input: CutoutInput): Promise<CutoutResult> {
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
      body: JSON.stringify(buildRequestBody(dataUrl)),
      signal: AbortSignal.timeout(input.timeoutMs ?? PROVIDER_TIMEOUT_MS),
    })
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')
    const reason: CutoutFailure = timedOut ? 'timeout' : 'provider_error'
    return { ok: false, reason, message: MESSAGES[reason], durationMs: since() }
  }

  const requestId = response.headers.get(REQUEST_ID_HEADER) ?? ''

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    const reason = classifyFailure(response.status, body)
    return { ok: false, reason, message: MESSAGES[reason], status: response.status, requestId, durationMs: since() }
  }

  let payload: { image?: { url?: string; content_type?: string } }
  try {
    payload = await response.json()
  } catch {
    return { ok: false, reason: 'empty_result', message: MESSAGES.empty_result, status: response.status, requestId, durationMs: since() }
  }

  // One image, per the schema — not an array.
  const url = typeof payload?.image?.url === 'string' ? payload.image.url : ''
  if (!url) {
    return { ok: false, reason: 'empty_result', message: MESSAGES.empty_result, status: response.status, requestId, durationMs: since() }
  }

  const fail = (reason: CutoutFailure): CutoutResult =>
    ({ ok: false, reason, message: MESSAGES[reason], requestId, durationMs: since() })

  let bytes: Buffer
  let contentType: string

  const inline = url.startsWith('data:') ? readDataUrl(url) : null
  if (url.startsWith('data:')) {
    if (!inline) return fail('empty_result')
    bytes = inline.bytes
    contentType = inline.contentType
  } else {
    // fal answered with a temporary URL despite sync_mode. Fetched HERE, so the
    // browser is never handed a provider URL.
    if (!isAllowedResultUrl(url)) return fail('empty_result')

    try {
      const download = await fetch(url, { signal: AbortSignal.timeout(RESULT_FETCH_TIMEOUT_MS) })
      if (!download.ok) {
        return { ok: false, reason: 'provider_error', message: MESSAGES.provider_error, status: download.status, requestId, durationMs: since() }
      }
      contentType = download.headers.get('content-type') ?? payload.image?.content_type ?? ''
      bytes = Buffer.from(await download.arrayBuffer())
    } catch {
      return { ok: false, reason: 'provider_error', message: MESSAGES.provider_error, requestId, durationMs: since() }
    }
  }

  // A cut-out is a PNG with an alpha channel. Anything else — a JPEG, an error
  // page, an opaque image — is not what was asked for, and composing it would
  // paste a rectangle of factory floor onto a studio background.
  if (!contentType.startsWith('image/')) return fail('empty_result')
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_CUTOUT_BYTES) return fail('empty_result')

  return { ok: true, png: bytes, contentType, requestId, durationMs: since() }
}
