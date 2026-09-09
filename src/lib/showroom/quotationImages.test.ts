/**
 * Showroom quotation image rules and salesperson attribution.
 *
 * The defects these lock down:
 *
 *  1. Every product-image fetch carried `apikey` and `Authorization: Bearer
 *     <SUPABASE SERVICE ROLE KEY>`. Since every stored image is on
 *     bestofexports.com, that sent BOE's service-role key to a third-party
 *     WordPress host on every quotation download.
 *  2. `salesperson_name` was queried, passed into the PDF builder, and then
 *     never rendered — the quotation named no salesperson at all.
 *  3. A product whose image would not load left an empty rectangle where the
 *     photo should be, with nothing to say why.
 *
 * Run:
 *   npx tsx --test src/lib/showroom/quotationImages.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_PRODUCT_IMAGE_BUCKET,
  IMAGE_FETCH_USER_AGENT,
  SALESPERSON_LABEL,
  classifyImageSource,
  detectImageFormat,
  imagePlaceholder,
  imageRequestHeaders,
  isPubliclyShareableImageUrl,
  needsConversion,
  pickPrimaryImage,
  resolveStoragePath,
  salespersonLine,
} from './quotationImages'

const SUPABASE_URL = 'https://abcdefghijkl.supabase.co'
const SERVICE_KEY  = 'service-role-key-value'

describe('pickPrimaryImage', () => {
  test('images[0] wins over the legacy image_url', () => {
    assert.equal(
      pickPrimaryImage({ images: ['https://a/1.jpg'], image_url: 'https://b/2.jpg' }),
      'https://a/1.jpg',
    )
  })

  test('an empty images[] falls back to image_url', () => {
    // `images` is `text[] NOT NULL DEFAULT '{}'`, so this is the shape every
    // pre-images row has after the back-fill.
    assert.equal(pickPrimaryImage({ images: [], image_url: 'https://b/2.jpg' }), 'https://b/2.jpg')
  })

  test('a blank first entry is skipped rather than fetched', () => {
    // `?? ` does not skip '', so the old chain would have returned the empty
    // string and turned the fetch into a guaranteed miss.
    assert.equal(pickPrimaryImage({ images: ['   ', 'https://a/2.jpg'] }), 'https://a/2.jpg')
    assert.equal(pickPrimaryImage({ images: [''], image_url: 'https://b/2.jpg' }), 'https://b/2.jpg')
  })

  test('surrounding whitespace never reaches the network', () => {
    assert.equal(pickPrimaryImage({ images: ['  https://a/1.jpg  '] }), 'https://a/1.jpg')
  })

  test('a product with nothing on file yields null', () => {
    assert.equal(pickPrimaryImage({ images: [], image_url: null }), null)
    assert.equal(pickPrimaryImage(null), null)
    assert.equal(pickPrimaryImage({}), null)
  })

  test('a non-array images column cannot crash the merge', () => {
    assert.equal(pickPrimaryImage({ images: 'not-an-array', image_url: 'https://b/2.jpg' }), 'https://b/2.jpg')
  })
})

describe('classifyImageSource', () => {
  test('the real production shape is an external URL', () => {
    assert.equal(
      classifyImageSource('https://bestofexports.com/wp-content/uploads/2026/07/Atri-Chair.jpg', SUPABASE_URL),
      'external-url',
    )
  })

  test('the project’s own Supabase host is recognised as ours', () => {
    assert.equal(
      classifyImageSource(`${SUPABASE_URL}/storage/v1/object/sign/products/a.jpg`, SUPABASE_URL),
      'supabase-url',
    )
  })

  test('a bare path is a storage path', () => {
    assert.equal(classifyImageSource('products/a.jpg', SUPABASE_URL), 'storage-path')
    assert.equal(classifyImageSource('2026/07/a.jpg', SUPABASE_URL), 'storage-path')
  })

  test('blanks, junk and unfetchable schemes are nothing', () => {
    assert.equal(classifyImageSource('', SUPABASE_URL), 'none')
    assert.equal(classifyImageSource('   ', SUPABASE_URL), 'none')
    assert.equal(classifyImageSource(null, SUPABASE_URL), 'none')
    assert.equal(classifyImageSource('https://', SUPABASE_URL), 'none')
    assert.equal(classifyImageSource('data:image/png;base64,AAAA', SUPABASE_URL), 'none')
  })

  test('with no Supabase URL configured, every absolute URL is external', () => {
    // Fail closed: an unknown own-host must never be a reason to attach credentials.
    assert.equal(classifyImageSource(`${SUPABASE_URL}/x.jpg`, null), 'external-url')
    assert.equal(classifyImageSource(`${SUPABASE_URL}/x.jpg`, 'not a url'), 'external-url')
  })
})

describe('imageRequestHeaders', () => {
  test('an external host is never sent the service-role key', () => {
    const headers = imageRequestHeaders('external-url', SERVICE_KEY)
    const serialised = JSON.stringify(headers)
    assert.equal(serialised.includes(SERVICE_KEY), false)
    assert.equal('apikey' in headers, false)
    assert.equal('Authorization' in headers, false)
  })

  test('Supabase itself still gets credentials', () => {
    const headers = imageRequestHeaders('supabase-url', SERVICE_KEY)
    assert.equal(headers.apikey, SERVICE_KEY)
    assert.equal(headers.Authorization, `Bearer ${SERVICE_KEY}`)
  })

  test('no key configured means no credential headers at all', () => {
    const headers = imageRequestHeaders('supabase-url', null)
    assert.equal('apikey' in headers, false)
    assert.equal('Authorization' in headers, false)
  })

  test('every request identifies itself and states what it accepts', () => {
    for (const kind of ['external-url', 'supabase-url', 'storage-path'] as const) {
      const headers = imageRequestHeaders(kind, SERVICE_KEY)
      assert.equal(headers['User-Agent'], IMAGE_FETCH_USER_AGENT)
      assert.match(headers.Accept, /image\//)
    }
  })
})

describe('isPubliclyShareableImageUrl', () => {
  // /showroom/share/[token] has no auth at all, so this decides what an
  // anonymous link holder is allowed to see.
  test('the real production shape is publishable', () => {
    assert.equal(
      isPubliclyShareableImageUrl('https://bestofexports.com/wp-content/uploads/a.jpg', SUPABASE_URL),
      true,
    )
  })

  test('a bare storage path is never published', () => {
    assert.equal(isPubliclyShareableImageUrl('products/2026/a.jpg', SUPABASE_URL), false)
    assert.equal(isPubliclyShareableImageUrl('2026/07/a.jpg', SUPABASE_URL), false)
  })

  test('a Supabase public-object URL is publishable', () => {
    assert.equal(
      isPubliclyShareableImageUrl(`${SUPABASE_URL}/storage/v1/object/public/products/a.jpg`, SUPABASE_URL),
      true,
    )
  })

  test('a signed Supabase URL is publishable — it expires and carries its own auth', () => {
    assert.equal(
      isPubliclyShareableImageUrl(`${SUPABASE_URL}/storage/v1/object/sign/products/a.jpg?token=abc`, SUPABASE_URL),
      true,
    )
  })

  test('an unsigned private-bucket URL is withheld rather than published', () => {
    // It would 401 for the customer anyway, so publishing it hands out the
    // bucket and object layout in exchange for nothing.
    assert.equal(
      isPubliclyShareableImageUrl(`${SUPABASE_URL}/storage/v1/object/products/a.jpg`, SUPABASE_URL),
      false,
    )
  })

  test('nothing usable is not publishable', () => {
    assert.equal(isPubliclyShareableImageUrl('', SUPABASE_URL), false)
    assert.equal(isPubliclyShareableImageUrl(null, SUPABASE_URL), false)
    assert.equal(isPubliclyShareableImageUrl('data:image/png;base64,AAA', SUPABASE_URL), false)
  })
})

describe('resolveStoragePath', () => {
  test('a bucket-relative path is left alone', () => {
    // The old rule ate `2026` as a bucket name and asked for `07/a.jpg`.
    assert.deepEqual(
      resolveStoragePath('2026/07/a.jpg'),
      { bucket: DEFAULT_PRODUCT_IMAGE_BUCKET, objectPath: '2026/07/a.jpg' },
    )
  })

  test('a leading segment is stripped only when it is the bucket', () => {
    assert.deepEqual(
      resolveStoragePath('products/2026/a.jpg'),
      { bucket: 'products', objectPath: '2026/a.jpg' },
    )
    assert.deepEqual(
      resolveStoragePath('products/2026/a.jpg', 'showroom'),
      { bucket: 'showroom', objectPath: 'products/2026/a.jpg' },
    )
  })

  test('a leading slash is not a nameless first segment', () => {
    assert.deepEqual(
      resolveStoragePath('/products/a.jpg'),
      { bucket: 'products', objectPath: 'a.jpg' },
    )
  })
})

describe('detectImageFormat', () => {
  const png  = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
  const webp = Uint8Array.from([
    0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00,
    0x57, 0x45, 0x42, 0x50,
  ])

  test('recognises the three formats the quotation supports', () => {
    assert.equal(detectImageFormat(png),  'png')
    assert.equal(detectImageFormat(jpeg), 'jpeg')
    assert.equal(detectImageFormat(webp), 'webp')
  })

  test('RIFF that is not WebP is not WebP', () => {
    const riffWave = Uint8Array.from([
      0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00,
      0x57, 0x41, 0x56, 0x45,
    ])
    assert.equal(detectImageFormat(riffWave), null)
  })

  test('an HTML error page served with a 200 is not an image', () => {
    // A WAF challenge page arrives as 200 text/html; embedding it would throw.
    const html = new TextEncoder().encode('<!DOCTYPE html><html>')
    assert.equal(detectImageFormat(html), null)
  })

  test('empty, short and absent buffers are not images', () => {
    assert.equal(detectImageFormat(new Uint8Array(0)), null)
    assert.equal(detectImageFormat(Uint8Array.from([0xff])), null)
    assert.equal(detectImageFormat(null), null)
  })

  test('only WebP costs a conversion', () => {
    assert.equal(needsConversion('webp'), true)
    assert.equal(needsConversion('png'),  false)
    assert.equal(needsConversion('jpeg'), false)
  })
})

describe('imagePlaceholder', () => {
  test('a product with no image on file says so', () => {
    const box = imagePlaceholder({ hasStoredImage: false, productCode: 'BOE-SR-003' })
    assert.equal(box.title, 'NO IMAGE ON FILE')
    assert.equal(box.subtitle, 'BOE-SR-003')
  })

  test('an image that would not load is distinguished from one that does not exist', () => {
    const box = imagePlaceholder({ hasStoredImage: true, productCode: 'BOE-SR-003' })
    assert.equal(box.title, 'IMAGE UNAVAILABLE')
  })

  test('the merge’s own em-dash placeholder is not printed as a product code', () => {
    assert.equal(imagePlaceholder({ hasStoredImage: true, productCode: '—' }).subtitle, null)
    assert.equal(imagePlaceholder({ hasStoredImage: true, productCode: '  ' }).subtitle, null)
    assert.equal(imagePlaceholder({ hasStoredImage: true }).subtitle, null)
  })
})

describe('salespersonLine', () => {
  test('names the consultant who owns the inquiry', () => {
    assert.equal(salespersonLine('Ashok Choudhary'), 'Sales Consultant: Ashok Choudhary')
    assert.equal(SALESPERSON_LABEL, 'Sales Consultant')
  })

  test('an unresolved profile prints no line rather than a dash', () => {
    // The route falls back to '—' when the users lookup returns nothing; a lone
    // dash under a heading reads as a bug in a customer-facing document.
    assert.equal(salespersonLine('—'), null)
    assert.equal(salespersonLine('-'), null)
    assert.equal(salespersonLine(''), null)
    assert.equal(salespersonLine('   '), null)
    assert.equal(salespersonLine(null), null)
    assert.equal(salespersonLine(undefined), null)
  })

  test('a padded name is trimmed, not rejected', () => {
    assert.equal(salespersonLine('  Prerna  '), 'Sales Consultant: Prerna')
  })
})
