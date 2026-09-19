/**
 * Assets & Access — "Manage Access Records" (20261028000000).
 *
 * The capability derivation itself is exercised in assetsAccess.test.ts. This
 * file asserts the parts a behavioural test cannot reach:
 *
 *   1. what the module REGISTERS, and that a preset can never hand it out;
 *   2. what the MIGRATION does — the predicate, the three policies it replaces,
 *      the absence of a DELETE policy, and the shape of the single grant;
 *   3. that the enforcement is SERVER-SIDE, so hiding a button is nowhere near
 *      the whole story;
 *   4. that nothing hardcodes the one employee who holds it, and no role name
 *      implies it.
 *
 * Repository files only. No database, no browser.
 *
 * Run:
 *   npx tsx --test src/lib/permissions/manageAccessRecords.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  PRESET_LEVELS,
  actionDependencyChain,
  dependentActionsToRemove,
  isProtectedAction,
  standardActionsForLevel,
  withRequiredDependencies,
} from './levels'
import { isActionEnforced, moduleEnforcement } from './enforcement'
import { getRegisteredModule } from './registry'
import './modules'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const ACTION = 'manage_access_records'
const MIGRATION = 'supabase/migrations/20261028000000_assets_access_manage_access_records.sql'

/**
 * The employee this capability was built for, and who will be granted it BY
 * HAND in Control Center after release.
 *
 * The id is written here, in a test, precisely so that it can be proved absent
 * everywhere else. It is not read by any code path.
 */
const ADITYA = '973b4337-9cae-4f66-8e7f-b158326cdc10'

/** Every file under `dir`, recursively. Skips nothing that could hide a grant. */
function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (entry.isFile()) yield full
  }
}

const assets = getRegisteredModule('assets_access')
const actionKeys = (assets?.actions ?? []).map(a => a.actionKey)

// ── 1. The registry ─────────────────────────────────────────────────────────

describe('what Assets & Access registers', () => {
  test('the capability is registered, named exactly as the owner asked', () => {
    const action = assets?.actions.find(a => a.actionKey === ACTION)
    assert.ok(action, 'assets_access must register manage_access_records')
    assert.equal(action?.displayName, 'Manage Access Records')
  })

  test('the five asset actions are untouched — nothing was widened to make room', () => {
    for (const key of ['view', 'create', 'edit', 'delete', 'manage', 'assign']) {
      assert.ok(actionKeys.includes(key), `assets_access lost '${key}'`)
    }
  })

  test('it is registered against Assets & Access and no other module', () => {
    // One key, one module. The engine scopes a grant by (module, action), but a
    // key registered twice would be two grants an administrator could confuse.
    for (const key of ['task_management', 'sample_tracking', 'orders', 'finance', 'meetings']) {
      const other = getRegisteredModule(key)
      assert.ok(
        !(other?.actions ?? []).some(a => a.actionKey === ACTION),
        `${key} must not register ${ACTION}`,
      )
    }
  })
})

// ── 2. A preset can never hand it out ───────────────────────────────────────

describe('protected, and dependent on module entry', () => {
  test('it is a PROTECTED action', () => {
    assert.equal(isProtectedAction(ACTION), true)
  })

  test('no standard level grants it — Manager included', () => {
    for (const level of PRESET_LEVELS) {
      assert.ok(
        !standardActionsForLevel(level, actionKeys).includes(ACTION),
        `${level} granted ${ACTION}`,
      )
    }
  })

  test('ticking it in Custom brings module entry with it', () => {
    // Without `view` the RESTRICTIVE access_records_module_entry_gate
    // (20260905000000) refuses every policy on the table, so the grant would be
    // stored and dead.
    assert.deepEqual(actionDependencyChain(ACTION), ['view'])
    assert.ok(withRequiredDependencies([ACTION], actionKeys).includes('view'))
  })

  test('withdrawing module entry withdraws it too', () => {
    // The half that matters for safety: an administrator who turns Assets &
    // Access off for someone must not leave the Access Register grant standing.
    assert.ok(dependentActionsToRemove('view', actionKeys).includes(ACTION))
  })
})

// ── 3. The migration ────────────────────────────────────────────────────────

