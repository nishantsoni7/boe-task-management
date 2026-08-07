/**
 * Which product images may be resized, and what a thumbnail actually loads.
 *
 * The rule that matters most here is the *fallback*: showroom images are pasted
 * URLs on hosts nobody enumerated, and Next's optimizer answers 400 for a host
 * it was not told about. So an unlisted host must come back untouched — a
 * slightly heavy thumbnail is a cost, a broken one is a regression.
 *
 * The allowlist is read from the environment at module load, so each case sets
 * the environment first and imports afterwards.
 *
 * Run:
 *   npx tsx --test src/lib/imageHosts.test.ts
 */

import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'

type Mod = typeof import('./imageHosts')

let mod: Mod

before(async () => {
  process.env.NEXT_PUBLIC_SHOWROOM_IMAGE_HOSTS = 'cdn.supplier.test, *.assets.test'
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://abcdefgh.supabase.co'
  mod = await import('./imageHosts')
})

describe('the allowlist', () => {
  test('the real product image host is allowed with no configuration at all', () => {
    // Every image URL in showroom_products is https://bestofexports.com/… , so
    // the optimization must work out of the box rather than waiting for someone
    // to set an env var.
    assert.ok(mod.OPTIMIZABLE_IMAGE_HOSTS.includes('bestofexports.com'))
    assert.ok(mod.isOptimizableImageUrl('https://bestofexports.com/images/chair.jpg'))
    assert.ok(mod.isOptimizableImageUrl('https://www.bestofexports.com/images/chair.jpg'))
  })

  test('configured hosts and the project’s own Supabase host are added, not substituted', () => {
    assert.deepEqual(
      [...mod.OPTIMIZABLE_IMAGE_HOSTS].sort(),
      [
        '*.assets.test', 'abcdefgh.supabase.co', 'bestofexports.com',
        'cdn.supplier.test', 'www.bestofexports.com',
      ],
    )
  })

  test('an exact host matches only itself', () => {
    assert.equal(mod.hostMatches('cdn.supplier.test', 'cdn.supplier.test'), true)
    assert.equal(mod.hostMatches('cdn.supplier.test', 'CDN.SUPPLIER.TEST'), true)
    assert.equal(mod.hostMatches('cdn.supplier.test', 'evil.cdn.supplier.test'), false)
    assert.equal(mod.hostMatches('cdn.supplier.test', 'cdn.supplier.test.evil.com'), false)
  })

  test('a wildcard covers subdomains and nothing else', () => {
    assert.equal(mod.hostMatches('*.assets.test', 'images.assets.test'), true)
    assert.equal(mod.hostMatches('*.assets.test', 'a.b.assets.test'), true)
    // Not the bare domain, matching how Next reads `**.example.com`.
    assert.equal(mod.hostMatches('*.assets.test', 'assets.test'), false)
    assert.equal(mod.hostMatches('*.assets.test', 'notassets.test'), false)
    // The suffix trick: `evil-assets.test` must not pass as a subdomain.
    assert.equal(mod.hostMatches('*.assets.test', 'evil-assets.test'), false)
  })
})

describe('which URLs may be optimized', () => {
  test('an allowlisted https URL may be', () => {
    assert.equal(mod.isOptimizableImageUrl('https://cdn.supplier.test/chair.jpg'), true)
    assert.equal(mod.isOptimizableImageUrl('https://images.assets.test/x/y.png'), true)
    assert.equal(
      mod.isOptimizableImageUrl('https://abcdefgh.supabase.co/storage/v1/object/public/p/a.jpg'),
      true,
    )
  })

  test('an unknown host may not', () => {
    assert.equal(mod.isOptimizableImageUrl('https://cdn.test/chair.jpg'), false)
    assert.equal(mod.isOptimizableImageUrl('https://other.supabase.co/x.jpg'), false)
  })

  test('non-https schemes and junk are refused rather than throwing', () => {
    for (const raw of [
      '', '   ', null, undefined,
      'not a url', '/local/path.jpg', 'chair.jpg',
      'data:image/png;base64,AAAA',
      'javascript:alert(1)',
      'ftp://cdn.supplier.test/x.jpg',
      // http is deliberately excluded: remotePatterns allows https only, so
      // optimizing this would be a guaranteed 400.
      'http://cdn.supplier.test/x.jpg',
      'http://bestofexports.com/images/chair.jpg',
    ]) {
      assert.doesNotThrow(() => mod.isOptimizableImageUrl(raw), String(raw))
      assert.equal(mod.isOptimizableImageUrl(raw), false, String(raw))
    }
  })

  test('an http URL still renders — it falls back instead of breaking', () => {
    const src = 'http://bestofexports.com/images/chair.jpg'
    assert.deepEqual(mod.thumbSource(src), { src, optimized: false, original: src })
  })
})

