/**
 * The approved PI's product pictures on the Documents card: truthful counts and
 * a ZIP that holds only pictures that actually downloaded.
 *
 * Run:
 *   npx tsx --test src/lib/orders/productPictures.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { unzipSync } from 'fflate'
import type { PiViewerItem } from '@/lib/pi/previewView'
import {
  buildProductPicturesZip,
  productPictureZipEntries,
  productPicturesLine,
  productPicturesState,
  productPicturesZipName,
} from './productPictures'

const item = (over: Partial<PiViewerItem>): PiViewerItem => ({
  key: 'k', row: 32, role: 'representative', roleLabel: 'Representative image', sequence: 'B001', name: 'Lounge chair',
  url: 'https://x.test/object/sign/order-files/submissions/s/images/i/representative/0-abc.png?token=t', label: 'l', ...over,
})

describe('what the card says', () => {
  test('none, all, some and missing', () => {
    assert.equal(productPicturesLine(productPicturesState({ recorded: 0, loading: false, available: 0, unavailable: 0 })), 'No product pictures on this PI.')
    assert.equal(productPicturesLine(productPicturesState({ recorded: 16, loading: false, available: 16, unavailable: 0 })), '16 pictures')
    assert.equal(productPicturesLine(productPicturesState({ recorded: 16, loading: false, available: 12, unavailable: 4 })),
      '12 of 16 pictures available · 4 no longer in storage')
    // The production case behind "16 images unavailable": rows recorded, files gone.
    const missing = productPicturesState({ recorded: 16, loading: false, available: 0, unavailable: 16 })
    assert.equal(missing.kind, 'missing')
    assert.equal(productPicturesLine(missing), '16 pictures recorded, but the files are no longer in storage.')
  })

  test('a failed read and loading are said as such, never as "none"', () => {
    assert.equal(productPicturesState({ recorded: null, loading: false, available: 0, unavailable: 0 }).kind, 'unreadable')
    assert.equal(productPicturesState({ recorded: null, loading: true, available: 0, unavailable: 0 }).kind, 'loading')
  })
})

describe('the ZIP', () => {
  test('entries are named by product and role, unique, with the real extension', () => {
    const entries = productPictureZipEntries([
      item({ key: 'a' }),
      item({ key: 'b', role: 'customization', url: 'https://x.test/c/0-1.jpg?t' }),
      item({ key: 'c', role: 'customization', url: 'https://x.test/c/1-2.webp?t' }),
      item({ key: 'd', row: 33, sequence: 'B002', name: 'Table', url: 'https://x.test/d.jpeg?t' }),
    ])
    assert.deepEqual(entries.map(e => e.name), [
      'B001 Lounge chair - representative.png',
      'B001 Lounge chair - customization 1.jpg',
      'B001 Lounge chair - customization 2.webp',
      'B002 Table - representative.jpeg',
    ])
  })

  test('only pictures that downloaded go in; none downloaded means no archive', async () => {
    const entries = [{ name: 'a.png', url: 'ok-1' }, { name: 'b.png', url: 'missing' }, { name: 'c.png', url: 'ok-2' }]
    const fetchBytes = async (url: string) => url.startsWith('ok') ? new Uint8Array([1, 2, 3]) : null
    const result = await buildProductPicturesZip(entries, fetchBytes)
    assert.equal(result.included, 2)
    assert.equal(result.failed, 1)
    assert.deepEqual(Object.keys(unzipSync(result.bytes!)).sort(), ['a.png', 'c.png'])

    const none = await buildProductPicturesZip(entries, async () => null)
    assert.equal(none.bytes, null)
    assert.equal(none.failed, 3)
  })

  test('the archive is named after the Order', () => {
    assert.equal(productPicturesZipName('0526', 'Rivoli'), '0526 product pictures.zip')
    assert.equal(productPicturesZipName(null, 'Rivoli / Mumbai'), 'Rivoli _ Mumbai product pictures.zip')
  })
})
