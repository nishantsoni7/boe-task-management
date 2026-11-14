// A PI Operations flagged, ON THE SCREENS OF WHO MUST ANSWER IT (owner, 2026-11-11): the approver's
// "Needs your decision" row, the strip on the other Orders dashboards, where each is placed, and that
// nothing is read under View As or drawn when nothing waits.
//
// Run with: npm run test:file -- src/lib/orders/flaggedPisScreens.test.tsx

import '@/lib/testing/cssModuleStub'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DecisionCard } from '@/components/orders/dashboard/DecisionQueue'
import { FlaggedPiStrip, FlaggedPiStripView } from '@/components/orders/dashboard/FlaggedPiStrip'
import { flaggedRow, reviewRow, sortDecisionRows } from './adminDashboard'
import { readFlaggedPis } from './flaggedPis'

const ROOT = join(__dirname, '..', '..', '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8').replace(/\r/g, '')
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el)

const NOW = Date.parse('2026-11-11T08:00:00Z')
const DAY = 86400

const flaggedApi = (over: Record<string, unknown> = {}) => ({
  handoff_id: 'h-546', order_id: 'o-546', order_number: '0546', client_name: 'Qavaali', version_number: 1,
  reason: 'As per mohit... client wanted a visit from our side before aligning the order as he has these pieces in Delhi',
  by_name: 'Nitish Bansal', since: '2026-11-08T08:00:00Z', waiting_seconds: 3 * DAY, ...over,
})
const flagged = (over: Record<string, unknown> = {}) => readFlaggedPis([flaggedApi(over)])[0]

describe('the approver\'s "Needs your decision"', () => {
  const ready = (rows: ReturnType<typeof flaggedRow>[], extra: { flaggedFailed?: boolean } = {}) =>
    html(createElement(DecisionCard, { state: { kind: 'ready', rows: sortDecisionRows(rows, NOW), ...extra } }))

  test('a flagged PI is a row: client, Order and version, who flagged it, how long, what Operations said, a link to the Order', () => {
    const out = ready([flaggedRow(flagged())])
    assert.match(out, /Qavaali/)
    assert.match(out, /Order 546 · PI V1 · from Nitish Bansal/)
    assert.match(out, /3 d 0 h/)
    assert.match(out, /Since 8 Nov/)
    assert.match(out, /Operations cannot accept PI V1/)
    assert.match(out, /client wanted a visit from our side/)
    assert.match(out, /href="\/orders\/o-546\?returnTo=%2Forders"/)
    assert.match(out, /ageDanger/, 'three days is red, with an icon')
    assert.match(out, />—<\/span>/, 'no value is shown')
  })

  test('beside other decisions it is tagged, and the longest wait leads', () => {
    const review = { id: 's1', client_name: 'Client 1', bill_to_name: null, draft_reference: 'PID-00001', subtotal_after_discount: '1000', submitted_by: null, submitted_at: '2026-11-11T06:00:00Z' }
    const out = ready([reviewRow(review, null, null), flaggedRow(flagged())])
    assert.match(out, /Flagged by Operations<\/span>/)
    assert.match(out, /PI review<\/span>/)
    assert.ok(out.indexOf('Qavaali') < out.indexOf('Client 1'), 'the PI flagged three days ago is above the one submitted two hours ago')
  })

  test('a flagged-PI read that failed is said, and an empty list is then NOT "nothing is waiting"', () => {
    const empty = ready([], { flaggedFailed: true })
    assert.match(empty, /role="alert"[^>]*>PIs flagged by Operations could not be loaded/)
    assert.equal(/Nothing is waiting/.test(empty), false)
    const withRows = ready([flaggedRow(flagged())], { flaggedFailed: true })
    assert.match(withRows, /could not be loaded/)
    assert.match(withRows, /Qavaali/, 'the rows that were read are still drawn')
    assert.match(ready([]), /Nothing is waiting for your decision/)
  })
})

