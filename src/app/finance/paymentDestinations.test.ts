/**
 * The BOE accounts a payment was recorded against, and the cash trail — pure logic.
 *
 * Run:
 *   npx tsx --test src/app/finance/paymentDestinations.test.ts
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BOE_ACCOUNTS,
  EMPTY_COLLECTION_STATE,
  buildCollectionPayloadForMode,
  captureForMode,
  collectionDisplayFor,
  collectionErrorForMode,
  destinationFromDb,
  modeCapturesCash,
  paymentDestinationLabel,
  readCollectionState,
  type BoeAccountKey,
  type CollectionState,
  type StoredCollection,
} from './paymentDestinations'

const collection = (over: Partial<CollectionState> = {}): CollectionState => ({
  ...EMPTY_COLLECTION_STATE,
  ...over,
})

/** The stored pair for one account, read from the list rather than rebuilt. */
const pair = (key: BoeAccountKey) => {
  const a = BOE_ACCOUNTS.find(d => d.key === key)
  if (!a) throw new Error(`no such account: ${key}`)
  return { payment_mode: a.payment_mode, received_in: a.received_in }
}

// A stored row on a given account, with an empty cash trail by default.
const stored = (key: BoeAccountKey, over: Partial<StoredCollection> = {}): StoredCollection => ({
  ...pair(key),
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

// ── The four accounts still describe the rows recorded against them ───────────
//
// No form offers them any more (20261013000000). They survive because the rows
// do: a payment recorded before the change carries a real pair naming a real
// account, and a screen that could not name it would print a blank where a
// financial fact belongs.

test('there are exactly four accounts, banks first', () => {
  assert.deepEqual(BOE_ACCOUNTS.map(d => d.key), ['hdfc', 'canara', 'paytm', 'pnb'])
})

test('every account states what it MEANS, not just what it is called', () => {
  for (const d of BOE_ACCOUNTS) {
    assert.ok(d.label.trim().length > 0, `${d.key} has no label`)
    assert.ok(d.helper.trim().length > 0, `${d.key} says nothing about what it means`)
  }
})

test('every stored pair is legal under the table CHECK constraints', () => {
  const MODES    = ['bank_transfer', 'cash', 'upi', 'cheque', 'other']
  const ACCOUNTS = ['company_account', 'cash_in_hand', 'savings_account', 'other']
  for (const d of BOE_ACCOUNTS) {
    assert.ok(MODES.includes(d.payment_mode),    `${d.key} stores an illegal payment_mode`)
    assert.ok(ACCOUNTS.includes(d.received_in),  `${d.key} stores an illegal received_in`)
  }
})

test('the four pairs are distinct — no two accounts collide', () => {
  const pairs = BOE_ACCOUNTS.map(d => `${d.payment_mode}|${d.received_in}`)
  assert.equal(new Set(pairs).size, pairs.length)
})

test('the pair round-trips back to the account it came from', () => {
  for (const d of BOE_ACCOUNTS) {
    assert.equal(destinationFromDb(d.payment_mode, d.received_in)?.key, d.key)
  }
})

test('the pair is read TOGETHER — neither column names an account alone', () => {
  // 'cash' alone does not say Paytm and 'other' alone does not say PNB.
  assert.equal(destinationFromDb('cash', 'other'), null)
  assert.equal(destinationFromDb('other', 'cash_in_hand'), null)
})

test('a stored row displays its account name', () => {
  assert.equal(paymentDestinationLabel('bank_transfer', 'company_account'), 'HDFC')
  assert.equal(paymentDestinationLabel('cash', 'cash_in_hand'), 'Paytm')
})

test('a legacy or account-less pair falls back to the mode label, never to a guessed account', () => {
  assert.equal(paymentDestinationLabel('cheque', 'company_account'), 'Cheque')
  assert.equal(paymentDestinationLabel('upi', null), 'UPI')
  // An unrecognised mode is shown AS STORED rather than relabelled as 'Other'.
  assert.equal(paymentDestinationLabel('crypto', null), 'crypto')
})

// ── The cash trail belongs to CASH ────────────────────────────────────────────
//
// Which is a rule about the payment MODE now, not about an account. Every one of
// these is decided again server-side by submit_payment_request, so a stale form
// field cannot smuggle a collector onto a bank transfer.

test('only Cash captures a cash trail', () => {
  assert.equal(captureForMode('cash'), 'handover')
  assert.equal(modeCapturesCash('cash'), true)
  for (const mode of ['bank_transfer', 'upi', 'cheque', 'other', '', 'crypto']) {
    assert.equal(captureForMode(mode), 'none', mode)
    assert.equal(modeCapturesCash(mode), false, mode)
  }
})

test('a non-cash mode stores no cash trail at all, whatever the form still held', () => {
  const full = collection({
    collectedBy: 'user-1', collectedFrom: 'Ravi Traders',
    handedOverTo: 'user-2', handoverDate: '2026-07-21', note: 'carried in a bag',
  })
  for (const mode of ['bank_transfer', 'upi', 'cheque', 'other']) {
    assert.deepEqual(buildCollectionPayloadForMode(mode, full), {
      collected_by_user_id:     null,
      collected_from_text:      null,
      handed_over_to_user_id:   null,
      handed_over_at:           null,
      collection_handover_note: null,
    }, mode)
  }
})

test('Cash stores the whole trail', () => {
  assert.deepEqual(buildCollectionPayloadForMode('cash', collection({
    collectedBy: 'user-1', collectedFrom: 'Ravi Traders',
    handedOverTo: 'user-2', handoverDate: '2026-07-21', note: 'handed over at the office',
  })), {
    collected_by_user_id:     'user-1',
    collected_from_text:      'Ravi Traders',
    handed_over_to_user_id:   'user-2',
    handed_over_at:           '2026-07-21',
    collection_handover_note: 'handed over at the office',
  })
})

test('a cash payment submits fine with the handover not yet known', () => {
  const p = buildCollectionPayloadForMode('cash', collection({ collectedBy: 'user-1' }))
  assert.equal(p.collected_by_user_id, 'user-1')
  assert.equal(p.handed_over_to_user_id, null)
  assert.equal(p.handed_over_at, null)
})

test('empty and whitespace-only optionals store null, never an empty string', () => {
  const p = buildCollectionPayloadForMode('cash', collection({
    collectedBy: 'user-1', collectedFrom: '   ', note: '  ', handedOverTo: '', handoverDate: '',
  }))
  assert.equal(p.collected_from_text, null)
  assert.equal(p.collection_handover_note, null)
  assert.equal(p.handed_over_to_user_id, null)
  assert.equal(p.handed_over_at, null)
})

test('every payload carries all five keys, so moving OFF Cash clears the trail', () => {
  const KEYS = [
    'collected_by_user_id', 'collected_from_text',
    'handed_over_to_user_id', 'handed_over_at', 'collection_handover_note',
  ]
  for (const mode of ['bank_transfer', 'cash', 'upi', 'cheque', 'other']) {
    assert.deepEqual(
      Object.keys(buildCollectionPayloadForMode(mode, collection())).sort(),
      [...KEYS].sort(),
      mode)
  }
})

// ── Reading a stored trail back into the form ─────────────────────────────────

test('nulls read back as empty strings, so inputs stay controlled', () => {
  assert.deepEqual(readCollectionState({
    collected_by_user_id: null, collected_from_text: null,
    handed_over_to_user_id: null, handed_over_at: null, collection_handover_note: null,
  }), EMPTY_COLLECTION_STATE)
})

test('a stored trail round-trips through the form state unchanged', () => {
  const row = {
    collected_by_user_id:     'user-1',
    collected_from_text:      'Ravi Traders',
    handed_over_to_user_id:   'user-2',
    handed_over_at:           '2026-07-21',
    collection_handover_note: 'handed over at the office',
  }
  assert.deepEqual(buildCollectionPayloadForMode('cash', readCollectionState(row)), row)
})

// ── Validation ────────────────────────────────────────────────────────────────

test('a non-cash mode validates nothing about cash', () => {
  for (const mode of ['bank_transfer', 'upi', 'cheque', 'other']) {
    assert.equal(collectionErrorForMode(mode, collection(), '2026-07-20'), null, mode)
  }
})

test('Cash needs a collector', () => {
  const err = collectionErrorForMode('cash', collection(), '2026-07-20')
  assert.ok(err)
  assert.match(err, /collected/i)
  assert.equal(collectionErrorForMode('cash', collection({ collectedBy: 'user-1' }), '2026-07-20'), null)
})

test('Cash submits with no handover — the handover happens later, on purpose', () => {
  assert.equal(
    collectionErrorForMode('cash', collection({ collectedBy: 'user-1', collectedFrom: 'Ravi Traders' }), '2026-07-20'),
    null)
})

test('the handover pair moves together or not at all', () => {
  const half = collection({ collectedBy: 'user-1', handedOverTo: 'user-2' })
  assert.match(collectionErrorForMode('cash', half, '2026-07-20') ?? '', /date/i)

  const other = collection({ collectedBy: 'user-1', handoverDate: '2026-07-21' })
  assert.match(collectionErrorForMode('cash', other, '2026-07-20') ?? '', /who|handed over to/i)

  const both = collection({ collectedBy: 'user-1', handedOverTo: 'user-2', handoverDate: '2026-07-21' })
  assert.equal(collectionErrorForMode('cash', both, '2026-07-20'), null)
})

test('cash cannot be handed over before it was collected', () => {
  const early = collection({ collectedBy: 'user-1', handedOverTo: 'user-2', handoverDate: '2026-07-19' })
  assert.match(collectionErrorForMode('cash', early, '2026-07-20') ?? '', /before the payment date/i)

  // Same day is fine, and a missing payment date is not guessed at.
  const same = collection({ collectedBy: 'user-1', handedOverTo: 'user-2', handoverDate: '2026-07-20' })
  assert.equal(collectionErrorForMode('cash', same, '2026-07-20'), null)
  assert.equal(collectionErrorForMode('cash', same, ''), null)
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

// ── An account-less row is described by its MODE ─────────────────────────────
//
// Every payment written through either redesigned entry form carries
// received_in NULL: the account picker is gone and nothing is invented in its
// place. Such a row still has to describe itself, so the mode decides.

describe('a stored pair that names no account falls back to the mode', () => {
  test('a cash payment with no account still shows its collection', () => {
    const d = collectionDisplayFor(
      {
        payment_mode: 'cash', received_in: null,
        collected_by_user_id: 'user-1', collected_from_text: 'Ravi Traders',
        handed_over_to_user_id: null, handed_over_at: null, collection_handover_note: null,
      },
      { collectedBy: 'Nishant' },
      rawDate,
    )
    assert.equal(d?.title, 'Cash collection and handover')
    assert.equal(rowValue(d, 'Collected by'), 'Nishant')
    assert.equal(rowValue(d, 'Handover status'), 'Pending handover')
  })

  test('a non-cash payment with no account and no data shows nothing', () => {
    for (const payment_mode of ['bank_transfer', 'upi', 'cheque', 'other']) {
      assert.equal(collectionDisplayFor({
        payment_mode, received_in: null,
        collected_by_user_id: null, collected_from_text: null,
        handed_over_to_user_id: null, handed_over_at: null, collection_handover_note: null,
      }, {}, rawDate), null, payment_mode)
    }
  })

  test('a HISTORICAL pair still wins over the mode, so old rows read as they always did', () => {
    // Paytm is (cash, cash_in_hand) and captures 'collection', not 'handover'.
    // Re-deciding that from the mode years later would add a handover row to a
    // payment whose account said none was possible.
    const d = collectionDisplayFor(
      stored('paytm', { collected_by_user_id: 'user-1' }),
      { collectedBy: 'Nishant' },
      rawDate,
    )
    assert.equal(d?.title, 'Cash collection')
    assert.equal(rowValue(d, 'Handover status'), null)
  })
})

describe('neither payment-entry form states an account any more', () => {
  test('the edit modal never writes received_in, for any row', () => {
    const source = readFileSync(join(process.cwd(), 'src/app/finance/page.tsx'), 'utf8')
    // Every remaining mention is a TYPE (`received_in: string | null`), never a
    // value in a payload. So this reads the token that FOLLOWS the key, rather
    // than asserting the key is unsaid — a spelling check would fail on the
    // type and pass on a write spread in from elsewhere.
    const written = [...source.matchAll(/received_in:\s*([A-Za-z_$][\w$]*)/g)]
      .map(m => m[1])
      .filter(token => token !== 'string')
    assert.deepEqual(written, [],
      `no form on this page may write received_in — the account picker is gone (found: ${written.join(', ')})`)
    assert.ok(source.includes('...buildCollectionPayloadForMode(paymentMode, collection)'),
      'the cash trail must be written from the MODE, all five keys, always')
  })

  test('the Payment Request form sends no client name and no account', () => {
    const source = readFileSync(join(process.cwd(), 'src/app/finance/page.tsx'), 'utf8')
    assert.ok(source.includes(".rpc('submit_payment_request'"),
      'the form must write through the protected door, not through an insert')
    assert.equal(source.includes('p_client_name'), false,
      'submit_payment_request has no client-name parameter, on purpose')
    assert.equal(source.includes('p_received_in'), false,
      'and no receiving-account parameter either')
  })

  test('the Record Payment form sends NULL for both rather than inventing one', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/app/finance/received/RecordSplitPaymentModal.tsx'), 'utf8')
    assert.ok(source.includes('p_client_name:  null'))
    assert.ok(source.includes('p_received_in:  null'))
  })
})
