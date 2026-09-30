/**
 * Run: npx tsx --test src/lib/customerReviews/leaderboardLanding.test.ts
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { arrangeLanding, LANDING_LIST_ROWS } from './leaderboardLanding'
import { submitAvailability } from './submitAvailability'
import type { Leaderboard, LeaderboardRow } from './reviewReport'

const row = (n: string, rank: number, reviews: number, is_me = false): LeaderboardRow => ({
  rank, employee_id: n, name: n, reviews, credits: reviews * 5, points: reviews / 2, is_me, tied: false,
})
const board = (rows: LeaderboardRow[]): Leaderboard => ({
  month: '2026-09-01', current_month: '2026-09-01', leader_reviews: rows[0]?.reviews ?? 0, leaders: 1,
  state: 'behind', need: null, me: null, participants: rows.length, rows,
})
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n')

describe('arrangeLanding', () => {
  test('empty when nobody has an eligible review', () => {
    assert.equal(arrangeLanding(board([])).kind, 'empty')
    assert.equal(arrangeLanding(board([row('a', 1, 0), row('b', 1, 0)])).kind, 'empty')
  })
  test('sole leader with a runner-up', () => {
    const r = arrangeLanding(board([row('a', 1, 5), row('b', 2, 3), row('c', 3, 1)]))
    assert.equal(r.kind, 'ranked')
    if (r.kind !== 'ranked') return
    assert.deepEqual(r.leaders.map(x => x.name), ['a'])
    assert.equal(r.joint, false)
    assert.deepEqual(r.runnersUp.map(x => x.name), ['b'])
  })
  test('joint leaders are shown together and there is no runner-up', () => {
    const r = arrangeLanding(board([row('a', 1, 4), row('b', 1, 4), row('c', 3, 2)]))
    if (r.kind !== 'ranked') throw new Error('expected ranked')
    assert.deepEqual(r.leaders.map(x => x.name), ['a', 'b'])
    assert.equal(r.joint, true)
    assert.deepEqual(r.runnersUp, [])
  })
  test('tied runners-up are shown together', () => {
    const r = arrangeLanding(board([row('a', 1, 6), row('b', 2, 3), row('c', 2, 3)]))
    if (r.kind !== 'ranked') throw new Error('expected ranked')
    assert.deepEqual(r.runnersUp.map(x => x.name), ['b', 'c'])
  })
  test('a lone participant has no runner-up', () => {
    const r = arrangeLanding(board([row('a', 1, 2), row('z', 2, 0)]))
    if (r.kind !== 'ranked') throw new Error('expected ranked')
    assert.deepEqual(r.runnersUp, [])
  })
  test('the viewer is appended when outside the top rows, not duplicated inside', () => {
    const many = Array.from({ length: 8 }, (_, i) => row(`p${i}`, i + 1, 9 - i))
    const outside = arrangeLanding(board(many.map((x, i) => (i === 7 ? { ...x, is_me: true } : x))))
    if (outside.kind !== 'ranked') throw new Error('expected ranked')
    assert.equal(outside.meOutside, true)
    assert.equal(outside.list.length, LANDING_LIST_ROWS + 1)
    const inside = arrangeLanding(board(many.map((x, i) => (i === 2 ? { ...x, is_me: true } : x))))
    if (inside.kind !== 'ranked') throw new Error('expected ranked')
    assert.equal(inside.meOutside, false)
    assert.equal(inside.list.length, LANDING_LIST_ROWS)
  })
})

describe('zero-count viewer', () => {
  test('appears once, highlighted, below the list, with the database rank', () => {
    const r = arrangeLanding(board([row('a', 1, 5), row('b', 2, 3), row('me', 3, 0, true), row('z', 3, 0)]))
    if (r.kind !== 'ranked') throw new Error('expected ranked')
    assert.deepEqual(r.list.map(x => x.name), ['a', 'b', 'me'])
    assert.equal(r.list.filter(x => x.is_me).length, 1)
    assert.equal(r.list[2].rank, 3)
    assert.equal(r.meOutside, true)
  })
  test('all-zero board is still the empty state, even for a participant', () => {
    assert.equal(arrangeLanding(board([row('me', 1, 0, true), row('z', 1, 0)])).kind, 'empty')
  })
  test('a viewer with reviews inside the top rows is not repeated', () => {
    const r = arrangeLanding(board([row('a', 1, 5), row('me', 2, 3, true)]))
    if (r.kind !== 'ranked') throw new Error('expected ranked')
    assert.equal(r.list.filter(x => x.is_me).length, 1)
    assert.equal(r.meOutside, false)
  })
})

describe('submit availability (shared by both entry points)', () => {
  test('loading, failed, limit and ready', () => {
    assert.equal(submitAvailability({ loaded: false, loadError: null, canSubmitAny: true, limitMessage: null }).status, 'loading')
    const failed = submitAvailability({ loaded: true, loadError: 'load failed', canSubmitAny: true, limitMessage: null })
    assert.deepEqual([failed.status, failed.reason], ['error', 'load failed'])
    const limit = submitAvailability({ loaded: true, loadError: null, canSubmitAny: false, limitMessage: 'Monthly limit reached' })
    assert.deepEqual([limit.status, limit.reason], ['limit', 'Monthly limit reached'])
    assert.equal(submitAvailability({ loaded: true, loadError: null, canSubmitAny: true, limitMessage: null }).status, 'ready')
  })
  test('the header and the section use one availability and one open action, with no DOM forwarding', () => {
    const screen = read('src/app/customer-reviews/CustomReviewsScreen.tsx')
    const control = read('src/components/customerReviews/CustomReviewSubmitControl.tsx')
    const section = read('src/components/customerReviews/CustomReviewSubmissions.tsx')
    const all = screen + control + section
    assert.equal(all.includes('getElementById') || all.includes('.click' + '()'), false)
    assert.ok(section.includes("disabled={availability.status !== 'ready'}") && section.includes('onClick={openNew}'))
    assert.ok(control.includes("disabled={!ready}") && control.includes('onClick={open}'))
    assert.ok(section.includes('usePublishSubmitControl(availability, openNew)'))
  })
  test('every change refreshes the mounted leaderboards through the existing keys', () => {
    const section = read('src/components/customerReviews/CustomReviewSubmissions.tsx')
    assert.ok(section.includes('invalidateQueries({ queryKey: REVIEW_LEADERBOARD_KEY })'))
    assert.ok(section.includes('invalidateQueries({ queryKey: REVIEW_LEADER_CARD_KEY })'))
    assert.ok(read('src/components/customerReviews/ReviewsLeaderboardPanel.tsx').includes('[...REVIEW_LEADERBOARD_KEY, null]'))
  })
})

describe('custom-only Reviews module', () => {
  const retired = ['batches', 'images', 'progress', 'mine', 'reviews', '[id]']
  for (const p of retired) {
    test(`/customer-reviews/${p} redirects to the landing page`, () => {
      const src = read(`src/app/customer-reviews/${p}/page.tsx`)
      assert.match(src, /redirect\('\/customer-reviews'\)/)
      assert.doesNotMatch(src, /Screen/)
    })
  }
  test('the sidebar offers no legacy destination', () => {
    const src = read('src/components/layout/CustomerReviewsLayout.tsx')
    for (const gone of ["path: '/customer-reviews/reviews'", "path: '/customer-reviews/batches'", "path: '/customer-reviews/images'", "path: '/customer-reviews/progress'"]) {
      assert.ok(!src.includes(gone), gone)
    }
    assert.ok(src.includes("path: '/customer-reviews/custom'"))
    assert.ok(src.includes("path: '/customer-reviews/reports'"))
  })
  test('the landing page renders the custom screen for everyone, with one leaderboard read', () => {
    const page = read('src/app/customer-reviews/page.tsx')
    assert.ok(!/OverviewScreen|MyReviewsScreen/.test(page))
    const panel = read('src/components/customerReviews/ReviewsLeaderboardPanel.tsx')
    assert.equal((panel.match(/\.rpc\(/g) ?? []).length, 1)
    assert.ok(panel.includes("'customer_review_leaderboard'"))
    assert.ok(!/credits\s*\*\s*10|points\s*\*\s*10/.test(panel))
  })
})
