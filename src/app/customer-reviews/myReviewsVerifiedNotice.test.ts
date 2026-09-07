/**
 * A candidate cannot be redirected to by someone else's action. Verification
 * happens when a verifier presses a button on THEIR OWN screen — the
 * `?verified=<credits>` query-param notice that produces only ever reaches
 * that verifier's own browser, never the candidate whose review it was. This
 * file pins the separate, time-windowed notice that actually reaches the
 * candidate, and the fallback order between the two.
 *
 * Run:
 *   npx tsx --test src/app/customer-reviews/myReviewsVerifiedNotice.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { recentlyVerifiedNotice, verifiedNotice } from './MyReviewsScreen'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const SCREEN = read('src/app/customer-reviews/MyReviewsScreen.tsx')

describe('recentlyVerifiedNotice — the notice a candidate can actually receive', () => {
  test('nothing recently verified is nothing said', () => {
    assert.equal(recentlyVerifiedNotice([]), null)
  })

  test('one verified review names it and points to My Credits, without a number', () => {
    const line = recentlyVerifiedNotice([{ card_ref: 'BOE-0042' }])
    assert.ok(line?.includes('BOE-0042'))
    assert.ok(line?.toLowerCase().includes('my credits'))
    // No credit figure is guessed here — that number belongs to the ledger.
    assert.equal(/\d+\s*(credit|point)/i.test(line ?? ''), false)
  })

  test('more than one is a count, not a list of every card_ref', () => {
    const line = recentlyVerifiedNotice([{ card_ref: 'BOE-0042' }, { card_ref: 'BOE-0043' }])
    assert.ok(line?.includes('2'))
    assert.equal(line?.includes('BOE-0042'), false)
  })
})

describe('the query-param notice still exists for whoever it does reach', () => {
  test('null flag is no notice; a numeric flag names the amount', () => {
    assert.equal(verifiedNotice(null), null)
    assert.ok(verifiedNotice('50')?.includes('50'))
  })
})

describe('the screen actually queries and shows the recently-verified notice', () => {
  test('a supplementary query reads THIS candidate\'s own verified rows, time-windowed', () => {
    assert.ok(SCREEN.includes("eq('booked_by', profile.id)"))
    assert.ok(SCREEN.includes("eq('status', 'verified')"))
    assert.ok(SCREEN.includes("gte('verified_at', since)"))
  })

  test('the two notice sources are combined, query-param taking priority', () => {
    assert.match(
      SCREEN,
      /verifiedNotice\(searchParams\.get\('verified'\)\)\s*\?\?\s*recentlyVerifiedNotice\(recentlyVerified\)/,
    )
  })

  test('the recently-verified query does not widen MINE_STATUSES to include verified rows', () => {
    // The two queries stay separate: the main list still never asks for
    // verified cards (see customerReviewOutreach.test.ts for the exhaustive
    // version of this check) — this just pins that the new query is its own
    // read, not a change to the existing one.
    assert.ok(SCREEN.includes("const MINE_STATUSES = ['available', 'booked', 'submitted'] as const"))
  })
})
