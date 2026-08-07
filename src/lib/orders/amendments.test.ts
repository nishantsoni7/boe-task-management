import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  parseMoney,
  initialAmendState,
  buildAmendmentPayload,
  validateAmendment,
  toProposedFields,
  hasPendingChangeRequest,
  canReviewChangeRequest,
  canAmendOrderDirectly,
  canRequestOrderChange,
  isAmendableStatus,
  describeAmendment,
  describeProposal,
  staleProposalFields,
  amendmentErrorMessage,
  EMPTY_AMENDMENT_PAYLOAD,
  AMENDABLE_FIELDS,
  type AmendableOrder,
  type AmendFormState,
  type OrderChangeRequest,
} from './amendments'

// A running Order with every amendable field populated, so a test that changes
// one field is never accidentally also testing the null-to-value path.
const order: AmendableOrder = {
  status:              'running',
  client_name:         'Sharma Interiors',
  total_value:         250000,
  total_product_value: 210000,
  confirm_date:        '2026-07-01',
  due_date:            '2026-08-15',
  lead_source:         'reference',
  notes:               'Two-tone finish agreed on call.',
}

const untouched = (): AmendFormState => initialAmendState(order)

function built(form: AmendFormState) {
  const res = buildAmendmentPayload(order, form)
  assert.equal(res.ok, true, 'expected the payload to build')
  return res as Extract<typeof res, { ok: true }>
}

// ── parseMoney ────────────────────────────────────────────────────────────────

describe('parseMoney', () => {
  test('an empty box is "leave it alone", not zero', () => {
    assert.deepEqual(parseMoney(''), { ok: true, value: null })
    assert.deepEqual(parseMoney('   '), { ok: true, value: null })
  })

  test('accepts what a person actually types into a rupee field', () => {
    assert.deepEqual(parseMoney('250000'),    { ok: true, value: 250000 })
    assert.deepEqual(parseMoney('2,50,000'),  { ok: true, value: 250000 })
    assert.deepEqual(parseMoney('₹2,50,000'), { ok: true, value: 250000 })
    assert.deepEqual(parseMoney(' 1250.75 '), { ok: true, value: 1250.75 })
  })

  test('zero is a real amount, distinct from an empty box', () => {
    assert.deepEqual(parseMoney('0'), { ok: true, value: 0 })
  })

  test('rounds to the two decimal places the column stores', () => {
    assert.deepEqual(parseMoney('100.005'), { ok: true, value: 100.01 })
    assert.deepEqual(parseMoney('100.004'), { ok: true, value: 100 })
  })

  test('refuses a negative amount, matching the CHECK constraint', () => {
    const res = parseMoney('-5')
    assert.equal(res.ok, false)
  })

  test('refuses text and infinities', () => {
    assert.equal(parseMoney('abc').ok, false)
    assert.equal(parseMoney('Infinity').ok, false)
  })

  test('refuses an amount numeric(12,2) could not hold', () => {
    assert.equal(parseMoney('10000000000').ok, false)   // 1e10
    assert.equal(parseMoney('9999999999').ok, true)
  })
})

// ── buildAmendmentPayload ─────────────────────────────────────────────────────

