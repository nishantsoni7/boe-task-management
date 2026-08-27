// The one place that talks to an image provider.
//
// SERVER ONLY. The API key is read by the caller from the environment and
// passed in, so the route is the only caller and the key never crosses to the
// browser.
//
// WHAT THIS ASKS FOR, AND WHAT IT DELIBERATELY DOES NOT
// -----------------------------------------------------
// One thing only: PhotoRoom's Remove Background API (`POST /v1/segment`), which
// returns the SAME pixels the photograph contained, with the background made
// transparent. Nothing here asks PhotoRoom to generate a background, restage
// the product, or edit it in any way — those are different products
// (`/v2/edit`, `/v1/instant-backgrounds`) with a different price and, more to
// the point, a different guarantee. A generated background is a picture of a
// chair; a segmented one is BOE's chair.
//
// So every visible product pixel in the finished image comes from the uploaded
// photograph. The studio look is added afterwards, locally and deterministically
// (see composeStudioImage.ts). This file's whole job is the cut-out.

const ENDPOINT = 'https://sdk.photoroom.com/v1/segment'

/** Comfortably under the route's own ceiling, leaving room to compose and
 *  serialise the finished image. */
export const PROVIDER_TIMEOUT_MS = 40_000

export type CutoutFailure =
  /** No API key configured. The page says so; it never pretends to have edited. */
  | 'not_configured'
  /** The key was refused. An administrator has to fix it — retrying will not. */
  | 'invalid_key'
  /** The PhotoRoom plan is out of credits. Also not a retry. */
  | 'insufficient_credits'
  /** PhotoRoom could not read this file, or found nothing to segment. */
  | 'unsupported_image'
  /** Too many requests at PhotoRoom's end. Worth retrying shortly. */
  | 'rate_limited'
  /** No answer in time. Worth retrying. */
  | 'timeout'
  /** Anything else, including an answer that was not an image. */
  | 'provider_error'

export type CutoutResult =
  | { ok: true; png: Buffer }
  | { ok: false; reason: CutoutFailure; message: string; detail?: string }

export type CutoutInput = {
  /** The prepared photograph. */
  bytes: Buffer
  /** Its MIME type, as decided by validateSourceImage. */
  mimeType: string
  /** A file name for the multipart part; PhotoRoom accepts anything sensible. */
  fileName?: string
  apiKey: string
  timeoutMs?: number
}

/** What the employee is told, per failure. Each one says whether trying again
 *  is worth their time, because "please try again" on a dead API key is a lie
 *  that costs somebody twenty minutes. */
const MESSAGES: Record<CutoutFailure, string> = {
  not_configured:       'The image service is not set up yet. Ask your administrator to configure it.',
  invalid_key:          'The image service rejected this site’s credentials. Ask your administrator to check the key.',
  insufficient_credits: 'The image service has no processing credits left. Ask your administrator to top up the plan.',
  unsupported_image:    'That photograph could not be processed. Try a different photograph of the product.',
  rate_limited:         'The image service is busy right now. Wait a moment and try again.',
  timeout:              'The image is taking longer than expected. Please try again.',
  provider_error:       'The image service could not process this photograph. Please try again.',
}

function fail(reason: CutoutFailure, detail?: string): CutoutResult {
  return { ok: false, reason, message: MESSAGES[reason], detail }
}

/** HTTP status → what actually went wrong. PhotoRoom answers 402 when a plan is
 *  out of credits, which is the failure most likely to be mistaken for a bug.
 *
 *  ONE AMBIGUITY WORTH KNOWING ABOUT: a 403 can also come from something
 *  between this server and PhotoRoom — a corporate proxy or an egress policy
 *  that does not allow `sdk.photoroom.com` — rather than from PhotoRoom
 *  refusing the key. Both read as "credentials rejected" here, because at HTTP
 *  level they are indistinguishable. The logged `detail` is what tells them
 *  apart: a network denial says so in as many words. Check the server log
 *  before concluding the key is bad. */
export function failureForStatus(status: number): CutoutFailure {
  if (status === 401 || status === 403) return 'invalid_key'
  if (status === 402) return 'insufficient_credits'
  if (status === 429) return 'rate_limited'
  if (status === 400 || status === 415 || status === 422) return 'unsupported_image'
  return 'provider_error'
}

/** The multipart body. Built here so a test can read it without a network call. */
export function buildForm(input: Pick<CutoutInput, 'bytes' | 'mimeType' | 'fileName'>): FormData {
  const form = new FormData()
  // The field name PhotoRoom's segment endpoint reads.
  form.append(
    'image_file',
    new Blob([new Uint8Array(input.bytes)], { type: input.mimeType }),
    input.fileName || 'product.jpg',
  )
  // A transparent PNG: RGBA, no background colour of any kind. `bg_color` is
  // deliberately never sent — the background is composed locally.
  form.append('format', 'png')
  form.append('channels', 'rgba')
  return form
}

/**
 * Cut the product out of one photograph.
 *
 * Never throws: every failure comes back as `{ ok: false }` with a reason the
 * route maps to a status code and a message the page can show. PhotoRoom's own
 * error text is returned in `detail` for the SERVER LOG only — the route does
 * not put it in the response, because it can echo request content.
 */
export async function removeBackground(input: CutoutInput): Promise<CutoutResult> {
  if (!input.apiKey) return fail('not_configured')

  let response: Response
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        // The key travels in a header, never in the URL or the body: a
        // query-string key ends up in access logs and error traces.
        'x-api-key': input.apiKey,
        Accept: 'image/png, application/json',
      },
      body: buildForm(input),
      signal: AbortSignal.timeout(input.timeoutMs ?? PROVIDER_TIMEOUT_MS),
    })
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')
    if (timedOut) return fail('timeout')
    return fail('provider_error', e instanceof Error ? e.message : String(e))
  }

  if (!response.ok) {
    const detail = `${response.status} ${await response.text().catch(() => '')}`.slice(0, 500)
    return fail(failureForStatus(response.status), detail)
  }

  // A 200 that is not an image is an error page or a JSON body, not a cut-out.
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.startsWith('image/')) {
    return fail('provider_error', `200 with content-type ${contentType || 'none'}`)
  }

  const png = Buffer.from(await response.arrayBuffer())
  if (png.byteLength === 0) return fail('provider_error', '200 with an empty body')

  return { ok: true, png }
}
