// ── Showroom quotation: product images and salesperson attribution ────────────
//
// The decisions the quotation PDF makes about ONE product image, separated from
// PDFKit so they can be asserted without rendering a document or reaching the
// network. The route keeps the drawing; this module keeps the rules.
//
// WHERE THESE IMAGES ACTUALLY LIVE — verified against the production database
// on 2026-09-09, not assumed:
//
//   253 products, 196 with a primary image, 57 with none at all.
//   ALL 196 primary images are absolute `https://bestofexports.com/wp-content/
//   uploads/…` URLs on BOE's own WordPress site. Zero are Supabase Storage
//   paths. Zero are relative. (125 .jpg, 67 .jpeg, 3 .webp, 1 .png.)
//
// That single fact settles three things the old implementation guessed at:
//
//  1. The storage-path branch — "the first path segment is the bucket name" —
//     is not how anything is stored. No row exercises it. It stays supported
//     (an admin could paste one tomorrow) but it no longer *guesses*: the
//     bucket is named, and a leading segment is only stripped when it actually
//     matches that name. See {@link resolveStoragePath}.
//
//  2. Supabase credentials must not be attached to the request. The old code
//     sent `apikey` and `Authorization: Bearer <SERVICE ROLE KEY>` on *every*
//     image fetch — which, given the data above, meant sending BOE's Supabase
//     service-role key to a third-party WordPress host on every quotation.
//     {@link imageRequestHeaders} sends credentials only to Supabase itself.
//
//  3. A public web origin is being fetched by a server, not a browser. Origins
//     behind LiteSpeed/WAF rules routinely reject a request with no
//     `User-Agent` and no `Accept`. Both are now sent.

/** A product as far as the quotation cares: whatever the DB row put in these two fields. */
export type ProductImageFields = {
  images?: unknown
  image_url?: unknown
}

/**
 * The one image that represents a product in the quotation.
 *
 * `images[0]` wins, `image_url` is the pre-`images[]` fallback, and a blank or
 * whitespace-only entry counts as absent rather than as an image — `??` alone
 * would let `''` through and turn a fetch into a guaranteed miss.
 */
export function pickPrimaryImage(product: ProductImageFields | null | undefined): string | null {
  if (!product) return null
  const fromArray = Array.isArray(product.images)
    ? product.images.find(v => typeof v === 'string' && v.trim() !== '')
    : null
  const candidate = fromArray ?? product.image_url
  if (typeof candidate !== 'string') return null
  const trimmed = candidate.trim()
  return trimmed === '' ? null : trimmed
}

export type ImageSourceKind =
  /** An absolute URL on the project's own Supabase host — credentials apply. */
  | 'supabase-url'
  /** An absolute URL anywhere else — credentials must NOT be attached. */
  | 'external-url'
  /** A Supabase Storage object path that has to be signed before it can be fetched. */
  | 'storage-path'
  /** Nothing usable. */
  | 'none'

/**
 * What kind of thing a stored image value is.
 *
 * The distinction that matters is `supabase-url` vs `external-url`: it decides
 * whether the service-role key travels with the request. Everything today is
 * `external-url`.
 */
export function classifyImageSource(
  raw: string | null | undefined,
  supabaseUrl: string | null | undefined,
): ImageSourceKind {
  const value = (raw ?? '').trim()
  if (!value) return 'none'

  if (/^https?:\/\//i.test(value)) {
    let host: string
    try {
      host = new URL(value).hostname.toLowerCase()
    } catch {
      // Starts like a URL but is not one — nothing can fetch it.
      return 'none'
    }
    let ownHost: string | null = null
    try {
      ownHost = supabaseUrl ? new URL(supabaseUrl).hostname.toLowerCase() : null
    } catch {
      ownHost = null
    }
    return ownHost && host === ownHost ? 'supabase-url' : 'external-url'
  }

  // A scheme we cannot fetch server-side (data:, blob:, file:…) is not a path.
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return 'none'

  return 'storage-path'
}

/**
 * May this image URL be published on the UNAUTHENTICATED share page?
 *
 * The share endpoint has no auth — anyone holding the link sees the payload —
 * so it publishes only URLs that are already public by construction:
 *
 *   external-url  a URL on someone else's host, which is where every image
 *                 actually lives today (BOE's own public WordPress site).
 *   supabase-url  only when the path is Supabase's PUBLIC object route, or the
 *                 URL carries its own expiring signature.
 *
 * Everything else is withheld and the card falls back to its placeholder. A
 * bare storage path is a private-bucket coordinate; an unsigned private-bucket
 * URL would 401 for the customer anyway, so publishing it would hand out the
 * bucket and object layout in exchange for nothing.
 *
 * No row exercises the Supabase branch today, so this changes no current
 * behaviour — it decides the answer before someone pastes one.
 */
export function isPubliclyShareableImageUrl(
  raw: string | null | undefined,
  supabaseUrl: string | null | undefined,
): boolean {
  const kind = classifyImageSource(raw, supabaseUrl)
  if (kind === 'external-url') return true
  if (kind !== 'supabase-url') return false

  try {
    const url = new URL((raw ?? '').trim())
    if (url.pathname.includes('/storage/v1/object/public/')) return true
    // Signed URLs carry their authorization in the query string and expire.
    return url.searchParams.has('token')
  } catch {
    return false
  }
}