describe('buildAmendmentPayload', () => {
  test('an untouched form changes nothing', () => {
    const res = built(untouched())
    assert.deepEqual(res.changed, [])
    assert.deepEqual(res.payload, EMPTY_AMENDMENT_PAYLOAD)
  })

  test('only the field that moved appears in the payload', () => {
    const res = built({ ...untouched(), total_value: '275000' })
    assert.deepEqual(res.changed, ['total_value'])
    assert.equal(res.payload.p_total_value, 275000)
    assert.equal(res.payload.p_client_name, null)
    assert.equal(res.payload.p_due_date, null)
  })

  test('re-typing the same value in a different format is still no change', () => {
    const res = built({ ...untouched(), total_value: '₹2,50,000' })
    assert.deepEqual(res.changed, [])
  })

  test('an emptied box leaves the field alone rather than blanking it', () => {
    // This is the load-bearing rule: NULL means "unchanged" in the RPC, so a
    // cleared due date must not reach the database as an instruction to clear.
    const res = built({ ...untouched(), due_date: '', notes: '', client_name: '' })
    assert.deepEqual(res.changed, [])
    assert.equal(res.payload.p_due_date, null)
    assert.equal(res.payload.p_notes, null)
    assert.equal(res.payload.p_client_name, null)
  })

  test('several fields at once, reported in field order', () => {
    const res = built({
      ...untouched(),
      client_name: 'Sharma Interiors Pvt Ltd',
      total_value: '300000',
      due_date:    '2026-09-01',
    })
    assert.deepEqual(res.changed, ['client_name', 'total_value', 'due_date'])
    assert.equal(res.payload.p_client_name, 'Sharma Interiors Pvt Ltd')
    assert.equal(res.payload.p_total_value, 300000)
    assert.equal(res.payload.p_due_date, '2026-09-01')
  })

  test('surrounding whitespace is not a change, and is trimmed when it is', () => {
    assert.deepEqual(built({ ...untouched(), client_name: '  Sharma Interiors  ' }).changed, [])
    assert.equal(
      built({ ...untouched(), client_name: '  Verma Homes  ' }).payload.p_client_name,
      'Verma Homes',
    )
  })

  test('a bad amount fails on the field that caused it', () => {
    const res = buildAmendmentPayload(order, { ...untouched(), total_product_value: '-1' })
    assert.equal(res.ok, false)
    assert.equal(res.ok === false && res.field, 'total_product_value')
  })

  test('a malformed date is refused before it reaches the database', () => {
    const res = buildAmendmentPayload(order, { ...untouched(), due_date: '15-08-2026' })
    assert.equal(res.ok, false)
    assert.equal(res.ok === false && res.field, 'due_date')
  })

  test('a date that looks well-formed but is not a real day is refused', () => {
    const res = buildAmendmentPayload(order, { ...untouched(), confirm_date: '2026-02-31' })
    assert.equal(res.ok, false)
    assert.equal(res.ok === false && res.field, 'confirm_date')
  })

  test('a lead source outside the CHECK list is refused', () => {
    const res = buildAmendmentPayload(order, { ...untouched(), lead_source: 'linkedin' })
    assert.equal(res.ok, false)
    assert.equal(res.ok === false && res.field, 'lead_source')
  })

  test('a listed lead source is accepted', () => {
    const res = built({ ...untouched(), lead_source: 'instagram' })
    assert.deepEqual(res.changed, ['lead_source'])
    assert.equal(res.payload.p_lead_source, 'instagram')
  })

  test('setting a value on a field that was empty works', () => {
    const sparse: AmendableOrder = {
      ...order, total_value: null, due_date: null, lead_source: null, notes: null,
    }
    const form = initialAmendState(sparse)
    const res = buildAmendmentPayload(sparse, { ...form, total_value: '50000', due_date: '2026-10-01' })
    assert.equal(res.ok, true)
    assert.deepEqual(res.ok && res.changed, ['total_value', 'due_date'])
  })

  test('zero is a real new value, not an empty box', () => {
    const res = built({ ...untouched(), total_value: '0' })
    assert.deepEqual(res.changed, ['total_value'])
    assert.equal(res.payload.p_total_value, 0)
  })

  test('every amendable field can actually be built', () => {
    // Guards against a field being added to AMENDABLE_FIELDS for the form while
    // buildAmendmentPayload keeps ignoring it.
    const res = built({
      client_name:         'New Client',
      total_value:         '999',
      total_product_value: '888',
      confirm_date:        '2026-01-02',
      due_date:            '2026-01-03',
      lead_source:         'website',
      notes:               'Revised',
    })
    assert.deepEqual(
      [...res.changed].sort(),
      AMENDABLE_FIELDS.map(f => f.key).sort(),
    )
  })
})

// ── validateAmendment ─────────────────────────────────────────────────────────

describe('validateAmendment', () => {
  test('a reason is mandatory', () => {
    assert.equal(
      validateAmendment({ reason: '   ', changed: ['total_value'] }),
      'Say why this order is being amended.',
    )
  })

  test('an amendment that changes nothing is refused, as the database refuses it', () => {
    assert.equal(
      validateAmendment({ reason: 'Client added an item', changed: [] }),
      'Change at least one value before submitting.',
    )
  })

  test('a reason plus one change passes', () => {
    assert.equal(validateAmendment({ reason: 'Client added an item', changed: ['total_value'] }), null)
  })
})

