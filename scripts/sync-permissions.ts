/**
 * Permission registry <-> database sync/check.
 *
 * The TypeScript module registry (src/lib/permissions/modules.ts) is the
 * source of truth for which modules/actions exist. This script pushes that
 * definition into permission_modules / permission_actions /
 * module_permission_actions so SQL-side resolvers (which can't read a TS
 * registry) stay current — and, in --check mode, fails loudly instead of
 * letting the two drift apart silently.
 *
 * Run:
 *   npm run permissions:sync    # upsert registry into the DB
 *   npm run permissions:check   # read-only: exit 1 if DB is stale (for CI)
 */

import { config } from 'dotenv'
import { createClient } from '@supabase/supabase-js'

// Load .env.local first (this repo's local convention) without letting it
// clobber real environment variables already set by CI/production, then
// fall back to plain .env for anyone using that convention instead. dotenv
// never overrides an already-set process.env value, and a missing file is
// a silent no-op, so this is safe across all four environments.
config({ path: '.env.local' })
config()
import '../src/lib/permissions/modules'
import { getRegisteredModules, syncPermissionRegistry } from '../src/lib/permissions/registry'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in the environment.')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

async function checkOnly(): Promise<void> {
  const registered = getRegisteredModules()
  const mismatches: string[] = []

  const { data: dbModules, error: modulesError } = await supabase
    .from('permission_modules')
    .select('id, module_key, display_name, description')
  if (modulesError) throw modulesError

  const dbModuleByKey = new Map((dbModules ?? []).map((m) => [m.module_key, m]))

  for (const mod of registered) {
    const dbMod = dbModuleByKey.get(mod.moduleKey)
    if (!dbMod) {
      mismatches.push(`module "${mod.moduleKey}" is registered in code but missing from permission_modules`)
      continue
    }
    if (dbMod.display_name !== mod.displayName || (dbMod.description ?? undefined) !== mod.description) {
      mismatches.push(`module "${mod.moduleKey}" display_name/description differs from the registry`)
    }

    const { data: links, error: linksError } = await supabase
      .from('module_permission_actions')
      .select('default_allowed, permission_actions(action_key)')
      .eq('module_id', dbMod.id)
    if (linksError) throw linksError

    const dbActionKeys = new Set(
      (links ?? []).map((l) => (l.permission_actions as unknown as { action_key: string } | null)?.action_key),
    )
    for (const action of mod.actions) {
      if (!dbActionKeys.has(action.actionKey)) {
        mismatches.push(`module "${mod.moduleKey}" action "${action.actionKey}" is registered in code but missing from module_permission_actions`)
      }
    }
  }

  const registeredKeys = new Set(registered.map((m) => m.moduleKey))
  for (const dbMod of dbModules ?? []) {
    if (!registeredKeys.has(dbMod.module_key)) {
      mismatches.push(`module "${dbMod.module_key}" exists in permission_modules but is not registered in code`)
    }
  }

  if (mismatches.length > 0) {
    console.error(`Permission registry is out of sync with the database (${mismatches.length} issue(s)):`)
    for (const m of mismatches) console.error(`  - ${m}`)
    console.error('\nRun `npm run permissions:sync` to reconcile.')
    process.exit(1)
  }

  console.log(`Permission registry in sync: ${registered.length} module(s) match the database.`)
}

async function main(): Promise<void> {
  if (process.argv.includes('--check')) {
    await checkOnly()
    return
  }

  const registered = getRegisteredModules()
  console.log(`Syncing ${registered.length} module(s) into the permission engine...`)
  await syncPermissionRegistry(supabase)
  console.log('Done.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
