import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { moveOf, positionChange, share, tally, tallyByGroup } from './moves'
import type { BriefCase } from './sixMonth'

type Row = BriefCase['quarters']['rows'][number]
// Five columns, like the real brief: a year ago, three quarters, and the newest stretch ("now" is the last two).
const row = (values: (number | null)[], shown: (number | null)[], group?: string): Row => ({ keyword: 'k', demand: '', values, shown, group })
const SHOWN = [100, 100, 100, 100, 100]

describe('what happened to one search', () => {
  test('a better position is up, a worse one is down, under 2 places is the same', () => {
    assert.deepEqual(moveOf(row([10, 9, 8, 7, 6], SHOWN)), { move: 'up', places: -4 })
    assert.deepEqual(moveOf(row([6, 7, 8, 9, 14.5], SHOWN)), { move: 'down', places: 8.5 })
    assert.equal(moveOf(row([6, 7, 8, 9, 7.9], SHOWN)).move, 'same')
    assert.equal(moveOf(row([6, 7, 8, 9, 8], SHOWN)).move, 'down', 'exactly 2 places is a move')
  })

  test('"now" is the newest firm reading of the last two columns, not an old quarter', () => {
    assert.equal(moveOf(row([5, 5, 5, 9, null], [100, 100, 100, 100, null])).places, 4, 'the Jul–Sep quarter counts when the newest has nothing')
    assert.equal(moveOf(row([5, 5, 5, 20, 12], [100, 100, 100, 100, 100])).places, 7, 'the newest column wins over the quarter before')
  })

  test('a search Google stopped showing is out of view, which is a fall, not a blank', () => {
    assert.deepEqual(moveOf(row([5, 6, 7, null, null], [100, 100, 100, null, null])), { move: 'out', places: null })
    assert.equal(moveOf(row([5, 6, 7, 30, 30], [100, 100, 100, 3, 19])).move, 'out', 'a position from under 20 showings is chance, not a reading')
  })

  test('a search that was not firm a year ago is new when it is firm now, otherwise too thin', () => {
    assert.equal(moveOf(row([30, null, null, 8, 9], [3, null, null, 40, 40])).move, 'new')
    assert.equal(moveOf(row([30, null, null, 8, 9], [3, null, null, 4, 5])).move, 'thin')
    assert.equal(moveOf(row([null, null, null, null, null], [null, null, null, null, null])).move, 'thin')
  })

  test('a row with no showings counts at all counts as firm, as the table always drew it', () => {
    assert.equal(moveOf(row([11, 21, 3.5], [])).places, -7.5)
    assert.equal(positionChange(row([5, null, 7], [20, null, 25])), 2)
    assert.equal(positionChange(row([30, 4, 50], [3, 30, 30])), null)
  })
})

describe('counting a whole set of searches', () => {
  const rows = [
    row([5, 5, 5, 5, 3], SHOWN, 'A'), // up 2
    row([5, 5, 5, 5, 5], SHOWN, 'A'), // same
    row([5, 5, 5, 5, 9], SHOWN, 'B'), // down 4
    row([5, 5, 5, 5, 15], SHOWN, 'B'), // down 10
    row([5, 5, 5, null, null], [100, 100, 100, null, null], 'B'), // out
    row([null, null, null, 4, 4], [null, null, null, 50, 50], 'C'), // new
    row([null, null, null, null, null], [null, null, null, null, null], 'C'), // thin
  ]

  test('every search lands in exactly one count, and the average fall uses only those that fell', () => {
    const t = tally(rows)
    assert.deepEqual([t.up, t.same, t.down, t.out, t.new, t.thin, t.total], [1, 1, 2, 1, 1, 1, 7])
    assert.equal(t.up + t.same + t.down + t.out + t.new + t.thin, t.total)
    assert.equal(t.avgDown, 7)
    assert.equal(t.avgUp, 2)
  })

  test('with nothing that fell there is no average to quote', () => {
    const t = tally([row([5, 5, 5, 5, 5], SHOWN)])
    assert.equal(t.avgDown, null)
    assert.equal(t.avgUp, null)
  })

  test('each category is counted on its own, in the order the categories first appear', () => {
    const groups = tallyByGroup(rows)
    assert.deepEqual(groups.map(g => g.group), ['A', 'B', 'C'])
    assert.deepEqual(groups.map(g => g.tally.total), [2, 3, 2])
    assert.equal(groups[1].tally.down, 2)
    assert.equal(groups.reduce((t, g) => t + g.tally.out, 0), tally(rows).out, 'the categories add up to the whole')
    assert.deepEqual(tallyByGroup([row([1, 2], [])]), [], 'rows with no category are left out')
  })

  test('a share is a whole percentage, and none of nothing is 0', () => {
    assert.equal(share(57, 134), 43)
    assert.equal(share(0, 0), 0)
  })
})
