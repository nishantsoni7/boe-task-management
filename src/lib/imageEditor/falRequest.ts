// One request to fal, and everything that must be true of it.
//
// SERVER ONLY. Both provider stages go through here, so the rules that protect
// BOE's account live in one place instead of being re-argued per adapter:
//
//   * a deadline covers the WHOLE exchange, headers and body alike. An
//     AbortSignal passed to fetch keeps aborting while the body streams, so a
//     200 whose body is cut off mid-read is a TIMEOUT, not an empty answer —
//     see `wasAborted` below, and the incident that made it necessary.
//   * ONE request per call. No retry of any kind, including after a timeout —
//     a request that may already have been billed is not quietly billed again.
//     This is also why `@fal-ai/client` is not used: its `run()` retries
//     `maxRetries: 3` over 429/502/503/504, so one button press could become
//     four charges.
//   * the key travels in a header, never in a URL, where it would land in
//     access logs and error traces.
//   * a result URL is downloaded HERE, from an allowlisted fal host, so the
//     browser is never handed a provider URL and never learns one exists.
//   * nothing from the response body is returned or logged. The body is read
//     only far enough to tell an exhausted balance from a bad key.
//
// THE TRANSPORT
// -------------
// Read from @fal-ai/client 1.10.1 (`src/request.js`, `src/response.js`) rather
// than from memory: `POST https://fal.run/<model id>`, `Authorization: Key
// <credentials>`, the input as the JSON body, the request id returned in the
// `x-fal-request-id` response header.
//
// Bria's two endpoints disagree about the shape of a success, so both are
// accepted: background removal answers `{ image: Image }` and product shot
// answers `{ images: Array<Image> }`.

/** fal returns the request id here; it is the only provider detail worth logging. */
const REQUEST_ID_HEADER = 'x-fal-request-id'

/** Hosts a result may be downloaded from, when fal answers with a URL rather
 *  than inline data. */
const RESULT_HOSTS = ['fal.media', 'fal.ai', 'fal.run']

/**
 * Downloading a hosted result.
 *
 * Exported because it is part of the route's time budget, not an implementation
 * detail: without `sync_mode` the studio image comes back as a URL, so a call
 * can spend its own timeout AND this one before returning.
 */
export const RESULT_FETCH_TIMEOUT_MS = 8_000

/** Under the route's 60s ceiling, leaving room for the second stage. */
export const PROVIDER_TIMEOUT_MS = 45_000

/** Bria's ceiling for an input image. */
export const PROVIDER_MAX_IMAGE_BYTES = 12 * 1024 * 1024

/** A sanity ceiling on what is pulled into memory, not a limit anybody reaches. */
export const MAX_RESULT_BYTES = 32 * 1024 * 1024

export type FalFailure =
  | 'not_configured'
  | 'invalid_key'
  | 'insufficient_credit'
  | 'rate_limited'
  | 'unsupported_image'
  | 'moderation'
  | 'timeout'
  /** A 200 that carried nothing usable — missing, unreadable, or the wrong type. */
  | 'empty_result'
  | 'provider_error'

export type FalImage = { bytes: Buffer; contentType: string }

export type FalResult =
  | { ok: true; images: FalImage[]; requestId: string; durationMs: number }
  | {
      ok: false
      reason: FalFailure
      message: string
      /** Safe to log: a status code, never a body. */
      status?: number
      requestId?: string
      durationMs: number
      /**
       * Where it went wrong, for the log only.
       *
       * `request` never reached a response; `body` got headers and lost the
       * body; `download` lost a hosted result. Worth recording because
       * "timeout, status 200" and "timeout, no status" are different faults
       * with different fixes, and telling them apart from the log alone is
       * what this incident cost.
       */
      phase?: 'request' | 'body' | 'download'
    }

/** Employee-facing wording. Deliberately says nothing about which provider,
 *  which model, or what anything cost. */