describe('20261028000000 — registration and defaults', () => {
  const sql = read(MIGRATION)

  test('registers a CUSTOM action, denied by default', () => {
    assert.match(
      sql,
      /INSERT INTO public\.permission_actions \(action_key, display_name, is_system\)\s*\nVALUES \('manage_access_records', 'Manage Access Records', false\)/,
    )
    assert.match(sql, /JOIN public\.permission_actions pa ON pa\.action_key = 'manage_access_records'\nWHERE pm\.module_key = 'assets_access'/)
    // default_allowed = false. The migration also asserts this at apply time.
    assert.match(sql, /SELECT pm\.id, pa\.id, false/)
  })

  test('the only ROLE rule it writes is admin’s', () => {
    const roleInserts = sql.match(/INSERT INTO public\.role_permissions[\s\S]*?;/g) ?? []
    assert.equal(roleInserts.length, 1)
    assert.match(roleInserts[0], /SELECT 'admin'/)
    // …and it asserts, at apply time, that no other role rule grants it.
    assert.match(sql, /non-admin role rule\(s\) grant this action/)
  })

  test('no department rule grants it', () => {
    assert.ok(
      !/INSERT INTO public\.department_permissions/i.test(sql),
      'the migration must write no department rule',
    )
    assert.match(sql, /department rule\(s\) grant this action/)
  })
})

describe('20261028000000 — the server-side check', () => {
  const sql = read(MIGRATION)

  test('the predicate is SECURITY DEFINER and resolves the action, not a role name', () => {
    const fn = sql.slice(
      sql.indexOf('CREATE OR REPLACE FUNCTION public.can_manage_access_records()'),
      sql.indexOf('COMMENT ON FUNCTION public.can_manage_access_records()'),
    )
    assert.ok(fn.length > 0, 'can_manage_access_records() must be defined')
    assert.match(fn, /SECURITY DEFINER/)
    assert.match(fn, /SET search_path = public/)
    // A deactivated account reads nothing, however its grants were left.
    assert.match(fn, /AND is_active/)
    assert.match(fn, /role = 'admin'/)
    assert.match(fn, /resolve_permission\(auth\.uid\(\), 'assets_access', 'manage_access_records'\)/)
  })

  test('it is not executable by anon', () => {
    assert.match(sql, /REVOKE EXECUTE ON FUNCTION public\.can_manage_access_records\(\) FROM public, anon;/)
    assert.match(sql, /GRANT  EXECUTE ON FUNCTION public\.can_manage_access_records\(\) TO authenticated;/)
  })

  test('all three administrative policies on access_records read the predicate', () => {
    // SELECT, INSERT and UPDATE — a direct PostgREST request is refused by RLS,
    // not by the absence of a button.
    for (const [name, clause] of [
      ['access_records_manage_select', 'FOR SELECT TO authenticated\n  USING (public.can_manage_access_records())'],
      ['access_records_manage_insert', 'FOR INSERT TO authenticated\n  WITH CHECK (public.can_manage_access_records())'],
    ] as const) {
      assert.ok(sql.includes(`CREATE POLICY "${name}" ON public.access_records\n  ${clause}`), name)
    }
    assert.ok(sql.includes(
      'CREATE POLICY "access_records_manage_update" ON public.access_records\n' +
      '  FOR UPDATE TO authenticated\n' +
      '  USING     (public.can_manage_access_records())\n' +
      '  WITH CHECK(public.can_manage_access_records())',
    ))
  })

  test('the old admin-only policies are dropped, not left beside the new ones', () => {
    for (const name of [
      'access_records_admin_select', 'access_records_admin_insert', 'access_records_admin_update',
    ]) {
      assert.ok(sql.includes(`DROP POLICY IF EXISTS "${name}"`), `${name} must be dropped`)
    }
  })

  test('the employee’s own-row read is untouched', () => {
    assert.ok(
      !sql.includes('DROP POLICY IF EXISTS "access_records_own_select"'),
      'access_records_own_select must not be dropped — it is how an employee sees their own records',
    )
    assert.match(sql, /access_records_own_select/)
  })

  test('no DELETE policy is created, for anybody', () => {
    // No /s flag: the tsconfig target predates it. Matching the two tokens on
    // the same CREATE POLICY statement is what matters, and every policy in
    // this file is written on the line after its CREATE POLICY.
    assert.ok(
      !/CREATE POLICY[\s\S]{0,200}?FOR DELETE/i.test(sql),
      'access_records must gain no DELETE policy',
    )
    // Asserted at apply time as well.
    assert.match(sql, /access_records grew % DELETE policy/)
  })

  test('the RESTRICTIVE module entry gate is required to still exist', () => {
    assert.match(sql, /access_records_module_entry_gate/)
    assert.match(sql, /NOT p\.polpermissive/)
  })
})