/** Today's bucket default, preserved from the previous implementation. */
export const DEFAULT_PRODUCT_IMAGE_BUCKET = 'products'

/**
 * Split a stored storage path into `{ bucket, objectPath }`.
 *
 * The previous rule was "everything before the first slash is the bucket",
 * which silently ate a real directory name whenever the value was already
 * bucket-relative — the far more common way a Supabase path is stored. Since
 * no row in production is a storage path at all, neither reading is supported
 * by evidence, so this stops guessing: the bucket is named by configuration,
 * and the leading segment is removed only when it *is* that bucket.
 */
export function resolveStoragePath(
  raw: string,
  bucket: string = DEFAULT_PRODUCT_IMAGE_BUCKET,
): { bucket: string; objectPath: string } {
  const value = raw.trim().replace(/^\/+/, '')
  const prefix = `${bucket}/`
  return value.startsWith(prefix)
    ? { bucket, objectPath: value.slice(prefix.length) }
    : { bucket, objectPath: value }
}

/**
 * A browser-shaped identity for a server-side image fetch.
 *
 * Node's fetch sends no `User-Agent` and no `Accept` at all. A public origin
 * behind a WAF has every reason to treat that as a bot, and the failure is
 * invisible here — the image is simply skipped and the quotation ships without
 * it. Naming ourselves costs nothing and removes the whole failure class.
 */
export const IMAGE_FETCH_USER_AGENT =
  'BOE-Operating-System/1.0 (+https://bestofexports.com; quotation-pdf)'

/**
 * Headers for fetching one product image.
 *
 * Supabase credentials go to Supabase and nowhere else. Attaching them to an
 * arbitrary host — which is what every quotation used to do — hands the
 * service-role key to whoever runs that host, and buys nothing: a public image
 * needs no authorization, and a private one is reached through a signed URL
 * whose signature is already in the query string.
 */
export function imageRequestHeaders(
  kind: ImageSourceKind,
  serviceKey: string | null | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': IMAGE_FETCH_USER_AGENT,
    Accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8,*/*;q=0.5',
  }
  if (kind === 'supabase-url' && serviceKey) {
    headers.apikey = serviceKey
    headers.Authorization = `Bearer ${serviceKey}`
  }
  return headers
}

export type ImageFormat = 'png' | 'jpeg' | 'webp'

/**
 * The format of downloaded bytes, by magic number rather than by file extension
 * or `Content-Type` — a WordPress `.jpg` that is really a WebP is a real thing,
 * and PDFKit throws on bytes it cannot parse.
 */
export function detectImageFormat(buf: Uint8Array | null | undefined): ImageFormat | null {
  if (!buf || buf.length < 4) return null
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png'
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpeg'
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) return 'webp'
  return null
}

/**
 * Only WebP has to be re-encoded — PDFKit embeds PNG and JPEG natively.
 *
 * Kept as its own predicate because the route pays for `sharp` only when this
 * is true, and "which formats cost a conversion" is exactly the sort of thing
 * that drifts out of step with {@link detectImageFormat} once it lives inside
 * a 200-line render function.
 */
export function needsConversion(format: ImageFormat): boolean {
  return format === 'webp'
}

// ── The missing-image box ─────────────────────────────────────────────────────

/**
 * What to draw where an image would have gone.
 *
 * An image can be absent for two different reasons and the quotation should not
 * pretend they are the same: a product with no image on file is a catalogue gap
 * ("No image on file"), while a product whose image would not load is a
 * transient failure the customer should not be asked to interpret ("Image
 * unavailable"). Either way the box is filled deliberately instead of being
 * left as the empty rectangle the previous layout produced.
 *
 * The product code goes underneath when there is one, so the salesperson can
 * still say which item the blank card is.
 */
export function imagePlaceholder(input: {
  hasStoredImage: boolean
  productCode?: string | null
}): { title: string; subtitle: string | null } {
  const code = (input.productCode ?? '').trim()
  return {
    title: input.hasStoredImage ? 'IMAGE UNAVAILABLE' : 'NO IMAGE ON FILE',
    subtitle: code && code !== '—' ? code : null,
  }
}

// ── Salesperson attribution ───────────────────────────────────────────────────

/** The quotation's wording for who owns the customer relationship. */
export const SALESPERSON_LABEL = 'Sales Consultant'

/**
 * The salesperson line for the quotation header, or null when there is nothing
 * worth printing.
 *
 * The name is the one attached to the *inquiry*, never the person who happened
 * to press Download — an admin pulling a colleague's quotation must not put
 * their own name in front of that colleague's customer. The route resolves it
 * from `showroom_inquiries.salesperson_id`; this only decides how it reads and
 * what happens when the profile lookup came back empty.
 *
 * A missing name prints nothing at all rather than `Sales Consultant: —`. A
 * dash under a heading in a customer-facing document reads as a mistake, and an
 * absent line reads as an ordinary layout without one.
 */
export function salespersonLine(name: string | null | undefined): string | null {
  const trimmed = (name ?? '').trim()
  if (!trimmed || trimmed === '—' || trimmed === '-') return null
  return `${SALESPERSON_LABEL}: ${trimmed}`
}
