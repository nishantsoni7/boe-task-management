/**
 * Payment destination + cash trail — pure logic.
 *
 * Run:
 *   npx tsx --test src/app/finance/paymentDestinations.test.ts
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_DESTINATION_KEY,
  EMPTY_COLLECTION_STATE,
  PAYMENT_DESTINATIONS,
  buildCollectionPayload,
  captureFor,
  collectionDisplayFor,
  collectionErrorFor,
  destinationDbPair,
  destinationFromDb,
  isPaymentDestinationKey,
  paymentDestinationLabel,
  readCollectionState,
  readDestinationKey,
  readDestinationKeyOrNull,
  destinationWritePair,
  type CollectionState,
  type PaymentDestinationKey,
  type StoredCollection,
} from './paymentDestinations'

const collection = (over: Partial<CollectionState> = {}): CollectionState => ({
  ...EMPTY_COLLECTION_STATE,
  ...over,
})

// A stored row on a given destination, with an empty cash trail by default.
const stored = (key: PaymentDestinationKey, over: Partial<StoredCollection> = {}): StoredCollection => ({
  ...destinationDbPair(key),
  collected_by_user_id:     null,
  collected_from_text:      null,
  handed_over_to_user_id:   null,
  handed_over_at:           null,
  collection_handover_note: null,
  ...over,
})

// Identity formatter: the helper's date handling is the host's business, so the
// tests assert WHICH value was formatted, not how.
const rawDate = (iso: string) => `D(${iso})`

const rowValue = (d: { rows: { label: string; value: string }[] } | null, label: string) =>
  d?.rows.find(r => r.label === label)?.value ?? null

// ── The four destinations ─────────────────────────────────────────────────────

test('there are exactly four destinations, offered accounts-first', () => {
  assert.deepEqual(
    PAYMENT_DESTINATIONS.map(d => d.key),
    ['hdfc', 'canara', 'paytm', 'pnb'],
  )
  assert.deepEqual(
    PAYMENT_DESTINATIONS.map(d => d.label),
    ['HDFC', 'Canara', 'Paytm', 'PNB'],
  )
})

test('every destination states what the account MEANS, not what it is called', () => {
  const helpers = Object.fromEntries(PAYMENT_DESTINATIONS.map(d => [d.key, d.helper]))
  assert.equal(helpers.hdfc,   'Company current account')
  assert.equal(helpers.canara, 'Savings account')
  assert.equal(helpers.paytm,  'Cash collected internally')
  assert.equal(helpers.pnb,    'Cash collected through an external source')
  // No destination is distinguished by its icon alone: every one carries a
  // visible label and a visible helper.
  for (const d of PAYMENT_DESTINATIONS) {
    assert.ok(d.label.trim().length > 0)
    assert.ok(d.helper.trim().length > 0)
    assert.ok(d.iconKey.trim().length > 0)
  }
})

test('a fresh form starts on HDFC, and an unknown key is rejected', () => {
  assert.equal(DEFAULT_DESTINATION_KEY, 'hdfc')
  assert.equal(isPaymentDestinationKey('hdfc'), true)
  // 'hawala' was the pre-destination UI key for PNB. It must not resolve.
  assert.equal(isPaymentDestinationKey('hawala'), false)
  assert.equal(isPaymentDestinationKey(''), false)
})

// ── Destination → stored pair ─────────────────────────────────────────────────
// These four pairs are the values already sitting in the table. Changing one
// would silently re-classify every historical row that carries it, so they are
// asserted literally rather than derived.

test('each destination maps to the pair the table has always stored', () => {
  assert.deepEqual(destinationDbPair('hdfc'),   { payment_mode: 'bank_transfer', received_in: 'company_account' })
  assert.deepEqual(destinationDbPair('canara'), { payment_mode: 'bank_transfer', received_in: 'savings_account' })
  assert.deepEqual(destinationDbPair('paytm'),  { payment_mode: 'cash',          received_in: 'cash_in_hand'    })
  assert.deepEqual(destinationDbPair('pnb'),    { payment_mode: 'other',         received_in: 'other'           })
})

test('every stored pair is legal under the table CHECK constraints', () => {
  // 20260628000200: payment_mode IN (…), received_in IN (…).
  const MODES = ['bank_transfer', 'cash', 'upi', 'cheque', 'other']
  const RECEIVED = ['company_account', 'cash_in_hand', 'savings_account', 'other']
  for (const d of PAYMENT_DESTINATIONS) {
    assert.ok(MODES.includes(d.payment_mode), `${d.key}: bad payment_mode`)
    assert.ok(RECEIVED.includes(d.received_in), `${d.key}: bad received_in`)
  }
})

test('the four pairs are distinct — no two destinations collide', () => {
  const pairs = PAYMENT_DESTINATIONS.map(d => `${d.payment_mode}|${d.received_in}`)
  assert.equal(new Set(pairs).size, PAYMENT_DESTINATIONS.length)
})

test('the pair round-trips back to the destination it came from', () => {
  for (const d of PAYMENT_DESTINATIONS) {
    const pair = destinationDbPair(d.key)
    assert.equal(destinationFromDb(pair.payment_mode, pair.received_in)?.key, d.key)
    assert.equal(readDestinationKey(pair), d.key)
  }
})

test('the pair is read TOGETHER — neither column names an account alone', () => {
  // 'cash' is Paytm only with cash_in_hand; 'other' is PNB only with 'other'.
  assert.equal(destinationFromDb('cash', 'company_account'), null)
  assert.equal(destinationFromDb('other', 'company_account'), null)
  assert.equal(destinationFromDb('bank_transfer', 'other'), null)
})

// ── Display, and the legacy fallback ──────────────────────────────────────────

test('a stored row displays its account name', () => {
  assert.equal(paymentDestinationLabel('bank_transfer', 'company_account'), 'HDFC')
  assert.equal(paymentDestinationLabel('bank_transfer', 'savings_account'), 'Canara')
  assert.equal(paymentDestinationLabel('cash',          'cash_in_hand'),    'Paytm')
  assert.equal(paymentDestinationLabel('other',         'other'),           'PNB')
})

test('a legacy pair falls back to the mode label, never to a guessed account', () => {
  assert.equal(paymentDestinationLabel('upi',    'company_account'), 'UPI')
  assert.equal(paymentDestinationLabel('cheque', 'other'),           'Cheque')
  assert.equal(paymentDestinationLabel('cash',   'company_account'), 'Cash')
  // Unknown to both tables: the raw value, rather than a fabricated name.
  assert.equal(paymentDestinationLabel('neft', 'company_account'), 'neft')
})

test('the EDIT form lands a legacy row on a selectable destination', () => {
  // Display may fall back to a legacy label, but the form has to open on
  // something the user can see and correct.
  assert.equal(readDestinationKey({ payment_mode: 'upi', received_in: 'company_account' }), 'hdfc')
})

// ── Conditional capture ───────────────────────────────────────────────────────

test('only the two cash destinations capture a cash trail', () => {
  assert.equal(captureFor('hdfc'),   'none')
  assert.equal(captureFor('canara'), 'none')
  assert.equal(captureFor('paytm'),  'collection')
  assert.equal(captureFor('pnb'),    'handover')
})

test('an unknown destination captures nothing rather than throwing', () => {
  assert.equal(captureFor('hawala'), 'none')
})

// ── The payload ───────────────────────────────────────────────────────────────

test('a bank destination stores no cash trail at all', () => {
  const filled = collection({
    collectedBy: 'user-1', collectedFrom: 'Ravi', handedOverTo: 'user-2',
    handoverDate: '2026-07-20', note: 'at the office',
  })
  for (const key of ['hdfc', 'canara']) {
    assert.deepEqual(buildCollectionPayload(key, filled), {
      collected_by_user_id:     null,
      collected_from_text:      null,
      handed_over_to_user_id:   null,
      handed_over_at:           null,
      collection_handover_note: null,
    })
  }
})

test('Paytm stores the collector and the note, and nothing about a handover', () => {
  const p = buildCollectionPayload('paytm', collection({
    collectedBy: 'user-1', collectedFrom: 'Ravi', handedOverTo: 'user-2',
    handoverDate: '2026-07-20', note: 'collected at showroom',
  }))
  assert.equal(p.collected_by_user_id, 'user-1')
  assert.equal(p.collection_handover_note, 'collected at showroom')
  // Internally-collected cash has not been handed anywhere.
  assert.equal(p.collected_from_text, null)
  assert.equal(p.handed_over_to_user_id, null)
  assert.equal(p.handed_over_at, null)
})

test('PNB stores the whole trail', () => {
  assert.deepEqual(
    buildCollectionPayload('pnb', collection({
      collectedBy: 'user-1', collectedFrom: 'Ravi Traders', handedOverTo: 'user-2',
      handoverDate: '2026-07-20', note: 'handed over at the office',
    })),
    {
      collected_by_user_id:     'user-1',
      collected_from_text:      'Ravi Traders',
      handed_over_to_user_id:   'user-2',
      handed_over_at:           '2026-07-20',
      collection_handover_note: 'handed over at the office',
    },
  )
})

test('a PNB payment submits fine with the handover not yet known', () => {
  const p = buildCollectionPayload('pnb', collection({ collectedBy: 'user-1', collectedFrom: 'Ravi' }))
  assert.equal(p.collected_by_user_id, 'user-1')
  assert.equal(p.handed_over_to_user_id, null)
  assert.equal(p.handed_over_at, null)
})

test('empty and whitespace-only optionals store null, never an empty string', () => {
  const p = buildCollectionPayload('pnb', collection({
    collectedBy: 'user-1', collectedFrom: '   ', note: '', handedOverTo: '', handoverDate: '',
  }))
  assert.equal(p.collected_from_text, null)
  assert.equal(p.collection_handover_note, null)
  assert.equal(p.handed_over_to_user_id, null)
  assert.equal(p.handed_over_at, null)
})

test('every payload carries all five keys, so switching destination CLEARS the trail', () => {
  const keys = [
    'collected_by_user_id', 'collected_from_text',
    'handed_over_to_user_id', 'handed_over_at', 'collection_handover_note',
  ]
  for (const d of PAYMENT_DESTINATIONS) {
    assert.deepEqual(
      Object.keys(buildCollectionPayload(d.key, collection({ collectedBy: 'user-1' }))).sort(),
      [...keys].sort(),
      `${d.key} must send every column`,
    )
  }
})

// ── Reading a row back ────────────────────────────────────────────────────────

test('nulls read back as empty strings, so inputs stay controlled', () => {
  assert.deepEqual(
    readCollectionState({
      collected_by_user_id: null, collected_from_text: null,
      handed_over_to_user_id: null, handed_over_at: null, collection_handover_note: null,
    }),
    EMPTY_COLLECTION_STATE,
  )
})

test('a stored trail round-trips through the form state unchanged', () => {
  const row = {
    collected_by_user_id:     'user-1',
    collected_from_text:      'Ravi Traders',
    handed_over_to_user_id:   'user-2',
    handed_over_at:           '2026-07-20',
    collection_handover_note: 'at the office',
  }
  assert.deepEqual(buildCollectionPayload('pnb', readCollectionState(row)), row)
})

// ── Validation ────────────────────────────────────────────────────────────────

test('a bank destination validates nothing about cash', () => {
  assert.equal(collectionErrorFor('hdfc', EMPTY_COLLECTION_STATE, '2026-07-20'), null)
  assert.equal(collectionErrorFor('canara', EMPTY_COLLECTION_STATE, '2026-07-20'), null)
})

test('a cash destination needs a collector', () => {
  assert.equal(
    collectionErrorFor('paytm', EMPTY_COLLECTION_STATE, '2026-07-20'),
    'Select who collected the cash.',
  )
  assert.equal(
    collectionErrorFor('pnb', EMPTY_COLLECTION_STATE, '2026-07-20'),
    'Select who collected the cash.',
  )
})

test('Paytm requires nothing beyond the collector', () => {
  assert.equal(collectionErrorFor('paytm', collection({ collectedBy: 'user-1' }), '2026-07-20'), null)
})

test('PNB submits with no handover — the handover happens later, on purpose', () => {
  assert.equal(
    collectionErrorFor('pnb', collection({ collectedBy: 'user-1', collectedFrom: 'Ravi' }), '2026-07-20'),
    null,
  )
})

test('the handover pair moves together or not at all', () => {
  assert.equal(
    collectionErrorFor('pnb', collection({ collectedBy: 'user-1', handedOverTo: 'user-2' }), '2026-07-20'),
    'Enter the date the cash was handed over.',
  )
  assert.equal(
    collectionErrorFor('pnb', collection({ collectedBy: 'user-1', handoverDate: '2026-07-21' }), '2026-07-20'),
    'Select who the cash was handed over to.',
  )
  assert.equal(
    collectionErrorFor('pnb', collection({
      collectedBy: 'user-1', handedOverTo: 'user-2', handoverDate: '2026-07-21',
    }), '2026-07-20'),
    null,
  )
})

test('cash cannot be handed over before it was collected', () => {
  assert.equal(
    collectionErrorFor('pnb', collection({
      collectedBy: 'user-1', handedOverTo: 'user-2', handoverDate: '2026-07-19',
    }), '2026-07-20'),
    'The handover date cannot be before the payment date.',
  )
  // Same day is the normal case, not an error.
  assert.equal(
    collectionErrorFor('pnb', collection({
      collectedBy: 'user-1', handedOverTo: 'user-2', handoverDate: '2026-07-20',
    }), '2026-07-20'),
    null,
  )
  // No payment date yet (the form is half-filled): nothing is guessed.
  assert.equal(
    collectionErrorFor('pnb', collection({
      collectedBy: 'user-1', handedOverTo: 'user-2', handoverDate: '2026-07-19',
    }), ''),
    null,
  )
})

test('the Paytm section never blocks on handover fields it does not show', () => {
  // Left over from a PNB selection the user switched away from. Not shown, not
  // stored, and not a reason to refuse the save.
  assert.equal(
    collectionErrorFor('paytm', collection({ collectedBy: 'user-1', handedOverTo: 'user-2' }), '2026-07-20'),
    null,
  )
})

// ── Read-only display ─────────────────────────────────────────────────────────
// One helper for every read-only surface, so the requester's details popup and
// the admin review popup can never disagree about whether money has moved.

test('a bank destination shows no cash section at all', () => {
  assert.equal(collectionDisplayFor(stored('hdfc'),   {}, rawDate), null)
  assert.equal(collectionDisplayFor(stored('canara'), {}, rawDate), null)
})

test('a bank destination that nonetheless CARRIES data still shows it', () => {
  // A destination corrected after the fact, or a legacy pair. Real recorded
  // data is never hidden because the current destination stopped asking for it.
  const d = collectionDisplayFor(
    stored('hdfc', { collected_by_user_id: 'user-1' }),
    { collectedBy: 'Nishant' },
    rawDate,
  )
  assert.ok(d, 'stored data must surface even on a bank destination')
  assert.equal(rowValue(d, 'Collected by'), 'Nishant')
})

test('Paytm shows a collection section — and nothing about a handover', () => {
  const d = collectionDisplayFor(
    stored('paytm', { collected_by_user_id: 'user-1', collection_handover_note: 'collected at showroom' }),
    { collectedBy: 'Nishant' },
    rawDate,
  )
  assert.equal(d?.title, 'Cash collection')
  assert.equal(d?.handoverPending, false)
  assert.equal(rowValue(d, 'Collected by'), 'Nishant')
  assert.equal(rowValue(d, 'Collection details'), 'collected at showroom')
  assert.equal(rowValue(d, 'Handover status'), null)
  assert.equal(rowValue(d, 'Handed over to'), null)
  assert.equal(rowValue(d, 'Handover date'), null)
})

test('PNB awaiting handover shows ONE pending state, not two empty rows', () => {
  const d = collectionDisplayFor(
    stored('pnb', { collected_by_user_id: 'user-1', collected_from_text: 'Ravi Traders' }),
    { collectedBy: 'Nishant' },
    rawDate,
  )
  assert.equal(d?.title, 'Cash collection and handover')
  assert.equal(d?.handoverPending, true)
  assert.equal(rowValue(d, 'Collected by'), 'Nishant')
  assert.equal(rowValue(d, 'Collected from'), 'Ravi Traders')
  assert.equal(rowValue(d, 'Handover status'), 'Pending handover')
  // The absent recipient and the absent date are one fact, stated once.
  assert.equal(rowValue(d, 'Handed over to'), null)
  assert.equal(rowValue(d, 'Handover date'), null)
  assert.equal(d?.rows.filter(row => row.value === 'Not provided').length, 0)
})

test('PNB with a completed handover names the recipient and the date', () => {
  const d = collectionDisplayFor(
    stored('pnb', {
      collected_by_user_id:     'user-1',
      collected_from_text:      'Ravi Traders',
      handed_over_to_user_id:   'user-2',
      handed_over_at:           '2026-07-21',
      collection_handover_note: 'handed over at the office',
    }),
    { collectedBy: 'Nishant', handedOverTo: 'Nitish' },
    rawDate,
  )
  assert.equal(d?.handoverPending, false)
  assert.equal(rowValue(d, 'Handover status'), 'Handed over')
  assert.equal(rowValue(d, 'Handed over to'), 'Nitish')
  assert.equal(rowValue(d, 'Handover date'), 'D(2026-07-21)')
  assert.equal(rowValue(d, 'Collection / handover note'), 'handed over at the office')
})

test('a half-recorded handover is not treated as recorded', () => {
  // The DB CHECK forbids this pair, so it can only arrive from a stale client
  // read. It must read as pending, never as "handed over to nobody".
  const d = collectionDisplayFor(
    stored('pnb', { collected_by_user_id: 'user-1', handed_over_to_user_id: 'user-2' }),
    { collectedBy: 'Nishant', handedOverTo: 'Nitish' },
    rawDate,
  )
  assert.equal(d?.handoverPending, true)
  assert.equal(rowValue(d, 'Handover status'), 'Pending handover')
  assert.equal(rowValue(d, 'Handed over to'), null)
})

test('a uuid is never rendered — an unresolved name says so', () => {
  const d = collectionDisplayFor(
    stored('pnb', {
      collected_by_user_id:   'e1d2c3b4-0000-0000-0000-000000000000',
      handed_over_to_user_id: 'aaaabbbb-0000-0000-0000-000000000000',
      handed_over_at:         '2026-07-21',
    }),
    {},
    rawDate,
  )
  for (const row of d!.rows) {
    assert.ok(!row.value.includes('-0000-'), `a raw uuid leaked into "${row.label}"`)
  }
  assert.equal(rowValue(d, 'Collected by'), 'Unknown user')
  assert.equal(rowValue(d, 'Handed over to'), 'Unknown user')
})

test('a cash payment with nothing recorded still states the collector is missing', () => {
  const d = collectionDisplayFor(stored('paytm'), {}, rawDate)
  assert.equal(rowValue(d, 'Collected by'), 'Not recorded')
})

test('optional empties are omitted rather than printed as blank rows', () => {
  const d = collectionDisplayFor(
    stored('pnb', { collected_by_user_id: 'user-1' }),
    { collectedBy: 'Nishant' },
    rawDate,
  )
  assert.deepEqual(d?.rows.map(row => row.label), ['Collected by', 'Handover status'])
})

// ── An unstated account is not an account ────────────────────────────────────
//
// REGRESSION, and a real one. Before this was fixed, opening the Payment
// Requests edit modal on a payment recorded against a PI — which stores
// received_in NULL, because only amount, date and mode are mandatory there —
// resolved the destination through readDestinationKey, whose documented fallback
// is the DEFAULT account. Saving any other field then wrote BOTH halves of the
// pair back, silently turning a UPI payment with no stated account into a Bank
// Transfer into HDFC. Two recorded financial facts, rewritten by a form the user
// opened to fix a typo.

describe('a stored pair that names no account resolves to null, not to a default', () => {
  test('received_in NULL is null, whatever the mode', () => {
    for (const payment_mode of ['upi', 'cash', 'cheque', 'bank_transfer', 'other']) {
      assert.equal(readDestinationKeyOrNull({ payment_mode, received_in: null }), null, payment_mode)
    }
  })

  test('an unrecognised legacy pair is null too', () => {
    assert.equal(readDestinationKeyOrNull({ payment_mode: 'cheque', received_in: 'company_account' }), null)
  })

  test('a real pair still resolves to its account', () => {
    assert.equal(readDestinationKeyOrNull({ payment_mode: 'bank_transfer', received_in: 'company_account' }), 'hdfc')
    assert.equal(readDestinationKeyOrNull({ payment_mode: 'cash', received_in: 'cash_in_hand' }), 'paytm')
  })

  test('readDestinationKey keeps its own contract — a real, selectable choice', () => {
    // Unchanged on purpose: callers that must land on something a user can pick
    // still do. The edit form is simply no longer one of them.
    assert.equal(readDestinationKey({ payment_mode: 'upi', received_in: 'company_account' }), 'hdfc')
  })
})

describe('nothing is written back when no account was chosen', () => {
  test('null yields no pair at all, so both columns are left alone', () => {
    assert.equal(destinationWritePair(null), null)
  })

  test('a chosen destination yields exactly the stored pair', () => {
    for (const d of PAYMENT_DESTINATIONS) {
      assert.deepEqual(destinationWritePair(d.key), {
        payment_mode: d.payment_mode, received_in: d.received_in,
      })
    }
  })

  test('spreading the null result adds no keys to an update payload', () => {
    // This is exactly how the edit modal uses it: `...(pair ?? {})`.
    const payload = { amount: 100, ...(destinationWritePair(null) ?? {}) }
    assert.deepEqual(Object.keys(payload), ['amount'])
    assert.equal('payment_mode' in payload, false)
    assert.equal('received_in' in payload, false)
  })
})

describe('an unstated destination carries no cash-trail requirement', () => {
  test('captureFor tolerates null and asks for nothing', () => {
    assert.equal(captureFor(null), 'none')
    assert.equal(collectionErrorFor(null, EMPTY_COLLECTION_STATE, '2026-08-19'), null)
  })
})

describe('the edit modal never restates where money went', () => {
  test('it reads the nullable form and spreads the pair conditionally', () => {
    const source = readFileSync(join(process.cwd(), 'src/app/finance/page.tsx'), 'utf8')
    // The seed must be the honest reader.
    assert.ok(source.includes('readDestinationKeyOrNull(r)'),
      'the edit modal must seed its destination from the nullable reader')
    // And the write must be conditional, never an unconditional pair.
    assert.ok(source.includes('...(editDbMode ?? {})'),
      'the edit modal must spread the pair conditionally')
    assert.ok(!/payment_mode: editDbMode\.payment_mode/.test(source),
      'the edit modal must not write payment_mode unconditionally')
    assert.ok(!/received_in:  ?editDbMode\.received_in/.test(source),
      'the edit modal must not write received_in unconditionally')
  })

  test('the Received Payments form treats an empty account as NULL, not as a value', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/app/finance/received/ReceivedPaymentsView.tsx'), 'utf8')
    assert.ok(source.includes("form.receivedIn === '' ? null : form.receivedIn"),
      'the not-stated sentinel must be stored as NULL')
    assert.ok(source.includes("{ label: 'Not stated', value: '' }"),
      'the account list must offer an explicit not-stated option')
  })
})
