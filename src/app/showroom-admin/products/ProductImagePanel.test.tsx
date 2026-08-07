/**
 * Product image panel — rendering contract.
 *
 * The panel sits beside the edit form and is fed straight from the form's own
 * `images` state, which means it is handed half-typed URLs, blanks and empty
 * rows constantly. What it must guarantee:
 *   * a product with an image shows it whole (contained, not cropped),
 *   * several images get selectable thumbnails and one is picked out,
 *   * a single image gets no thumbnail strip to click through, and
 *   * a product with no usable image renders a clean empty state instead of a
 *     broken <img> — a product without images must not break the page.
 *
 * Run:
 *   npx tsx --test src/app/showroom-admin/products/ProductImagePanel.test.tsx
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { ProductImagePanel, usableImages } from './ProductImagePanel'

const A = 'https://cdn.test/chair-front.jpg'
const B = 'https://cdn.test/chair-side.jpg'
const C = 'https://cdn.test/chair-back.jpg'

const render = (images: (string | null | undefined)[], selectedIndex = 0) =>
  renderToStaticMarkup(
    <ProductImagePanel
      images={images}
      selectedIndex={selectedIndex}
      onSelect={() => {}}
      alt="Dining Chair"
    />,
  )

/** `src` of every <img> in render order. */
const imageSources = (markup: string) =>
  [...markup.matchAll(/<img\b[^>]*\bsrc="([^"]*)"/g)].map(m => m[1])

/** How many thumbnail buttons the strip rendered. */
const thumbnailCount = (markup: string) =>
  [...markup.matchAll(/aria-label="Show image \d+"/g)].length

/** Query params of a rendered URL, with the markup's `&amp;` escaping undone. */
const queryOf = (url: string) =>
  new URLSearchParams(url.replace(/&amp;/g, '&').split('?')[1] ?? '')

describe('usableImages', () => {
  test('drops blanks, whitespace-only rows and duplicates, keeping order', () => {
    assert.deepEqual(usableImages([' ', A, '', B, A, null, undefined, '   ']), [A, B])
  })

  test('trims surrounding whitespace off a pasted URL', () => {
    assert.deepEqual(usableImages([`  ${A}  `]), [A])
  })

  test('an entirely empty form state yields nothing', () => {
    assert.deepEqual(usableImages(['']), [])
    assert.deepEqual(usableImages([]), [])
  })
})

describe('a product with one image', () => {
  test('renders the image as the large preview', () => {
    assert.deepEqual(imageSources(render([A])), [A])
  })

  test('shows the product name as alt text', () => {
    assert.match(render([A]), /alt="Dining Chair"/)
  })

  test('is contained rather than cropped, so the aspect ratio survives', () => {
    const markup = render([A])
    assert.match(markup, /object-fit:contain/)
    assert.doesNotMatch(markup, /object-fit:cover/)
  })

  test('renders no thumbnail strip — there is nothing to switch between', () => {
    assert.equal(thumbnailCount(render([A])), 0)
  })

  test('does not render the empty state', () => {
    assert.doesNotMatch(render([A]), /No image yet/)
  })
})

describe('a product with several images', () => {
  test('renders one thumbnail per image', () => {
    assert.equal(thumbnailCount(render([A, B, C])), 3)
  })

  test('the large preview is the selected one', () => {
    assert.equal(imageSources(render([A, B, C], 1))[0], B)
    assert.equal(imageSources(render([A, B, C], 2))[0], C)
  })

  test('exactly one thumbnail is marked as chosen', () => {
    const pressed = [...render([A, B, C], 1).matchAll(/aria-pressed="true"/g)]
    assert.equal(pressed.length, 1)
  })

  test('blank rows in the form do not become thumbnails', () => {
    assert.equal(thumbnailCount(render([A, '', B, '  '])), 2)
  })

  test('a selection past the end falls back to the first image instead of blanking', () => {
    assert.equal(imageSources(render([A, B], 9))[0], A)
    assert.equal(imageSources(render([A, B], -3))[0], A)
  })

  test('a selection stranded by a removed image still shows something', () => {
    // The user was on image 3 and deleted rows until only one is left.
    assert.equal(imageSources(render([A], 2))[0], A)
  })
})

describe('the preview asks for a preview-sized image', () => {
  // A real stored product image. bestofexports.com is where every one of them
  // lives, so this is the path that runs in production.
  const REAL = 'https://bestofexports.com/wp-content/uploads/2025/05/Alba-Chair.webp'

  test('the large preview goes through the optimizer, not straight to the original', () => {
    const src = imageSources(render([REAL]))[0]
    assert.match(src, /^\/_next\/image/)
    assert.equal(queryOf(src).get('url'), REAL)
  })

  test('it requests roughly the rendered width, not the full original', () => {
    const params = queryOf(imageSources(render([REAL]))[0])
    assert.equal(params.get('w'), '384')
    assert.equal(params.get('q'), '55')
  })

  test('a 2x candidate is offered for high-DPI screens', () => {
    const markup = render([REAL])
    const srcSet = markup.match(/srcSet="([^"]*)"|srcset="([^"]*)"/)
    assert.ok(srcSet, 'expected a srcSet on the preview')
    const value = srcSet[1] ?? srcSet[2]
    assert.match(value, /w=384[^,]*1x/)
    assert.match(value, /w=828[^,]*2x/)
  })

  test('it asks for a much smaller width than a full-size original', () => {
    // The guard that matters: the preview must never be the width of the stored
    // image. 384 is well under the 768+ these images are stored at.
    const w = Number(queryOf(imageSources(render([REAL]))[0]).get('w'))
    assert.ok(w <= 384, `preview requested ${w}px`)
  })

  test('an image on an unlisted host is still loaded directly, never broken', () => {
    // The existing safety property is unchanged: no optimizer, no regression.
    const src = imageSources(render([A]))[0]
    assert.equal(src, A)
    assert.doesNotMatch(src, /_next\/image/)
  })

  test('the thumbnail strip is left exactly as it was', () => {
    // Out of scope for this change — the strip still loads its own URLs.
    const sources = imageSources(render([A, B, C]))
    assert.deepEqual(sources.slice(1), [A, B, C])
  })
})

describe('a product with no image', () => {
  test('renders the empty state, not an <img>', () => {
    const markup = render([''])
    assert.equal(imageSources(markup).length, 0)
    assert.match(markup, /No image yet/)
  })

  test('points at the existing Product images field rather than a new uploader', () => {
    assert.match(render([]), /Product images/)
  })

  test('an all-blank form state renders without throwing', () => {
    assert.doesNotThrow(() => render(['', '   ', null, undefined]))
    assert.match(render(['', '   ', null, undefined]), /No image yet/)
  })

  test('no thumbnail strip is rendered', () => {
    assert.equal(thumbnailCount(render([])), 0)
  })
})
