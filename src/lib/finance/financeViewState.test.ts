/**
 * Requirement 5's state-persistence safety net, proven directly.
 *
 * Run:
 *   npx tsx --test src/lib/finance/financeViewState.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  FINANCE_VIEW_STATE_DEFAULTS,
  financeViewStateKey,
  parseFinanceViewState,
  serializeFinanceViewState,
  type PersistedFinanceViewState,
} from './financeViewState'

const REPO_ROOT = join(__dirname, '..', '..', '..')
const read = (relPath: string) => readFileSync(join(REPO_ROOT, relPath), 'utf8')

describe('round-trip', () => {
  test('serialize then parse returns exactly the same state', () => {
    const state: PersistedFinanceViewState = {
      search: 'Alpha Textiles',
      dateFrom: '2026-01-01',
      dateTo: '2026-01-31',
      allocation: 'available',
      confirmedFilter: 'partial',
      page: 3,
    }
    assert.deepEqual(parseFinanceViewState(serializeFinanceViewState(state)), state)
  })

  test('two different surfaces never share a storage key', () => {
    assert.notEqual(financeViewStateKey('confirmed'), financeViewStateKey('to_verify'))
  })
})

describe('fails closed to the defaults', () => {
  test('null / missing input', () => {
    assert.deepEqual(parseFinanceViewState(null), FINANCE_VIEW_STATE_DEFAULTS)
    assert.deepEqual(parseFinanceViewState(undefined), FINANCE_VIEW_STATE_DEFAULTS)
    assert.deepEqual(parseFinanceViewState(''), FINANCE_VIEW_STATE_DEFAULTS)
  })

  test('malformed JSON does not throw, and degrades to defaults', () => {
    assert.deepEqual(parseFinanceViewState('{not json'), FINANCE_VIEW_STATE_DEFAULTS)
  })

  test('a JSON value that is not an object degrades to defaults', () => {
    assert.deepEqual(parseFinanceViewState('42'), FINANCE_VIEW_STATE_DEFAULTS)
    assert.deepEqual(parseFinanceViewState('"hello"'), FINANCE_VIEW_STATE_DEFAULTS)
    assert.deepEqual(parseFinanceViewState('null'), FINANCE_VIEW_STATE_DEFAULTS)
  })

  test('wrong-typed or out-of-range fields fall back FIELD BY FIELD, not wholesale', () => {
    const partiallyBad = JSON.stringify({
      search: 'kept',
      dateFrom: 123,          // wrong type
      dateTo: FINANCE_VIEW_STATE_DEFAULTS.dateTo,
      allocation: null,       // wrong type
      confirmedFilter: 'full', // valid
      page: -5,                // out of range
    })
    assert.deepEqual(parseFinanceViewState(partiallyBad), {
      search: 'kept',
      dateFrom: FINANCE_VIEW_STATE_DEFAULTS.dateFrom,
      dateTo: FINANCE_VIEW_STATE_DEFAULTS.dateTo,
      allocation: FINANCE_VIEW_STATE_DEFAULTS.allocation,
      confirmedFilter: 'full',
      page: FINANCE_VIEW_STATE_DEFAULTS.page,
    })
  })

  test('page is floored to a whole number', () => {
    assert.equal(parseFinanceViewState(JSON.stringify({ page: 3.9 })).page, 3)
  })
})

describe('never restores destructive confirmation data (Requirement 5, items 5–6)', () => {
  test('DeletePaymentModal never imports this module — a delete reason or typed Payment ID cannot be restored through it', () => {
    const source = read('src/components/finance/DeletePaymentModal.tsx')
    assert.doesNotMatch(source, /financeViewState/)
  })

  test('the persisted state shape carries no reason or confirmation field at all', () => {
    const keys = Object.keys(FINANCE_VIEW_STATE_DEFAULTS)
    for (const forbidden of ['reason', 'confirmPaymentId', 'typedId', 'deleteReason']) {
      assert.ok(!keys.includes(forbidden), `${forbidden} must never be part of the persisted shape`)
    }
  })

  test('a reason/typed-ID field surviving in raw storage is silently dropped by the parser', () => {
    // Simulates a forged or stale sessionStorage value carrying fields this
    // module has never written — proves the parser only ever reads the six
    // named fields, whatever else is present in the JSON.
    const forged = JSON.stringify({
      search: 'x',
      reason: 'a stale destructive reason that must never resurface',
      confirmPaymentId: 'P-AA-0001',
    })
    const result = parseFinanceViewState(forged) as unknown as Record<string, unknown>
    assert.ok(!('reason' in result))
    assert.ok(!('confirmPaymentId' in result))
  })
})
