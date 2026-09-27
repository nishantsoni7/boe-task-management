/**
 * Assets & Access — "Manage Asset Catalogue" (20270131000000).
 *
 * The capability derivation is exercised in assetsAccess.test.ts, and the
 * database behaviour — denial of direct requests, duplicates, retirement,
 * rename keeping links — in supabase/tests/asset_catalogue_assertions.sql.
 * This file asserts what those cannot reach from where they run:
 *
 *   1. what the module REGISTERS, and that no preset hands it out;
 *   2. the SHAPE of the migration: no client write path, the predicate checked
 *      first in every write RPC, RESTRICT on every link into the catalogue,
 *      and nobody granted anything;
 *   3. that the screens no longer carry their own list of categories.
 *
 * Repository files only. No database, no browser.
 *
 * Run:
 *   npx tsx --test src/lib/permissions/manageAssetCatalogue.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  PRESET_LEVELS,
  actionDependencyChain,
  isProtectedAction,
  standardActionsForLevel,
} from './levels'
import { protectedActionWords } from './accessControlChanges'
import { getRegisteredModule } from './registry'
import './modules'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const ACTION = 'manage_asset_catalogue'
const MIGRATION = read('supabase/migrations/20270131000000_asset_catalogue.sql')
/** The migration with its comments removed, so prose can never satisfy an assertion. */
const SQL = MIGRATION.replace(/--[^\n]*/g, '')

describe('what Assets & Access registers', () => {
  const assets = getRegisteredModule('assets_access')

  test('the capability is registered under the name an administrator will see', () => {
    const action = assets?.actions.find(a => a.actionKey === ACTION)
    assert.equal(action?.displayName, 'Manage Asset Catalogue')
  })

  test('it is protected, depends on module entry, and no preset grants it', () => {
    assert.equal(isProtectedAction(ACTION), true)
    assert.deepEqual(actionDependencyChain(ACTION), ['view'])
    for (const level of PRESET_LEVELS) {
      assert.ok(!standardActionsForLevel(level, (assets?.actions ?? []).map(a => a.actionKey)).includes(ACTION), `${level} preset grants ${ACTION}`)
    }
  })

  test('Control Center names what is being handed over', () => {
    assert.match(protectedActionWords([ACTION], 'assets_access'), /catalogue/i)
  })
})

