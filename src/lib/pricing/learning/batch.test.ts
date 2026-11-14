// Price learning, piece 1: a batch while it is checked. PiFile values are made from invented grids through the real
// reader, so these tests also pin how the reader's verdict becomes "learn" or "left out".

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { blockers, buildSaveDoc, countsOf, factsOf, initialReview, learned, testLinesOf, type ReviewPi, type SeenBefore } from './batch'
import type { PiFile } from './piFile'
import { contentPrint, judge, readPiGrids, type Cell } from './readPi'

const TODAY = new Date('2026-11-14T06:00:00Z')
const HEAD = ['Code', 'Name', 'Quantity', 'Dimension in inches & shape', 'Representative image', 'Material', 'Cost per piece (INR)', 'Total cost (INR)']
const hex = (c: string, n: number) => `${c.repeat(64 - String(n).length)}${n}`

async function file(n: number, rows: Cell[][], opts: { date?: Cell; head?: Cell[]; label?: string } = {}): Promise<PiFile> {
  const grid: Cell[][] = [...(opts.date ? [['', '', '', '', '', 'Date', opts.date]] : []), opts.head ?? HEAD, ...rows]
  const reading = readPiGrids([{ name: 'Master', grid }], TODAY)
  return { label: opts.label ?? `Client ${n} PI.xlsx`, fileHash: hex('a', n), contentPrint: await contentPrint(reading.lines), reading, savedDate: '2025-06-01', verdict: judge(reading, reading.piDate !== null), failure: null }
}
const BED: Cell[] = ['1', 'King bed with headboard', 56, '78 x 84 x 42', null, 'Teak wood', 54800, 3068800]
const TABLE: Cell[] = ['2', 'Bedside table, 2 drawers', 112, '20 x 16 x 22', null, 'Teak wood', 11400, 1276800]
const DESK: Cell[] = ['3', 'Writing desk', 56, '48 x 22 x 30', null, 'Teak wood', 19600, 1097600]
const CHAIR: Cell[] = ['4', 'Lounge chair', 56, '30 x 30 x 31', null, 'Mango', 12900, 722400]
const SAMPLE: Cell[] = ['5', 'Lounge chair, sample piece', 1, '30 x 30 x 31', null, 'Mango', 28000, 28000]
const SIX = (extra: Cell[][] = []): Cell[][] => [BED, TABLE, DESK, CHAIR, ['6', 'Luggage rack', 56, '36 x 22 x 18', null, 'Mango', 4300, 240800], ...extra]

describe('starting a review', () => {
  test('a readable PI is learned; its date comes from the file, or from the date the file was saved when it has none', async () => {
    const a = await file(1, SIX(), { date: 45700 })
    const b = await file(2, [BED, TABLE, DESK])
    const [pa, pb] = initialReview([a, b], [], null)
    assert.deepEqual([pa.learn, pa.date, pa.dateSource], [true, '2025-02-12', 'file'])
    assert.deepEqual([pb.learn, pb.date, pb.dateSource], [true, '2025-06-01', 'saved'])
    assert.equal(b.verdict.status, 'check', 'a missing date is shown as something to check')
  })

  test('a sample line starts unticked; a US-dollar file, a file that could not be read and a quantities-only list are left out with the reason', async () => {
    const withSample = await file(1, SIX([SAMPLE]), { date: 45700 })
    const usd = await file(2, [['1', 'Console', 10, '48 x 14 x 30', null, 'Mango', 220, 2200]], { head: HEAD.map(h => h.replace('INR', 'USD')) })
    const nothing = await file(3, [['1', 'Console', 10, '48 x 14 x 30', null, 'Mango', null, 0]])
    const [a, b, c] = initialReview([withSample, usd, nothing], [], null)
    assert.deepEqual(a.lines.map(l => l.keep), [true, true, true, true, true, false])
    assert.deepEqual([b.learn, c.learn], [false, false])
    assert.match(b.leftOutReason!, /US dollars/)
    assert.match(c.leftOutReason!, /no prices filled in/)
    assert.deepEqual(countsOf([a, b, c]), { files: 3, learn: 1, check: 0, leftOut: 2, seen: 0 })
  })

  test('a file or a set of lines seen in an earlier batch is not learned again, and says which batch', async () => {
    const a = await file(1, SIX(), { date: 45700 })
    const b = await file(2, SIX(), { date: 45700, label: 'The same lines under another name.xlsx' })
    const seen: SeenBefore[] = [{ file_hash: a.fileHash, content_print: 'x'.repeat(64), batch_no: 2, left_out: false, reason: null }, { file_hash: 'y'.repeat(64), content_print: b.contentPrint, batch_no: 3, left_out: true, reason: 'The prices are in US dollars' }]
    const [pa, pb] = initialReview([a, b], seen, null)
    assert.equal(pa.leftOutReason, 'Already learned in batch 2')
    assert.equal(pb.leftOutReason, 'Already seen and left out in batch 3: The prices are in US dollars')
    assert.deepEqual([pa.seen !== null, pb.seen !== null], [true, true])
  })

  test('the same file chosen twice in one batch is learned once', async () => {
    const a = await file(1, SIX(), { date: 45700 })
    const [first, second] = initialReview([a, { ...a }], [], null)
    assert.deepEqual([first.learn, second.learn, second.leftOutReason], [true, false, 'The same PI is in this batch twice'])
    assert.equal(buildSaveDoc([first, second], { avg_miss: null, hit_rate: null, priced: 0, unpriced: 0 }, null, null).pis.length, 1, 'the database keeps each file once, so the copy is dropped before saving')
  })

  test('two PIs of one project: only the later one is learned', async () => {
    const v1 = await file(1, SIX(), { date: '1/3/2025' })
    const v2 = await file(2, SIX([['7', 'Mirror', 56, '24 x 42', null, 'Mango', 6100, 341600]]), { date: '1/4/2025' })
    const other = await file(3, [['1', 'Bar stool', 30, '16 x 16 x 30', null, 'Metal', 4100, 123000], ['2', 'Dining table', 8, '72 x 36 x 30', null, 'Teak', 47800, 382400], ['3', 'Bench', 6, '48 x 16 x 18', null, 'Teak', 9000, 54000], ['4', 'Sofa', 4, '62 x 30 x 32', null, 'Teak', 38500, 154000], ['5', 'Console', 5, '48 x 14 x 30', null, 'Mango', 11000, 55000]], { date: 45700 })
    const [p1, p2, p3] = initialReview([v1, v2, other], [], null)
    assert.deepEqual([p1.learn, p2.learn, p3.learn], [false, true, true])
    assert.match(p1.leftOutReason!, /older version of the same project/)
  })
})

