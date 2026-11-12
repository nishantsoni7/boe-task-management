// The approver's comment on the card of the person a flagged PI was sent back to (owner, 2026-11-12, Order 547:
// three notices to the salesperson, none opened). The card already lists the flagged PIs the salesperson must
// answer; it now also says "<approver> sent it back to you: “comment”", read from the Order history.
//
// Run with: npm run test:file -- src/lib/orders/flaggedPisSentBack.test.tsx

import '@/lib/testing/cssModuleStub'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { FlaggedPiStripView } from '@/components/orders/dashboard/FlaggedPiStrip'
import {
  COMMENT_CLIP,
  commentLine,
  loadSentBackComments,
  readFlaggedPis,
  readSentBackComments,
  sentBackBy,
} from './flaggedPis'

const ROOT = join(__dirname, '..', '..', '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8').replace(/\r/g, '')

const flagged = readFlaggedPis([{
  handoff_id: 'h-547', order_id: 'o-547', order_number: '0547', client_name: 'Suresh Ji', version_number: 1,
  reason: '1 line cannot be made as quoted: price too low.', by_name: 'Nitish Bansal', since: '2026-11-12T11:19:00Z', waiting_seconds: 3600,
}])

const row = (handoff: string, comment: unknown, at: string, who: string | null = 'Nishant Soni') => ({
  order_id: 'o-547', created_at: at, payload: { handoff_id: handoff, comment }, actor: who === null ? null : { full_name: who },
})

describe('reading the comments from the history', () => {
  test('the newest comment per flagged handoff wins, whatever order the rows come in', () => {
    const got = readSentBackComments([
      row('h-547', 'older', '2026-11-12T12:00:00Z'),
      row('h-547', 'Check the details and resubmit.', '2026-11-12T12:34:32Z'),
      row('h-547', 'middle', '2026-11-12T12:30:00Z'),
    ], flagged)
    assert.deepEqual(got, { 'h-547': { by: 'Nishant Soni', atIso: '2026-11-12T12:34:32Z', text: 'Check the details and resubmit.' } })
  })

  test('a comment about another handoff (an older PI version), a blank one and an unreadable one are ignored', () => {
    const got = readSentBackComments([
      row('h-OTHER', 'about V0', '2026-11-12T12:00:00Z'),
      row('h-547', '   ', '2026-11-12T12:01:00Z'),
      row('h-547', 42, '2026-11-12T12:02:00Z'),
      row('h-547', 'fine', 'not a date'),
      null, 'text', { payload: null },
    ], flagged)
    assert.deepEqual(got, {})
  })

  test('a sender no longer on record still reads, as "The approver"', () => {
    const got = readSentBackComments([row('h-547', 'Please revise.', '2026-11-12T12:00:00Z', null)], flagged)
    assert.equal(got['h-547'].by, null)
    assert.equal(sentBackBy(got['h-547']), 'The approver sent it back to you')
    assert.equal(sentBackBy({ by: 'Nishant Soni' }), 'Nishant Soni sent it back to you')
  })

  test('a failed read, a thrown read and an answer that is not a list all draw nothing extra; no rows means no read at all', async () => {
    assert.deepEqual(await loadSentBackComments(async () => ({ data: null, error: { message: 'boom' } }), flagged), {})
    assert.deepEqual(await loadSentBackComments(async () => { throw new Error('network') }, flagged), {})
    assert.deepEqual(await loadSentBackComments(async () => ({ data: { not: 'a list' }, error: null }), flagged), {})
    let calls = 0
    assert.deepEqual(await loadSentBackComments(async () => { calls += 1; return { data: [], error: null } }, []), {})
    assert.equal(calls, 0)
  })

  test('the read names each Order once', async () => {
    const two = readFlaggedPis([
      { handoff_id: 'h1', order_id: 'o1', version_number: 1, waiting_seconds: 1 },
      { handoff_id: 'h2', order_id: 'o1', version_number: 2, waiting_seconds: 1 },
      { handoff_id: 'h3', order_id: 'o3', version_number: 1, waiting_seconds: 1 },
    ])
    let asked: string[] = []
    await loadSentBackComments(async ids => { asked = ids; return { data: [], error: null } }, two)
    assert.deepEqual(asked, ['o1', 'o3'])
  })

  test('the card clips a long comment to one line; the Order page carries all of it', () => {
    assert.equal(commentLine('  Revise\n\n the   price.  '), 'Revise the price.')
    const long = commentLine('word '.repeat(100))
    assert.equal(long.length, COMMENT_CLIP)
    assert.ok(long.endsWith('…'))
  })
})

describe('the card', () => {
  const card = (sent?: Record<string, { by: string | null; atIso: string; text: string }>) =>
    renderToStaticMarkup(createElement(FlaggedPiStripView, { state: { kind: 'ready', rows: flagged, ...(sent ? { sent } : {}) } }))

  test('draws the approver\'s comment on the PI it is about, beside Operations\' reason', () => {
    const out = card({ 'h-547': { by: 'Nishant Soni', atIso: '2026-11-12T12:34:32Z', text: 'Check the details which needs to be modified and resubmit with modifications.' } })
    assert.match(out, /data-sent-back="true"/)
    assert.match(out, /Nishant Soni sent it back to you: “Check the details which needs to be modified and resubmit with modifications\.”/)
    assert.match(out, /price too low/, 'Operations\' reason is still there')
    assert.match(out, /Flagged by Nitish Bansal/)
  })

  test('is exactly as it was when there is no comment', () => {
    assert.doesNotMatch(card(), /data-sent-back|sent it back to you/)
    assert.doesNotMatch(card({}), /data-sent-back|sent it back to you/)
  })

  test('a comment for a PI that is not on the card is not drawn', () => {
    assert.doesNotMatch(card({ 'h-other': { by: 'Someone', atIso: '2026-11-12T12:34:32Z', text: 'x' } }), /sent it back to you/)
  })
})

describe('the strip that loads it', () => {
  const src = read('src/components/orders/dashboard/FlaggedPiStrip.tsx')

  test('reads the history only for the PIs it already lists, and never lets it change or fail the list', () => {
    assert.match(src, /\.from\('order_activity_log'\)[\s\S]*?\.eq\('event_type', 'operations_handoff_sent_to_sales'\)[\s\S]*?\.in\('order_id', ids\)/)
    assert.match(src, /if \(!rows \|\| rows\.length === 0\) return/)
    // The list is drawn first; the comment only ever adds `sent` to the same rows.
    assert.ok(src.indexOf("setState(rows ? { kind: 'ready', rows } : { kind: 'failed' })") < src.indexOf('await loadSentBackComments('))
    assert.match(src, /setState\(\{ kind: 'ready', rows, sent \}\)/)
  })
})
