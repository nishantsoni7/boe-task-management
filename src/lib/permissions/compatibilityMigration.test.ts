/**
 * 20260902000000 — default-deny compatibility.
 *
 * The migration cannot be run here, so these assertions read its SQL and prove
 * the properties that matter: it addresses people by UUID rather than by name,
 * it asserts the baseline before mutating, it removes exactly the two grants
 * that must not become real, and it re-grants Meetings to the current real
 * employees while leaving the test accounts behind.
 *
 * Also pins the Access Control screen's retirement of the separate Module
 * Visibility workflow.
 *
 * Repository files only. No DB.
 *
 * Run:
 *   npx tsx --test src/lib/permissions/compatibilityMigration.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const sql = read('supabase/migrations/20260902000000_access_control_v1_compatibility.sql')
const code = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')

/**
 * One SQL statement, from its opening keyword to its terminating semicolon.
 * Assertions about "what this statement does" must not read the next one.
 */
function statement(startsWith: string): string {
  const start = code.indexOf(startsWith)
  assert.notEqual(start, -1, `statement not found: ${startsWith}`)
  const end = code.indexOf(';', start)
  assert.notEqual(end, -1, `unterminated statement: ${startsWith}`)
  return code.slice(start, end + 1)
}

// The exact ids captured in the 2026-08-14 baseline.
const DUMMY_SALES = 'ac5e5888-cb72-4f9c-ab36-5b4d32efe54c'
const DHRUV = '61f4a1f7-3c2a-435f-abca-f884301dcc96'
const ADITYA = '973b4337-9cae-4f66-8e7f-b158326cdc10'
const GRANDFATHERED = [
  '9322e802-7203-456d-8986-ca625f3a8b77', // Prerna
  'b37c5ae7-b03f-4dd8-ad4c-3a210caff1f8', // Saksham
  '9b3bc075-0652-469a-a93f-698652f0e727', // Rakesh Prajapat
  'f8039454-9152-452d-8d33-261f58a471af', // Mohit Sharma
  'fb6eec18-f60c-4210-a712-f265f6732557', // Shravi
  '742c9b96-7c1c-4366-8272-99293f7ffa28', // Santosh Patel
  ADITYA,
  'fcf8bbf9-0cc4-4a6e-ba64-1143b14ef4a2', // Jasvi
  'c725dcae-aee2-4891-875b-433f8eb6c03d', // Namrata
  'a3d157da-9eef-4d81-9aa6-84b4aa6061d6', // Ashok Choudhary
  DHRUV,
]
/** Test accounts that hold Meetings today and must NOT be grandfathered. */
const EXCLUDED = [
  '890f0067-cef5-4d9c-9fdd-98fe407f3cbd', // Objection B
  '27e2f32b-f12b-4a6a-aebd-c44d2ce1db7f', // Test Management User (DUMMY)
  DUMMY_SALES,                            // Test Sales User (DUMMY)
  'f4df0228-319c-4baa-947d-a3f709a0e8a3', // Test Operations User (DUMMY)
  '47b9bdc8-c73b-44f2-a675-aa3290a4e470', // Test HR User (DUMMY)
  'be0a101a-6bfb-495b-8e95-30a7c104be04', // Test Design User (DUMMY)
  'e2a14cb8-38ca-43e6-8703-3eb28b839375', // Objection A
  'eadf65b1-98c1-4c63-ba0f-816cc171f81e', // Test Admin Dept User (DUMMY)
  '57b11e89-a90b-407d-b92b-c4b0354f77fa', // Test Marketing User (DUMMY)
]

