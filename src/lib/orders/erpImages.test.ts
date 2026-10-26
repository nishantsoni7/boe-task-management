import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { erpPictureUrlsByRow, loadErpImages } from './erpImages'
import type { ErpSheetImage } from './erpWorkbookImages'
import type { PiViewerItem } from '@/lib/pi/previewView'

const item = (row: number, role: 'representative' | 'customization', url: string) =>
  ({ key: `${role}:${row}:${url}`, row, role, url }) as unknown as PiViewerItem

const fake = (n: number): ErpSheetImage => ({ bytes: new Uint8Array([n]), width: 10, height: 10, ext: 'jpeg' })

describe('which picture goes on the sheet', () => {
  test('the representative picture of each row; the first one when a row has no representative', () => {
    const urls = erpPictureUrlsByRow([
      item(5, 'customization', 'c5'), item(5, 'representative', 'r5'), item(5, 'customization', 'c5b'),
      item(6, 'customization', 'c6'), item(6, 'customization', 'c6b'),
    ])
    assert.equal(urls.get(5), 'r5')
    assert.equal(urls.get(6), 'c6')
    assert.equal(urls.has(7), false)
  })
})

describe('loading the pictures', () => {
  test('one picture per product, in product order; a product with no URL stays empty', async () => {
    const { images, failed } = await loadErpImages(['a', null, 'c'], async u => new Uint8Array([u.charCodeAt(0)]), async b => fake(b[0]))
    assert.equal(images[0]?.bytes[0], 97)
    assert.equal(images[1], null)
    assert.equal(images[2]?.bytes[0], 99)
    assert.equal(failed, 0, 'no URL is not a failure')
  })

  test('a picture that cannot be fetched or decoded is left out and counted, and the rest still load', async () => {
    const { images, failed } = await loadErpImages(
      ['ok', 'gone', 'throws', 'bad'],
      async u => {
        if (u === 'gone') return null
        if (u === 'throws') throw new Error('network')
        return new Uint8Array([1])
      },
      async () => null,
    )
    assert.deepEqual(images, [null, null, null, null])
    assert.equal(failed, 4)

    const mixed = await loadErpImages(
      ['ok', 'gone'],
      async u => (u === 'gone' ? null : new Uint8Array([7])),
      async b => fake(b[0]),
    )
    assert.equal(mixed.images[0]?.bytes[0], 7)
    assert.equal(mixed.images[1], null)
    assert.equal(mixed.failed, 1)
  })

  test('never more than the concurrency at once', async () => {
    let live = 0
    let peak = 0
    await loadErpImages(Array.from({ length: 10 }, (_, i) => `u${i}`), async () => {
      live++
      peak = Math.max(peak, live)
      await new Promise(r => setTimeout(r, 2))
      live--
      return new Uint8Array([1])
    }, async () => fake(1), 3)
    assert.ok(peak <= 3)
  })
})
