/**
 * A HELD ORDER, AS THE SUMMARY AND THE BREAKDOWN SAY IT (walkthrough of #209,
 * 2026-09-25: W1, W2, W3 and the two "Order value" figures).
 *
 *   W1  after a re-alignment or an administrator's recovery, the alignment line
 *       names who put the Order back and when, beside the acceptance;
 *   W2  a held Order's summary row carries the reason it is not aligned;
 *   W3  a held Order that is ready again says so on the strip, amber;
 *   O-1 an amended Order's breakdown names the PI's total and the Order's own
 *       value apart instead of captioning both "Order value".
 *
 * Run:
 *   npx tsx --test src/lib/orders/heldOrderSummary.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  describeOperationsHandoff,
  latestRealignment,
  type PersistedOperationsHandoff,
} from './operationsHandoff'
import { orderAttentionItems, orderSummaryView, type OrderRecordFact } from './orderWorkspace'
import { advanceAttentionLabel, advanceRealignLabel, type AdvanceReadiness } from './advanceReadiness'
import { ORDER_VALUE_AMENDED_NOTE, ORDER_VALUE_LABEL, PI_VALUE_LABEL, orderCommercialLines } from './orderCommercial'
import type { PiAmountRow } from '@/lib/pi/previewView'

const A = 'aaaaaaaa-0000-0000-0000-00000000000a'
const B = 'bbbbbbbb-0000-0000-0000-00000000000b'
const NAMES = new Map([[A, 'Suite Factory'], [B, 'Suite Ops']])
const when = (iso: string | null) => (iso ? iso.slice(11, 16) : '—')

const accepted: PersistedOperationsHandoff = {
  id: 'h1', order_id: 'o1', pi_version_id: 'v1', submission_id: 's1', version_number: 1,
  approved_by: A, approved_at: '2026-09-25T09:56:00Z',
  assigned_to: A, assigned_at: '2026-09-25T09:56:00Z', unassigned_reason: null,
  production_alignment_at_approval: 'not_aligned', prior_handoff_status: null,
  status: 'accepted',
  accepted_by: A, accepted_at: '2026-09-25T09:57:00Z', accepted_note: null,
  acceptance_withdrawn_by: null, acceptance_withdrawn_at: null, acceptance_withdrawn_reason: null,
  clarification_by: null, clarification_at: null, clarification_reason: null,
  superseded_at: null, superseded_by_version_id: null, created_at: '2026-09-25T09:56:00Z',
} as PersistedOperationsHandoff

const view = (over: Partial<Parameters<typeof describeOperationsHandoff>[0]>) => {
  const v = describeOperationsHandoff({
    live: accepted, hasSourcePi: true, namesById: NAMES, formatWhen: when,
    viewerId: null, viewingAs: false, orderStatus: 'running',
    productionAligned: true, productionAlignedAt: null, ...over,
  })
  if (v.kind !== 'recorded') throw new Error('expected a recorded handoff')
  return v
}

describe('W1: who put a held Order back into production', () => {
  test('never re-aligned: the acceptance is the whole story', () => {
    assert.equal(view({}).alignment.line, 'Accepted by Suite Factory · 09:57')
  })
  test('re-aligned by the current reviewer: named first, the acceptance kept beside it', () => {
    const realignment = latestRealignment([
      { event_type: 'operations_handoff_accepted', actor_name: 'Suite Factory', created_at: '2026-09-25T09:57:00Z', payload: { version_id: 'v1' } },
      { event_type: 'operations_handoff_realigned', actor_name: 'Suite Ops', created_at: '2026-09-25T10:03:00Z', payload: { version_id: 'v1' } },
    ], 'v1')
    assert.equal(view({ realignment }).alignment.line, 'Aligned again by Suite Ops · 10:03 · PI V1 accepted by Suite Factory · 09:57')
  })
  test('recovered by an administrator: said as a recovery', () => {
    const realignment = latestRealignment([
      { event_type: 'operations_handoff_realigned', actor_name: 'Suite Ops', created_at: '2026-09-25T10:03:00Z', payload: { version_id: 'v1' } },
      { event_type: 'operations_handoff_realigned_by_admin', actor_name: 'Preview Admin', created_at: '2026-09-25T10:06:00Z', payload: { version_id: 'v1' } },
    ], 'v1')
    assert.equal(view({ realignment }).alignment.line, 'Recovered by Preview Admin · 10:06 · PI V1 accepted by Suite Factory · 09:57')
  })
  test('a re-alignment of an earlier version, or one older than the acceptance, is not claimed', () => {
    assert.equal(latestRealignment([
      { event_type: 'operations_handoff_realigned', actor_name: 'Suite Ops', created_at: '2026-09-25T10:03:00Z', payload: { version_id: 'v0' } },
    ], 'v1'), null)
    const stale = { kind: 'operations' as const, byName: 'Suite Ops', at: '2026-09-25T09:00:00Z' }
    assert.equal(view({ realignment: stale }).alignment.line, 'Accepted by Suite Factory · 09:57')
  })
})

const facts = (detail: string | null): OrderRecordFact[] => [
  { key: 'production', label: 'Production', value: 'Not Aligned', detail, tone: 'amber' },
] as OrderRecordFact[]

describe('W2: a held Order says why it is not aligned', () => {
  const held = view({ productionAligned: false }).alignment
  test('the alignment says it is held, and why', () => {
    assert.equal(held.held, true)
    assert.equal(held.line, 'PI V1 accepted; production on hold — advance below 40%')
  })
  test('the summary draws that line for a held Order…', () => {
    const s = orderSummaryView({ fields: [], facts: facts(held.line), clientContact: null, productionAligned: false, productionHeld: true })
    assert.equal(s.sales.production.line, 'PI V1 accepted; production on hold — advance below 40%')
  })
  test('…and still draws nothing for any other unaligned Order', () => {
    const s = orderSummaryView({ fields: [], facts: facts('Awaiting operations acceptance of PI V1'), clientContact: null, productionAligned: false })
    assert.equal(s.sales.production.line, null)
  })
})

const base: AdvanceReadiness = {
  order_value: '420000', verified: '168000', awaiting: '0', required: '168000', shortfall: '0',
  percent: '40', threshold_percent: '40', below: false, ready: true, exception: null,
}
const hold = { id: 'h', cause: 'value_changed', held_at: null, order_value: '420000', previous_order_value: '350000', verified: '140000', percent: '33.33', shortfall: '28000' }

describe('W3: a held Order that is ready again says so', () => {
  test('ready and still held: an amber line, and no blocking label', () => {
    const r = { ...base, hold }
    assert.equal(advanceAttentionLabel(r), null, 'nothing blocks it — the button stays enabled')
    assert.equal(advanceRealignLabel(r), 'Production on hold — the advance is covered again; align production again')
    const items = orderAttentionItems({
      status: 'running', productionAligned: false, hasSalesperson: true, hasDueDate: true, hasLeadSource: true,
      isOverdue: false, awaitingVerificationCount: 0, pendingChangeRequests: 0, pendingPiRevision: false,
      documentsFailed: false, documentsOutdated: false,
      advanceBelowLabel: advanceAttentionLabel(r), advanceRealignLabel: advanceRealignLabel(r),
    })
    assert.deepEqual(items.find(i => i.key === 'advance_realign'), { key: 'advance_realign', label: advanceRealignLabel(r), tone: 'amber' })
  })
  test('still short: the red blocking line only', () => {
    const r = { ...base, below: true, ready: false, shortfall: '28000', hold }
    assert.equal(advanceRealignLabel(r), null)
    assert.ok(advanceAttentionLabel(r))
  })
  test('not held: nothing', () => {
    assert.equal(advanceRealignLabel(base), null)
  })
})

describe('the two "Order value" figures', () => {
  const rows: PiAmountRow[] = [
    { key: 'gross', label: 'Gross product amount', value: '₹2,68,000', kind: 'amount' },
    { key: 'gst', label: 'GST', value: '₹48,240', kind: 'amount' },
    { key: 'grandTotal', label: 'Grand Total', value: '₹3,16,240', kind: 'amount', groupStart: true },
  ] as PiAmountRow[]
  test('an Order not amended: the PI total is the Order value, as before', () => {
    const lines = orderCommercialLines(rows)
    assert.deepEqual(lines.map(l => [l.label, l.value, l.role]).at(-1), [ORDER_VALUE_LABEL, '₹3,16,240', 'final'])
  })
  test('an amended Order: the PI total is named the PI value, and the Order value closes the breakdown', () => {
    const lines = orderCommercialLines(rows, { orderValue: '₹4,20,000' })
    const last = lines.at(-1)!, pi = lines.find(l => l.key === 'grandTotal')!
    assert.deepEqual([pi.label, pi.value, pi.role], [PI_VALUE_LABEL, '₹3,16,240', 'running'])
    assert.deepEqual([last.label, last.value, last.role, last.note], [ORDER_VALUE_LABEL, '₹4,20,000', 'final', ORDER_VALUE_AMENDED_NOTE])
    assert.equal(lines.filter(l => l.label === ORDER_VALUE_LABEL).length, 1, 'one line is called "Order value"')
  })
})
