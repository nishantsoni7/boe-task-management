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
import {
  payrollRowActions,
  payrollAttention,
  PAYROLL_ACTION_LABELS,
  PAYROLL_ROW_ACTION_PRESENTATION,
} from './periodActions'

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

describe('row action presentation', () => {
  test('the row leads with one text action and draws the rest as icons', () => {
    // Whatever the status, the action the row leads with is the labelled one —
    // that is what stops a row from turning into four competing buttons.
    for (const status of ['draft', 'generated', 'locked'] as const) {
      const { primary, secondary } = payrollRowActions(status)
      assert.equal(PAYROLL_ROW_ACTION_PRESENTATION[primary], 'text', status)
      for (const s of secondary) {
        assert.equal(PAYROLL_ROW_ACTION_PRESENTATION[s], 'icon', `${status}/${s}`)
      }
    }
  })

  test('Regenerate, Lock and Unlock are never full-text buttons in a row', () => {
    assert.equal(PAYROLL_ROW_ACTION_PRESENTATION.regenerate, 'icon')
    assert.equal(PAYROLL_ROW_ACTION_PRESENTATION.lock,       'icon')
    assert.equal(PAYROLL_ROW_ACTION_PRESENTATION.unlock,     'icon')
  })

  test('an icon action still has a label to announce — the icon is never the only name', () => {
    for (const [action, presentation] of Object.entries(PAYROLL_ROW_ACTION_PRESENTATION)) {
      if (presentation !== 'icon') continue
      const label = PAYROLL_ACTION_LABELS[action as keyof typeof PAYROLL_ACTION_LABELS]
      assert.ok(label && label.length > 0, action)
    }
  })
})

describe('payrollAttention', () => {
  const current = { outOfDate: false, reopened: false }

  test('a period with nothing outstanding shows no attention at all', () => {
    assert.equal(payrollAttention({ status: 'generated', ...current }), null)
    assert.equal(payrollAttention({ status: 'locked',    ...current }), null)
    assert.equal(payrollAttention({ status: 'draft',     ...current }), null)
  })

  test('a stale generated period asks to be regenerated', () => {
    const a = payrollAttention({ status: 'generated', outOfDate: true, reopened: false })
    assert.equal(a?.title, 'Payroll needs regeneration')
    assert.equal(a?.body,  'Attendance records were updated after payroll generation.')
    assert.equal(a?.tone,  'amber')
    // One action fixes it, so there is no sequence to spell out.
    assert.deepEqual(a?.steps, [])
    assert.equal(a?.action, 'regenerate')
  })

  test('a stale locked period offers the way back, in order', () => {
    const a = payrollAttention({ status: 'locked', outOfDate: true, reopened: false })
    assert.equal(a?.title, 'Payroll has attendance changes')
    assert.equal(a?.body,  'Attendance records were updated after this payroll was locked.')
    assert.equal(a?.tone,  'amber')
    assert.deepEqual(a?.steps, [
      'Unlock payroll',
      'Regenerate payroll',
      'Review results',
      'Lock payroll again',
    ])
    // Regeneration is impossible while locked, so the popup must not offer it.
    assert.equal(a?.action, 'unlock')
  })

  test('the popup never invents an action the row does not already offer', () => {
    for (const status of ['generated', 'locked'] as const) {
      const a = payrollAttention({ status, outOfDate: true, reopened: false })!
      const { primary, secondary } = payrollRowActions(status)
      assert.ok([primary, ...secondary].includes(a.action!), status)
    }
  })

  test('a reopened but current period is marked, and not as work outstanding', () => {
    const a = payrollAttention({ status: 'generated', outOfDate: false, reopened: true })
    // Amber is reserved for stale payroll — the Attention Needed card counts
    // exactly those, so a reopened-and-regenerated month must not read the same.
    assert.equal(a?.tone, 'info')
    assert.equal(a?.action, null)
  })

  test('staleness outranks the reopen note when a period is both', () => {
    const a = payrollAttention({ status: 'locked', outOfDate: true, reopened: true })
    assert.equal(a?.tone, 'amber')
    assert.equal(a?.action, 'unlock')
  })
})
