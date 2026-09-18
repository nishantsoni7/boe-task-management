/**
 * Prefilling "Add to Meeting" from a task.
 *
 * Why this is worth testing at all: public.tasks has no order_number and no
 * customer column, so every prefilled value is INFERRED from what somebody typed.
 * An inference that is too eager puts a wrong order number on a management agenda,
 * which is worse than an empty field — so the interesting assertions here are the
 * ones about what it must NOT guess.
 *
 * The labelled-line path is not hypothetical: a task created from a meeting already
 * carries `Order: 2041` and `Customer: …` lines (see taskDraft.ts), so the round
 * trip meeting → task → meeting has to work exactly.
 *
 * Run:
 *   npx tsx --test src/lib/meetings/taskCapture.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  CAPTURE_INBOX, buildTaskCapturePrefill, captureDetails, capturePrefillIsSubmittable,
  captureSubmitAllowed, captureTargetId, captureTargetMeetings,
  extractCustomerName, extractOrderNumber, suggestCategory,
  type CaptureMeetingOption,
} from './taskCapture'
import { istToday } from '@/lib/istDate'
import { buildMeetingTaskDraft } from './taskDraft'
import type { Meeting, MeetingOrder, MeetingOrderItem } from './types'

// ─── Order number ────────────────────────────────────────────────────────────

describe('the order number', () => {
  test('a labelled line wins, whatever else the text contains', () => {
    const found = extractOrderNumber({
      title: 'Follow up on 9999 urgently',
      note: 'Order: 2041\nCustomer: Acme',
    })
    assert.equal(found, '2041')
  })

  test('every labelled spelling the product actually uses is understood', () => {
    for (const label of ['Order', 'Order No', 'Order Number', 'Order Ref']) {
      assert.equal(extractOrderNumber({ note: `${label}: BOE-408` }), 'BOE-408', label)
    }
  })

  test('the label must start the line, so a sentence mentioning it does not match', () => {
    // "…the order: nothing yet" must not be read as an order number.
    assert.equal(extractOrderNumber({ note: 'We discussed the order: nothing yet' }), '')
  })

  test('a labelled line stops at the end of its own line', () => {
    const found = extractOrderNumber({ note: 'Order: 2041\nThis is a long paragraph about it.' })
    assert.equal(found, '2041')
  })

  test('an em-dash or hyphen placeholder is not an order number', () => {
    assert.equal(extractOrderNumber({ note: 'Order: —' }), '')
    assert.equal(extractOrderNumber({ note: 'Order: -' }), '')
  })

  test('without a label, an order-shaped token in the title is offered', () => {
    assert.equal(extractOrderNumber({ title: 'Order 2041 finish issue' }), '2041')
    assert.equal(extractOrderNumber({ title: '#7788 dispatch commitment' }), '#7788')
    assert.equal(extractOrderNumber({ title: 'BOE-408 drawing approval' }), 'BOE-408')
  })

  test('the title is preferred over the body when neither is labelled', () => {
    assert.equal(extractOrderNumber({ title: 'Order 2041 issue', note: 'also see 9999' }), '2041')
  })

  test('a small number is NOT guessed at — that is a quantity, not an order', () => {
    // The defect this prevents: "Send 12 samples" becoming order 12.
    assert.equal(extractOrderNumber({ title: 'Send 12 samples to the client' }), '')
    assert.equal(extractOrderNumber({ title: 'Check 5 pieces' }), '')
  })

  test('nothing order-shaped means an empty field the user has to fill in', () => {
    assert.equal(extractOrderNumber({ title: 'Customer complaint about the finish' }), '')
    assert.equal(extractOrderNumber({}), '')
    assert.equal(extractOrderNumber({ title: null, note: null }), '')
  })
})

// ─── Customer ────────────────────────────────────────────────────────────────

describe('the customer', () => {
  test('is read from a labelled line only', () => {
    assert.equal(extractCustomerName({ note: 'Customer: Blue Lagoon Resorts' }), 'Blue Lagoon Resorts')
    assert.equal(extractCustomerName({ note: 'Client: Acme' }), 'Acme')
  })

  test('is never guessed out of free text', () => {
    // There is no way to recognise a customer name in a sentence, and a wrong name
    // on a management record is worse than no name.
    assert.equal(extractCustomerName({ title: 'Blue Lagoon says the finish is wrong' }), '')
  })
})

// ─── Category suggestion ─────────────────────────────────────────────────────

describe('the suggested category', () => {
  test('after-sales language suggests After Sales, with the matching tag', () => {
    assert.deepEqual(suggestCategory({ title: 'Replacement needed for the damaged unit' }),
      { category: 'after_sales', afterSalesTag: 'replacement' })
    assert.deepEqual(suggestCategory({ title: 'Repair required at the villa' }),
      { category: 'after_sales', afterSalesTag: 'repair' })
    assert.deepEqual(suggestCategory({ title: 'Wrong item delivered to the client' }),
      { category: 'after_sales', afterSalesTag: 'other' })
  })

  test('site language suggests After Sales / Site Issue', () => {
    assert.deepEqual(suggestCategory({ title: 'Site damage reported on arrival' }),
      { category: 'after_sales', afterSalesTag: 'site_issue' })
  })

  test('production language leaves it on Running Order with no tag', () => {
    for (const title of [
      'Fabric approval pending',
      'Production delay on the dining chairs',
      'QC issue found before packing',
      'Dispatch commitment for Friday',
    ]) {
      assert.deepEqual(suggestCategory({ title }), { category: 'running_order', afterSalesTag: null }, title)
    }
  })

  test('the default is Running Order, which is the commoner case', () => {
    assert.deepEqual(suggestCategory({}), { category: 'running_order', afterSalesTag: null })
  })
})

// ─── The whole prefill ───────────────────────────────────────────────────────

describe('the quick sheet opens with', () => {
  test('the task title as the issue line, collapsed and clamped', () => {
    const long = 'x'.repeat(200)
    const prefill = buildTaskCapturePrefill({ title: `Order 2041  \n  spaced   out ${long}` })
    assert.ok(prefill.issue.length <= 120)
    assert.ok(!prefill.issue.includes('\n'))
    assert.ok(!prefill.issue.includes('  '))
    assert.ok(prefill.issue.endsWith('…'), 'a clamped line says it was clamped')
  })

  test('a short title is used exactly, with no ellipsis added', () => {
    const prefill = buildTaskCapturePrefill({ title: 'Fabric approval pending' })
    assert.equal(prefill.issue, 'Fabric approval pending')
  })

  test('everything a meeting-born task carries, read straight back', () => {
    // The real round trip: Meetings writes this body, Tasks stores it, and
    // Add to Meeting reads it back without anybody retyping a field.
    const meeting = { title: 'New Order Review — 1 Feb 2026', meeting_date: '2026-02-01' } as Meeting
    const order = {
      order_number: '2041', customer_name: 'Blue Lagoon', expected_dispatch_date: null,
    } as MeetingOrder
    const item = {
      sku: 'CH-12', product_name: 'Dining chair', quantity: null, current_stage: null,
      responsible_department: null, issue: 'Fabric approval pending', latest_update: null,
    } as MeetingOrderItem

    const draft = buildMeetingTaskDraft(meeting, order, item)
    const prefill = buildTaskCapturePrefill({ title: draft.title, note: draft.description })

    assert.equal(prefill.orderNumber, '2041')
    assert.equal(prefill.customerName, 'Blue Lagoon')
    assert.equal(prefill.category, 'running_order')
  })
})

// ─── Submittability ──────────────────────────────────────────────────────────

describe('what the form refuses before it makes a round trip', () => {
  const ok = { category: 'running_order', orderNumber: '2041', issue: 'Delay', afterSalesTag: null }

  test('a complete draft is submittable', () => {
    assert.equal(capturePrefillIsSubmittable(ok), true)
  })

  test('no order number, no submit', () => {
    assert.equal(capturePrefillIsSubmittable({ ...ok, orderNumber: '   ' }), false)
  })

  test('no issue line, no submit', () => {
    assert.equal(capturePrefillIsSubmittable({ ...ok, issue: '' }), false)
  })

  test('an invalid category is refused in the browser as well as the database', () => {
    assert.equal(capturePrefillIsSubmittable({ ...ok, category: 'repair' }), false)
    assert.equal(capturePrefillIsSubmittable({ ...ok, category: null }), false)
  })

  test('an after-sales tag on a running-order issue is refused', () => {
    // The same rule as the CHECK constraint, so the form never sends a pairing the
    // database will reject.
    assert.equal(capturePrefillIsSubmittable({ ...ok, afterSalesTag: 'repair' }), false)
    assert.equal(capturePrefillIsSubmittable({
      ...ok, category: 'after_sales', afterSalesTag: 'repair',
    }), true)
  })

  test('a target meeting is NOT required — that is what the Inbox is for', () => {
    assert.equal(capturePrefillIsSubmittable(ok), true)
  })
})

// ─── The details line ────────────────────────────────────────────────────────

describe('the details sent with a capture', () => {
  test('nothing typed and no reference means no details at all', () => {
    assert.equal(captureDetails({}), null)
    assert.equal(captureDetails({ extra: '   ' }), null)
  })

  test('what the user typed is kept, and the task reference is appended', () => {
    const details = captureDetails({ extra: 'Vendor says two weeks', taskRef: 'T-1' })
    assert.ok(details!.includes('Vendor says two weeks'))
    assert.ok(details!.includes('T-1'))
  })

  test('the task’s own title and body are never copied in', () => {
    // A meeting viewer who may not read the source task must not learn its contents
    // from an agenda row. Only the issue line the capturing user chose travels.
    const details = captureDetails({ extra: 'Vendor says two weeks' })
    assert.ok(!details!.toLowerCase().includes('task title'))
    assert.equal(details, 'Vendor says two weeks')
  })
})

// ─── Which meeting quick capture offers, and which it selects ───────────────
//
// Deterministic: "today" is passed in. The production shape that motivated this —
// a stale 12 Aug New Order draft and a 5 Aug "ZZ TEST" Repair Order review still
// live in September — is reproduced below.

const TODAY = '2026-09-17'

function meeting(over: Partial<CaptureMeetingOption> & { id: string }): CaptureMeetingOption & { title: string } {
  return {
    meeting_date: TODAY,
    meeting_type: 'new_order',
    status: 'draft',
    created_at: '2026-09-01T00:00:00Z',
    title: over.id,
    ...over,
  }
}

const PRODUCTION_SHAPE = [
  meeting({ id: 'stale-new-order-draft-12-aug', meeting_date: '2026-08-12', meeting_type: 'new_order', status: 'draft' }),
  meeting({ id: 'new-order-16-sept-in-progress', meeting_date: '2026-09-16', meeting_type: 'new_order', status: 'in_progress' }),
  meeting({ id: 'zz-test-repair-5-aug', meeting_date: '2026-08-05', meeting_type: 'repair_order', status: 'in_progress' }),
  meeting({ id: 'stale-repair-draft-18-aug', meeting_date: '2026-08-18', meeting_type: 'repair_order', status: 'draft' }),
]

describe('quick capture offers only upcoming meetings, nearest first', () => {
  test('several upcoming meetings: the nearest is chosen', () => {
    const offered = captureTargetMeetings([
      meeting({ id: 'in-two-weeks', meeting_date: '2026-10-01' }),
      meeting({ id: 'tomorrow', meeting_date: '2026-09-18' }),
      meeting({ id: 'next-week', meeting_date: '2026-09-24' }),
    ], 'running_order', TODAY)
    assert.deepEqual(offered.map(m => m.id), ['tomorrow', 'next-week', 'in-two-weeks'])
    assert.equal(captureTargetId(null, offered), 'tomorrow')
  })

  test('a meeting dated today counts as upcoming', () => {
    const offered = captureTargetMeetings([meeting({ id: 'today' })], 'running_order', TODAY)
    assert.equal(captureTargetId(null, offered), 'today')
  })

  test('two on the same day: the one raised first leads, deterministically', () => {
    const offered = captureTargetMeetings([
      meeting({ id: 'b', meeting_date: '2026-09-20', created_at: '2026-09-10T10:00:00Z' }),
      meeting({ id: 'a', meeting_date: '2026-09-20', created_at: '2026-09-10T09:00:00Z' }),
    ], 'running_order', TODAY)
    assert.deepEqual(offered.map(m => m.id), ['a', 'b'])
  })

  test('past and future meetings: the future one is chosen, the past one is not offered', () => {
    const offered = captureTargetMeetings([
      meeting({ id: 'last-week', meeting_date: '2026-09-10', status: 'in_progress' }),
      meeting({ id: 'next-week', meeting_date: '2026-09-24' }),
    ], 'running_order', TODAY)
    assert.deepEqual(offered.map(m => m.id), ['next-week'])
    assert.equal(captureTargetId(null, offered), 'next-week')
  })

  test('only past meetings: the Meeting Inbox is chosen — never the most recent past meeting', () => {
    const offered = captureTargetMeetings([
      meeting({ id: 'yesterday', meeting_date: '2026-09-16', status: 'in_progress' }),
      meeting({ id: 'last-month', meeting_date: '2026-08-12' }),
    ], 'running_order', TODAY)
    assert.deepEqual(offered, [])
    assert.equal(captureTargetId(null, offered), CAPTURE_INBOX)
  })

  test('stale drafts and test meetings from production are excluded in both categories', () => {
    const running = captureTargetMeetings(PRODUCTION_SHAPE, 'running_order', TODAY)
    const afterSales = captureTargetMeetings(PRODUCTION_SHAPE, 'after_sales', TODAY)
    assert.ok(!running.some(m => m.id === 'stale-new-order-draft-12-aug'), 'Running Order must not offer the 12 Aug draft')
    assert.ok(!afterSales.some(m => m.id === 'zz-test-repair-5-aug'), 'After Sales must not offer ZZ TEST')
    // Everything in that shape is in the past, so both categories go to the Inbox.
    assert.equal(captureTargetId(null, running), CAPTURE_INBOX)
    assert.equal(captureTargetId(null, afterSales), CAPTURE_INBOX)
  })

  test('completed meetings and the other review type are never offered', () => {
    const offered = captureTargetMeetings([
      meeting({ id: 'completed-future', meeting_date: '2026-09-20', status: 'completed' }),
      meeting({ id: 'repair-future', meeting_date: '2026-09-20', meeting_type: 'repair_order' }),
      meeting({ id: 'new-order-future', meeting_date: '2026-09-21' }),
    ], 'running_order', TODAY)
    assert.deepEqual(offered.map(m => m.id), ['new-order-future'])
  })
})

describe('the selected target follows the category', () => {
  const upcoming = [
    ...PRODUCTION_SHAPE,
    meeting({ id: 'new-order-23-sept', meeting_date: '2026-09-23', meeting_type: 'new_order' }),
    meeting({ id: 'new-order-19-sept', meeting_date: '2026-09-19', meeting_type: 'new_order' }),
    meeting({ id: 'repair-25-sept', meeting_date: '2026-09-25', meeting_type: 'repair_order' }),
  ]

  test('switching category recalculates the default to that category’s nearest upcoming meeting', () => {
    const running = captureTargetMeetings(upcoming, 'running_order', TODAY)
    const afterSales = captureTargetMeetings(upcoming, 'after_sales', TODAY)
    assert.equal(captureTargetId(null, running), 'new-order-19-sept')
    assert.equal(captureTargetId(null, afterSales), 'repair-25-sept')
  })

  test('a meeting chosen under one category does not survive a switch to the other', () => {
    const afterSales = captureTargetMeetings(upcoming, 'after_sales', TODAY)
    assert.equal(captureTargetId('new-order-23-sept', afterSales), 'repair-25-sept')
  })

  test('a switch to a category with no upcoming meeting lands on the Inbox', () => {
    const onlyNewOrders = upcoming.filter(m => m.meeting_type === 'new_order')
    const afterSales = captureTargetMeetings(onlyNewOrders, 'after_sales', TODAY)
    assert.equal(captureTargetId('new-order-19-sept', afterSales), CAPTURE_INBOX)
  })

  test('an explicit choice that is still offered, or the Inbox, is kept', () => {
    const running = captureTargetMeetings(upcoming, 'running_order', TODAY)
    assert.equal(captureTargetId('new-order-23-sept', running), 'new-order-23-sept')
    assert.equal(captureTargetId(CAPTURE_INBOX, running), CAPTURE_INBOX)
  })
})

describe('Add is blocked until the meeting list has loaded successfully', () => {
  const ready = { saving: false, finished: false, meetingsLoaded: true, meetingsError: null, draftSubmittable: true }

  test('loaded, no error, a complete draft: allowed', () => {
    assert.equal(captureSubmitAllowed(ready), true)
  })

  test('a load failure blocks submission — it never silently becomes the Inbox', () => {
    assert.equal(captureSubmitAllowed({ ...ready, meetingsLoaded: false, meetingsError: 'could not be loaded' }), false)
    assert.equal(captureSubmitAllowed({ ...ready, meetingsError: 'could not be loaded' }), false)
  })

  test('still loading, saving, finished or an incomplete draft: blocked', () => {
    assert.equal(captureSubmitAllowed({ ...ready, meetingsLoaded: false }), false)
    assert.equal(captureSubmitAllowed({ ...ready, saving: true }), false)
    assert.equal(captureSubmitAllowed({ ...ready, finished: true }), false)
    assert.equal(captureSubmitAllowed({ ...ready, draftSubmittable: false }), false)
  })
})

describe('"today" is the Indian business date', () => {
  test('just after midnight IST is already the new day, although UTC is still yesterday', () => {
    // 2026-09-17 00:30 IST = 2026-09-16 19:00 UTC.
    const now = new Date('2026-09-16T19:00:00Z')
    assert.equal(now.toISOString().slice(0, 10), '2026-09-16')
    assert.equal(istToday(now), '2026-09-17')
    const offered = captureTargetMeetings([meeting({ id: 'dated-16-sept', meeting_date: '2026-09-16' })], 'running_order', istToday(now))
    assert.deepEqual(offered, [], 'a meeting dated yesterday in India is not offered at 00:30 IST')
  })
})