describe('checking, then saving', () => {
  const review = async (): Promise<ReviewPi[]> => initialReview([await file(1, SIX([SAMPLE]), { date: 45700 }), await file(2, [['1', 'Console', 10, '48 x 14 x 30', null, 'Mango', 220, 2200]], { head: HEAD.map(h => h.replace('INR', 'USD')) })], [], 'property_owner')

  test('order facts come from the ticked lines only', async () => {
    const [p] = await review()
    assert.deepEqual(factsOf(p), { pieces: 336, designs: 5, subtotal: 6406400, discount: null, valueBeforeGst: 6406400 })
    p.lines[0].keep = false
    assert.equal(factsOf(p).pieces, 280)
  })

  test('blockers: nothing ready, a date that is not a date, more than 25 files', async () => {
    const [p, usd] = await review()
    assert.deepEqual(blockers([p, usd]), [])
    assert.deepEqual(blockers([usd]), ['No PI is ready to learn.'])
    p.date = '12/02/2025'
    assert.deepEqual(blockers([p]), ['1 PI needs a date.'])
    p.lines.forEach(l => { l.keep = false })
    assert.equal(learned(p), false, 'a PI with no ticked line is not learned')
    assert.deepEqual(blockers(Array.from({ length: 26 }, () => usd)).includes('A batch holds 25 files at most.'), true)
  })

  test('the blind test prices the ticked lines of the PIs being learned, each with its PI date', async () => {
    const pis = await review()
    const lines = testLinesOf(pis)
    assert.equal(lines.length, 5, 'the sample line and the dollar PI are not tested')
    assert.deepEqual([lines[0].name, lines[0].price, lines[0].date, lines[0].clientType], ['King bed with headboard', 54800, '2025-02-12', 'property_owner'])
  })

  test('the saved document keeps a left-out PI with its lines and reason, a left-out line with its reason, and drops what cannot be saved', async () => {
    const [p, usd] = await review()
    const none = await file(9, [['1', 'Console', 10, '48 x 14 x 30', null, 'Mango', null, 0]])
    const doc = buildSaveDoc([p, usd, ...initialReview([none], [], null)], { avg_miss: 24.8, hit_rate: 31, priced: 4, unpriced: 1 }, 'property_owner', null)
    assert.equal(doc.pis.length, 2, 'a file with no lines at all is not saved')
    const [a, b] = doc.pis
    assert.deepEqual([a.left_out, a.pieces, a.value_before_gst, a.pi_date, a.date_source, a.label], [false, 336, 6406400, '2025-02-12', 'file', 'Client 1 PI.xlsx'])
    assert.deepEqual(a.lines.slice(-1)[0], { name: 'Lounge chair, sample piece', size: '30 x 30 x 31', material: 'Mango', customization: '', qty: 1, price: 28000, derived: false, left_out: true, left_out_reason: 'A sample price' })
    assert.deepEqual([b.left_out, b.lines.length], [true, 1])
    assert.match(b.left_out_reason!, /US dollars/)
    assert.deepEqual(doc.score, { avg_miss: 24.8, hit_rate: 31, priced: 4, unpriced: 1 })
    assert.match(a.file_hash, /^[0-9a-f]{64}$/)
  })
})