// ── toProposedFields ──────────────────────────────────────────────────────────

describe('toProposedFields', () => {
  test('maps every RPC argument onto its proposed_ column', () => {
    const { payload } = built({ ...untouched(), total_value: '275000', notes: 'Revised scope' })
    const proposed = toProposedFields(payload)
    assert.equal(proposed.proposed_total_value, 275000)
    assert.equal(proposed.proposed_notes, 'Revised scope')
    assert.equal(proposed.proposed_client_name, null)
    // Same number of keys, so a new p_ argument cannot be silently dropped.
    assert.equal(Object.keys(proposed).length, Object.keys(payload).length)
  })
})

// ── Pending-request bookkeeping ───────────────────────────────────────────────

const pending = (over: Partial<OrderChangeRequest> = {}) => ({
  order_id:     'order-1',
  requested_by: 'user-1',
  request_type: 'edit' as const,
  status:       'pending' as const,
  ...over,
})

describe('hasPendingChangeRequest', () => {
  test('finds this person\'s open request of this type', () => {
    assert.equal(hasPendingChangeRequest([pending()], 'order-1', 'user-1', 'edit'), true)
  })

  test('someone else\'s open request does not block mine', () => {
    assert.equal(hasPendingChangeRequest([pending()], 'order-1', 'user-2', 'edit'), false)
  })

  test('a different type on the same order does not block', () => {
    assert.equal(hasPendingChangeRequest([pending()], 'order-1', 'user-1', 'cancel'), false)
  })

  test('a reviewed request never blocks the next one', () => {
    assert.equal(
      hasPendingChangeRequest([pending({ status: 'rejected' })], 'order-1', 'user-1', 'edit'),
      false,
    )
    assert.equal(
      hasPendingChangeRequest([pending({ status: 'approved' })], 'order-1', 'user-1', 'edit'),
      false,
    )
  })
})

describe('canReviewChangeRequest', () => {
  test('only a pending request can be reviewed', () => {
    assert.equal(canReviewChangeRequest({ status: 'pending' }), true)
    assert.equal(canReviewChangeRequest({ status: 'approved' }), false)
    assert.equal(canReviewChangeRequest({ status: 'rejected' }), false)
  })
})

// ── Which door ────────────────────────────────────────────────────────────────

describe('door selection', () => {
  const admin  = { role: 'admin' }
  const member = { role: 'member' }

  test('a closed order is amendable by nobody', () => {
    for (const status of ['dispatched', 'cancelled']) {
      assert.equal(isAmendableStatus(status), false)
      assert.equal(canAmendOrderDirectly(admin, { status }), false)
      assert.equal(canRequestOrderChange(member, { status }), false)
    }
  })

  test('an open order gives the admin the direct door', () => {
    for (const status of ['running', 'on_hold', 'ready_for_dispatch']) {
      assert.equal(canAmendOrderDirectly(admin, { status }), true)
      assert.equal(canRequestOrderChange(admin, { status }), false)
    }
  })

  test('everyone else gets the request door, never the direct one', () => {
    assert.equal(canAmendOrderDirectly(member, { status: 'running' }), false)
    assert.equal(canRequestOrderChange(member, { status: 'running' }), true)
  })

  test('a signed-out reader gets neither', () => {
    assert.equal(canAmendOrderDirectly(null, { status: 'running' }), false)
    assert.equal(canRequestOrderChange(null, { status: 'running' }), false)
  })
})

// ── describeAmendment ─────────────────────────────────────────────────────────

