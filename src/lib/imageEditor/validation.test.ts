/**
 * What the Image Editor accepts, and what it refuses.
 *
 * This validator runs twice per upload — once in the browser, once in
 * /api/image-editor/studio — so a change here changes both halves at once, and
 * these cases are what stop the two from being talked into disagreeing.
 *
 * The cases that matter operationally: an iPhone HEIC (rejected with a sentence
 * that names the formats), a file the browser could not type (accepted on its
 * extension, because a blank `File.type` is common enough that rejecting it
 * would fail real uploads), and a size ceiling that is enforced rather than
 * suggested.
 *
 * Run:
 *   npx tsx --test src/lib/imageEditor/validation.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  validateSourceImage,
  mimeTypeFromName,
  MAX_SOURCE_IMAGE_BYTES,
  STUDIO_IMAGE_ACCEPT,
} from './validation'

const ONE_MB = 1024 * 1024

describe('accepted photographs', () => {
  test('JPG, PNG and WebP pass, and report the type the provider will be told', () => {
    for (const [type, name] of [
      ['image/jpeg', 'sofa.jpg'],
      ['image/png',  'sofa.png'],
      ['image/webp', 'sofa.webp'],
    ]) {
      const result = validateSourceImage({ name, type, size: ONE_MB })
      assert.equal(result.ok, true, `${type} should be accepted`)
      assert.equal(result.ok && result.mimeType, type)
    }
  })

  test('an uppercase or padded MIME type from a browser still passes', () => {
    const result = validateSourceImage({ name: 'chair.JPG', type: ' IMAGE/JPEG ', size: ONE_MB })
    assert.equal(result.ok, true)
    assert.equal(result.ok && result.mimeType, 'image/jpeg')
  })

  test('a blank File.type falls back to the extension rather than failing', () => {
    // Some Windows sources and some Android pickers hand over a File with no
    // type at all. Refusing those would refuse real product photographs.
    const result = validateSourceImage({ name: 'DSC_0041.JPEG', type: '', size: 2 * ONE_MB })
    assert.equal(result.ok, true)
    assert.equal(result.ok && result.mimeType, 'image/jpeg')
  })

  test('exactly at the size ceiling is still accepted', () => {
    const result = validateSourceImage({ name: 'bed.png', type: 'image/png', size: MAX_SOURCE_IMAGE_BYTES })
    assert.equal(result.ok, true)
  })
})

describe('refused uploads', () => {
  test('an iPhone HEIC is refused, and the message names what to upload instead', () => {
    const result = validateSourceImage({ name: 'IMG_2201.HEIC', type: 'image/heic', size: 3 * ONE_MB })
    assert.equal(result.ok, false)
    assert.match(result.ok ? '' : result.error, /JPG, PNG or WebP/)
  })

  test('a PDF quotation dropped on the upload area is refused', () => {
    const result = validateSourceImage({ name: 'quote.pdf', type: 'application/pdf', size: ONE_MB })
    assert.equal(result.ok, false)
  })

  test('a GIF is refused — the attachment flow takes them, this one does not', () => {
    const result = validateSourceImage({ name: 'spin.gif', type: 'image/gif', size: ONE_MB })
    assert.equal(result.ok, false)
  })

  test('an unknown extension with no declared type is refused', () => {
    const result = validateSourceImage({ name: 'scan.tiff', type: '', size: ONE_MB })
    assert.equal(result.ok, false)
  })

  test('one byte over the ceiling is refused, and the message says the limit', () => {
    const result = validateSourceImage({
      name: 'wardrobe.jpg', type: 'image/jpeg', size: MAX_SOURCE_IMAGE_BYTES + 1,
    })
    assert.equal(result.ok, false)
    assert.match(result.ok ? '' : result.error, /10 MB/)
  })

  test('an empty file is refused before it can reach the provider', () => {
    const result = validateSourceImage({ name: 'sofa.jpg', type: 'image/jpeg', size: 0 })
    assert.equal(result.ok, false)
  })

  test('nothing chosen at all is refused without throwing', () => {
    assert.equal(validateSourceImage(null).ok, false)
    assert.equal(validateSourceImage(undefined).ok, false)
  })

  test('a declared type that is not accepted is NOT rescued by a friendly extension', () => {
    // `virus.exe` renamed to `photo.jpg` is not the threat here — the point is
    // that when the browser DID type the file, that answer is used. A file
    // declared image/gif does not become a JPG by being called one.
    const result = validateSourceImage({ name: 'photo.jpg', type: 'image/gif', size: ONE_MB })
    assert.equal(result.ok, false)
  })
})

describe('the file picker', () => {
  test('accept lists both extensions and MIME types', () => {
    // Extension-only pickers exist on Android; type-only matching exists on
    // desktop. Listing both is what makes the picker show product photographs
    // on every device BOE actually uses.
    for (const token of ['.jpg', '.jpeg', '.png', '.webp', 'image/jpeg', 'image/png', 'image/webp']) {
      assert.ok(STUDIO_IMAGE_ACCEPT.includes(token), `accept should include ${token}`)
    }
  })

  test('mimeTypeFromName is case-insensitive and answers null for the rest', () => {
    assert.equal(mimeTypeFromName('a.JPG'), 'image/jpeg')
    assert.equal(mimeTypeFromName('a.WebP'), 'image/webp')
    assert.equal(mimeTypeFromName('a.heic'), null)
    assert.equal(mimeTypeFromName(undefined), null)
    assert.equal(mimeTypeFromName('no-extension'), null)
  })
})