// ── 3b. THE MIGRATION GRANTS THE CAPABILITY TO NOBODY ───────────────────────
//
// The capability is defined and enforced by the migration; WHO HOLDS IT is an
// administrator's decision, made in Control Center after release. A seeded
// first holder would mean the permission arrived already given to someone, with
// no record of the decision in the place the business reads such decisions —
// and reverting the migration would then silently revoke a person's access
// rather than remove an unused ability.

describe('20261028000000 — no employee, role or department seed', () => {
  const sql = read(MIGRATION)

  test('it writes NO employee_permission_overrides row at all', () => {
    // Not an insert, not an update, not a delete. The only mention of the table
    // is the post-condition that counts holders and the comment explaining why.
    for (const verb of ['INSERT INTO', 'UPDATE', 'DELETE FROM']) {
      assert.ok(
        !new RegExp(`${verb}\\s+public\\.employee_permission_overrides`, 'i').test(sql),
        `the migration must not ${verb} employee_permission_overrides`,
      )
    }
  })

  test('the only ROLE rule is admin’s, and there is no department rule', () => {
    const roleInserts = sql.match(/INSERT INTO public\.role_permissions[\s\S]*?;/g) ?? []
    assert.equal(roleInserts.length, 1)
    assert.match(roleInserts[0], /SELECT 'admin'/)
    assert.ok(!/INSERT INTO public\.department_permissions/i.test(sql))
  })

  test('it contains no user id whatsoever', () => {
    // A UUID literal in this file could only be a person. There is none — which
    // is a stronger statement than "not that one person's".
    const uuids = sql.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g)
    assert.equal(uuids, null, `the migration names ${uuids?.join(', ')}`)
  })

  test('and it ASSERTS the absence at apply time, so a re-added seed fails the migration', () => {
    assert.match(sql, /this migration must grant the action to nobody/)
    assert.match(sql, /non-admin role rule\(s\) grant this action/)
    assert.match(sql, /department rule\(s\) grant this action/)
  })

  test('it says, in the file, how the capability is granted instead', () => {
    assert.match(sql, /Control Center/)
    assert.match(sql, /Access Control/)
  })
})

// ── 4. Nothing hardcodes the holder, and no role name implies it ────────────

describe('the app decides by grant, never by identity or role name', () => {
  const APP_FILES = [
    'src/lib/permissions/assetsAccess.ts',
    'src/lib/assets/viewRouting.ts',
    'src/app/assets-access/page.tsx',
    'src/components/layout/AssetsLayout.tsx',
    'src/hooks/useAssetsAccess.ts',
  ]

  test('no application file names the employee this was built for', () => {
    for (const file of APP_FILES) {
      assert.ok(
        !read(file).includes(ADITYA),
        `${file} must not hardcode a user id`,
      )
    }
  })

  test('NOTHING in the repository ties that user id to this capability', () => {
    // The broad statement, and the one that survives a refactor: no file
    // anywhere — application source or migration — mentions both the action key
    // and that person's id. Earlier Assets & Access migrations legitimately name
    // him for OTHER grants (20260723000000, 20260902000000, 20260903000000), so
    // the test is co-occurrence rather than mere presence.
    const roots = ['src', 'supabase/migrations', 'supabase/tests']
    // This file is the one legitimate exception: it holds the id in order to
    // prove it appears nowhere else, and nothing reads it.
    const SELF = __filename
    const offenders: string[] = []
    for (const root of roots) {
      for (const file of walk(join(ROOT, root))) {
        if (file === SELF) continue
        const text = readFileSync(file, 'utf8')
        if (text.includes(ADITYA) && text.includes(ACTION)) {
          offenders.push(file.slice(ROOT.length + 1))
        }
      }
    }
    assert.deepEqual(
      offenders, [],
      'these files tie a specific user id to manage_access_records; the grant belongs in Control Center',
    )
  })

  test('the capability is derived from the action key, not from a role literal', () => {
    const src = read('src/lib/permissions/assetsAccess.ts')
    assert.match(src, /const canManageAccess\s*=\s*allowed\('manage_access_records'\)/)
    // The old rule was `canManageAccess: false` for every non-admin. It is gone.
    assert.ok(!/canManageAccess:\s*false,/.test(src.split('NO_ASSETS_ACCESS_CAPABILITIES')[2] ?? ''))
    // 'manager' appears nowhere as a decision in this file.
    assert.ok(!/role === 'manager'/.test(src))
  })

  test('the register screen and its nav read the capability, not users.role', () => {
    const page = read('src/app/assets-access/page.tsx')
    assert.match(page, /canManageAccess=\{caps\.canManageAccess\}/)
    // The primary action is offered on the same boolean the RLS predicate
    // mirrors, so the button and the database cannot disagree.
    assert.match(page, /if \(!caps\.canManageAccess\) return null/)
  })

  test('Assets & Access still reports every action as enforced', () => {
    assert.equal(moduleEnforcement('assets_access').state, 'enforced')
    assert.equal(isActionEnforced('assets_access', ACTION), true)
  })
})

