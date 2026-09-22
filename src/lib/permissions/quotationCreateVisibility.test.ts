/**
 * Who is OFFERED the action that raises a quotation request.
 *
 * An admin is not. Raising a request is the salesperson's step — it captures a
 * customer the raiser is dealing with — and the admin's part of the workflow is
 * the one after it: read it, respond to it, approve or reject it. The admin held
 * the New Request button only because `role === 'admin'` short-circuits every
 * capability in quotations.ts, never because the workflow asked them to raise
 * one.
 *
 * THE POINT OF THIS SUITE IS THE NARROWING, not the hiding. canCreateQuotations
 * must be false wherever canManageQuotations is false, false additionally for an
 * admin, and equal to it everywhere else — so no role gains anything, an admin
 * loses exactly one offer, and every non-admin that could raise a request still
 * can. If a future edit makes it a widening, these fail.
 *
 * Run:
 *   npx tsx --test src/lib/permissions/quotationCreateVisibility.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  deriveQuotationCapabilities,
  NO_QUOTATION_CAPABILITIES,
} from './quotations'
import type { EffectivePermission } from './types'

const ROOT = process.cwd()
// \r stripped: see the note in src/app/modules/moduleCardSurface.test.ts.
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r/g, '')

const LIST = read('src/app/tasks/quotation-requests/page.tsx')
const SIDEBAR = read('src/components/layout/DashboardLayout.tsx')
const NEW_PAGE = read('src/app/tasks/quotation-requests/new/page.tsx')

/** An allowed action on task_management, in the shape the engine returns. */
const grant = (actionKey: string): EffectivePermission =>
  ({ actionKey, allowed: true } as EffectivePermission)

const VIEW = grant('view')
const VIEW_QUOTATIONS = grant('view_quotations')
const MANAGE_QUOTATIONS = grant('manage_quotations')

describe('an admin reviews quotations and is not offered the creation action', () => {
  const admin = deriveQuotationCapabilities('admin', [])

  test('the admin may still SEE quotations', () => {
    assert.equal(admin.canViewQuotations, true)
  })

  test('the admin may still MANAGE them — review, respond, approve, reject', () => {
    assert.equal(admin.canManageQuotations, true,
      'every non-creation quotation operation branches on this and is unchanged')
  })

  test('the admin is NOT offered creation', () => {
    assert.equal(admin.canCreateQuotations, false)
  })

  test('and that holds however the admin arrives — with or without grants', () => {
    for (const perms of [
      [],
      [VIEW],
      [VIEW, VIEW_QUOTATIONS],
      [VIEW, MANAGE_QUOTATIONS],
      [VIEW, VIEW_QUOTATIONS, MANAGE_QUOTATIONS],
    ]) {
      const caps = deriveQuotationCapabilities('admin', perms)
      assert.equal(caps.canCreateQuotations, false,
        'an explicit manage_quotations grant does not restore the offer')
      assert.equal(caps.canManageQuotations, true, 'and never costs them manage')
    }
  })
})

describe('every other role keeps exactly what it had', () => {
  test('a manage_quotations holder is still offered creation', () => {
    const caps = deriveQuotationCapabilities('employee', [VIEW, MANAGE_QUOTATIONS])
    assert.equal(caps.canManageQuotations, true)
    assert.equal(caps.canCreateQuotations, true, 'unchanged for non-admins')
  })

  test('a view-only holder is not, and never was', () => {
    const caps = deriveQuotationCapabilities('employee', [VIEW, VIEW_QUOTATIONS])
    assert.equal(caps.canViewQuotations, true)
    assert.equal(caps.canManageQuotations, false)
    assert.equal(caps.canCreateQuotations, false)
  })

  test('a grant on a module the person cannot open produces nothing', () => {
    // Module entry first, as before: `view` is missing here.
    const caps = deriveQuotationCapabilities('employee', [MANAGE_QUOTATIONS])
    assert.equal(caps.canManageQuotations, false)
    assert.equal(caps.canCreateQuotations, false)
  })

  test('no permissions at all produce nothing', () => {
    const caps = deriveQuotationCapabilities('employee', [])
    assert.deepEqual(caps, NO_QUOTATION_CAPABILITIES)
  })

  test('every role is covered, and only admin differs', () => {
    for (const role of ['employee', 'manager', 'hr', 'sales', null, undefined]) {
      const caps = deriveQuotationCapabilities(role, [VIEW, MANAGE_QUOTATIONS])
      assert.equal(caps.canCreateQuotations, caps.canManageQuotations,
        `${role} must keep create and manage in step`)
    }
  })
})

