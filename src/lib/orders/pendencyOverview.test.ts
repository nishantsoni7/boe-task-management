import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPendencyOverviews, pendencyCountLabel } from './pendencyOverview'
import { activityCategory } from './orderActivityCategory'
import { isMainActivityEvent } from './orderActivityImportance'
import { checkPendencyScreenshot, describePendencyError, pendencyEvidencePath } from './orderPendencies'

const A = '11111111-1111-1111-1111-111111111111'
const B = '22222222-2222-2222-2222-222222222222'
const C = '33333333-3333-3333-3333-333333333333'

test('the list says how many are pending, counting Fabric, Finish and the open pendencies', () => {
  const overviews = buildPendencyOverviews(
    [A],
    [{ order_id: A, approval_kind: 'fabric', status: 'fully_approved' }],
    [{ order_id: A, label: 'Sample approval' }, { order_id: A, label: 'Drawing sign-off' }],
  )
  assert.equal(pendencyCountLabel(overviews.get(A)?.pending.length ?? 0), '3 pending', 'Finish and the two open')
  assert.equal(pendencyCountLabel(1), '1 pending')
})

test('Approved only when Fabric and Finish are Fully Approved and nothing is open', () => {
  const out = buildPendencyOverviews(
    [A, B, C],
    [
      { order_id: A, approval_kind: 'fabric', status: 'fully_approved' },
      { order_id: A, approval_kind: 'finish', status: 'fully_approved' },
      { order_id: B, approval_kind: 'fabric', status: 'fully_approved' },
      { order_id: B, approval_kind: 'finish', status: 'partially_approved' },
    ],
    [{ order_id: A, label: 'Signed drawing' }],
  )
  assert.equal(out.get(A)?.approved, false, 'an open pendency blocks Approved')
  assert.deepEqual(out.get(A)?.pending.map(p => p.label), ['Signed drawing'])
  assert.deepEqual(out.get(B)?.pending.map(p => [p.label, p.detail]), [['Finish', 'Partially Approved']])
  // No events at all: both kinds are Not Approved.
  assert.deepEqual(out.get(C)?.pending.map(p => p.label), ['Fabric', 'Finish'])
  const clean = buildPendencyOverviews([A], [
    { order_id: A, approval_kind: 'fabric', status: 'fully_approved' },
    { order_id: A, approval_kind: 'finish', status: 'fully_approved' },
  ], [])
  assert.equal(clean.get(A)?.approved, true)
})

test('every approval is one category, apart from PI edits and payments', () => {
  const c = (eventType: string) => activityCategory({ source: 'order', label: '', eventType })
  assert.equal(c('order_approval_recorded'), 'approvals')
  assert.equal(c('order_pendency_approved'), 'approvals')
  assert.equal(c('order_pendency_added'), 'approvals')
  assert.equal(c('payment_verified'), 'payments')
  assert.equal(c('pi_revision_proposed'), 'pi_edits')
  assert.equal(c('status_changed'), 'other')
  assert.equal(activityCategory({ source: 'pi', label: 'Payment verified by Finance' }), 'payments')
  assert.equal(activityCategory({ source: 'pi', label: 'Revised PI uploaded' }), 'pi_edits')
})

test('an approval or reopen is main activity; adding or removing a pendency is minor', () => {
  const main = (eventType: string) => isMainActivityEvent({ source: 'order', label: '', eventType })
  assert.equal(main('order_pendency_approved'), true)
  assert.equal(main('order_pendency_reopened'), true)
  assert.equal(main('order_approval_recorded'), true)
  assert.equal(main('order_pendency_added'), false)
  assert.equal(main('order_pendency_removed'), false)
})

test('a pendency screenshot lives under its own folder and must be a usable image', () => {
  assert.equal(
    pendencyEvidencePath({ orderId: A, objectId: 'abc', fileName: 'Shot.PNG' }),
    `orders/${A}/pendency/abc.png`,
  )
  assert.equal(checkPendencyScreenshot(null)?.includes('required'), true)
  assert.equal(checkPendencyScreenshot({ size: 10, type: 'application/pdf' })?.includes('PNG'), true)
  assert.equal(checkPendencyScreenshot({ size: 6 * 1024 * 1024, type: 'image/png' })?.includes('5 MB'), true)
  assert.equal(checkPendencyScreenshot({ size: 1000, type: 'image/jpeg' }), null)
  assert.match(describePendencyError('ORDER_PENDENCY_EVIDENCE_REQUIRED: x'), /screenshot/)
})

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
const sql = readFileSync(join(process.cwd(), 'supabase/migrations/20270421000000_order_pendency_approvals.sql'), 'utf8')

test('migration 20270421000000: approving needs proof, clearing without it is closed, approvals reach Activity', () => {
  for (const fn of ['add_order_pendencies', 'approve_order_pendency', 'reopen_order_pendency', 'remove_order_pendency']) {
    const start = sql.indexOf(`create or replace function public.${fn}(`)
    assert.notEqual(start, -1, fn)
    const head = sql.slice(start, sql.indexOf('$$;', start))
    assert.match(head, /security definer/)
    assert.match(head, /set search_path = public, pg_temp/)
    assert.match(head, /can_manage_order_pendencies/)
    assert.match(head, /for update/, 'locks the Order')
    assert.match(head, /insert into public\.order_activity_log/, `${fn} writes Activity`)
  }
  assert.match(sql, /revoke execute on function public\.clear_order_pendency\(uuid\) from public, anon, authenticated/)
  assert.match(sql, /ORDER_PENDENCY_EVIDENCE_REQUIRED/)
  assert.match(sql, /after insert on public\.order_approval_events/)
  assert.match(sql, /security_invoker = true/)
  // A filed proof can never be deleted as an orphan.
  assert.match(sql, /p\.evidence_path = storage\.objects\.name/)
  assert.doesNotMatch(sql, /function public\.record_order_approval_event/)
})