describe('describeAmendment', () => {
  test('one line per field that moved, with labels and formatted money', () => {
    const lines = describeAmendment({
      source: 'admin_direct',
      reason: 'Client added two chairs',
      changes: {
        total_value: { from: 250000, to: 275000 },
        due_date:    { from: '2026-08-15', to: '2026-09-01' },
      },
    })
    assert.deepEqual(lines, [
      'Total Order Value: ₹2,50,000 → ₹2,75,000',
      'Due Date: 2026-08-15 → 2026-09-01',
    ])
  })

  test('lines come out in field order, not payload order', () => {
    const lines = describeAmendment({
      changes: {
        due_date:    { from: 'a', to: 'b' },
        client_name: { from: 'c', to: 'd' },
      },
    })
    assert.equal(lines[0].startsWith('Client Name'), true)
    assert.equal(lines[1].startsWith('Due Date'), true)
  })

  test('a null before-value reads as an em dash rather than "null"', () => {
    const lines = describeAmendment({ changes: { notes: { from: null, to: 'Added' } } })
    assert.deepEqual(lines, ['Notes: — → Added'])
  })

  test('lead source is shown by its label', () => {
    const lines = describeAmendment({
      changes: { lead_source: { from: 'reference', to: 'repeat_customer' } },
    })
    assert.deepEqual(lines, ['Lead Source: Reference → Repeat Customer'])
  })

  test('an empty payload produces no lines rather than throwing', () => {
    assert.deepEqual(describeAmendment({}), [])
    assert.deepEqual(describeAmendment({ changes: {} }), [])
  })

  test('a field this build does not know about is still shown', () => {
    const lines = describeAmendment({ changes: { shipping_city: { from: 'Jaipur', to: 'Delhi' } } })
    assert.deepEqual(lines, ['shipping city: Jaipur → Delhi'])
  })
})

// ── Proposal rendering and staleness (20260818000000) ─────────────────────────

// A full request row, baseline captured server-side at filing time against the
// `order` fixture above.
const proposal = (over: Partial<OrderChangeRequest> = {}): OrderChangeRequest => ({
  id: 'req-1',
  order_id: 'order-1',
  order_number_snapshot: '0017',
  request_type: 'edit',
  requested_by: 'user-1',
  reason: 'Client added two chairs',
  status: 'pending',
  reviewed_by: null,
  reviewed_at: null,
  review_note: null,
  created_at: '2026-08-01T10:00:00Z',
  proposed_client_name: null,
  proposed_total_value: 300000,
  proposed_total_product_value: null,
  proposed_confirm_date: null,
  proposed_due_date: null,
  proposed_lead_source: null,
  proposed_notes: null,
  baseline_client_name: order.client_name,
  baseline_total_value: order.total_value,
  baseline_total_product_value: order.total_product_value,
  baseline_confirm_date: order.confirm_date,
  baseline_due_date: order.due_date,
  baseline_lead_source: order.lead_source,
  baseline_notes: order.notes,
  ...over,
})

describe('describeProposal', () => {
  test('shows baseline → proposed, so the admin sees what is being replaced', () => {
    assert.deepEqual(describeProposal(proposal()), [
      'Total Order Value: ₹2,50,000 → ₹3,00,000',
    ])
  })

  test('only proposed fields appear', () => {
    const lines = describeProposal(proposal({ proposed_due_date: '2026-09-01' }))
    assert.equal(lines.length, 2)
    assert.ok(lines.some(l => l.startsWith('Total Order Value')))
    assert.ok(lines.some(l => l === 'Due Date: 2026-08-15 → 2026-09-01'))
  })

  test('a request filed before baselines existed shows the proposal alone', () => {
    // Pre-20260806 rows carry no baseline. Showing "— → ₹3,00,000" would
    // claim the old value was empty, which is worse than saying less.
    const legacy = proposal({ baseline_total_value: undefined })
    assert.deepEqual(describeProposal(legacy), ['Total Order Value: ₹3,00,000'])
  })

  test('a null baseline is a real value and renders as an em dash', () => {
    const lines = describeProposal(proposal({
      proposed_notes: 'Added', baseline_notes: null,
    }))
    assert.ok(lines.includes('Notes: — → Added'))
  })

  test('a cancellation proposes nothing', () => {
    const cancel = proposal({ request_type: 'cancel', proposed_total_value: null })
    assert.deepEqual(describeProposal(cancel), [])
  })
})