describe('creation is a NARROWING of manage and never a widening', () => {
  const ROLES = ['admin', 'employee', 'manager', null, undefined]
  const PERM_SETS: EffectivePermission[][] = [
    [], [VIEW], [VIEW_QUOTATIONS], [MANAGE_QUOTATIONS],
    [VIEW, VIEW_QUOTATIONS], [VIEW, MANAGE_QUOTATIONS],
    [VIEW, VIEW_QUOTATIONS, MANAGE_QUOTATIONS],
  ]

  test('canCreateQuotations is never true where canManageQuotations is false', () => {
    for (const role of ROLES) {
      for (const perms of PERM_SETS) {
        const caps = deriveQuotationCapabilities(role, perms)
        if (!caps.canManageQuotations) {
          assert.equal(caps.canCreateQuotations, false,
            `${role} with ${perms.length} grants gained creation out of nowhere`)
        }
        // And create always implies view, transitively through manage.
        if (caps.canCreateQuotations) assert.equal(caps.canViewQuotations, true)
      }
    }
  })

  test('the two differ for admin and for nobody else', () => {
    for (const role of ROLES) {
      for (const perms of PERM_SETS) {
        const caps = deriveQuotationCapabilities(role, perms)
        const differs = caps.canManageQuotations !== caps.canCreateQuotations
        assert.equal(differs, role === 'admin' && caps.canManageQuotations,
          `${role} is the wrong place for create and manage to diverge`)
      }
    }
  })
})

describe('every surface that offers creation reads the new capability', () => {
  test('the list page header button is gated on it', () => {
    assert.ok(LIST.includes('canCreateQuotations'))
    assert.ok(/actions=\{canCreateQuotations \?/.test(LIST),
      'the New Request button is the gated thing')
  })

  test('the empty state does not point at a button the reader lacks', () => {
    assert.ok(/canCreateQuotations\s*\n?\s*\? 'Use the New Request button/.test(LIST))
    assert.equal(
      /Use the New Request button to submit a quotation request\.\s*\n\s*<\/p>/.test(LIST),
      false, 'the sentence must never be printed unconditionally')
  })

  test('the sidebar item is gated on it', () => {
    assert.ok(SIDEBAR.includes('quotationCaps.canCreateQuotations'))
    assert.equal(SIDEBAR.includes('quotationCaps.canManageQuotations'), false,
      'the sidebar had the only other use, and it moved')
  })

  test('there is no OTHER create-a-quotation entry point left ungated', () => {
    // Every navigation to the creation route in the app, outside the route's
    // own file, must sit behind canCreateQuotations.
    for (const [name, source] of [['list', LIST], ['sidebar', SIDEBAR]] as const) {
      const refs = source.match(/'\/tasks\/quotation-requests\/new'/g) ?? []
      assert.ok(refs.length > 0, `${name} still routes to the creation page`)
      assert.ok(source.includes('canCreateQuotations'),
        `${name} routes there without gating on the capability`)
    }
  })
})

describe('nothing below the interface moved', () => {
  test('the creation ROUTE keeps the gate it always had', () => {
    // canManageQuotations, unchanged. This is a display change: an admin is not
    // offered the action, and the route is not re-authorised around them.
    assert.ok(NEW_PAGE.includes('canManageQuotations'))
    assert.equal(NEW_PAGE.includes('canCreateQuotations'), false)
  })

  test('the two pre-existing capabilities are unchanged for every role', () => {
    for (const role of ['admin', 'employee', 'manager', null]) {
      for (const perms of [[], [VIEW], [VIEW, VIEW_QUOTATIONS], [VIEW, MANAGE_QUOTATIONS]]) {
        const caps = deriveQuotationCapabilities(role, perms)
        // Re-derived from the rules as they stood before canCreateQuotations.
        const allowed = (k: string) => perms.some(p => p.actionKey === k && p.allowed)
        const expectManage = role === 'admin'
          || (allowed('view') && allowed('manage_quotations'))
        const expectView = role === 'admin'
          || (allowed('view') && (allowed('view_quotations') || expectManage))
        assert.equal(caps.canManageQuotations, expectManage, `manage changed for ${role}`)
        assert.equal(caps.canViewQuotations, expectView, `view changed for ${role}`)
      }
    }
  })

  test('no second role-detection system was introduced', () => {
    // Comments stripped: this file explains the rule in prose that quotes it.
    const strip = (s: string) =>
      s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    const helper = strip(read('src/lib/permissions/quotations.ts'))
    const roleTests = helper.match(/role === /g) ?? []
    assert.equal(roleTests.length, 1,
      'the one pre-existing admin short-circuit decides it, and nothing else')
    for (const source of [LIST, SIDEBAR]) {
      assert.equal(/role === 'admin'/.test(strip(source)), false,
        'a surface must ask the helper, never test the role itself')
    }
  })

  test('the redaction and the task-type test are untouched', () => {
    const helper = read('src/lib/permissions/quotations.ts')
    assert.ok(helper.includes('export function redactQuotationFields'))
    assert.ok(helper.includes('export function isQuotationTask'))
    assert.ok(helper.includes("task.task_type === 'quotation_request'"))
  })
})