describe('the strip on the other Orders dashboards', () => {
  test('draws nothing while loading and nothing when none waits', () => {
    assert.equal(html(createElement(FlaggedPiStripView, { state: { kind: 'loading' } })), '')
    assert.equal(html(createElement(FlaggedPiStripView, { state: { kind: 'ready', rows: [] } })), '')
  })

  test('one line per PI: Order, client, who flagged it, the wait, the reason, and a button to the Order', () => {
    const out = html(createElement(FlaggedPiStripView, { state: { kind: 'ready', rows: [flagged()] } }))
    assert.match(out, /Operations flagged 1 PI</)
    assert.match(out, /reply to the approver/)
    assert.match(out, />546</)
    assert.match(out, /Qavaali/)
    assert.match(out, /Flagged by Nitish Bansal/)
    assert.match(out, /PI V1/)
    assert.match(out, /Waiting 3 days/)
    assert.match(out, /data-tone="alert"/, 'red from the third day, like a PI returned to Sales')
    assert.match(out, /client wanted a visit from our side/)
    assert.match(out, /href="\/orders\/o-546\?returnTo=%2Forders"/)
    assert.match(out, />Respond</)
  })

  test('a fresh flag is amber, and several are counted', () => {
    const out = html(createElement(FlaggedPiStripView, {
      state: { kind: 'ready', rows: [flagged({ waiting_seconds: 3600 * 5 }), flagged({ handoff_id: 'h-2', order_id: 'o-2' })] },
    }))
    assert.match(out, /Operations flagged 2 PIs</)
    assert.match(out, /data-tone="warn"/)
    assert.match(out, /Waiting 5 h/)
  })

  test('a failed read is said in a line, never read as "nothing waits"', () => {
    const out = html(createElement(FlaggedPiStripView, { state: { kind: 'failed' } }))
    assert.match(out, /role="alert"/)
    assert.match(out, /could not be loaded, so one waiting for you may be missing/)
  })

  test('under View As nothing is drawn and nothing is read', () => {
    const calls: string[] = []
    const supabase = { rpc: (fn: string) => { calls.push(fn); return Promise.resolve({ data: [], error: null }) } }
    const out = html(createElement(FlaggedPiStrip, { supabase: supabase as never, viewingAs: true, reloadKey: 0 }))
    assert.equal(out, '')
    assert.deepEqual(calls, [])
  })
})

describe('where each screen reads it, and where it is placed', () => {
  const page = read('src/app/orders/page.tsx')
  const decision = read('src/components/orders/dashboard/DecisionQueue.tsx')
  const forYou = read('src/hooks/queries/useForYouWork.ts')

  test('the Orders page places the strip for a salesperson, and for everybody who is not the approver, and never twice', () => {
    assert.equal((page.match(/<FlaggedPiStrip/g) ?? []).length, 2)
    const personal = page.slice(page.indexOf('personalView ? ('), page.indexOf(') : operationsView ? ('))
    assert.match(personal, /<FlaggedPiStrip/)
    assert.match(page, /summary\.kind === 'ready' && !approverView \? \(\s*<FlaggedPiStrip/)
    assert.match(page, /reloadKey=\{reloadTick\}/)
    assert.match(page, /setReloadTick\(t => t \+ 1\)/)
  })

  test('the page itself reads nothing more: the dashboard\'s first burst is still the three dashboard reads', () => {
    assert.equal(/my_flagged_pis/.test(page), false)
  })

  test('the approver\'s list reads the same database definition, beside its three reads, under the reader\'s own rights', () => {
    assert.match(decision, /loadFlaggedPis\(/)
    assert.match(decision, /flaggedRow/)
    assert.equal(/service/.test(decision), false)
  })

  test('the launcher reads it only while the item is on for this person, never under View As', () => {
    assert.match(forYou, /useWorkRead<FlaggedPi>\('pi_flagged_by_operations', userId, wanted\('pi_flagged_by_operations'\)/)
    assert.match(forYou, /\.rpc\('my_flagged_pis'\)/)
    assert.match(forYou, /!viewMode/)
  })
})