export const MESSAGES: Record<FalFailure, string> = {
  not_configured:      'The image service is not set up yet. Ask your administrator to configure it.',
  invalid_key:         'The image service rejected this site’s credentials. Ask your administrator to check the key.',
  insufficient_credit: 'The image service has no credit left. Ask your administrator to top up the account.',
  rate_limited:        'The image service is busy right now. Wait a moment and try again.',
  unsupported_image:   'That photograph could not be processed. Try a different photograph of the product.',
  moderation:          'The image service declined to process this photograph. Try a different photograph of the product.',
  timeout:             'The image service took too long to process this photograph. Please try again in a few minutes.',
  // Deliberately NOT "the product could not be separated": a 200 carrying no
  // image is the service misbehaving, and telling an employee to photograph
  // their chair differently would send them to fix something that is not broken.
  empty_result:        'The image service did not return an image. Please try again.',
  provider_error:      'The image service could not process this photograph. Please try again.',
}

/** Failures where sending the same thing again cannot help. */
export const NO_RETRY_FAILURES: ReadonlySet<FalFailure> = new Set<FalFailure>([
  'not_configured', 'invalid_key', 'insufficient_credit', 'unsupported_image', 'moderation',
])
// `empty_result` is NOT on that list. A well-formed answer carrying no image is
// the service misbehaving rather than anything about the photograph, and the
// next attempt may well work. The deterministic refusals — a cut-out with no
// product in it, a product too small for the frame — are local, and the route
// marks those itself.

/**
 * Which failure a response represents.
 *
 * The body is read ONLY to tell an exhausted balance apart from a bad key, and
 * a moderation refusal apart from an ordinary rejection. Nothing from it is
 * returned or logged.
 */
