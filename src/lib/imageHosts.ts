// ── Which remote images may be resized ────────────────────────────────────────
//
// Showroom product images are pasted URLs, not uploads: there is no bucket and
// no upload path, so an image can live on any host an admin can reach. That is
// exactly the situation Next's optimizer refuses to serve blind — an optimizer
// that will fetch any URL on request is an open proxy, so it resizes only hosts
// named in `images.remotePatterns` and answers 400 for everything else.
//
// So the allowlist is configuration, and this module is the single place it is
// read. `next.config.ts` turns it into `remotePatterns`; the thumbnail turns it
// into a decision about one URL. Both from the same values, so the client can
// never point at an optimizer URL the server will reject.
//
// A host that is NOT listed still works — the thumbnail falls back to the
// original URL, which is exactly what it did before. Listing a host buys smaller
// bytes; leaving it out costs nothing but the saving.

/**
 * Where showroom product images actually live today.
 *
 * Not a guess: every one of the 187 image URLs stored across the 202 products
 * in `showroom_products` is an `https://bestofexports.com/…` URL — BOE's own
 * site. So the common case needs no configuration at all, and the optimization
 * is on by default rather than waiting for someone to discover an env var.
 *
 * `www.` is included because it is the same site and a pasted URL could carry
 * it; an unlisted variant would silently fall back to the original rather than
 * break, but there is no reason to leave that saving on the floor.
 */
const DEFAULT_HOSTS = ['bestofexports.com', 'www.bestofexports.com']

/**
 * Extra comma-separated hostnames whose images may be optimized, e.g.
 * `cdn.supplier.com,*.boefurniture.com`. A leading `*.` matches subdomains.
 * Added to {@link DEFAULT_HOSTS} rather than replacing them.
 *
 * Read as a literal so the value is inlined into the client bundle at build
 * time — the thumbnail runs in the browser and has no other way to see it.
 */
const CONFIGURED_HOSTS = process.env.NEXT_PUBLIC_SHOWROOM_IMAGE_HOSTS ?? ''

/** The project's own Supabase host, allowed automatically when it is set. */
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''

function supabaseHost(): string | null {
  if (!SUPABASE_URL) return null
  try {
    return new URL(SUPABASE_URL).hostname
  } catch {
    return null
  }
}

/** Every allowed host pattern, de-duplicated and lower-cased. */
export const OPTIMIZABLE_IMAGE_HOSTS: string[] = (() => {
  const out = new Set<string>(DEFAULT_HOSTS)
  for (const raw of CONFIGURED_HOSTS.split(',')) {
    const host = raw.trim().toLowerCase()
    if (host) out.add(host)
  }
  const own = supabaseHost()
  if (own) out.add(own.toLowerCase())
  return [...out]
})()

/** True when `hostname` is covered by `pattern` (`*.example.com` or an exact host). */
export function hostMatches(pattern: string, hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (pattern.startsWith('*.')) {
    const base = pattern.slice(2)
    // A wildcard covers subdomains only — `*.example.com` is not example.com,
    // matching how Next reads `**.example.com`.
    return host.endsWith(`.${base}`)
  }
  return host === pattern
}

/**
 * Can Next's optimizer serve this URL?
 *
 * Only absolute **https** URLs on an allowlisted host. Anything else — a
 * relative path, a data: URI, a plain-http URL, a host nobody configured — is
 * left alone for the caller to render as-is.
 *
 * https-only on purpose, and it must stay in step with
 * {@link imageRemotePatterns}: every stored product URL is https, and a scheme
 * this side allows but `remotePatterns` does not would turn a working thumbnail
 * into a 400. Narrower is also the safer default for an optimizer that fetches
 * whatever it is pointed at.
 */
export function isOptimizableImageUrl(raw: string | null | undefined): boolean {
  const url = (raw ?? '').trim()
  if (!url) return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  return OPTIMIZABLE_IMAGE_HOSTS.some(pattern => hostMatches(pattern, parsed.hostname))
}

// ── Thumbnail URLs ────────────────────────────────────────────────────────────

/**
 * Widths the optimizer is asked for, covering a 56px box at 1x and 2x.
 *
 * Both values must exist in `images.imageSizes` (they are defaults), because the
 * optimizer rejects any width outside that list with a 400.
 */
export const THUMB_WIDTH_1X = 64
export const THUMB_WIDTH_2X = 128

/**
 * Quality for list thumbnails. Low on purpose: at 56 CSS px the artefacts are
 * invisible and the bytes are what the user actually feels. Must appear in
 * `images.qualities` or the optimizer answers 400.
 */
export const THUMB_QUALITY = 35

/** Next's built-in Image Optimization endpoint. Matches `images.path`. */
const OPTIMIZER_PATH = '/_next/image'

const optimizerUrl = (src: string, width: number, quality: number) =>
  `${OPTIMIZER_PATH}?url=${encodeURIComponent(src)}&w=${width}&q=${quality}`

export type ThumbSource = {
  src: string
  /** 1x/2x candidates; undefined when the original is served unchanged. */
  srcSet?: string
  /** True when the bytes come from the optimizer rather than the origin. */
  optimized: boolean
  /**
   * The untouched origin URL, always present.
   *
   * This is the retreat path. The optimizer fetches the image *server-side*,
   * which the browser never had to do before — if the origin is unreachable
   * from the server, or the optimizer is misconfigured, the caller can fall
   * back to loading the original directly, exactly as it did before any of
   * this existed. Optimization is then a saving that can fail, never a
   * dependency that can break a working image.
   */
  original: string
}

/**
 * What a small square thumbnail should actually load for `raw`.
 *
 * An allowlisted host is resized and re-encoded (WebP where the browser accepts
 * it) down to a 64/128px square instead of shipping a multi-megabyte original
 * into a 56px box. Everything else is returned untouched, so an unconfigured
 * host degrades to today's behaviour rather than to a broken image.
 */
export function thumbSource(raw: string | null | undefined): ThumbSource | null {
  const src = (raw ?? '').trim()
  if (!src) return null
  if (!isOptimizableImageUrl(src)) return { src, optimized: false, original: src }

  return {
    src: optimizerUrl(src, THUMB_WIDTH_1X, THUMB_QUALITY),
    srcSet: `${optimizerUrl(src, THUMB_WIDTH_1X, THUMB_QUALITY)} 1x, ` +
            `${optimizerUrl(src, THUMB_WIDTH_2X, THUMB_QUALITY)} 2x`,
    optimized: true,
    original: src,
  }
}

/**
 * The allowlist as Next `images.remotePatterns` entries.
 *
 * https only, matching {@link isOptimizableImageUrl} exactly — the two are the
 * client and server halves of one decision, and a disagreement shows up as a
 * broken thumbnail rather than as a failing test.
 */
export function imageRemotePatterns(): { protocol: 'https'; hostname: string }[] {
  return OPTIMIZABLE_IMAGE_HOSTS.map(pattern => ({
    protocol: 'https' as const,
    // Next spells a subdomain wildcard `**.example.com`.
    hostname: pattern.startsWith('*.') ? `**.${pattern.slice(2)}` : pattern,
  }))
}
