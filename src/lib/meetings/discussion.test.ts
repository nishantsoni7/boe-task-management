/**
 * The order-discussion workflow — the rules, without a database.
 *
 * What these pin, and why each is worth a test:
 *
 *   1. TWO CATEGORIES, AND ONLY TWO. A third one is a migration, not a client
 *      change, and an after-sales tag on a running-order item is refused here as
 *      well as by the CHECK constraint — so the form can never send a pairing the
 *      database will reject.
 *
 *   2. TWO STATES, AND ONLY TWO. Open and Resolved. Carry-forward eligibility is
 *      derived from that one field, so "a resolved issue never comes back" is a
 *      one-line consequence rather than a behaviour spread over four screens.
 *
 *   3. THE BOARD CANNOT LIE. A filter that silently matches nothing, or a "still
 *      to discuss" count that includes items resolved last month, is how a review
 *      starts skipping things.
 *
 *   4. EARLIER MEANS EARLIER. A later meeting is not previous history for an
 *      earlier one — opening last month's review must show what was known then.
 *
 *   5. HISTORY IS GROUPED BY MEETING, NEWEST FIRST, and one issue's thread never
 *      picks up another issue's updates even when both are on the same order.
 *
 * Run:
 *   npx tsx --test src/lib/meetings/discussion.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  AFTER_SALES_TAGS, DISCUSSION_CATEGORIES, DISCUSSION_CATEGORY_META,
  DISCUSSION_FILTERS, DISCUSSION_STATE_META,
  afterSalesTagAllowed, buildDiscussionRows, carriesForward, categoryForMeetingType,
  discussionSummary, earlierDiscussionHistory, filterDiscussionRows, groupDiscussionHistory, heldBefore,
  latestResolutionNote,
  isAfterSalesTag, isDiscussedHere, isDiscussionCategory, isInInbox,
  matchesDiscussionFilter, meetingTypeForCategory, sortDiscussionRows, stateInMeeting,
  type DiscussionItemState, type DiscussionRow,
  type MeetingDiscussionAppearance, type MeetingDiscussionEvent, type MeetingDiscussionItem,
} from './discussion'
import type { MeetingOrderEvidence } from './types'

// ─── Fixtures ────────────────────────────────────────────────────────────────

let seq = 0
const id = (prefix: string) => `${prefix}-${++seq}`

function makeItem(over: Partial<MeetingDiscussionItem> = {}): MeetingDiscussionItem {
  return {
    id: id('item'),
    category: 'running_order',
    after_sales_tag: null,
    order_number: '2041',
    order_number_key: '2041',
    customer_name: 'Acme',
    title: 'Fabric approval pending',
    details: null,
    source_task_id: null,
    state: 'open',
    created_by: 'u1',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    resolved_at: null,
    resolved_by: null,
    ...over,
  }
}

function makeAppearance(
  itemId: string,
  over: Partial<MeetingDiscussionAppearance> = {},
): MeetingDiscussionAppearance {
  return {
    id: id('app'),
    meeting_id: 'm1',
    discussion_item_id: itemId,
    meeting_order_id: null,
    agenda_position: 1,
    carried_from_id: null,
    placement: 'manual',
    latest_update: null,
    decision: null,
    next_review_date: null,
    discussed_at: null,
    discussed_by: null,
    created_by: 'u1',
    created_at: '2026-01-02T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    ...over,
  }
}

function makeEvent(over: Partial<MeetingDiscussionEvent> = {}): MeetingDiscussionEvent {
  return {
    id: id('ev'),
    discussion_item_id: 'item-x',
    meeting_id: 'm1',
    appearance_id: null,
    order_number: '2041',
    meeting_title: 'New Order Review',
    event_type: 'update',
    previous_update: null,
    new_update: null,
    previous_state: null,
    new_state: null,
    previous_review_date: null,
    new_review_date: null,
    task_id: null,
    detail: null,
    actor_id: 'u1',
    created_at: '2026-01-02T10:00:00Z',
    ...over,
  }
}

function makeEvidence(appearanceId: string | null, at: string): MeetingOrderEvidence {
  return {
    id: id('img'),
    meeting_id: 'm1',
    meeting_order_id: 'o1',
    order_number: '2041',
    storage_path: `o1/${id('path')}.jpg`,
    file_name: 'screenshot.jpg',
    mime_type: 'image/jpeg',
    size_bytes: 1000,
    uploaded_by: 'u1',
    created_at: at,
    discussion_appearance_id: appearanceId,
  }
}

function makeRow(
  item: MeetingDiscussionItem,
  appearance: MeetingDiscussionAppearance,
  over: Partial<DiscussionRow> = {},
): DiscussionRow {
  return {
    item,
    appearance,
    earlierMeetings: 0,
    evidenceCount: 0,
    linkedTaskIds: [],
    resolvedHere: false,
    // A live meeting's fixture: what it shows is the state now.
    recordedState: item.state,
    resolution: null,
    changedSince: false,
    ...over,
  }
}

// ─── 1. Categories ───────────────────────────────────────────────────────────

describe('there are exactly two primary categories', () => {
  test('the list is Running Order and After Sales, and nothing else', () => {
    assert.deepEqual(DISCUSSION_CATEGORIES, ['running_order', 'after_sales'])
    assert.equal(Object.keys(DISCUSSION_CATEGORY_META).length, 2)
  })

  test('the validator accepts those two and refuses everything else', () => {
    for (const category of DISCUSSION_CATEGORIES) {
      assert.ok(isDiscussionCategory(category))
    }
    // Every near miss a form, an import or a hand-written RPC call could produce.
    for (const bad of ['repair', 'new_order', 'RUNNING_ORDER', '', null, undefined, 0, {}]) {
      assert.equal(isDiscussionCategory(bad), false, `${String(bad)} must not be a category`)
    }
  })

  test('both categories are labelled, and the two labels are different words', () => {
    assert.equal(DISCUSSION_CATEGORY_META.running_order.label, 'Running Order')
    assert.equal(DISCUSSION_CATEGORY_META.after_sales.label, 'After Sales')
  })

  test('every category carries a label as well as a colour', () => {
    // Colour alone must never be the carrier of meaning. A category with an empty
    // label would leave the badge as a coloured rectangle.
    for (const category of DISCUSSION_CATEGORIES) {
      assert.ok(DISCUSSION_CATEGORY_META[category].label.trim().length > 0)
    }
    for (const state of ['open', 'resolved'] as DiscussionItemState[]) {
      assert.ok(DISCUSSION_STATE_META[state].label.trim().length > 0)
    }
  })
})

describe('an after-sales tag is a tag, never a third category', () => {
  test('the four tags are recognised and nothing else is', () => {
    assert.deepEqual(AFTER_SALES_TAGS, ['repair', 'replacement', 'site_issue', 'other'])
    for (const tag of AFTER_SALES_TAGS) assert.ok(isAfterSalesTag(tag))
    for (const bad of ['Repair', 'site issue', '', null, 3]) {
      assert.equal(isAfterSalesTag(bad), false)
    }
  })

  test('a tag is refused on a running-order issue — the same rule as the CHECK', () => {
    assert.equal(afterSalesTagAllowed('after_sales', 'repair'), true)
    assert.equal(afterSalesTagAllowed('running_order', 'repair'), false)
  })

  test('no tag at all is always allowed, however it is spelled as empty', () => {
    for (const empty of [null, undefined, '']) {
      assert.equal(afterSalesTagAllowed('running_order', empty), true)
      assert.equal(afterSalesTagAllowed('after_sales', empty), true)
    }
  })

  test('an unknown tag is refused even on an after-sales issue', () => {
    assert.equal(afterSalesTagAllowed('after_sales', 'warranty'), false)
  })
})

describe('a category maps to exactly one review type, both ways', () => {
  test('running orders belong in the New Order review, after sales in Repair Order', () => {
    assert.equal(meetingTypeForCategory('running_order'), 'new_order')
    assert.equal(meetingTypeForCategory('after_sales'), 'repair_order')
  })

  test('the mapping round-trips, so carry-forward and the Inbox agree', () => {
    for (const category of DISCUSSION_CATEGORIES) {
      assert.equal(categoryForMeetingType(meetingTypeForCategory(category)), category)
    }
    for (const type of ['new_order', 'repair_order'] as const) {
      assert.equal(meetingTypeForCategory(categoryForMeetingType(type)), type)
    }
  })
})

// ─── 2. States ───────────────────────────────────────────────────────────────

describe('an issue has two states, and carry-forward follows from that alone', () => {
  test('an open issue carries forward; a resolved one does not', () => {
    assert.equal(carriesForward({ state: 'open' }), true)
    assert.equal(carriesForward({ state: 'resolved' }), false)
  })

  test('the Inbox is "open, and on no agenda"', () => {
    assert.equal(isInInbox(0, { state: 'open' }), true)
    // Once it is on a meeting it is not waiting for one.
    assert.equal(isInInbox(1, { state: 'open' }), false)
    // A resolved issue is finished, not waiting.
    assert.equal(isInInbox(0, { state: 'resolved' }), false)
  })

  test('there is no third state anywhere in the module', () => {
    assert.deepEqual(Object.keys(DISCUSSION_STATE_META).sort(), ['open', 'resolved'])
    // Task execution states must not leak into Meetings.
    for (const taskState of ['pending', 'working', 'waiting', 'blocked', 'completed', 'cancelled']) {
      assert.ok(!(taskState in DISCUSSION_STATE_META), `${taskState} is a TASK state`)
    }
  })
})

// ─── 3. The board ────────────────────────────────────────────────────────────

describe('the board filters', () => {
  const runningOpen   = makeRow(makeItem({ category: 'running_order', state: 'open' }), makeAppearance('a'))
  const afterResolved = makeRow(
    makeItem({
      category: 'after_sales', state: 'resolved', title: 'Repair required',
      resolved_at: 'x', resolved_by: 'u',
    }),
    makeAppearance('b'),
  )
  const rows = [runningOpen, afterResolved]

  test('every filter offered is a filter that works', () => {
    // A control the reducer does not handle would match nothing and read as "no
    // items", which is the silent failure this covers.
    for (const filter of DISCUSSION_FILTERS) {
      const matched = rows.filter(row => matchesDiscussionFilter(row, filter))
      assert.ok(matched.length > 0, `${filter} matched nothing`)
    }
  })

  test('All shows everything; the category filters split it; the state filters cross it', () => {
    assert.equal(filterDiscussionRows(rows, 'all').length, 2)
    assert.deepEqual(filterDiscussionRows(rows, 'running_order'), [runningOpen])
    assert.deepEqual(filterDiscussionRows(rows, 'after_sales'), [afterResolved])
    assert.deepEqual(filterDiscussionRows(rows, 'open'), [runningOpen])
    assert.deepEqual(filterDiscussionRows(rows, 'resolved'), [afterResolved])
  })

  test('search looks at the order, the customer, the issue and the latest position', () => {
    const row = makeRow(
      makeItem({ order_number: '7788', customer_name: 'Blue Lagoon', title: 'Polishing delay' }),
      makeAppearance('c', { latest_update: 'Vendor promised Friday' }),
    )
    for (const needle of ['7788', 'blue lagoon', 'POLISHING', 'friday']) {
      assert.equal(filterDiscussionRows([row], 'all', needle).length, 1, needle)
    }
    assert.equal(filterDiscussionRows([row], 'all', 'nothing here').length, 0)
  })

  test('search and the filter are applied together, not one instead of the other', () => {
    // "fabric" matches only the OPEN running-order row, so the Resolved filter
    // must return nothing — a filter that ignored the search would return one.
    assert.equal(filterDiscussionRows(rows, 'resolved', 'fabric').length, 0)
    assert.equal(filterDiscussionRows(rows, 'resolved', 'repair').length, 1)
    assert.equal(filterDiscussionRows(rows, 'open', 'repair').length, 0)
  })
})

describe('the meeting summary', () => {
  test('discussed, still to discuss and resolved today are counted separately', () => {
    const rows = [
      // discussed today
      makeRow(makeItem(), makeAppearance('a', { discussed_at: '2026-01-02T10:00:00Z', discussed_by: 'u1' })),
      // inherited, not yet touched
      makeRow(makeItem(), makeAppearance('b')),
      // resolved in THIS meeting
      makeRow(
        makeItem({ state: 'resolved', resolved_at: 'x', resolved_by: 'u' }),
        makeAppearance('c', { discussed_at: '2026-01-02T11:00:00Z', discussed_by: 'u1' }),
        { resolvedHere: true },
      ),
    ]
    assert.deepEqual(discussionSummary(rows), {
      total: 3, discussed: 2, toDiscuss: 1, resolvedHere: 1,
    })
  })

  test('an issue resolved in an EARLIER meeting is not work still to do here', () => {
    // The defect this exists for: counting it would tell the meeting it has an
    // outstanding item that nobody can act on, every month, forever.
    const rows = [makeRow(
      makeItem({ state: 'resolved', resolved_at: 'x', resolved_by: 'u' }),
      makeAppearance('a'),
    )]
    const summary = discussionSummary(rows)
    assert.equal(summary.toDiscuss, 0)
    assert.equal(summary.resolvedHere, 0)
  })

  test('"discussed" is exactly "has a discussed_at", never "has an update"', () => {
    assert.equal(isDiscussedHere({ discussed_at: null }), false)
    assert.equal(isDiscussedHere({ discussed_at: '2026-01-02T00:00:00Z' }), true)
  })
})

describe('agenda order', () => {
  test('rows sort by the position carry-forward gave them, then by when added', () => {
    const a = makeRow(makeItem(), makeAppearance('a', { agenda_position: 2, created_at: '2026-01-02T00:00:00Z' }))
    const b = makeRow(makeItem(), makeAppearance('b', { agenda_position: 1, created_at: '2026-01-02T00:00:00Z' }))
    const c = makeRow(makeItem(), makeAppearance('c', { agenda_position: 2, created_at: '2026-01-01T00:00:00Z' }))
    assert.deepEqual(sortDiscussionRows([a, b, c]).map(r => r.appearance.id),
      [b.appearance.id, c.appearance.id, a.appearance.id])
  })
})

// ─── 4. Earlier means earlier ────────────────────────────────────────────────

describe('"held before" is by meeting date, then by when the meeting was raised', () => {
  test('an earlier date is earlier', () => {
    assert.equal(
      heldBefore({ meeting_date: '2026-01-01', created_at: 'z' }, { meeting_date: '2026-02-01', created_at: 'a' }),
      true,
    )
  })

  test('two meetings on the same day still have an order', () => {
    assert.equal(
      heldBefore(
        { meeting_date: '2026-01-01', created_at: '2026-01-01T08:00:00Z' },
        { meeting_date: '2026-01-01', created_at: '2026-01-01T14:00:00Z' },
      ),
      true,
    )
  })

  test('a later meeting is never earlier than this one', () => {
    assert.equal(
      heldBefore({ meeting_date: '2026-03-01', created_at: 'a' }, { meeting_date: '2026-02-01', created_at: 'z' }),
      false,
    )
  })
})

describe('buildDiscussionRows', () => {
  const current = { id: 'm2', meeting_date: '2026-02-01', created_at: '2026-02-01T09:00:00Z' }
  const item = makeItem()
  const here = makeAppearance(item.id, { meeting_id: 'm2' })

  test('only meetings held BEFORE this one count as earlier', () => {
    const rows = buildDiscussionRows({
      appearances: [here],
      itemsById: new Map([[item.id, item]]),
      events: [],
      evidence: [],
      earlierAppearances: [
        // before → counts
        { discussion_item_id: item.id, meeting_id: 'm1', meeting: { meeting_date: '2026-01-01', created_at: 'a' } },
        // after → does not
        { discussion_item_id: item.id, meeting_id: 'm3', meeting: { meeting_date: '2026-03-01', created_at: 'a' } },
        // this meeting itself → does not
        { discussion_item_id: item.id, meeting_id: 'm2', meeting: { meeting_date: '2026-02-01', created_at: '2026-02-01T09:00:00Z' } },
      ],
      currentMeeting: current,
    })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].earlierMeetings, 1)
  })

  test('an appearance whose meeting could not be read is not counted as earlier', () => {
    const rows = buildDiscussionRows({
      appearances: [here],
      itemsById: new Map([[item.id, item]]),
      events: [],
      evidence: [],
      earlierAppearances: [{ discussion_item_id: item.id, meeting_id: 'm9', meeting: null }],
      currentMeeting: current,
    })
    assert.equal(rows[0].earlierMeetings, 0)
  })

  test('evidence and tasks are counted per APPEARANCE, so two issues on one order stay apart', () => {
    const other = makeItem({ order_number: '2041' })
    const otherHere = makeAppearance(other.id, { meeting_id: 'm2', agenda_position: 2 })
    const rows = buildDiscussionRows({
      appearances: [here, otherHere],
      itemsById: new Map([[item.id, item], [other.id, other]]),
      events: [
        makeEvent({ discussion_item_id: item.id, appearance_id: here.id, event_type: 'task_linked', task_id: 't1' }),
        makeEvent({ discussion_item_id: item.id, appearance_id: here.id, event_type: 'task_linked', task_id: 't1' }),
        makeEvent({ discussion_item_id: other.id, appearance_id: otherHere.id, event_type: 'task_linked', task_id: 't2' }),
      ],
      evidence: [makeEvidence(here.id, '2026-02-01T10:00:00Z')],
      currentMeeting: current,
    })
    const first  = rows.find(r => r.appearance.id === here.id)!
    const second = rows.find(r => r.appearance.id === otherHere.id)!
    // The same task linked twice is one task, not two.
    assert.deepEqual(first.linkedTaskIds, ['t1'])
    assert.deepEqual(second.linkedTaskIds, ['t2'])
    assert.equal(first.evidenceCount, 1)
    assert.equal(second.evidenceCount, 0)
  })

  test('evidence with no appearance is ORDER evidence and belongs to no issue', () => {
    const rows = buildDiscussionRows({
      appearances: [here],
      itemsById: new Map([[item.id, item]]),
      events: [],
      evidence: [makeEvidence(null, '2026-02-01T10:00:00Z')],
      currentMeeting: current,
    })
    assert.equal(rows[0].evidenceCount, 0)
  })

  test('resolvedHere is true only when the resolve event happened on THIS appearance', () => {
    const resolvedItem = makeItem({ state: 'resolved', resolved_at: 'x', resolved_by: 'u' })
    const hereApp = makeAppearance(resolvedItem.id, { meeting_id: 'm2' })
    const rows = buildDiscussionRows({
      appearances: [hereApp],
      itemsById: new Map([[resolvedItem.id, resolvedItem]]),
      events: [makeEvent({
        discussion_item_id: resolvedItem.id, appearance_id: 'some-other-appearance', event_type: 'resolved',
      })],
      evidence: [],
      currentMeeting: current,
    })
    assert.equal(rows[0].resolvedHere, false)
  })

  test('an appearance whose issue did not come back is dropped, not half-rendered', () => {
    const rows = buildDiscussionRows({
      appearances: [makeAppearance('missing-item', { meeting_id: 'm2' })],
      itemsById: new Map(),
      events: [],
      evidence: [],
      earlierAppearances: [],
      currentMeeting: current,
    })
    assert.equal(rows.length, 0)
  })
})

// ─── 5. History ──────────────────────────────────────────────────────────────

describe('one issue’s history, grouped by meeting', () => {
  const item = makeItem()
  const m1 = { id: 'm1', title: 'January Review', meeting_date: '2026-01-01', created_at: '2026-01-01T09:00:00Z' }
  const m2 = { id: 'm2', title: 'February Review', meeting_date: '2026-02-01', created_at: '2026-02-01T09:00:00Z' }
  const m3 = { id: 'm3', title: 'March Review', meeting_date: '2026-03-01', created_at: '2026-03-01T09:00:00Z' }
  const meetingsById = new Map([[m1.id, m1], [m2.id, m2], [m3.id, m3]])

  const a1 = makeAppearance(item.id, { meeting_id: 'm1', latest_update: 'Issue recorded.' })
  const a2 = makeAppearance(item.id, { meeting_id: 'm2', latest_update: 'Vendor response pending.', carried_from_id: a1.id })
  const a3 = makeAppearance(item.id, { meeting_id: 'm3', latest_update: 'Repair approved.', carried_from_id: a2.id })

  const groups = groupDiscussionHistory({
    appearances: [a1, a2, a3],
    meetingsById,
    events: [
      makeEvent({ discussion_item_id: item.id, appearance_id: a1.id, new_update: 'Issue recorded.', created_at: '2026-01-01T10:00:00Z' }),
      makeEvent({ discussion_item_id: item.id, appearance_id: a2.id, new_update: 'Vendor response pending.', created_at: '2026-02-01T10:00:00Z' }),
      makeEvent({ discussion_item_id: item.id, appearance_id: a3.id, new_update: 'Repair approved.', created_at: '2026-03-01T10:00:00Z' }),
      // The capture: no meeting, no appearance.
      makeEvent({ discussion_item_id: item.id, meeting_id: null, appearance_id: null, event_type: 'captured', created_at: '2025-12-30T10:00:00Z' }),
    ],
    evidence: [makeEvidence(a2.id, '2026-02-01T11:00:00Z')],
    currentMeetingId: 'm3',
  })

  test('newest meeting first', () => {
    assert.deepEqual(
      groups.filter(g => g.meetingId).map(g => g.meetingTitle),
      ['March Review', 'February Review', 'January Review'],
    )
  })

  test('each group carries only its OWN meeting’s position — nothing is copied forward', () => {
    const byTitle = new Map(groups.map(g => [g.meetingTitle, g]))
    assert.equal(byTitle.get('January Review')!.update, 'Issue recorded.')
    assert.equal(byTitle.get('February Review')!.update, 'Vendor response pending.')
    assert.equal(byTitle.get('March Review')!.update, 'Repair approved.')
  })

  test('each group holds only its own events and images', () => {
    const feb = groups.find(g => g.meetingTitle === 'February Review')!
    assert.equal(feb.events.length, 1)
    assert.equal(feb.events[0].new_update, 'Vendor response pending.')
    assert.equal(feb.evidence.length, 1)
    const jan = groups.find(g => g.meetingTitle === 'January Review')!
    assert.equal(jan.evidence.length, 0)
  })

  test('the meeting currently open is marked, so the screen can say "this meeting"', () => {
    assert.equal(groups.find(g => g.meetingId === 'm3')!.isCurrent, true)
    assert.equal(groups.find(g => g.meetingId === 'm1')!.isCurrent, false)
  })

  test('events with no meeting land in their own final group, not in a real meeting', () => {
    const loose = groups[groups.length - 1]
    assert.equal(loose.meetingId, null)
    assert.equal(loose.events.length, 1)
    assert.equal(loose.events[0].event_type, 'captured')
  })

  test('a meeting the reader cannot see is named as such, never invented', () => {
    const hidden = groupDiscussionHistory({
      appearances: [makeAppearance(item.id, { meeting_id: 'secret' })],
      meetingsById: new Map(),
      events: [],
      evidence: [],
    })
    assert.equal(hidden[0].meetingTitle, 'A meeting you cannot see')
    assert.equal(hidden[0].meetingDate, null)
  })

  test('two independent issues on the SAME order keep separate threads', () => {
    // The reason a persistent discussion item exists at all: order number is not
    // the identity of a business issue.
    const repair      = makeItem({ order_number: '2041', category: 'after_sales', title: 'Repair required' })
    const production  = makeItem({ order_number: '2041', category: 'running_order', title: 'Production delay' })
    const repairApp     = makeAppearance(repair.id, { meeting_id: 'm1', latest_update: 'Vendor booked' })
    const productionApp = makeAppearance(production.id, { meeting_id: 'm1', latest_update: 'Line freed up' })

    const repairGroups = groupDiscussionHistory({
      appearances: [repairApp],
      meetingsById,
      events: [
        makeEvent({ discussion_item_id: repair.id, appearance_id: repairApp.id, new_update: 'Vendor booked' }),
        makeEvent({ discussion_item_id: production.id, appearance_id: productionApp.id, new_update: 'Line freed up' }),
      ],
      evidence: [],
    })

    assert.equal(repairGroups.filter(g => g.meetingId).length, 1)
    const only = repairGroups[0]
    assert.equal(only.update, 'Vendor booked')
    // The other issue's update reached the "no meeting" bucket, never this thread.
    assert.deepEqual(only.events.map(e => e.new_update), ['Vendor booked'])
  })

  test('events inside a group read oldest first — the order they happened in', () => {
    const app = makeAppearance(item.id, { meeting_id: 'm1' })
    const result = groupDiscussionHistory({
      appearances: [app],
      meetingsById,
      events: [
        makeEvent({ discussion_item_id: item.id, appearance_id: app.id, new_update: 'second', created_at: '2026-01-01T12:00:00Z' }),
        makeEvent({ discussion_item_id: item.id, appearance_id: app.id, new_update: 'first',  created_at: '2026-01-01T10:00:00Z' }),
      ],
      evidence: [],
    })
    assert.deepEqual(result[0].events.map(e => e.new_update), ['first', 'second'])
  })
})

// ─── The colours stay inside the BOE palette ─────────────────────────────────

describe('no new colour enters the design system', () => {
  test('Running Order uses the existing blue/info family and After Sales the amber/warning one', () => {
    // These are the exact values ITEM_STATUS_META.open and .waiting already use, so
    // the guide, the board and every badge agree without a second palette.
    assert.deepEqual(DISCUSSION_CATEGORY_META.running_order,
      { label: 'Running Order', bg: '#EFF6FF', color: '#1E40AF', border: '#BFDBFE' })
    assert.deepEqual(DISCUSSION_CATEGORY_META.after_sales,
      { label: 'After Sales', bg: '#FFFBEB', color: '#92400E', border: '#FDE68A' })
  })

  test('the two category colours are distinguishable from each other', () => {
    assert.notEqual(DISCUSSION_CATEGORY_META.running_order.color, DISCUSSION_CATEGORY_META.after_sales.color)
  })

  test('a category colour is never reused for a state, so the two axes cannot be confused', () => {
    const categoryColours = DISCUSSION_CATEGORIES.map(c => DISCUSSION_CATEGORY_META[c].color)
    for (const state of ['open', 'resolved'] as DiscussionItemState[]) {
      assert.ok(!categoryColours.includes(DISCUSSION_STATE_META[state].color),
        `${state} wears a category colour`)
    }
  })
})

// ─── A completed meeting keeps showing what happened in it ───────────────────

describe('the state a meeting shows is the state it RECORDED', () => {
  const ITEM = 'item-history'
  const resolvedInM2 = makeEvent({
    discussion_item_id: ITEM, event_type: 'resolved', appearance_id: 'app-m2',
    detail: 'Repair accepted on site', actor_name: 'Priya', created_at: '2026-02-01T11:00:00Z',
  })
  const reopenedLater = makeEvent({
    discussion_item_id: ITEM, event_type: 'reopened', appearance_id: null, meeting_id: null,
    detail: 'Same fault reported again', created_at: '2026-03-10T09:00:00Z',
  })

  const m1 = { status: 'completed' as const, completed_at: '2026-01-01T18:00:00Z' }
  const m2 = { status: 'completed' as const, completed_at: '2026-02-01T18:00:00Z' }
  const live = { status: 'in_progress' as const, completed_at: null }

  test('M1, completed while the issue was open, still shows Open after it is resolved', () => {
    const state = stateInMeeting([resolvedInM2], 'resolved', m1)
    assert.equal(state.recorded, 'open')
    assert.equal(state.current, 'resolved')
    assert.equal(state.changedSince, true)
    assert.equal(state.resolution, null)
  })

  test('M2, where it was resolved, still shows Resolved — with the original note — after a reopen', () => {
    const state = stateInMeeting([resolvedInM2, reopenedLater], 'open', m2)
    assert.equal(state.recorded, 'resolved')
    assert.equal(state.current, 'open')
    assert.equal(state.changedSince, true)
    // The note comes from the EVENT; the item's own resolution_note was cleared by
    // the reopen, so it could not be the source.
    assert.equal(state.resolution?.detail, 'Repair accepted on site')
    assert.equal(state.resolution?.actor_name, 'Priya')
  })

  test('a live meeting shows the state now, and reports nothing as changed', () => {
    const state = stateInMeeting([resolvedInM2, reopenedLater], 'open', live)
    assert.equal(state.recorded, 'open')
    assert.equal(state.changedSince, false)
  })

  test('events are replayed in time order, whatever order they arrive in', () => {
    const resolvedAgain = makeEvent({
      discussion_item_id: ITEM, event_type: 'resolved', detail: 'Fixed for good',
      created_at: '2026-03-20T10:00:00Z',
    })
    const later = { status: 'completed' as const, completed_at: '2026-03-25T18:00:00Z' }
    const state = stateInMeeting([resolvedAgain, reopenedLater, resolvedInM2], 'resolved', later)
    assert.equal(state.recorded, 'resolved')
    assert.equal(state.resolution?.detail, 'Fixed for good')
    assert.equal(state.changedSince, false)
  })

  test('a completed meeting with no completion time falls back to the state now', () => {
    const state = stateInMeeting([resolvedInM2], 'resolved', { status: 'completed', completed_at: null })
    assert.equal(state.recorded, 'resolved')
    assert.equal(state.changedSince, false)
  })

  test('the board filters and counts by the RECORDED state, not the state now', () => {
    const item = makeItem({ state: 'open' })
    const app = makeAppearance(item.id, { meeting_id: 'm2' })
    const rows = buildDiscussionRows({
      appearances: [app],
      itemsById: new Map([[item.id, item]]),
      events: [
        { ...resolvedInM2, discussion_item_id: item.id, appearance_id: app.id },
        { ...reopenedLater, discussion_item_id: item.id },
      ],
      evidence: [],
      currentMeeting: { id: 'm2', meeting_date: '2026-02-01', created_at: '2026-02-01T09:00:00Z', ...m2 },
    })
    assert.equal(rows[0].recordedState, 'resolved')
    assert.equal(rows[0].item.state, 'open', 'the item itself is open now')
    assert.equal(filterDiscussionRows(rows, 'resolved').length, 1)
    assert.equal(filterDiscussionRows(rows, 'open').length, 0)
    assert.equal(discussionSummary(rows).toDiscuss, 0, 'a meeting that resolved it has nothing left to discuss')
    assert.equal(rows[0].changedSince, true)
  })
})

// ─── Review fixes (PR #164) ──────────────────────────────────────────────────

describe('"Earlier meetings" is strictly earlier', () => {
  const meetingsById = new Map([
    ['m-jan', { id: 'm-jan', title: 'January', meeting_date: '2026-01-10', created_at: '2026-01-01T00:00:00Z' }],
    ['m-feb', { id: 'm-feb', title: 'February', meeting_date: '2026-02-10', created_at: '2026-02-01T00:00:00Z' }],
    ['m-feb-2', { id: 'm-feb-2', title: 'February, second', meeting_date: '2026-02-10', created_at: '2026-02-02T00:00:00Z' }],
    ['m-mar', { id: 'm-mar', title: 'March', meeting_date: '2026-03-10', created_at: '2026-03-01T00:00:00Z' }],
  ])
  const appearances = ['m-jan', 'm-feb', 'm-feb-2', 'm-mar'].map(meetingId =>
    makeAppearance('item-h', { id: `app-${meetingId}`, meeting_id: meetingId }))
  const events = [
    makeEvent({ discussion_item_id: 'item-h', meeting_id: null, event_type: 'captured', created_at: '2026-01-05T00:00:00Z' }),
    makeEvent({ discussion_item_id: 'item-h', meeting_id: null, event_type: 'reopened', created_at: '2026-02-20T00:00:00Z' }),
  ]
  const history = groupDiscussionHistory({ appearances, meetingsById, events, evidence: [], currentMeetingId: 'm-feb' })

  test('opening a completed February meeting shows January only — never February or March', () => {
    const earlier = earlierDiscussionHistory(history, {
      id: 'm-feb', meeting_date: '2026-02-10', created_at: '2026-02-01T00:00:00Z',
      status: 'completed', completed_at: '2026-02-11T00:00:00Z',
    })
    assert.deepEqual(earlier.filter(g => g.meetingId !== null).map(g => g.meetingId), ['m-jan'])
    // Outside a meeting: the capture came before; the reopen came after it closed.
    const loose = earlier.find(g => g.meetingId === null)
    assert.deepEqual(loose?.events.map(e => e.event_type), ['captured'])
  })

  test('the same date is settled by which meeting was raised first', () => {
    const earlier = earlierDiscussionHistory(history, {
      id: 'm-feb-2', meeting_date: '2026-02-10', created_at: '2026-02-02T00:00:00Z', status: 'in_progress',
    })
    assert.deepEqual(earlier.filter(g => g.meetingId !== null).map(g => g.meetingId).sort(), ['m-feb', 'm-jan'])
  })

  test('a group whose meeting did not come back is not guessed to be earlier', () => {
    const blind = groupDiscussionHistory({
      appearances: [makeAppearance('item-h', { id: 'app-unknown', meeting_id: 'm-unknown' })],
      meetingsById, events: [], evidence: [], currentMeetingId: 'm-mar',
    })
    assert.deepEqual(earlierDiscussionHistory(blind, {
      id: 'm-mar', meeting_date: '2026-03-10', created_at: '2026-03-01T00:00:00Z', status: 'in_progress',
    }), [])
  })
})

describe('"resolved today" counts only a resolution still in force', () => {
  const meeting = { id: 'm1', meeting_date: '2026-01-02', created_at: '2026-01-01T00:00:00Z', status: 'in_progress' as const }

  test('resolved here and still resolved: counted', () => {
    const item = makeItem({ id: 'i-live', state: 'resolved', resolved_at: 'x', resolved_by: 'u' })
    const appearance = makeAppearance(item.id, { id: 'a-live' })
    const rows = buildDiscussionRows({
      appearances: [appearance], itemsById: new Map([[item.id, item]]), evidence: [], currentMeeting: meeting,
      events: [makeEvent({ discussion_item_id: item.id, appearance_id: appearance.id, event_type: 'resolved', detail: 'Fixed' })],
    })
    assert.equal(rows[0].resolvedHere, true)
    assert.equal(discussionSummary(rows).resolvedHere, 1)
  })

  test('resolved here, then reopened in the same live meeting: not counted', () => {
    const item = makeItem({ id: 'i-reopened', state: 'open' })
    const appearance = makeAppearance(item.id, { id: 'a-reopened' })
    const rows = buildDiscussionRows({
      appearances: [appearance], itemsById: new Map([[item.id, item]]), evidence: [], currentMeeting: meeting,
      events: [
        makeEvent({ discussion_item_id: item.id, appearance_id: appearance.id, event_type: 'resolved', created_at: '2026-01-02T10:00:00Z' }),
        makeEvent({ discussion_item_id: item.id, meeting_id: null, event_type: 'reopened', created_at: '2026-01-02T11:00:00Z' }),
      ],
    })
    assert.equal(rows[0].resolvedHere, false)
    assert.equal(discussionSummary(rows).resolvedHere, 0)
  })

  test('resolved in ANOTHER meeting: not counted here', () => {
    const item = makeItem({ id: 'i-elsewhere', state: 'resolved', resolved_at: 'x', resolved_by: 'u' })
    const appearance = makeAppearance(item.id, { id: 'a-here' })
    const rows = buildDiscussionRows({
      appearances: [appearance], itemsById: new Map([[item.id, item]]), evidence: [], currentMeeting: meeting,
      events: [makeEvent({ discussion_item_id: item.id, appearance_id: 'a-elsewhere', meeting_id: 'm-other', event_type: 'resolved' })],
    })
    assert.equal(rows[0].resolvedHere, false)
  })
})

describe('the Reopen dialog quotes the resolution from the trail', () => {
  test('the latest visible resolution, and nothing when none is visible', () => {
    const events = [
      makeEvent({ discussion_item_id: 'i1', event_type: 'resolved', detail: 'First fix', created_at: '2026-01-01T00:00:00Z' }),
      makeEvent({ discussion_item_id: 'i1', event_type: 'resolved', detail: 'Second fix', created_at: '2026-03-01T00:00:00Z' }),
      makeEvent({ discussion_item_id: 'i2', event_type: 'resolved', detail: 'Other issue', created_at: '2026-04-01T00:00:00Z' }),
    ]
    assert.equal(latestResolutionNote(events, 'i1'), 'Second fix')
    assert.equal(latestResolutionNote(events, 'i3'), null)
  })

  test('the issue row type has no resolution_note to read', () => {
    assert.ok(!('resolution_note' in makeItem()))
  })
})