describe('staleProposalFields', () => {
  test('nothing is stale while the order still matches the baseline', () => {
    assert.deepEqual(staleProposalFields(proposal(), order), [])
  })

  test('a field changed since filing is reported stale', () => {
    // The clobbering scenario: admin amended to 400000 after the request.
    const moved = { ...order, total_value: 400000 }
    assert.deepEqual(staleProposalFields(proposal(), moved), ['Total Order Value'])
  })

  test('a change to a field this request does not propose is not stale', () => {
    // Granularity matters: refusing on unrelated movement would train admins
    // to re-submit blindly, which is the failure this check exists to prevent.
    const moved = { ...order, due_date: '2026-12-01' }
    assert.deepEqual(staleProposalFields(proposal(), moved), [])
  })

  test('several stale fields are all reported', () => {
    const req = proposal({ proposed_client_name: 'New Name', proposed_due_date: '2026-09-01' })
    const moved = { ...order, total_value: 400000, client_name: 'Renamed', due_date: '2026-10-10' }
    assert.deepEqual(
      staleProposalFields(req, moved).sort(),
      ['Client Name', 'Due Date', 'Total Order Value'].sort(),
    )
  })

  test('null-to-null is not a change', () => {
    const sparse: AmendableOrder = { ...order, notes: null }
    const req = proposal({ proposed_notes: 'Added', baseline_notes: null })
    assert.deepEqual(staleProposalFields(req, sparse), [])
  })

  test('a value going from null to set IS a change', () => {
    const req = proposal({ proposed_notes: 'Added', baseline_notes: null })
    assert.deepEqual(staleProposalFields(req, { ...order, notes: 'Someone wrote this' }), ['Notes'])
  })

  test('a legacy request with no baseline is never judged stale here', () => {
    // The database applies the same rule — it cannot compare against a
    // baseline that was never captured.
    const legacy = proposal({ baseline_total_value: undefined })
    assert.deepEqual(staleProposalFields(legacy, { ...order, total_value: 999 }), [])
  })
})

// ── Error mapping ─────────────────────────────────────────────────────────────

describe('amendmentErrorMessage', () => {
  test('each database refusal maps to its own sentence', () => {
    const cases: [string, string][] = [
      ['ORDER_AMENDMENT_REQUIRED: ...',        'Amend Order'],
      ['ORDER_AMENDMENT_FORBIDDEN: ...',       'Only an administrator'],
      ['ORDER_AMENDMENT_NO_CHANGE: ...',       'Nothing was changed'],
      ['ORDER_CLOSED: ...',                    'closed'],
      ['ORDER_ALREADY_CANCELLED: ...',         'already been cancelled'],
      ['ORDER_DISPATCHED: ...',                'already been dispatched'],
      ['ORDER_VALUE_NEGATIVE: ...',            'cannot be negative'],
      ['ORDER_CHANGE_REQUEST_REVIEWED: ...',   'already been reviewed'],
      ['ORDER_CHANGE_REQUEST_STALE: ...',      'changed after the request was raised'],
      ['ORDER_FIELD_FROZEN: ...',              'creation record'],
    ]
    for (const [raw, fragment] of cases) {
      const msg = amendmentErrorMessage(raw)
      assert.ok(msg, `expected a message for ${raw}`)
      assert.ok(msg.includes(fragment), `"${msg}" should mention "${fragment}"`)
    }
  })

  test('ORDER_DISPATCHED is not swallowed by the ORDER_CLOSED branch', () => {
    // Both contain "ORDER_", and ORDER_CLOSED is checked later; a reordering
    // that broke this would give a cancelling admin the wrong sentence.
    assert.ok(amendmentErrorMessage('ORDER_DISPATCHED: x')?.includes('dispatched'))
  })

  test('the unique-index violation is translated, not shown raw', () => {
    const msg = amendmentErrorMessage(
      'duplicate key value violates unique constraint "order_change_requests_one_pending_idx"',
    )
    assert.ok(msg?.includes('already have an open request'))
  })

  test('an unrelated failure falls through so the caller can map it', () => {
    assert.equal(amendmentErrorMessage('network request failed'), null)
    assert.equal(amendmentErrorMessage(null), null)
    assert.equal(amendmentErrorMessage(undefined), null)
  })
})
