/**
 * THE PNB/PAYTM CUSTODY TRAIL — who physically held the money.
 *
 * The pure half: which modes carry a trail, what a drafted activity must say
 * before it can be sent, how the five legacy columns are read back as events,
 * and how the two sources merge into one chronological list. Plus the source
 * contracts that keep the CONTROL append-only and keep the internal meaning of
 * an account off every screen.
 *
 * NONE OF THIS IS THE AUTHORIZATION. append_payment_custody_events re-derives
 * the actor and permits only a finance.approve / finance.manage holder or the
 * request's own submitter while it is unapproved; the applicable modes, the
 * required people, the future-date bound and the idempotency are all decided
 * again in SQL. Those are covered by supabase/tests/payment_custody_and_modes_assertions.sql.
 *
 * Run:
 *   npx tsx --test src/lib/finance/custodyTrail.test.ts
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CUSTODY_ACTIVITY_LABEL,
  CUSTODY_ACTIVITY_TYPES,
  CUSTODY_TRAIL_NOTE,
  CUSTODY_TRAIL_TITLE,
  custodyDraftError,
  custodyDraftsError,
  custodyEventLine,
  custodyTrail,
  custodyTrailUserIds,
  emptyCustodyDraft,
  isoToLocalInput,
  legacyCustodyEvents,
  localInputToIso,
  modeRequiresCustodyTrail,
  readCustodyEvent,
  toRpcCustodyEvents,
  type CustodyDraft,
  type CustodyEvent,
} from './custodyTrail'

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8')

const MIGRATION_114 = 'supabase/migrations/20261014000000_payment_destination_display_modes_and_custody.sql'
const TRAIL_CONTROL = 'src/app/finance/components/CustodyTrailFields.tsx'
const TRAIL_BLOCK   = 'src/app/finance/components/PaymentDestinationBlock.tsx'
const REQUEST_PAGE  = 'src/app/finance/page.tsx'
const RECORD_FORM   = 'src/app/finance/received/RecordSplitPaymentModal.tsx'

const draft = (over: Partial<CustodyDraft> = {}): CustodyDraft => ({
  ...emptyCustodyDraft('k-1'),
  occurredAt: '2026-08-20T14:30',
  collectedBy: 'user-1',
  ...over,
})

const handover = (over: Partial<CustodyDraft> = {}): CustodyDraft => ({
  ...emptyCustodyDraft('k-2', 'handed_over'),
  occurredAt: '2026-08-20T18:00',
  handedBy: 'user-1',
  handedTo: 'user-2',
  ...over,
})

const stored = (over: Partial<CustodyEvent> = {}): CustodyEvent => ({
  id: 'evt-1',
  activityType: 'collected',
  occurredAt: '2026-08-20T09:00:00.000Z',
  collectedBy: 'user-1',
  handedBy: null,
  handedTo: null,
  remark: null,
  paymentModeAtEvent: 'pnb',
  recordedBy: 'user-9',
  recordedAt: '2026-08-20T09:05:00.000Z',
  legacy: false,
  ...over,
})

const NAMES = new Map([
  ['user-1', 'Nishant'],
  ['user-2', 'Nitish'],
  ['user-9', 'Admin'],
])

// ═══════════════════════════════════════════════════════════════════════════
// 1. WHICH MODES CARRY A TRAIL
// ═══════════════════════════════════════════════════════════════════════════

describe('the trail belongs to the two modes a person carries', () => {
  test('PNB and Paytm, and nothing else', () => {
    assert.equal(modeRequiresCustodyTrail('pnb'), true)
    assert.equal(modeRequiresCustodyTrail('paytm'), true)
    for (const other of ['hdfc', 'canara', 'bank_transfer', 'cash', 'upi', 'cheque', 'other', '', null]) {
      assert.equal(modeRequiresCustodyTrail(other), false, String(other))
    }
  })

  test('the database decides the same two, in its own function', () => {
    assert.ok(read(MIGRATION_114).includes(
      "select btrim(lower(coalesce(p_mode, ''))) in ('pnb', 'paytm');"))
  })

  test('the control draws nothing for a mode nobody carries', () => {
    assert.ok(read(TRAIL_CONTROL).includes('if (!applies) return null'),
      'the editor must not render for a bank account')
  })

  test('no screen glosses an account name', () => {
    // The heading and its one sentence name the ACCOUNTS. "PNB" is what a person
    // reads; what PNB means internally lives in the database's column comment.
    assert.equal(/[(（][^)）]*[)）]/.test(CUSTODY_TRAIL_TITLE), false)
    assert.ok(CUSTODY_TRAIL_NOTE.includes('PNB and Paytm'))
    for (const file of [TRAIL_CONTROL, TRAIL_BLOCK, 'src/lib/finance/custodyTrail.ts']) {
      assert.equal(/hawala/i.test(read(file)), false, `${file} must not name what an account MEANS`)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. WHAT AN ACTIVITY MUST SAY
// ═══════════════════════════════════════════════════════════════════════════

describe('a drafted activity', () => {
  test('there are exactly two shapes, named as the product names them', () => {
    assert.deepEqual([...CUSTODY_ACTIVITY_TYPES], ['collected', 'handed_over'])
    assert.equal(CUSTODY_ACTIVITY_LABEL.collected, 'Collected')
    assert.equal(CUSTODY_ACTIVITY_LABEL.handed_over, 'Handed Over')
  })

  test('a complete one is accepted', () => {
    assert.equal(custodyDraftError(draft()), null)
    assert.equal(custodyDraftError(handover()), null)
  })

  test('every activity needs the date AND time it happened', () => {
    assert.match(custodyDraftError(draft({ occurredAt: '' })) ?? '', /date and time/)
    assert.match(custodyDraftError(handover({ occurredAt: '   ' })) ?? '', /date and time/)
  })

  test('a collection needs a collector', () => {
    assert.match(custodyDraftError(draft({ collectedBy: '' })) ?? '', /who collected/)
  })

  test('a handover needs BOTH ends, and two different people', () => {
    assert.match(custodyDraftError(handover({ handedBy: '' })) ?? '', /handed the money over/)
    assert.match(custodyDraftError(handover({ handedTo: '' })) ?? '', /who received/)
    assert.match(custodyDraftError(handover({ handedTo: 'user-1' })) ?? '', /two different people/)
  })

  test('a list names the row that is wrong', () => {
    assert.equal(custodyDraftsError([draft(), handover()]), null)
    assert.match(
      custodyDraftsError([draft(), handover({ handedTo: '' })]) ?? '',
      /^Activity 2: /)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. THE PAYLOAD
// ═══════════════════════════════════════════════════════════════════════════

describe('what is sent to the append door', () => {
  test('the key travels with the row — that is what defeats a retry', () => {
    const [sent] = toRpcCustodyEvents([draft({ key: 'stable-key' })])
    assert.equal(sent.key, 'stable-key')
  })

  test('the unused half of the shape is sent as null, never omitted', () => {
    const [collected] = toRpcCustodyEvents([draft()])
    assert.deepEqual(Object.keys(collected).sort(),
      ['activity_type', 'collected_by', 'handed_by', 'handed_to', 'key', 'occurred_at', 'remark'])
    assert.equal(collected.handed_by, null)
    assert.equal(collected.handed_to, null)

    const [handed] = toRpcCustodyEvents([handover()])
    assert.equal(handed.collected_by, null)
    assert.equal(handed.handed_by, 'user-1')
  })

  test('a local datetime is sent as an absolute instant', () => {
    // occurred_at is a timestamptz and the server bounds it against now().
    // Sending a bare local string would be wrong by the reader's offset.
    const [sent] = toRpcCustodyEvents([draft({ occurredAt: '2026-08-20T14:30' })])
    assert.equal(sent.occurred_at, new Date('2026-08-20T14:30').toISOString())
    assert.match(sent.occurred_at as string, /Z$/)
  })

  test('an empty remark is null, never an empty string', () => {
    assert.equal(toRpcCustodyEvents([draft({ remark: '   ' })])[0].remark, null)
    assert.equal(toRpcCustodyEvents([draft({ remark: ' at the office ' })])[0].remark, 'at the office')
  })

  test('a datetime round-trips through the control', () => {
    const iso = localInputToIso('2026-08-20T14:30')
    assert.equal(isoToLocalInput(iso), '2026-08-20T14:30')
    assert.equal(localInputToIso(''), null)
    assert.equal(localInputToIso('not a date'), null)
    assert.equal(isoToLocalInput(null), '')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. THE LEGACY FIVE COLUMNS, READ AS EVENTS
// ═══════════════════════════════════════════════════════════════════════════

describe('a payment recorded before the trail existed', () => {
  const legacyRow = {
    payment_mode: 'other',
    collected_by_user_id: 'user-1',
    collected_from_text: 'Ravi Traders',
    handed_over_to_user_id: 'user-2',
    handed_over_at: '2026-07-21',
    collection_handover_note: 'handed over at the office',
  }

  test('its five columns become the same two events, marked as legacy', () => {
    const events = legacyCustodyEvents(legacyRow, '2026-07-20')
    assert.deepEqual(events.map(e => e.activityType), ['collected', 'handed_over'])
    assert.ok(events.every(e => e.legacy), 'a projection must never pass as a stored event')
    // The columns carry no author and no recording time. Inventing them would
    // be inventing an audit trail.
    assert.ok(events.every(e => e.recordedBy === null && e.recordedAt === null))
  })

  test('the outside party is carried into the remark, which is where it lives now', () => {
    const [collection] = legacyCustodyEvents(legacyRow, '2026-07-20')
    assert.match(collection.remark ?? '', /Collected from Ravi Traders/)
    assert.match(collection.remark ?? '', /handed over at the office/)
  })

  test('a HALF-recorded handover is not projected as one', () => {
    // The DB CHECK forbids the pair, so it can only arrive from a stale read. It
    // must not become an event claiming the money moved.
    const events = legacyCustodyEvents({ ...legacyRow, handed_over_at: null }, null)
    assert.deepEqual(events.map(e => e.activityType), ['collected'])
    const other = legacyCustodyEvents({ ...legacyRow, handed_over_to_user_id: null }, null)
    assert.deepEqual(other.map(e => e.activityType), ['collected'])
  })

  test('a payment that carried nothing projects nothing', () => {
    assert.deepEqual(legacyCustodyEvents({
      payment_mode: 'hdfc',
      collected_by_user_id: null, collected_from_text: null,
      handed_over_to_user_id: null, handed_over_at: null, collection_handover_note: null,
    }, null), [])
  })

  test('it keeps the mode it was recorded under, not today\'s', () => {
    const [collection] = legacyCustodyEvents(legacyRow, '2026-07-20')
    assert.equal(collection.paymentModeAtEvent, 'other')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. ONE TRAIL, IN ORDER
// ═══════════════════════════════════════════════════════════════════════════

describe('the merged trail', () => {
  test('legacy projections and stored events sort together, by when they happened', () => {
    const events = custodyTrail(
      [stored({ id: 'b', occurredAt: '2026-08-20T12:00:00.000Z' }),
       stored({ id: 'a', occurredAt: '2026-08-20T09:00:00.000Z' })],
      legacyCustodyEvents({
        payment_mode: 'other',
        collected_by_user_id: 'user-1', collected_from_text: null,
        handed_over_to_user_id: 'user-2', handed_over_at: '2026-08-19',
        collection_handover_note: null,
      }, '2026-08-18'),
    )
    assert.deepEqual(events.map(e => e.id),
      ['legacy-collected', 'legacy-handed-over', 'a', 'b'])
  })

  test('an undated legacy collection sorts first — it is the only thing that can', () => {
    const events = custodyTrail([stored({ id: 'z' })], [
      { ...stored({ id: 'legacy-collected', occurredAt: '' }), legacy: true },
    ])
    assert.deepEqual(events.map(e => e.id), ['legacy-collected', 'z'])
  })

  test('the order is stable across reads', () => {
    const same = [stored({ id: 'b' }), stored({ id: 'a' })]
    assert.deepEqual(custodyTrail(same).map(e => e.id), ['a', 'b'])
    assert.deepEqual(custodyTrail([...same].reverse()).map(e => e.id), ['a', 'b'])
  })

  test('every person the trail names is resolved in one query', () => {
    const ids = custodyTrailUserIds([
      stored(), stored({ id: 'e2', activityType: 'handed_over', collectedBy: null, handedBy: 'user-1', handedTo: 'user-2' }),
    ])
    assert.deepEqual(ids.sort(), ['user-1', 'user-2', 'user-9'])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 6. HOW ONE ACTIVITY READS
// ═══════════════════════════════════════════════════════════════════════════

describe('one activity, as words', () => {
  test('a collection names the collector; a handover names both ends', () => {
    const collected = custodyEventLine(stored(), NAMES, iso => `D(${iso})`)
    assert.equal(collected.title, 'Collected')
    assert.equal(collected.people, 'Nishant')

    const handed = custodyEventLine(
      stored({ activityType: 'handed_over', collectedBy: null, handedBy: 'user-1', handedTo: 'user-2' }),
      NAMES, iso => `D(${iso})`)
    assert.equal(handed.title, 'Handed Over')
    assert.equal(handed.people, 'Nishant → Nitish')
  })

  test('a uuid is never rendered — an unresolved name says so', () => {
    const line = custodyEventLine(stored({ collectedBy: 'ghost' }), NAMES, iso => `D(${iso})`)
    assert.equal(line.people, 'Unknown user')
  })

  test('an undated legacy event says so rather than printing a blank', () => {
    const line = custodyEventLine(stored({ occurredAt: '', legacy: true }), NAMES, iso => `D(${iso})`)
    assert.equal(line.when, 'Date not recorded')
    assert.equal(line.legacy, true)
  })

  test('it prints the account the money was in AT THE TIME', () => {
    // A request corrected from PNB to Paytm keeps its earlier activities
    // labelled PNB — the money really did move under that mode.
    assert.equal(custodyEventLine(stored({ paymentModeAtEvent: 'pnb' }), NAMES, String).modeLabel, 'PNB')
    assert.equal(custodyEventLine(stored({ paymentModeAtEvent: 'paytm' }), NAMES, String).modeLabel, 'Paytm')
    // A legacy row keeps its own historical mode, spelled the way it always was.
    assert.equal(custodyEventLine(stored({ paymentModeAtEvent: 'other' }), NAMES, String).modeLabel, 'Other')
  })

  test('a stored row is read without inventing anything', () => {
    const event = readCustodyEvent({
      id: 'x', activity_type: 'handed_over', occurred_at: '2026-08-20T10:00:00.000Z',
      collected_by_user_id: null, handed_by_user_id: 'user-1', handed_to_user_id: 'user-2',
      remark: null, payment_mode_at_event: 'paytm', created_by: 'user-9', created_at: '2026-08-20T10:05:00.000Z',
    })
    assert.equal(event.legacy, false)
    assert.equal(event.activityType, 'handed_over')
    assert.equal(event.recordedBy, 'user-9')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 7. APPEND ONLY, AND THE CONTROLS SAY SO
// ═══════════════════════════════════════════════════════════════════════════

describe('a saved activity cannot be edited or removed', () => {
  test('the control offers Remove only for an UNSAVED row', () => {
    const src = read(TRAIL_CONTROL)
    // The remove button lives inside the drafts loop and nowhere else.
    const draftsFrom = src.indexOf('{drafts.map((draft, index) =>')
    assert.ok(draftsFrom > -1, 'the drafts loop could not be located')
    const savedComponent = src.slice(src.indexOf('function SavedActivity('), draftsFrom)
    assert.equal(/onClick=\{\(\) => remove\(/.test(savedComponent), false,
      'a saved activity must carry no remove control')
    assert.equal(/Remove/.test(savedComponent), false)
  })

  test('nothing anywhere updates or deletes a custody event', () => {
    for (const file of [TRAIL_CONTROL, TRAIL_BLOCK, REQUEST_PAGE, RECORD_FORM]) {
      const src = read(file)
      assert.equal(/from\('finance_payment_custody_events'\)[\s\S]{0,80}\.(update|delete|upsert|insert)\(/.test(src), false,
        `${file} must not write finance_payment_custody_events directly`)
    }
    // The only write path is the protected door.
    assert.ok(read(TRAIL_BLOCK).includes(".rpc('append_payment_custody_events'"))
  })

  test('and the database refuses an edit for every role', () => {
    const sql = read(MIGRATION_114)
    assert.ok(sql.includes('CUSTODY_EVENT_IMMUTABLE'))
    assert.ok(sql.includes('create trigger finance_payment_custody_events_immutable'))
    assert.ok(sql.includes('before update on public.finance_payment_custody_events'))
  })

  test('a retry and a double click both write nothing', () => {
    const sql = read(MIGRATION_114)
    assert.ok(sql.includes('on conflict do nothing'),
      'the insert must collapse a duplicate rather than raising')
    assert.ok(sql.includes('finance_payment_custody_events_key_idx'),
      'the caller\'s key defeats a retried submission')
    assert.ok(sql.includes('finance_payment_custody_events_natural_idx'),
      'and the natural key defeats a re-minted duplicate')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 8. THE THREE FORMS ASK IT, AND THE DETAIL VIEWS SHOW IT
// ═══════════════════════════════════════════════════════════════════════════

describe('every surface that should carry the trail does', () => {
  test('both Payment Request forms and Record Payment offer the editor', () => {
    const page = read(REQUEST_PAGE)
    assert.equal((page.match(/<CustodyTrailFields/g) ?? []).length, 2,
      'Send Payment Request AND Edit Payment Request must both offer it')
    assert.ok(read(RECORD_FORM).includes('<CustodyTrailFields'),
      'Record Payment must offer it too')
  })

  test('all three send it through the RPC, and only for a mode that carries one', () => {
    for (const file of [REQUEST_PAGE, RECORD_FORM]) {
      const src = read(file)
      assert.ok(src.includes('modeRequiresCustodyTrail('),
        `${file} must decide by the mode`)
      assert.ok(src.includes('toRpcCustodyEvents('),
        `${file} must send the activities through the shared serializer`)
      assert.ok(src.includes('p_custody_events'),
        `${file} must pass them to the protected door`)
    }
  })

  test('a mode change never sends the five retired columns', () => {
    for (const file of [REQUEST_PAGE, RECORD_FORM]) {
      const src = read(file)
      for (const gone of ['p_collected_by', 'p_collected_from', 'p_handed_over_to',
                          'p_handed_over_at', 'p_collection_note']) {
        assert.equal(src.includes(gone), false,
          `${file} must not send ${gone} — the five columns are history`)
      }
    }
  })

  test('both detail surfaces show the whole trail', () => {
    for (const file of [REQUEST_PAGE, 'src/app/finance/received/ReceivedPaymentsView.tsx']) {
      assert.ok(read(file).includes('<PaymentCustodyTrail'),
        `${file} must show who carried the money`)
    }
  })

  test('the trail is drawn even when the payment has since moved off a carried mode', () => {
    // Correcting a request from PNB to a bank account preserves its history —
    // what is withdrawn is the ability to add MORE.
    assert.ok(read(TRAIL_BLOCK).includes('if (!applies && events.length === 0) return null'),
      'a payment that has a trail must keep showing it')
  })
})
