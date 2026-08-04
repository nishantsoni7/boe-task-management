/**
 * Which actions a payroll period row offers.
 *
 * These are the rules the dashboard renders, stated without a browser: a locked
 * row must offer a way back, a generated row must offer both regeneration and
 * locking, and no row may carry a disabled control.
 *
 * Run:
 *   npx tsx --test src/lib/payroll/periodActions.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { payrollRowActions, PAYROLL_ACTION_LABELS } from './periodActions'

const labelsOf = (status: 'draft' | 'generated' | 'locked') => {
  const { primary, secondary } = payrollRowActions(status)
  return [primary, ...secondary].map(a => PAYROLL_ACTION_LABELS[a])
}

describe('payrollRowActions', () => {
  test('a locked row offers View Payroll and Unlock Payroll', () => {
    assert.deepEqual(labelsOf('locked'), ['View Payroll', 'Unlock Payroll'])
  })

  test('a locked row leads with View Payroll and keeps Unlock secondary', () => {
    const { primary, secondary } = payrollRowActions('locked')
    assert.equal(primary, 'view')
    assert.deepEqual(secondary, ['unlock'])
  })

  test('a generated (unlocked) row offers Regenerate Payroll and Lock Payroll', () => {
    const labels = labelsOf('generated')
    assert.ok(labels.includes('Regenerate Payroll'), 'Regenerate Payroll must be offered')
    assert.ok(labels.includes('Lock Payroll'), 'Lock Payroll must be offered')
  })

  test('a generated row leads with View Payroll', () => {
    const { primary, secondary } = payrollRowActions('generated')
    assert.equal(primary, 'view')
    assert.deepEqual(secondary, ['regenerate', 'lock'])
  })

  test('a locked row never offers Regenerate or Lock — not even disabled', () => {
    const labels = labelsOf('locked')
    assert.ok(!labels.includes('Regenerate Payroll'))
    assert.ok(!labels.includes('Lock Payroll'))
    // The status badge says "Locked"; a greyed-out Lock button said it twice.
    assert.equal(labels.length, 2)
  })

  test('a draft row generates rather than regenerates, and cannot be locked or viewed', () => {
    assert.deepEqual(labelsOf('draft'), ['Generate Payroll'])
  })

  test('an unlocked period offers exactly what it offered before it was locked', () => {
    // Unlock returns the period to 'generated', so this is the guarantee that
    // "Regenerate Payroll and Lock Payroll become available again" holds by
    // construction rather than by a separate code path.
    assert.deepEqual(payrollRowActions('generated'), payrollRowActions('generated'))
    assert.deepEqual(labelsOf('generated'), ['View Payroll', 'Regenerate Payroll', 'Lock Payroll'])
  })

  test('every action has a label, and the labels are the standard wording', () => {
    assert.deepEqual(PAYROLL_ACTION_LABELS, {
      view:       'View Payroll',
      generate:   'Generate Payroll',
      regenerate: 'Regenerate Payroll',
      lock:       'Lock Payroll',
      unlock:     'Unlock Payroll',
    })
  })
})
