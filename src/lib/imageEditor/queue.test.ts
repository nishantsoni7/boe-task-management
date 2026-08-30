/**
 * The selection rules, each of which is a rule about money or about not losing
 * somebody's work.
 *
 * The two that matter most:
 *
 *   * one bad file never costs a good one — a rejected image is named and
 *     dropped, and everything else stays queued;
 *   * a finished result survives a later failure, because a run that lost four
 *     good images when the fifth was refused would have spent four charges for
 *     nothing.
 *
 * Run:
 *   npx tsx --test src/lib/imageEditor/queue.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  addFilesToQueue, pendingGenerationCount, nextWaiting, queueCounts,
  updateItem, removeItem, completedItems, canStartRun, resultFileName,
  MAX_QUEUE_SIZE, type QueueItem,
} from './queue'

/** A stand-in for a browser File: the queue only reads name, size, type. */
function file(name: string, type = 'image/jpeg', size = 2 * 1024 * 1024, lastModified = 1): File {
  return { name, type, size, lastModified } as unknown as File
}

const preview = (f: File) => `blob:${f.name}`
const id = (f: File, i: number) => `${f.name}-${i}`

const add = (existing: QueueItem[], files: File[]) =>
  addFilesToQueue(existing, files, preview, id)

describe('choosing images', () => {
  test('valid images are queued, with a thumbnail and a waiting state', () => {
    const { items, rejected } = add([], [file('chair.jpg'), file('sofa.png', 'image/png')])

    assert.equal(items.length, 2)
    assert.equal(rejected.length, 0)
    assert.deepEqual(items.map(i => i.status), ['waiting', 'waiting'])
    assert.equal(items[0].previewUrl, 'blob:chair.jpg')
    assert.equal(items[0].name, 'chair.jpg')
  })

  test('a bad file is named and dropped, and the good ones are kept', () => {
    // The case this rule exists for: an employee selects four photographs and a
    // PDF, and must not lose the four.
    const { items, rejected } = add([], [
      file('chair.jpg'),
      file('quote.pdf', 'application/pdf'),
      file('sofa.webp', 'image/webp'),
    ])

    assert.deepEqual(items.map(i => i.name), ['chair.jpg', 'sofa.webp'])
    assert.equal(rejected.length, 1)
    assert.equal(rejected[0].name, 'quote.pdf')
    assert.match(rejected[0].reason, /JPG, PNG or WebP/)
  })

  test('an oversized image is refused by name, with the limit in the reason', () => {
    const { items, rejected } = add([], [file('huge.jpg', 'image/jpeg', 11 * 1024 * 1024)])
    assert.equal(items.length, 0)
    assert.match(rejected[0].reason, /10 MB/)
  })

  test('the sixth image is refused and the first five are kept', () => {
    const five = Array.from({ length: 5 }, (_, i) => file(`chair-${i}.jpg`, 'image/jpeg', 1000, i))
    const { items } = add([], five)
    assert.equal(items.length, MAX_QUEUE_SIZE)

    const { items: after, rejected } = add(items, [file('sixth.jpg', 'image/jpeg', 1000, 99)])
    assert.equal(after.length, MAX_QUEUE_SIZE, 'the queue does not grow past five')
    assert.equal(rejected.length, 1)
    assert.match(rejected[0].reason, /5 images/)
  })

  test('a selection that overflows keeps as many as fit and names the rest', () => {
    const seven = Array.from({ length: 7 }, (_, i) => file(`c${i}.jpg`, 'image/jpeg', 1000, i))
    const { items, rejected } = add([], seven)

    assert.equal(items.length, 5)
    assert.deepEqual(rejected.map(r => r.name), ['c5.jpg', 'c6.jpg'])
  })

  test('the same file chosen twice is queued once', () => {
    // Two charges for one photograph is the failure mode here.
    const chair = file('chair.jpg')
    const { items } = add([], [chair])
    const { items: after, rejected } = add(items, [chair])

    assert.equal(after.length, 1)
    assert.match(rejected[0].reason, /already in the list/)
  })

  test('two different photographs with the same name are both kept', () => {
    const { items } = add([], [
      file('IMG_0001.jpg', 'image/jpeg', 1000, 1),
      file('IMG_0001.jpg', 'image/jpeg', 2000, 2),
    ])
    assert.equal(items.length, 2)
  })

  test('nothing is sent merely by being selected', () => {
    const { items } = add([], [file('chair.jpg')])
    // The only state a fresh item can be in.
    assert.equal(items[0].status, 'waiting')
    assert.equal(items[0].result, undefined)
  })
})