// ── 5. Credential security is not weakened ──────────────────────────────────

describe('the stored secret does not travel further than it did', () => {
  test('no client query selects secret_value', () => {
    const page = read('src/app/assets-access/page.tsx')
    assert.ok(
      !/\.select\([^)]*secret_value/.test(page),
      'the Access Register must not read the plaintext secret into the browser',
    )
    // The column list the screen does use, stated once.
    assert.match(page, /const ACCESS_RECORD_COLUMNS =\n\s*'id, employee_id, access_type, username, status, assigned_at, updated_at, updated_by'/)
  })

  test('writing a secret still works — the forms send one, they never show one', () => {
    const page = read('src/app/assets-access/page.tsx')
    assert.match(page, /secret_value: secret \|\| null/)         // Add
    assert.match(page, /\.\.\.\(secret \? \{ secret_value: secret \} : \{\}\)/) // Update, blank = unchanged
    assert.match(page, /type="password"/)
    // Blank means "keep the stored one", and the form says so rather than
    // leaving the reader to guess whether saving wipes it.
    assert.match(page, /placeholder="Leave blank to keep unchanged"/)
  })
})

// ── 6. The delegated workflow is the whole workflow ─────────────────────────
//
// The permission is only worth having if the screen behind it actually does the
// job an administrator does today: see EVERY employee's records, add one for
// anybody, and edit one. The live counterpart of this is §A4 of
// supabase/tests/asset_access_delegation_and_handover_assertions.sql, which
// performs all four writes as a grant holder against a real database.

describe('what the Access Register offers its holder', () => {
  const page = read('src/app/assets-access/page.tsx')
  const register = page.slice(
    page.indexOf('function AccessRegister('),
    page.indexOf('function CreateAccessModal('),
  )

  test('the list is the WHOLE register, not the reader’s own rows', () => {
    // No .eq('employee_id', …) anywhere in it. My Access is the screen that
    // filters; this one is the administrative view and RLS decides what arrives.
    assert.ok(register.length > 0, 'AccessRegister must exist')
    assert.match(register, /\.from\('access_records'\)\n\s*\.select\(ACCESS_RECORD_COLUMNS\)\n\s*\.order\('assigned_at'/)
    assert.ok(
      !/\.eq\('employee_id'/.test(register),
      'the register must not filter to one employee',
    )
  })

  test('it can add a record for any employee, chosen from the full list', () => {
    const create = page.slice(
      page.indexOf('function CreateAccessModal('),
      page.indexOf('function EditAccessModal('),
    )
    assert.match(create, /from\('access_records'\)\.insert\(\{/)
    assert.match(create, /employee_id: employeeId/)
    // The employee picker is the active-employee list the screen already loaded.
    assert.match(create, /employees\.map\(emp =>/)
  })

  test('it can edit a record — username, secret, and enabled state', () => {
    const edit = page.slice(page.indexOf('function EditAccessModal('))
    assert.match(edit, /\.from\('access_records'\)\n\s*\.update\(\{/)
    assert.match(edit, /username: username\.trim\(\)/)
    // Disable / re-enable lives on the row, in the register itself.
    assert.match(register, /const newStatus = row\.status === 'active' \? 'disabled' : 'active'/)
    assert.match(register, /\.update\(\{ status: newStatus, updated_by: user\?\.id \}\)/)
  })

  test('every one of those is offered without a role check in the component', () => {
    // The screen is reached only when caps.canManageAccess is true, and that is
    // decided once — in the layout and the view router — rather than re-derived
    // here from users.role. A role literal inside this component would be a
    // second, quieter rule.
    assert.ok(!/role === 'admin'/.test(register), 'no role literal in the register')
    assert.ok(!/isAdmin/.test(register), 'no admin flag in the register')
  })
})
