/**
 * The scoreboard on Add Lead: positions, the sentence about where I stand, the
 * short board, and the instant re-rank when a lead is saving.
 *
 * Run: npx tsx --test src/lib/exhibitionLeads/standings.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  boardRows, exhibitionDay, ordinal, rankRows, summarise, withMyDelta,
  type StandingRow, type Standings,
} from './standings'

const row = (name: string, total: number, today = 0, is_me = false): StandingRow => ({ name, total, today, rank: null, is_me })
const board = (rows: StandingRow[]): Standings => ({
  exhibition_id: 'x', today: '2026-10-09', is_final: false, participants: rows.length, rows: rankRows(rows),
})

describe('rankRows', () => {
  test('highest first, ties share a position, the next position skips', () => {
    const r = rankRows([row('Dev', 3), row('Asha', 7), row('Bala', 7), row('Chitra', 5)])
    assert.deepEqual(r.map(x => [x.name, x.rank]), [['Asha', 1], ['Bala', 1], ['Chitra', 3], ['Dev', 4]])
  })
  test('nobody with no leads has a position, so an all-zero board has no leader', () => {
    const r = rankRows([row('Asha', 0), row('Bala', 0)])
    assert.deepEqual(r.map(x => x.rank), [null, null])
    assert.deepEqual(summarise(board([row('Asha', 0), row('Bala', 0)])).leaders, [])
  })
  test('equal totals are ordered by name', () => {
    assert.deepEqual(rankRows([row('Zoya', 2), row('Anil', 2)]).map(x => x.name), ['Anil', 'Zoya'])
  })
})

describe('summarise: what to tell the person', () => {
  test('behind: how many to pass the person just ahead, not the leader', () => {
    const sum = summarise(board([row('Asha', 12), row('Bala', 8), row('Me', 5, 2, true)]))
    assert.equal(sum.me?.rank, 3)
    assert.equal(sum.gapToLeader, 7)
    assert.deepEqual(sum.next, { name: 'Bala', gap: 3 })
    assert.equal(sum.headline, '3 more to pass Bala')
  })
  test('leading: by how many', () => {
    const sum = summarise(board([row('Me', 9, 1, true), row('Asha', 6)]))
    assert.equal(sum.headline, 'Leading by 3')
    assert.equal(sum.gapToLeader, 0)
    assert.equal(sum.next, null)
  })
  test('joint first is said as such', () => {
    assert.equal(summarise(board([row('Me', 4, 0, true), row('Asha', 4)])).headline, 'Joint first')
  })
  test('alone on the board with leads and nobody to compare', () => {
    assert.equal(summarise(board([row('Me', 2, 0, true), row('Asha', 0)])).headline, 'You are leading')
  })
  test('no lead yet: an invitation, not a rank', () => {
    assert.equal(summarise(board([row('Me', 0, 0, true), row('Asha', 3)])).headline, 'Add a lead to join the board')
    assert.equal(summarise(board([row('Me', 0, 0, true), row('Asha', 0)])).headline, 'Be the first on the board')
  })
  test('top collector today, with ties', () => {
    const sum = summarise(board([row('Asha', 9, 3), row('Bala', 4, 3), row('Me', 1, 0, true)]))
    assert.deepEqual(sum.topToday, { names: ['Asha', 'Bala'], count: 3 })
    assert.equal(summarise(board([row('Me', 1, 0, true)])).topToday, null)
  })
  test('nothing loaded yet: nothing to say', () => {
    const sum = summarise(undefined)
    assert.equal(sum.me, null)
    assert.equal(sum.headline, '')
  })
})

describe('withMyDelta: the numbers move the moment Save is tapped', () => {
  test('adds to today and total, then re-ranks', () => {
    const before = board([row('Asha', 5, 1), row('Me', 4, 2, true)])
    const after = withMyDelta(before, 1)!
    const me = after.rows.find(r => r.is_me)!
    assert.equal(me.total, 5)
    assert.equal(me.today, 3)
    assert.equal(me.rank, 1, 'drew level with Asha: joint first')
    assert.equal(before.rows.find(r => r.is_me)!.total, 4, 'the input is not mutated')
  })
  test('a zero delta, no data, or no "me" row change nothing', () => {
    const b = board([row('Asha', 5), row('Me', 4, 0, true)])
    assert.equal(withMyDelta(b, 0), b)
    assert.equal(withMyDelta(undefined, 2), undefined)
    const other = board([row('Asha', 5)])
    assert.equal(withMyDelta(other, 2), other)
  })
  test('it never goes below zero', () => {
    const b = board([row('Me', 1, 1, true), row('Asha', 3)])
    assert.equal(withMyDelta(b, -5)!.rows.find(r => r.is_me)!.total, 0)
  })
})

describe('boardRows: the short board', () => {
  const many = rankRows(Array.from({ length: 9 }, (_, i) => row(`P${i}`, 20 - i, 0, i === 7)))
  test('top five, then me with a gap marker when I am further down', () => {
    const v = boardRows(many, 5, false)
    assert.equal(v.length, 6)
    assert.equal(v[5].is_me, true)
    assert.equal(v[5].gapBefore, true)
  })
  test('right after the top five there is no gap marker', () => {
    const rows = rankRows(Array.from({ length: 9 }, (_, i) => row(`P${i}`, 20 - i, 0, i === 5)))
    assert.equal(boardRows(rows, 5, false)[5].gapBefore, false)
  })
  test('inside the top five, just the top five; "all" shows everybody', () => {
    const rows = rankRows(Array.from({ length: 9 }, (_, i) => row(`P${i}`, 20 - i, 0, i === 1)))
    assert.equal(boardRows(rows, 5, false).length, 5)
    assert.equal(boardRows(rows, 5, true).length, 9)
  })
  test('a short board is shown whole', () => {
    assert.equal(boardRows(many.slice(0, 4), 5, false).length, 4)
  })
})

describe('small helpers', () => {
  test('ordinals', () => {
    assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal),
      ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '101st', '111th'])
  })
  test('day of the exhibition', () => {
    const e = { starts_on: '2026-10-09', ends_on: '2026-10-11' }
    assert.deepEqual(exhibitionDay(e, '2026-10-09'), { day: 1, of: 3 })
    assert.deepEqual(exhibitionDay(e, '2026-10-11'), { day: 3, of: 3 })
    assert.equal(exhibitionDay(e, '2026-10-08'), null)
    assert.equal(exhibitionDay(e, '2026-10-12'), null)
    assert.deepEqual(exhibitionDay({ starts_on: '2026-10-30', ends_on: '2026-11-02' }, '2026-11-01'), { day: 3, of: 4 }, 'across a month end')
  })
})
