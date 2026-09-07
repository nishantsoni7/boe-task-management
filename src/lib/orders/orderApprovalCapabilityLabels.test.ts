/**
 * Control Center labels and grant/revoke wiring for the three Order
 * workflow authorities: orders.approve_order, orders.approve_advance_exception,
 * orders.align_production.
 *
 * WHAT THIS FILE IS FOR
 * ----------------------
 * All three capabilities already existed, were already enforced server-side
 * (actor_has_module_permission, same as finance.approve), and were already
 * generically assignable/revocable from Control Center before this file was
 * added — see 20260908000000, 20260913000000 and 20261119000000 for the
 * capabilities themselves, and src/lib/permissions/orders.test.ts for their
 * independence at the derive-function layer.
 *
 * This file proves three things that were previously unproven by any test:
 *
 *   1. 20261122000000_order_approval_capability_labels.sql renames exactly
 *      the three permission_actions.display_name rows it says it does, and
 *      nothing else — reading source, no database.
 *   2. src/lib/permissions/modules.ts carries the same three labels, so the
 *      registry and the migration agree.
 *   3. Control Center's employee permission API actually reads
 *      permission_actions.display_name (so the label change is not inert),
 *      and its PUT handler's revoke path writes revoked_at/revoked_by, which
 *      is exactly what resolve_permission's employee-override branch
 *      excludes (20260660, "revoked_at IS NULL") — the two ends of
 *      revocation, read from source on both sides.
 *
 * Reads repository files only. No database, no network.
 *
 * Run:
 *   npx tsx --test src/lib/orders/orderApprovalCapabilityLabels.test.ts
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const read = (relPath: string) => readFileSync(join(root, relPath), 'utf8').replace(/\r\n/g, '\n')

const LABEL_MIGRATION = 'supabase/migrations/20261122000000_order_approval_capability_labels.sql'
const migration = read(LABEL_MIGRATION)

const LABELS: Record<string, string> = {
  approve_order: 'Approve PI / Confirm Order',
  approve_advance_exception: 'Approve Advance Exception',
  align_production: 'Align Order for Production',
}

describe('20261122000000 renames exactly three permission_actions rows', () => {
  for (const [actionKey, label] of Object.entries(LABELS)) {
    test(`${actionKey} -> "${label}"`, () => {
      assert.match(
        migration,
        new RegExp(
          `update public\\.permission_actions set display_name = '${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\s*\\n\\s*where action_key = '${actionKey}'`,
        ),
      )
    })
  }

  test('touches no other table — labels only, no capability or enforcement change', () => {
    const code = migration.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')
    assert.doesNotMatch(code, /insert into|delete from|alter table|create (or replace )?function/i,
      'this migration must only UPDATE permission_actions.display_name')
    assert.doesNotMatch(code, /employee_permission_overrides|role_permissions|department_permissions/i,
      'a label rename must not touch who holds what')
  })

  test('self-asserts each action belongs to exactly one module before renaming it', () => {
    assert.match(migration, /module_permission_actions/,
      'must verify no shared-label collision (the view_all lesson from 20261111000000) before writing')
  })
})

describe('the TypeScript registry carries the same three labels as the migration', () => {
  const modules = read('src/lib/permissions/modules.ts')

  for (const [actionKey, label] of Object.entries(LABELS)) {
    test(`modules.ts: ${actionKey} -> "${label}"`, () => {
      assert.ok(
        modules.includes(`{ actionKey: '${actionKey}', displayName: '${label}' }`),
        `src/lib/permissions/modules.ts must declare the same display name the migration writes for ${actionKey}`,
      )
    })
  }
})

describe('Control Center actually reads permission_actions.display_name — the label is not inert', () => {
  const route = read('src/app/api/control-center/permissions/employees/[id]/route.ts')

  test('the employee permission GET selects display_name from permission_actions', () => {
    assert.match(route, /permission_actions\s*\(\s*action_key,\s*display_name\s*\)/)
  })

  test('none of the three action keys has a module-scoped label override that would hide the DB label', () => {
    // MODULE_SCOPED_ACTION_LABELS exists for keys shared across modules with
    // different meanings (view_all, create in image_editor, ...). These three
    // are registered by exactly one module each (proven in the migration's
    // own self-assertion above), so if one ever gained an override entry here
    // it would silently stop reflecting the label this migration sets.
    const overrideBlockMatch = route.match(/const MODULE_SCOPED_ACTION_LABELS[^}]*\{([\s\S]*?)\n\}/)
    assert.ok(overrideBlockMatch, 'MODULE_SCOPED_ACTION_LABELS must still be findable in this file')
    const overrideBlock = overrideBlockMatch![1]
    for (const actionKey of Object.keys(LABELS)) {
      assert.doesNotMatch(overrideBlock, new RegExp(`\\b${actionKey}\\b`),
        `${actionKey} must not be overridden — its Control Center label comes from permission_actions.display_name`)
    }
  })
})

describe('revocation: the write side and the read side agree on revoked_at', () => {
  const route = read('src/app/api/control-center/permissions/employees/[id]/route.ts')
  const engine = read('supabase/migrations/20260660_create_permission_engine.sql')

  test('PUT with allowed: null writes revoked_by/revoked_at rather than deleting the row', () => {
    assert.match(route, /allowed\s*===\s*null/)
    assert.match(route, /revoked_by:\s*adminId,\s*revoked_at:\s*new Date\(\)\.toISOString\(\)/)
    assert.match(route, /\.is\('revoked_at',\s*null\)/,
      'the revoke UPDATE must target the currently-active override, not re-revoke an already-revoked row')
  })

  test('resolve_permission excludes a revoked override, so it falls back through the hierarchy', () => {
    assert.match(engine, /eo\.revoked_at IS NULL/i)
  })

  test('the grant write path never sets revoked_at, so a fresh grant is always active', () => {
    assert.match(route, /revoked_by:\s*null,\s*\n\s*revoked_at:\s*null,/)
  })
})
