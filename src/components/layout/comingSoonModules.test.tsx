/**
 * Sales, Marketing and Pricing (20270515000000): registered modules that open a Coming soon page.
 *
 * Who may open them, what a refused person sees, what the page says, and that the database registers exactly
 * what the code registers.
 *
 * Run:
 *   npm run test:file -- src/components/layout/comingSoonModules.test.tsx
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import '@/lib/testing/cssModuleStub'
import { ComingSoonNotice } from './ComingSoonModule'
import '@/lib/permissions/modules'
import { getRegisteredModule } from '@/lib/permissions/registry'
import { canAccessManagementModule, isEngineGatedModule } from '@/lib/permissions/moduleVisibility'
import type { EffectivePermission } from '@/lib/permissions/types'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r/g, '')
// Marketing is the first of the three to get real work (Meta Ads, module 26): 20270522000000 adds its `edit` action
// and changes its description. Its page is still Coming soon, so it stays in every list here.
const MODULES = [
  { key: 'sales', title: 'Sales', actions: ['view'] },
  { key: 'marketing', title: 'Marketing', actions: ['view', 'edit'] },
  { key: 'pricing', title: 'Pricing', actions: ['view'] },
]
const MIGRATION = read('supabase/migrations/20270515000000_register_sales_marketing_pricing_modules.sql')
const MARKETING_MIGRATION = read('supabase/migrations/20270522000000_marketing_meta_edit_action.sql')
const FIRST_MARKETING_DESCRIPTION = 'Marketing module. Coming soon.'
const LAUNCHER = read('src/app/modules/page.tsx')

const view = (allowed: boolean): EffectivePermission[] =>
  [{ actionKey: 'view', allowed, source: 'employee_override' }]
const canOpen = (role: string | null, moduleKey: string, permissions: EffectivePermission[]) =>
  canAccessManagementModule({ role, moduleKey, isModuleActive: true, permissions })

describe('who may open them', () => {
  for (const { key } of MODULES) {
    test(`${key}: Admin and a person granted view, nobody else`, () => {
      assert.equal(canOpen('admin', key, []), true)
      assert.equal(canOpen('member', key, view(true)), true)
      assert.equal(canOpen('manager', key, []), false)
      assert.equal(canOpen('member', key, []), false)
      assert.equal(canOpen('member', key, view(false)), false)
      assert.equal(canOpen(null, key, view(true)), false)
    })
  }
})

describe('registration', () => {
  for (const { key, title, actions } of MODULES) {
    test(`${key}: engine-gated, with ${actions.join(' and ')} as its ${actions.length === 1 ? 'only action' : 'actions'}`, () => {
      assert.ok(isEngineGatedModule(key))
      const mod = getRegisteredModule(key)
      assert.ok(mod)
      assert.equal(mod.displayName, title)
      assert.deepEqual(mod.actions.map(a => a.actionKey), actions)
    })

    test(`${key}: the database says what the code says`, () => {
      const mod = getRegisteredModule(key)
      // The first registration holds the description the module was born with.
      const bornWith = key === 'marketing' ? FIRST_MARKETING_DESCRIPTION : mod!.description
      assert.ok(MIGRATION.includes(`('${key}', '${title}', '${bornWith}', '/${key}', 'live', null,`), 'app_modules')
      assert.ok(MIGRATION.includes(`('${key}', '${title}', '${bornWith}')`), 'permission_modules')
      if (key === 'marketing') {
        // ...and the later migration changes it to what the code says now, in both tables.
        assert.notEqual(mod!.description, FIRST_MARKETING_DESCRIPTION)
        assert.equal(MARKETING_MIGRATION.split(`set description = '${mod!.description}'`).length - 1, 2, 'both tables')
      }
    })
  }

  test('the migration registers and adds nothing else', () => {
    assert.ok(!/create\s+(table|function|policy|trigger|type)|alter\s+(table|type)/i.test(MIGRATION))
    assert.ok(MIGRATION.includes("select 'admin', mpa.module_id"), 'the Admin role holds view')
    assert.equal((MIGRATION.match(/into public\.role_permissions/g) ?? []).length, 1, 'no other role is seeded')
  })
})

describe('the routes and the launcher', () => {
  for (const { key, title } of MODULES) {
    test(`${key}: the layout guards the module and a refused person goes back to Modules`, () => {
      const layout = read(`src/app/${key}/layout.tsx`)
      assert.ok(layout.includes(`<ModuleGuard moduleKey="${key}" deniedRoute="/modules">`))
    })

    test(`${key}: the page opens the Coming soon shell for this module`, () => {
      assert.ok(read(`src/app/${key}/page.tsx`).includes(`<ComingSoonModule moduleKey="${key}" title="${title}" />`))
    })

    test(`${key}: the launcher card is behind the same gate and goes to the route`, () => {
      assert.ok(LAUNCHER.includes(`...(canOpenModule('${key}') ? [{\n      key: '${key}',\n      title: '${title}',`))
      assert.ok(LAUNCHER.includes(`href: '/${key}',`))
    })
  }
})

describe('the notice', () => {
  const html = renderToStaticMarkup(<ComingSoonNotice moduleKey="sales" />)

  test('says Coming soon and offers the way back', () => {
    assert.ok(html.includes('Coming soon'))
    assert.ok(html.includes('It will open here when it is ready.'))
    assert.ok(html.includes('href="/modules"'))
    assert.ok(html.includes('Back to Modules'))
  })
})
