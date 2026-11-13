// The monthly vote and the owner's rating: when they are open, and what may be sent (owner, 2026-11-12).

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { closesAt, lastDayOf, ratingWindow, validateRating, validateVotes, voteOpensOn, voteWindow } from './vote'

const at = (iso: string) => new Date(iso)
const ME = 'a', A = 'b', B = 'c', C = 'd'
const people = new Set([ME, A, B, C])

describe('when', () => {
  test('November: vote 28–30, closing 23:00 IST on the 30th; ratings from the 25th', () => {
    assert.equal(lastDayOf('2026-11-01'), '2026-11-30')
    assert.equal(lastDayOf('2027-02-01'), '2027-02-28')
    assert.equal(voteOpensOn('2026-11-01'), '2026-11-28')
    assert.equal(closesAt('2026-11-01'), '2026-11-30T17:30:00.000Z')
    assert.equal(voteWindow(at('2026-11-27T12:00:00+05:30')).open, false)
    assert.equal(voteWindow(at('2026-11-28T00:05:00+05:30')).open, true)
    assert.equal(voteWindow(at('2026-11-30T22:59:00+05:30')).open, true)
    const after = voteWindow(at('2026-11-30T23:00:00+05:30'))
    assert.deepEqual([after.open, after.closed], [false, true])
    assert.equal(ratingWindow(at('2026-11-24T20:00:00+05:30')).open, false)
    assert.equal(ratingWindow(at('2026-11-25T09:00:00+05:30')).open, true)
  })

  test('just after midnight IST on the 1st is the new month, not the old one', () => {
    const w = voteWindow(at('2026-12-01T00:10:00+05:30'))
    assert.equal(w.month, '2026-12-01')
    assert.equal(w.open, false)
  })
})

describe('what may be sent', () => {
  test('exactly three different colleagues, never yourself, all on the Scoreboard', () => {
    assert.equal(validateVotes({ nominees: [A, B] }, ME, people).ok, false)
    assert.equal(validateVotes({ nominees: [A, A, B] }, ME, people).ok, false)
    assert.equal(validateVotes({ nominees: [ME, A, B] }, ME, people).ok, false)
    assert.equal(validateVotes({ nominees: [A, B, 'stranger'] }, ME, people).ok, false)
    assert.deepEqual(validateVotes({ nominees: [A, B, C], notes: { [A]: ' Covered my calls ', [B]: 'x' } }, ME, people), {
      ok: true,
      value: [{ nominee_id: A, note: 'Covered my calls' }, { nominee_id: B, note: null }, { nominee_id: C, note: null }],
    })
  })

  test('a rating is 1 to 5 with a reason the person reads', () => {
    assert.equal(validateRating({ rating: 0, reason: 'Good month' }).ok, false)
    assert.equal(validateRating({ rating: 4.5, reason: 'Good month' }).ok, false)
    assert.equal(validateRating({ rating: 4, reason: '' }).ok, false)
    assert.deepEqual(validateRating({ rating: 4, reason: ' Great follow-ups ' }), { ok: true, value: { rating: 4, reason: 'Great follow-ups' } })
  })
})