describe('the test account loses its protected Orders authority', () => {
  test('it is addressed by uuid, never by name', () => {
    assert.ok(code.includes(DUMMY_SALES))
    assert.equal(/full_name|ilike|'Test Sales User/.test(code), false, 'no name may appear in executable SQL')
  })

  test('only approve and manage are revoked', () => {
    const revoke = statement('update public.employee_permission_overrides')
    assert.ok(revoke.includes("pa.action_key in ('approve', 'manage')"))
    // view/create/edit are inert under 20260901000000 and are left alone.
    assert.equal(revoke.includes("'view'"), false)
    assert.equal(revoke.includes("'create'"), false)
  })

  test('it is a soft revoke, so the audit trail and the rollback survive', () => {
    assert.ok(code.includes('set revoked_by ='))
    assert.ok(code.includes('revoked_at = now()'))
    assert.equal(/delete from public\.employee_permission_overrides/.test(code), false)
  })

  test('a post-condition proves nothing protected survived', () => {
    assert.ok(code.includes('the test account still holds % protected Orders grant(s)'))
  })
})

describe('Meetings becomes deny-by-default without anyone losing access today', () => {
  test('the member and manager role defaults are removed', () => {
    assert.ok(code.includes('delete from public.role_permissions'))
    assert.ok(code.includes("rp.role in ('member', 'manager')"))
  })

  test('the admin role default is untouched', () => {
    const del = code.slice(code.indexOf('delete from public.role_permissions'))
    assert.equal(del.slice(0, 400).includes("'admin'"), false)
  })

  test('every current real employee is re-granted by uuid', () => {
    for (const id of GRANDFATHERED) {
      assert.ok(code.includes(id), `${id.slice(-6)} must be grandfathered`)
    }
  })

  test('Dhruv keeps the four actions his manager role gave him', () => {
    const block = statement('insert into public.employee_permission_overrides')
    for (const action of ['view', 'create', 'edit', 'manage']) {
      assert.ok(
        block.includes(`('${DHRUV}'::uuid, '${action}')`),
        `Dhruv must keep meetings.${action}`,
      )
    }
  })

  test('the nine test accounts are NOT grandfathered', () => {
    const block = statement('insert into public.employee_permission_overrides')
    for (const id of EXCLUDED) {
      // The dummy sales account legitimately appears elsewhere (the revoke
      // statement and a post-condition); what matters is that it is absent from
      // the grandfathering INSERT. The other eight must not appear at all.
      assert.equal(block.includes(id), false, `${id.slice(-6)} must not be grandfathered`)
      if (id !== DUMMY_SALES) {
        assert.equal(code.includes(id), false, `${id.slice(-6)} must not be re-granted anywhere`)
      }
    }
  })

  test('a future employee inherits nothing — the grant is per-person, not per-role', () => {
    const block = statement('insert into public.employee_permission_overrides')
    assert.ok(block.includes('employee_permission_overrides'))
    assert.equal(/insert into public\.role_permissions/.test(code), false)
  })

  test('only active, non-deleted employees are re-granted', () => {
    const block = statement('insert into public.employee_permission_overrides')
    assert.ok(block.includes('u.is_active'))
    assert.ok(block.includes('coalesce(u.is_deleted, false) = false'))
  })

  test('the expected number of rows is asserted before commit', () => {
    assert.ok(code.includes('expected 14 grandfathered Meetings rows'))
  })
})

describe('the migration fails safely rather than guessing', () => {
  test('it asserts the baseline before mutating anything', () => {
    const firstMutation = Math.min(
      ...['update public.employee_permission_overrides', 'delete from public.role_permissions', 'insert into public.employee_permission_overrides']
        .map(s => code.indexOf(s)).filter(i => i >= 0),
    )
    const firstAssertion = code.indexOf('raise exception')
    assert.ok(firstAssertion >= 0 && firstAssertion < firstMutation, 'assertions must precede mutation')
  })

  test('every precondition raises with a readable message', () => {
    for (const fragment of [
      'is not the member account captured in the baseline',
      'expected 2 active protected Orders overrides',
      'expected 5 Meetings role rows',
      'Meetings employee override(s) already exist',
    ]) {
      assert.ok(code.includes(fragment), `missing precondition: ${fragment}`)
    }
  })

  test('Dhruv and Aditya are protected by post-conditions', () => {
    assert.ok(code.includes('Dhruv holds only % active Finance/Orders grants'))
    assert.ok(code.includes('Aditya no longer holds the Assets assign grant'))
    assert.ok(code.includes(ADITYA))
  })
})

describe('scope limits', () => {
  test('Attendance and Payroll are never touched', () => {
    assert.equal(/attendance|payroll/i.test(code), false)
  })

  test('no unrelated module permission is changed', () => {
    // Scoped to the three MUTATING statements. The post-conditions legitimately
    // READ assets_access and finance to prove Aditya and Dhruv kept theirs;
    // reading is not changing.
    for (const start of [
      'update public.employee_permission_overrides',
      'delete from public.role_permissions',
      'insert into public.employee_permission_overrides',
    ]) {
      const named = [...statement(start).matchAll(/module_key = '([a-z_]+)'/g)].map(m => m[1])
      for (const m of named) {
        assert.ok(['meetings', 'orders'].includes(m), `${start} touches ${m}`)
      }
    }
  })

  test('Finance is not referenced except to assert Dhruv keeps it', () => {
    const financeRefs = [...code.matchAll(/finance/g)].length
    assert.ok(financeRefs > 0)
    assert.ok(code.includes("pm.module_key in ('finance', 'orders')"), 'only the preservation assertion')
  })

  test('a rollback plan is documented', () => {
    assert.ok(sql.includes('ROLLBACK'))
    assert.ok(sql.includes('set revoked_by = null, revoked_at = null'))
  })
})

describe('Module Visibility is no longer a separate administrator workflow', () => {
  const layout = read('src/components/layout/ControlCenterLayout.tsx')

  test('the sidebar no longer offers it', () => {
    assert.equal(layout.includes('label="Module Visibility"'), false)
  })

  test('nothing was deleted — the tab and its data remain for rollback', () => {
    assert.ok(layout.includes("'modules'"), 'the tab id survives so ?tab=modules still resolves')
    const page = read('src/app/admin/control-center/page.tsx')
    assert.ok(page.includes("tab === 'modules'"), 'the tab implementation is untouched')
  })

  test('app_modules itself is untouched by either migration', () => {
    assert.equal(/app_modules/.test(code), false)
    const enforcement = read('supabase/migrations/20260901000000_finance_orders_permission_enforcement.sql')
    const enforcementCode = enforcement.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')
    assert.equal(/app_modules/.test(enforcementCode), false)
  })
})

describe('the Access Control page uses the shared level model', () => {
  const page = read('src/app/admin/control-center/permissions/page.tsx')

  test('it imports the five V1 levels rather than declaring its own', () => {
    assert.ok(page.includes("from '@/lib/permissions/levels'"))
    assert.equal(
      page.includes("type AccessLevel = 'no_access' | 'viewer' | 'editor' | 'manager' | 'admin' | 'custom'"),
      false,
      'the page-local six-level vocabulary must be gone',
    )
  })

  test('the delete-granting Admin level is gone', () => {
    assert.equal(page.includes("key: 'admin', label: 'Admin'"), false)
    assert.equal(page.includes("{ key: 'editor'"), false)
  })

  test('it warns before clearing protected permissions', () => {
    assert.ok(page.includes('protectedActionsClearedByPreset'))
    assert.ok(page.includes('will remove:'))
    assert.ok(page.includes('Remove and continue'))
  })

  test('the warning names the actions in plain words', () => {
    assert.ok(page.includes("assign:                'Assign assets'"))
    assert.ok(page.includes('protectedActionWords'))
  })
})