describe('what a run would cost', () => {
  test('the count is the number of waiting items, and nothing else', () => {
    const { items } = add([], [file('a.jpg', 'image/jpeg', 1000, 1), file('b.jpg', 'image/jpeg', 1000, 2)])
    assert.equal(pendingGenerationCount(items), 2)

    const afterOne = updateItem(items, items[0].id, { status: 'done', result: { dataUrl: 'data:x', mimeType: 'image/png' } })
    assert.equal(pendingGenerationCount(afterOne), 1, 'a finished image is not paid for again')

    const afterFail = updateItem(afterOne, items[1].id, { status: 'failed', error: 'nope' })
    assert.equal(pendingGenerationCount(afterFail), 0, 'a failed image is not retried by the run')
  })

  test('a run starts only when there is work and nothing is in flight', () => {
    const { items } = add([], [file('a.jpg')])
    assert.equal(canStartRun(items), true)

    const inFlight = updateItem(items, items[0].id, { status: 'processing' })
    assert.equal(canStartRun(inFlight), false, 'a second run must not start over the first')

    assert.equal(canStartRun([]), false)
    assert.equal(canStartRun(updateItem(items, items[0].id, { status: 'done' })), false)
  })
})

describe('running the queue', () => {
  const three = () => add([], [
    file('a.jpg', 'image/jpeg', 1000, 1),
    file('b.jpg', 'image/jpeg', 1000, 2),
    file('c.jpg', 'image/jpeg', 1000, 3),
  ]).items

  test('items are sent in the order they were chosen, one at a time', () => {
    let items = three()
    assert.equal(nextWaiting(items)?.name, 'a.jpg')

    items = updateItem(items, items[0].id, { status: 'processing' })
    // The next one is not started while the first is in flight — the caller
    // asks for the next only after the current finishes.
    assert.equal(queueCounts(items).processing, 1)

    items = updateItem(items, items[0].id, { status: 'done', result: { dataUrl: 'data:a', mimeType: 'image/png' } })
    assert.equal(nextWaiting(items)?.name, 'b.jpg')
  })

  test('progress counts the item in hand', () => {
    let items = three()
    assert.equal(queueCounts(items).position, 0)

    items = updateItem(items, items[0].id, { status: 'processing' })
    assert.equal(queueCounts(items).position, 1, 'Processing 1 of 3')

    items = updateItem(items, items[0].id, { status: 'done' })
    items = updateItem(items, items[1].id, { status: 'processing' })
    assert.equal(queueCounts(items).position, 2, 'Processing 2 of 3')
    assert.equal(queueCounts(items).total, 3)
  })

  test('a failure in the middle costs nothing that already succeeded', () => {
    let items = three()
    items = updateItem(items, items[0].id, { status: 'done', result: { dataUrl: 'data:a', mimeType: 'image/png' } })
    items = updateItem(items, items[1].id, { status: 'failed', error: 'The image service is busy right now.' })
    items = updateItem(items, items[2].id, { status: 'done', result: { dataUrl: 'data:c', mimeType: 'image/png' } })

    const done = completedItems(items)
    assert.deepEqual(done.map(i => i.name), ['a.jpg', 'c.jpg'])
    assert.equal(done[0].result?.dataUrl, 'data:a')

    const counts = queueCounts(items)
    assert.deepEqual([counts.done, counts.failed, counts.waiting], [2, 1, 0])
    // And the failure explains itself.
    assert.match(items[1].error ?? '', /busy/)
  })

  test('removing one result leaves the others untouched', () => {
    let items = three()
    items = items.map(i => ({ ...i, status: 'done' as const, result: { dataUrl: `data:${i.name}`, mimeType: 'image/png' } }))

    const after = removeItem(items, items[1].id)
    assert.deepEqual(after.map(i => i.name), ['a.jpg', 'c.jpg'])
    assert.equal(completedItems(after).length, 2)
  })

  test('a failed item can be put back in the queue by hand, and only by hand', () => {
    // Retry is a person's decision, never the runner's: the failed item stays
    // failed until someone moves it back to waiting.
    let items = three()
    items = updateItem(items, items[0].id, { status: 'failed', error: 'The image service is busy right now.' })
    assert.equal(nextWaiting(items)?.name, 'b.jpg', 'the runner steps over it')

    items = updateItem(items, items[0].id, { status: 'waiting', error: undefined })
    assert.equal(pendingGenerationCount(items), 3, 'and a retry is one more paid generation')
  })
})

describe('download names', () => {
  test('the result is named after its source', () => {
    assert.equal(resultFileName('cane-chair.jpg', 'png'), 'cane-chair-studio.png')
    assert.equal(resultFileName('IMG_2201.JPEG', 'webp'), 'IMG_2201-studio.webp')
  })

  test('a hostile name cannot escape the downloads folder', () => {
    assert.equal(resultFileName('../../etc/passwd.jpg', 'png'), 'etc-passwd-studio.png')
    assert.equal(resultFileName('a/b\\c.jpg', 'jpg'), 'a-b-c-studio.jpg')
    assert.ok(!resultFileName('../x.jpg', 'png').includes('/'))
    assert.ok(!resultFileName('.hidden.jpg', 'png').startsWith('.'), 'no leading dot')
  })

  test('a name with nothing usable in it still produces a file name', () => {
    assert.equal(resultFileName('###.jpg', 'png'), 'product-studio.png')
    assert.equal(resultFileName('', 'png'), 'product-studio.png')
  })
})