export function classifyFailure(status: number, body: string): FalFailure {
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

/** True for a URL this module is willing to download a result from. */
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
export function readDataUrl(url: string): FalImage | null {
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

/** Bytes as a data URI, which is how every image reaches fal: inside the request
 *  BOE already authenticates, with no public URL created for it anywhere. */
export function toDataUrl(bytes: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${bytes.toString('base64')}`
}

/** Every image in a success body, whichever shape the endpoint answers with. */
function resultUrls(payload: unknown): string[] {
  const body = payload as { image?: { url?: unknown }; images?: Array<{ url?: unknown }> }

  const one = typeof body?.image?.url === 'string' ? [body.image.url] : []
  const many = Array.isArray(body?.images)
    ? body.images.map(i => i?.url).filter((u): u is string => typeof u === 'string')
    : []

  return [...one, ...many]
}

/**
 * Did this fail because we abandoned it?
 *
 * `AbortSignal.timeout` fires against the whole exchange, so an abort can
 * surface from `fetch`, from `response.json()` or from `arrayBuffer()`. The
 * signal's own `aborted` flag is the reliable witness; the error name is
 * checked too because an abort raised inside a stream does not always reach us
 * as the same error object.
 */
function wasAborted(signal: AbortSignal, error: unknown): boolean {
  if (signal.aborted) return true
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

export type FalCall = {
  modelId: string
  /** The request body, already built and validated by the calling adapter. */
  body: unknown
  apiKey: string
  timeoutMs?: number
  /**
   * Absolute wall-clock time after which this call must be finished.
   *
   * Every timeout below is clamped to what is left of it, so no combination of
   * a slow request and a slow download can push the route past the duration the
   * platform will allow. Without this the budget is a sum of worst cases that
   * nothing enforces.
   */
  deadlineAt?: number
  /** Budget for downloading a hosted result, when one is returned. */
  downloadMs?: number
  /** How many images the caller expects; extras are ignored, fewer is a failure. */
  expect?: number
}

/**
 * Make one billable request and bring the result back as bytes.
 *
 * Never throws: every failure comes back as `{ ok: false }` with a reason the
 * route maps to a status code and a message the page can show.
 */
export async function callFal(call: FalCall): Promise<FalResult> {
  const startedAt = Date.now()
  const since = () => Date.now() - startedAt

  if (!call.apiKey) {
    return { ok: false, reason: 'not_configured', message: MESSAGES.not_configured, durationMs: since() }
  }

  /** What may be spent on one step: its own budget, or what is left of the
   *  route's, whichever is smaller. */
  const budget = (want: number): number => {
    const remaining = call.deadlineAt === undefined
      ? Number.POSITIVE_INFINITY
      : call.deadlineAt - Date.now()
    return Math.max(0, Math.min(want, remaining))
  }

  const requestMs = budget(call.timeoutMs ?? PROVIDER_TIMEOUT_MS)
  if (requestMs <= 0) {
    // Out of time before starting. Answered without spending a request, which
    // is the whole point of knowing the deadline.
    return { ok: false, reason: 'timeout', message: MESSAGES.timeout, durationMs: since(), phase: 'request' }
  }

  const signal = AbortSignal.timeout(requestMs)

  let response: Response
  try {
    response = await fetch(`https://fal.run/${call.modelId}`, {
      method: 'POST',
      headers: {
        Authorization: `Key ${call.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(call.body),
      signal,
    })
  } catch (e) {
    const reason: FalFailure = wasAborted(signal, e) ? 'timeout' : 'provider_error'
    // Deliberately no retry here, and none below: a timeout is the case where a
    // charge is MOST likely to have already happened.
    return { ok: false, reason, message: MESSAGES[reason], durationMs: since(), phase: 'request' }
  }

  const requestId = response.headers.get(REQUEST_ID_HEADER) ?? ''

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    const reason = classifyFailure(response.status, body)
    return { ok: false, reason, message: MESSAGES[reason], status: response.status, requestId, durationMs: since() }
  }

  const fail = (reason: FalFailure, phase?: 'request' | 'body' | 'download'): FalResult =>
    ({ ok: false, reason, message: MESSAGES[reason], status: response.status, requestId, durationMs: since(), phase })

  let payload: unknown
  try {
    payload = await response.json()
  } catch (e) {
    // THE FAULT THIS GUARD EXISTS FOR. The headers arrived — status 200 — and
    // then the deadline fired while the body was still streaming, which with
    // `sync_mode: true` is a multi-megabyte base64 data URI. A bare catch here
    // called that an empty result, so a plain timeout was reported to an
    // employee as "the product could not be separated from that photograph"
    // and logged as a valid 200 carrying no image.
    return fail(wasAborted(signal, e) ? 'timeout' : 'empty_result', 'body')
  }

  const urls = resultUrls(payload)
  if (urls.length < (call.expect ?? 1)) return fail('empty_result')

  const images: FalImage[] = []
  for (const url of urls.slice(0, call.expect ?? 1)) {
    const inline = url.startsWith('data:') ? readDataUrl(url) : null

    if (url.startsWith('data:')) {
      if (!inline) return fail('empty_result')
      images.push(inline)
    } else {
      // fal answered with a temporary URL despite sync_mode. Fetched HERE, so
      // the browser is never handed a provider URL.
      if (!isAllowedResultUrl(url)) return fail('empty_result')

      const downloadMs = budget(call.downloadMs ?? RESULT_FETCH_TIMEOUT_MS)
      if (downloadMs <= 0) return fail('timeout', 'download')

      const downloadSignal = AbortSignal.timeout(downloadMs)
      try {
        const download = await fetch(url, { signal: downloadSignal })
        if (!download.ok) {
          return { ok: false, reason: 'provider_error', message: MESSAGES.provider_error, status: download.status, requestId, durationMs: since(), phase: 'download' }
        }
        images.push({
          contentType: download.headers.get('content-type') ?? '',
          // Same trap as the body read above: this streams, and abandoning it
          // half way is a timeout rather than a broken result.
          bytes: Buffer.from(await download.arrayBuffer()),
        })
      } catch (e) {
        const reason: FalFailure = wasAborted(downloadSignal, e) ? 'timeout' : 'provider_error'
        return { ok: false, reason, message: MESSAGES[reason], requestId, durationMs: since(), phase: 'download' }
      }
    }
  }

  for (const image of images) {
    // An error page, a JSON body, an empty file: none of these are the image
    // that was paid for, and passing one on would put it in front of an employee.
    if (!image.contentType.startsWith('image/')) return fail('empty_result')
    if (image.bytes.byteLength === 0 || image.bytes.byteLength > MAX_RESULT_BYTES) return fail('empty_result')
  }

  return { ok: true, images, requestId, durationMs: since() }
}