describe('what a thumbnail loads', () => {
  test('an allowlisted image is resized and re-encoded by the optimizer', () => {
    const src = 'https://cdn.supplier.test/chair.jpg'
    const out = mod.thumbSource(src)
    assert.ok(out)
    assert.equal(out.optimized, true)
    assert.match(out.src, /^\/_next\/image\?url=/)
    assert.match(out.src, new RegExp(`w=${mod.THUMB_WIDTH_1X}`))
    assert.match(out.src, new RegExp(`q=${mod.THUMB_QUALITY}`))
    // The original is carried as an encoded parameter, never spliced into the path.
    assert.equal(new URLSearchParams(out.src.split('?')[1]).get('url'), src)
  })

  test('a 2x candidate is offered for retina without a second request at 1x', () => {
    const out = mod.thumbSource('https://cdn.supplier.test/chair.jpg')
    assert.ok(out?.srcSet)
    assert.match(out.srcSet, new RegExp(`w=${mod.THUMB_WIDTH_1X}[^,]*1x`))
    assert.match(out.srcSet, new RegExp(`w=${mod.THUMB_WIDTH_2X}[^,]*2x`))
  })

  test('an unlisted host is returned untouched, not broken', () => {
    // The whole safety property: nothing regresses for hosts nobody configured.
    const src = 'https://cdn.test/legacy.jpg'
    assert.deepEqual(mod.thumbSource(src), { src, optimized: false, original: src })
  })

  test('the origin URL is always carried, so a failed optimization can retreat', () => {
    // Optimizing makes the SERVER fetch the image, which nothing did before. If
    // the origin is unreachable from the server, the caller must still be able
    // to load it the old way rather than show a placeholder.
    for (const src of [
      'https://bestofexports.com/wp-content/uploads/chair.webp',
      'https://cdn.test/legacy.jpg',
      'http://bestofexports.com/chair.webp',
    ]) {
      assert.equal(mod.thumbSource(src)?.original, src, src)
    }
  })

  test('a query string on the original survives encoding', () => {
    const src = 'https://cdn.supplier.test/chair.jpg?v=2&size=full'
    const out = mod.thumbSource(src)
    assert.equal(new URLSearchParams(out!.src.split('?')[1]).get('url'), src)
  })

  test('no image at all is no source', () => {
    assert.equal(mod.thumbSource(null), null)
    assert.equal(mod.thumbSource(undefined), null)
    assert.equal(mod.thumbSource('   '), null)
  })

  test('the widths asked for are ones the optimizer will accept', () => {
    // Next rejects any width outside imageSizes ∪ deviceSizes with a 400; these
    // two are defaults in imageSizes.
    const DEFAULT_IMAGE_SIZES = [32, 48, 64, 96, 128, 256, 384]
    assert.ok(DEFAULT_IMAGE_SIZES.includes(mod.THUMB_WIDTH_1X))
    assert.ok(DEFAULT_IMAGE_SIZES.includes(mod.THUMB_WIDTH_2X))
  })
})

describe('the Next config the allowlist produces', () => {
  test('every allowed host becomes a remote pattern', () => {
    const hostnames = mod.imageRemotePatterns().map(p => p.hostname)
    assert.ok(hostnames.includes('cdn.supplier.test'))
    assert.ok(hostnames.includes('abcdefgh.supabase.co'))
    // Next spells a subdomain wildcard with a double star.
    assert.ok(hostnames.includes('**.assets.test'))
    assert.ok(!hostnames.includes('*.assets.test'))
  })

  test('a host the client would optimize is one the server config allows', () => {
    // The invariant that keeps the two sides from disagreeing: if this drifts,
    // thumbnails 400 in production.
    const patterns = mod.imageRemotePatterns()
    for (const host of mod.OPTIMIZABLE_IMAGE_HOSTS) {
      const expected = host.startsWith('*.') ? `**.${host.slice(2)}` : host
      assert.ok(
        patterns.some(p => p.hostname === expected),
        `${host} is optimizable on the client but absent from remotePatterns`,
      )
    }
  })

  test('the config allows https only, matching what the client will emit', () => {
    // Both halves must agree on the scheme too, not just the host.
    assert.ok(mod.imageRemotePatterns().every(p => p.protocol === 'https'))
  })
})
