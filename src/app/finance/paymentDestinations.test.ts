/**
 * The BOE accounts a HISTORICAL payment was recorded against — pure logic.
 *
 * WHAT THIS FILE STOPPED TESTING, AND WHY
 * ---------------------------------------
 * It used to cover the cash-trail half of paymentDestinations.ts as well:
 * CollectionState, captureForMode, collectionErrorForMode,
 * buildCollectionPayloadForMode, readCollectionState and collectionDisplayFor.
 * All six are gone. They expressed a single collection and a single handover in
 * five columns on the payment row, rewritten on every save — a shape that could
 * not hold a second hand-off, could not say WHEN a collection happened, and
 * destroyed itself when a request's mode was corrected.
 *
 * Their replacement is an append-only event log (20261014000000 §2), covered by
 * src/lib/finance/custodyTrail.test.ts and by the SQL suite. The five columns
 * are frozen as history and are read back through legacyCustodyEvents, which is
 * tested there.
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
  destinationFromDb,
  paymentDestinationLabel,
  type BoeAccountKey,
} from './paymentDestinations'

/** The stored pair for one account, read from the list rather than rebuilt. */
const pair = (key: BoeAccountKey) => {
  const a = BOE_ACCOUNTS.find(d => d.key === key)
  if (!a) throw new Error(`no such account: ${key}`)
  return { payment_mode: a.payment_mode, received_in: a.received_in }
}

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8')

// ── 1. The four accounts, as history recorded them ───────────────────────────

describe('the four BOE accounts a historical row can name', () => {
  test('there are four, and each carries a distinct stored pair', () => {
    assert.equal(BOE_ACCOUNTS.length, 4)
    assert.deepEqual(BOE_ACCOUNTS.map(a => a.key), ['hdfc', 'canara', 'paytm', 'pnb'])
    const pairs = BOE_ACCOUNTS.map(a => `${a.payment_mode}|${a.received_in}`)
    assert.equal(new Set(pairs).size, 4, 'two accounts must never share one stored pair')
  })

  test('the pair is only meaningful read TOGETHER', () => {
    // `cash` alone does not say Paytm and `other` alone does not say PNB. This
    // is the whole reason the legacy values were not converted in place: since
    // 20260919000000 received_in is nullable and since 20261013000000 it is not
    // written at all, so a bare 'bank_transfer' is HDFC or Canara and nothing on
    // the row says which.
    assert.equal(destinationFromDb('cash', null), null)
    assert.equal(destinationFromDb('other', null), null)
    assert.equal(destinationFromDb('bank_transfer', null), null)
    assert.equal(destinationFromDb(...Object.values(pair('paytm')) as [string, string])?.key, 'paytm')
    assert.equal(destinationFromDb(...Object.values(pair('pnb')) as [string, string])?.key, 'pnb')
  })

  test('every account resolves back to itself', () => {
    for (const account of BOE_ACCOUNTS) {
      const found = destinationFromDb(account.payment_mode, account.received_in)
      assert.equal(found?.key, account.key)
      assert.equal(paymentDestinationLabel(account.payment_mode, account.received_in), account.label)
    }
  })
})

// ── 2. Reading a row this list cannot place ──────────────────────────────────

describe('a stored value that names no account', () => {
  test('a pair that matches nothing falls back to the mode label', () => {
    // A row recorded through a door that never asked for an account — every
    // payment written since 20261013000000 — carries a NULL received_in. It
    // reads as its MODE, which since 20261014000000 is the account name itself.
    assert.equal(paymentDestinationLabel('hdfc', null), 'HDFC')
    assert.equal(paymentDestinationLabel('pnb', null), 'PNB')
    assert.equal(paymentDestinationLabel('paytm', null), 'Paytm')
    assert.equal(paymentDestinationLabel('canara', null), 'Canara')
  })

  test('a RETIRED mode with no account still reads as the words it always read as', () => {
    assert.equal(paymentDestinationLabel('bank_transfer', null), 'Bank Transfer')
    assert.equal(paymentDestinationLabel('cheque', null), 'Cheque')
    assert.equal(paymentDestinationLabel('upi', null), 'UPI')
  })

  test('an unrecognised value is returned AS STORED, never relabelled', () => {
    // A row carrying something neither list knows is a fact worth seeing, and
    // relabelling it would hide the only evidence.
    assert.equal(paymentDestinationLabel('crypto', null), 'crypto')
    assert.equal(paymentDestinationLabel('crypto', 'nowhere'), 'crypto')
  })
})

// ── 3. No form asks for an account any more ──────────────────────────────────

describe('no payment-entry form states an account', () => {
  test('no form on the Finance page writes received_in', () => {
    const source = read('src/app/finance/page.tsx')
    // Every remaining mention is a TYPE (`received_in: string | null`), never a
    // value in a payload. So this reads the token that FOLLOWS the key, rather
    // than asserting the key is unsaid — a spelling check would fail on the type
    // and pass on a write spread in from elsewhere.
    const written = [...source.matchAll(/received_in:\s*([A-Za-z_$][\w$]*)/g)]
      .map(m => m[1])
      .filter(token => token !== 'string')
    assert.deepEqual(written, [],
      `no form on this page may write received_in — the account picker is gone (found: ${written.join(', ')})`)
  })

  test('the correction goes through the protected door, with its custody activities', () => {
    const source = read('src/app/finance/page.tsx')
    assert.ok(source.includes(".rpc('edit_payment_request'"),
      'a correction must go through the protected door, not a client UPDATE')
    assert.ok(source.includes('p_custody_events:  custodyEvents'),
      'and carry the activities it is ADDING')
    // THE FIVE LEGACY COLUMNS ARE NEVER WRITTEN. Clearing them on a mode change
    // is exactly the behaviour that would destroy the record of who had been
    // holding the money.
    for (const column of [
      'collected_by_user_id', 'collected_from_text',
      'handed_over_to_user_id', 'handed_over_at', 'collection_handover_note',
    ]) {
      assert.equal(new RegExp(`p_${column.replace(/_user_id$/, '')}\\s*:`).test(source), false,
        `no form may send ${column} — the five legacy columns are history`)
    }
  })

  test('the Payment Request form sends no client name and no account', () => {
    const source = read('src/app/finance/page.tsx')
    assert.ok(source.includes(".rpc('submit_payment_request'"),
      'the form must write through the protected door, not through an insert')
    assert.equal(source.includes('p_client_name'), false,
      'submit_payment_request has no client-name parameter, on purpose')
    assert.equal(source.includes('p_received_in'), false,
      'and no receiving-account parameter either')
  })

  test('the Record Payment form sends NULL for both rather than inventing one', () => {
    const source = read('src/app/finance/received/RecordSplitPaymentModal.tsx')
    assert.ok(source.includes('p_client_name:  null'))
    assert.ok(source.includes('p_received_in:  null'))
  })
})
