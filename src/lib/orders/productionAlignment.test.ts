/**
 * Production alignment of a Confirmed Order (20261119000000).
 *
 * Every Order is born Not Aligned; only orders.align_production moves it; View
 * As never lends it. Pure. No database, no network.
 *
 * Run:
 *   npx tsx --test src/lib/orders/productionAlignment.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  ALIGN_PRODUCTION_BUTTON_LABEL,
  ALIGN_PRODUCTION_NOTE_TOO_LONG,
  PRODUCTION_ALIGNMENT_LABEL,
  UNALIGN_PRODUCTION_BUTTON_LABEL,
  asProductionAlignment,
  canAlignProduction,
  describeAlignmentFailure,
  describeProductionAlignment,
  validateAlignmentNote,
} from './productionAlignment'
import { deriveOrdersCapabilities } from '../permissions/orders'
import { isProtectedAction, presetAllowedActions } from '../permissions/levels'
import { PROTECTED_ACTIONS } from '../permissions/levels'

describe('the default is Not Aligned', () => {
  test('an absent, null or unknown value reads as Not Aligned', () => {
    for (const value of [null, undefined, '', 'something']) {
      assert.equal(asProductionAlignment(value), 'not_aligned', String(value))
    }
    assert.equal(asProductionAlignment('aligned'), 'aligned')
  })

  test('a newly confirmed Order says Not Aligned and explains what is outstanding', () => {
    const view = describeProductionAlignment({
      alignment: 'not_aligned', alignedByName: null, alignedAt: null, note: null,
      orderStatus: 'running', canAlign: false,
    })
    assert.equal(view.label, PRODUCTION_ALIGNMENT_LABEL.not_aligned)
    assert.equal(view.label, 'Not Aligned')
    assert.ok(/Head of Manufacturing/.test(view.hint))
    assert.equal(view.line, null)
    assert.equal(view.action, null, 'no control for somebody who may not align')
  })

  test('an aligned Order names who aligned it and when', () => {
    const view = describeProductionAlignment({
      alignment: 'aligned', alignedByName: 'Arjun', alignedAt: '6 Sep 2026', note: 'costing agreed',
      orderStatus: 'running', canAlign: true,
    })
    assert.equal(view.label, 'Aligned')
    assert.equal(view.line, 'Aligned by Arjun · 6 Sep 2026')
    assert.equal(view.note, 'costing agreed')
    assert.equal(view.action, UNALIGN_PRODUCTION_BUTTON_LABEL)
  })

  test('the holder of the authority is offered the next move; a cancelled Order offers none', () => {
    const base = { alignment: 'not_aligned', alignedByName: null, alignedAt: null, note: null, canAlign: true }
    assert.equal(describeProductionAlignment({ ...base, orderStatus: 'running' }).action, ALIGN_PRODUCTION_BUTTON_LABEL)
    assert.equal(describeProductionAlignment({ ...base, orderStatus: 'cancelled' }).action, null)
  })
})

describe('the authority', () => {
  test('orders.align_production is its own protected capability', () => {
    assert.ok(PROTECTED_ACTIONS.has('align_production'))
    assert.equal(isProtectedAction('align_production'), true)
    const caps = deriveOrdersCapabilities('member', [
      { actionKey: 'view', allowed: true, source: 'employee_override' },
      { actionKey: 'align_production', allowed: true, source: 'employee_override' },
    ])
    assert.equal(caps.canAlignProduction, true)
    assert.equal(caps.canApproveOrderSubmission, false, 'aligning is not reviewing')
    assert.equal(caps.canManageOrders, false)
  })

  test('approve_order and manage do NOT imply it, and no preset grants it', () => {
    const reviewer = deriveOrdersCapabilities('member', [
      { actionKey: 'view', allowed: true, source: 'employee_override' },
      { actionKey: 'approve_order', allowed: true, source: 'employee_override' },
      { actionKey: 'manage', allowed: true, source: 'employee_override' },
    ])
    assert.equal(reviewer.canAlignProduction, false)
    for (const level of ['viewer', 'contributor', 'manager'] as const) {
      assert.equal(presetAllowedActions(level, ['view', 'align_production']).align_production, false, level)
    }
  })

  test('an admin holds it; View As lends it to nobody', () => {
    const admin = deriveOrdersCapabilities('admin', [])
    assert.equal(canAlignProduction(admin, false), true)
    assert.equal(canAlignProduction(admin, true), false)
  })
})

describe('the note and the refusals', () => {
  test('a note is optional, trimmed, and capped at 500', () => {
    assert.deepEqual(validateAlignmentNote('  '), { ok: true, note: null })
    assert.deepEqual(validateAlignmentNote(' ok '), { ok: true, note: 'ok' })
    assert.deepEqual(validateAlignmentNote('x'.repeat(501)), { ok: false, message: ALIGN_PRODUCTION_NOTE_TOO_LONG })
  })

  test('a refusal is a sentence, never a code', () => {
    const closed = describeAlignmentFailure({ message: 'ORDER_PRODUCTION_ALIGNMENT_CLOSED: Order 0042 is cancelled' })
    assert.ok(/cancelled/.test(closed))
    assert.ok(!closed.includes('ORDER_PRODUCTION'))
    assert.ok(/permission/.test(describeAlignmentFailure({ message: 'You do not have permission to align' })))
    assert.ok(describeAlignmentFailure(new Error('x')).length > 0)
  })
})