describe('the migration', () => {
  test('registers the action denied by default and grants it to nobody but the admin role', () => {
    assert.match(SQL, /VALUES \('manage_asset_catalogue', 'Manage Asset Catalogue', false\)/)
    assert.match(SQL, /SELECT pm\.id, pa\.id, false\s+FROM public\.permission_modules/)
    // The only role row is admin's, and no employee override is written.
    assert.match(SQL, /SELECT 'admin', mpa\.module_id, mpa\.action_id, true/)
    assert.doesNotMatch(SQL, /INSERT INTO public\.employee_permission_overrides/i)
    assert.doesNotMatch(SQL, /INSERT INTO public\.department_permissions/i)
    assert.doesNotMatch(SQL, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
      'no user id may appear in the migration')
  })

  test('no client may write the catalogue tables directly', () => {
    assert.match(SQL, /REVOKE INSERT, UPDATE, DELETE, TRUNCATE\s+ON public\.asset_categories, public\.asset_products, public\.asset_catalogue_activity\s+FROM authenticated/)
    // Every policy the migration creates on these tables is SELECT or the
    // RESTRICTIVE entry gate — never an INSERT / UPDATE / DELETE rule.
    const policies = [...SQL.matchAll(/CREATE POLICY "([^"]+)" ON public\.(asset_\w+)\s+FOR (\w+)/g)]
    assert.ok(policies.length >= 3)
    for (const [, name, , cmd] of policies) assert.equal(cmd, 'SELECT', `${name} is a ${cmd} policy`)
  })

  test('every write RPC checks the predicate before it touches anything', () => {
    for (const fn of ['create_asset_category', 'update_asset_category', 'create_asset_product', 'update_asset_product']) {
      const body = SQL.split(`CREATE OR REPLACE FUNCTION public.${fn}(`)[1]?.split('$$;')[0] ?? ''
      assert.ok(body, `${fn} is defined`)
      const firstStatement = body.split('BEGIN')[1]?.trim().split(';')[0]
      assert.equal(firstStatement, 'PERFORM public.assert_asset_catalogue_manager()', `${fn} must authorize first`)
      assert.match(body, /SECURITY DEFINER\s+SET search_path = public, pg_temp/, `${fn} pins its search_path`)
      assert.match(SQL, new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([^)]*\\) FROM public, anon;`), `${fn} is not anon-callable`)
    }
  })

  test('the predicate is admin OR the explicit grant, for active accounts only', () => {
    const body = SQL.split('FUNCTION public.can_manage_asset_catalogue()')[1].split('$$;')[0]
    assert.match(body, /AND is_active/)
    assert.match(body, /role = 'admin'\s+OR public\.resolve_permission\(auth\.uid\(\), 'assets_access', 'manage_asset_catalogue'\)/)
    // It does not borrow any asset action.
    assert.doesNotMatch(body, /'(create|edit|manage|assign|delete)'/)
  })

  test('historical references are protected: every link into the catalogue is RESTRICT', () => {
    assert.match(SQL, /FOREIGN KEY \(asset_type\) REFERENCES public\.asset_categories\(key\)\s+ON UPDATE RESTRICT ON DELETE RESTRICT/)
    assert.match(SQL, /FOREIGN KEY \(proposed_asset_type\) REFERENCES public\.asset_categories\(key\)\s+ON UPDATE RESTRICT ON DELETE RESTRICT/)
    assert.match(SQL, /product_id uuid\s+REFERENCES public\.asset_products\(id\) ON UPDATE RESTRICT ON DELETE RESTRICT/)
    assert.doesNotMatch(SQL, /ON DELETE CASCADE/i)
    assert.doesNotMatch(SQL, /DELETE FROM public\.asset_(categories|products)/i)
  })

  test('existing assets are not rewritten: no UPDATE of assets anywhere in the file', () => {
    assert.doesNotMatch(SQL, /UPDATE public\.assets\b/i)
  })

  test('the six categories are backfilled under their existing keys', () => {
    for (const key of ['laptop_desktop', 'monitor', 'mouse_keyboard', 'storage', 'phone', 'other']) {
      assert.match(SQL, new RegExp(`\\('${key}',\\s+'[^']+'\\)`), key)
    }
  })

  test('the consistency trigger locks what it validates against (review finding 3 on #240)', () => {
    // Without these, a concurrent product move and asset write can both
    // commit a mismatch. Behaviour is proved by
    // supabase/tests/run_asset_catalogue_race_local.sh (both orders + a
    // negative control); this pins that the locks stay in the file.
    const body = SQL.split('FUNCTION public.enforce_asset_catalogue_links()')[1].split('$$;')[0]
    assert.match(body, /FROM public\.asset_categories WHERE key = new\.asset_type\s+FOR SHARE;/)
    assert.match(body, /FROM public\.asset_products WHERE id = new\.product_id\s+FOR SHARE;/)
    // The mover still holds the product FOR UPDATE while it counts assets.
    const mover = SQL.split('FUNCTION public.update_asset_product(')[1].split('$$;')[0]
    assert.match(mover, /FROM public\.asset_products WHERE id = p_id FOR UPDATE;/)
    assert.match(mover, /ASSET_CATALOGUE_IN_USE/)
  })

  test('catalogue history is append-only', () => {
    assert.match(SQL, /BEFORE UPDATE OR DELETE ON public\.asset_catalogue_activity/)
  })
})

describe('one catalogue, not two', () => {
  test('the app no longer compiles in a list of categories', () => {
    const types = read('src/lib/assets/types.ts')
    assert.doesNotMatch(types, /ASSET_CATEGORY_OPTIONS/)
    const modals = read('src/components/assets/AssetChangeModals.tsx')
    assert.doesNotMatch(modals, /ASSET_CATEGORY_OPTIONS/)
  })
})
