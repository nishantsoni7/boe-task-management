/**
 * Image Editor access, and the one state that must not leak.
 *
 * THE STATE THIS FILE EXISTS FOR
 * ------------------------------
 * Control Center deliberately lets an administrator leave `create` stored while
 * `view` is off — child actions go dormant rather than being deleted, so
 * turning View back on restores what Use was. That means the pair
 * (view = false, create = true) is REACHABLE in the database and must grant
 * nothing at all.
 *
 * Every module before this one gets that gate free, from the RESTRICTIVE
 * row-level policies in 20260905000000. The Image Editor stores nothing, so it
 * has no tables for a policy to attach to, and resolve_permission() returns the
 * raw value for the action it is asked about. The gate is therefore in this
 * file and in the two API routes, and these tests are what hold it there.
 *
 * Run:
 *   npx tsx --test src/lib/permissions/imageEditor.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  deriveImageEditorCapabilities, NO_IMAGE_EDITOR_CAPABILITIES, IMAGE_EDITOR_MODULE_KEY,
} from './imageEditor'
import { canAccessManagementModule, ENGINE_GATED_MODULE_KEYS } from './moduleVisibility'
import type { EffectivePermission, PermissionLevel } from './types'

/** Which level decided a grant is irrelevant to the gate; one is enough. */
const SOURCE: PermissionLevel = 'employee_override'

const grants = (spec: Record<string, boolean>): EffectivePermission[] =>
  Object.entries(spec).map(([actionKey, allowed]) => ({
    actionKey, allowed, source: SOURCE,
  }))

const NEITHER = grants({ view: false, create: false })
const VIEW_ONLY = grants({ view: true, create: false })
const VIEW_AND_USE = grants({ view: true, create: true })
/** The dormant-child state: Use stored, View withdrawn. */
const USE_WITHOUT_VIEW = grants({ view: false, create: true })

describe('the four states', () => {
  test('neither grant: cannot open, cannot generate', () => {
    assert.deepEqual(deriveImageEditorCapabilities('member', NEITHER), {
      canOpen: false, canGenerate: false,
    })
  })

  test('View only: may open, may NOT generate', () => {
    assert.deepEqual(deriveImageEditorCapabilities('member', VIEW_ONLY), {
      canOpen: true, canGenerate: false,
    })
  })

  test('View + Use: may open and generate', () => {
    assert.deepEqual(deriveImageEditorCapabilities('member', VIEW_AND_USE), {
      canOpen: true, canGenerate: true,
    })
  })

  test('Use stored WITHOUT View grants nothing at all', () => {
    // The whole point. `create` is true in the database and must stay dormant.
    assert.deepEqual(deriveImageEditorCapabilities('member', USE_WITHOUT_VIEW), {
      canOpen: false, canGenerate: false,
    })
  })
})

describe('the dormant-child state, checked from every angle', () => {
  test('the launcher card stays hidden', () => {
    // Same function the /modules page and ModuleGuard call.
    assert.equal(canAccessManagementModule({
      role: 'member',
      moduleKey: IMAGE_EDITOR_MODULE_KEY,
      isModuleActive: true,
      permissions: USE_WITHOUT_VIEW,
    }), false)
  })

  test('direct page access stays blocked', () => {
    // ModuleGuard renders children only when canAccessManagementModule passes,
    // so the same false above is what refuses /image-editor.
    const guard = readFileSync(join(process.cwd(), 'src/components/layout/ModuleGuard.tsx'), 'utf8')
    assert.ok(guard.includes('canAccessManagementModule'), 'the guard must use the shared decision')
    const layout = readFileSync(join(process.cwd(), 'src/app/image-editor/layout.tsx'), 'utf8')
    assert.ok(layout.includes('ModuleGuard'), 'the Image Editor must be behind the guard')
    assert.ok(layout.includes('IMAGE_EDITOR_MODULE_KEY'))
  })

  test('canGenerate is false however `create` was stored', () => {
    const levels: PermissionLevel[] = ['system_default', 'role', 'department', 'employee_override']
    for (const source of levels) {
      const permissions: EffectivePermission[] = [
        { actionKey: 'view', allowed: false, source },
        { actionKey: 'create', allowed: true, source },
      ]
      assert.equal(deriveImageEditorCapabilities('member', permissions).canGenerate, false, source)
    }
  })

  test('a stronger grant does NOT imply entry here', () => {
    // deriveMeetingsCapabilities widens entry with `view || manage || edit ||
    // create`, which is right for a module whose rows are separately gated. The
    // same widening here would defeat the parent gate outright.
    for (const extra of ['manage', 'edit', 'delete', 'export', 'admin']) {
      const permissions = grants({ view: false, [extra]: true })
      assert.equal(deriveImageEditorCapabilities('member', permissions).canOpen, false, extra)
    }
  })
})

describe('failing closed', () => {
  test('a missing role grants nothing', () => {
    // A failed profile read is not "an ordinary employee".
    for (const role of [null, undefined, '']) {
      assert.deepEqual(deriveImageEditorCapabilities(role, VIEW_AND_USE), NO_IMAGE_EDITOR_CAPABILITIES)
    }
  })

  test('no permissions at all grants nothing', () => {
    assert.deepEqual(deriveImageEditorCapabilities('member', []), {
      canOpen: false, canGenerate: false,
    })
  })
})

describe('the administrator convention is preserved', () => {
  test('an admin holds both, with no grant rows', () => {
    assert.deepEqual(deriveImageEditorCapabilities('admin', []), {
      canOpen: true, canGenerate: true,
    })
  })

  test('an admin is not affected by a withdrawn view', () => {
    assert.deepEqual(deriveImageEditorCapabilities('admin', USE_WITHOUT_VIEW), {
      canOpen: true, canGenerate: true,
    })
  })

  test('no separate admin model was invented', () => {
    const source = readFileSync(join(process.cwd(), 'src/lib/permissions/imageEditor.ts'), 'utf8')
    assert.ok(source.includes('isAdminRole') || source.includes("=== 'admin'"))
    assert.ok(!source.includes('IMAGE_EDITOR_ADMIN'), 'no module-specific admin concept')
  })
})

describe('registration', () => {
  test('the module is engine-gated', () => {
    assert.ok((ENGINE_GATED_MODULE_KEYS as readonly string[]).includes(IMAGE_EDITOR_MODULE_KEY))
    assert.equal(ENGINE_GATED_MODULE_KEYS.length, 10)
  })

  test('the key is spelled once and shared', () => {
    assert.equal(IMAGE_EDITOR_MODULE_KEY, 'image_editor')
  })

  test('the registry declares exactly view and create, with the GLOBAL labels', () => {
    const modules = readFileSync(join(process.cwd(), 'src/lib/permissions/modules.ts'), 'utf8')
    const at = modules.indexOf("moduleKey: 'image_editor'")
    assert.ok(at > -1, 'the module must be registered')
    const block = modules.slice(at, modules.indexOf('})', at))
    assert.match(block, /actionKey: 'view', displayName: 'View'/)
    // 'Create', NOT 'Use'. syncPermissionRegistry upserts permission_actions on
    // conflict (action_key) and writes display_name with it, so a per-module
    // label here would rename `create` for every module that has it.
    assert.match(block, /actionKey: 'create', displayName: 'Create'/)
    // No custom action key was introduced.
    assert.ok(!block.includes('generate'), 'no custom generate action')
  })
})

describe('the Control Center label', () => {
  const API = readFileSync(join(process.cwd(),
    'src/app/api/control-center/permissions/employees/[id]/route.ts'), 'utf8').replace(/\r\n/g, '\n')

  test("image_editor's `create` is DISPLAYED as 'Use'", () => {
    // The internal key and the displayed word are different on purpose. This is
    // the code path the Control Center page renders from: the tree API resolves
    // every label, and page.tsx prints action.displayName verbatim.
    assert.match(API, /image_editor: \{ create: 'Use' \}/)
    assert.match(API, /MODULE_SCOPED_ACTION_LABELS\[moduleKey\]\?\.\[action\.action_key\]/)
    assert.match(API, /actionDisplayLabel\(action, mod\.module_key\)/)
  })

  test('the label is scoped to this module and changes `create` nowhere else', () => {
    const at = API.indexOf('const MODULE_SCOPED_ACTION_LABELS')
    const map = API.slice(at, API.indexOf('}\n', API.indexOf('}', at)) + 1)
    assert.ok(map.includes('image_editor'), 'the override must be module-scoped')
    // Exactly one module is overridden, and the fallback chain leaves every
    // other module reading permission_actions.display_name — 'Create'.
    assert.equal((map.match(/create:/g) ?? []).length, 1)
    assert.match(API, /\?\? ACTION_DISPLAY_LABELS\[action\.action_key\]\s*\n?\s*\?\? action\.display_name/)
  })

  test('the internal key stays `create`, a system action', () => {
    // The registry, the migration and both API guards all address `create`.
    const modules = readFileSync(join(process.cwd(), 'src/lib/permissions/modules.ts'), 'utf8')
    const at = modules.indexOf("moduleKey: 'image_editor'")
    assert.match(modules.slice(at, modules.indexOf('})', at)), /actionKey: 'create'/)

    const sql = readFileSync(join(process.cwd(),
      'supabase/migrations/20261020000000_register_image_editor_module.sql'), 'utf8')
    assert.match(sql, /action_key IN \('view', 'create'\)/)
    // The migration must not touch the global vocabulary.
    assert.ok(!sql.includes('permission_actions (action_key'),
      'no new or renamed action key')
  })

  test('the page prints the resolved label without re-deriving it', () => {
    const page = readFileSync(join(process.cwd(),
      'src/app/admin/control-center/permissions/page.tsx'), 'utf8')
    assert.ok(page.includes('{action.displayName}'), 'the toggle renders the resolved label')
  })
})

describe('the migration', () => {
  const SQL = readFileSync(
    join(process.cwd(), 'supabase/migrations/20261020000000_register_image_editor_module.sql'), 'utf8')

  test('it registers the module in both registries', () => {
    assert.match(SQL, /INSERT INTO public\.app_modules/)
    assert.match(SQL, /INSERT INTO public\.permission_modules/)
    assert.ok(SQL.includes("'/image-editor'"))
  })

  test('both actions default to DENIED', () => {
    assert.match(SQL, /INSERT INTO public\.module_permission_actions[\s\S]*?false/)
    assert.match(SQL, /action_key IN \('view', 'create'\)/)
  })

  test('only admin gets a role default', () => {
    const roles = SQL.match(/SELECT '(\w+)', mpa\.module_id/g) ?? []
    assert.deepEqual(roles, ["SELECT 'admin', mpa.module_id"])
  })

  test('it adds no table, no policy and no new action key', () => {
    for (const banned of ['CREATE TABLE', 'CREATE POLICY', 'ALTER TABLE', 'permission_actions (action_key']) {
      assert.ok(!SQL.includes(banned), `${banned} must not appear`)
    }
  })

  test('it explains why there is no RLS parent gate', () => {
    // A future reader looking for the usual module_entry_open() gate will not
    // find one. The absence must be deliberate and stated.
    assert.match(SQL, /module_entry_open/)
    assert.match(SQL, /no tables|NO TABLES/i)
  })
})

// ═══ The launcher card ════════════════════════════════════════════════════════
//
// Registering the module in app_modules and ENGINE_GATED_MODULE_KEYS decides
// AUTHORIZATION, not discovery. /modules renders a hardcoded array of card
// definitions, each wrapped in canOpenModule(key); a module with no entry in
// that array has no card however its permissions resolve. That is why View
// resolution and ModuleGuard worked while the card was missing.
//
// These tests pin the entry and the gate around it. The gate itself —
// canAccessManagementModule — is exercised directly above, so what is asserted
// here is that the card is wired to it and to nothing weaker.

describe('the /modules launcher card', () => {
  const LAUNCHER = readFileSync(join(process.cwd(), 'src/app/modules/page.tsx'), 'utf8')

  /** The card definition object, read with balanced brackets. */
  const cardBlock = (() => {
    const at = LAUNCHER.indexOf("key: 'image_editor'")
    assert.ok(at > -1, 'the Image Editor card must exist in the launcher')
    return LAUNCHER.slice(LAUNCHER.lastIndexOf('...(', at), LAUNCHER.indexOf('}] : []),', at))
  })()

  test('the card is gated by canOpenModule, the shared parent gate', () => {
    // Not by app_modules.visibility_type, not by a role check, not by `create`.
    assert.ok(cardBlock.startsWith("...(canOpenModule('image_editor') ?"), cardBlock.slice(0, 80))
  })

  test('View permission shows the card', () => {
    // canOpenModule delegates to canAccessManagementModule, verified here.
    assert.equal(canAccessManagementModule({
      role: 'member', moduleKey: IMAGE_EDITOR_MODULE_KEY,
      isModuleActive: true, permissions: VIEW_ONLY,
    }), true)
  })

  test('no View hides the card', () => {
    assert.equal(canAccessManagementModule({
      role: 'member', moduleKey: IMAGE_EDITOR_MODULE_KEY,
      isModuleActive: true, permissions: NEITHER,
    }), false)
  })

  test('stored Use without View hides the card', () => {
    // The dormant-child state must not light the launcher up either.
    assert.equal(canAccessManagementModule({
      role: 'member', moduleKey: IMAGE_EDITOR_MODULE_KEY,
      isModuleActive: true, permissions: USE_WITHOUT_VIEW,
    }), false)
  })

  test('an admin sees the card, under the existing convention', () => {
    assert.equal(canAccessManagementModule({
      role: 'admin', moduleKey: IMAGE_EDITOR_MODULE_KEY,
      isModuleActive: true, permissions: NEITHER,
    }), true)
    // And through the module's own derivation, which admins bypass.
    assert.equal(deriveImageEditorCapabilities('admin', NEITHER).canOpen, true)
  })

  test('the card opens /image-editor and is titled Image Editor', () => {
    assert.match(cardBlock, /href: '\/image-editor'/)
    assert.match(cardBlock, /title: 'Image Editor'/)
  })

  test('the description matches the registered module description exactly', () => {
    const sql = readFileSync(join(process.cwd(),
      'supabase/migrations/20261020000000_register_image_editor_module.sql'), 'utf8')
    const description = 'Turn factory furniture photographs into catalogue studio images.'
    assert.ok(cardBlock.includes(description), 'the card must use the registered description')
    assert.ok(sql.includes(description), 'and the migration must register that same sentence')
  })

  test('the icon comes from a library already used in the app', () => {
    assert.match(LAUNCHER, /import \{ Image as ImageIcon \} from 'lucide-react'/)
    assert.match(cardBlock, /<ImageIcon size=\{26\} strokeWidth=\{1\.8\} \/>/)
    const editor = readFileSync(join(process.cwd(), 'src/app/image-editor/page.tsx'), 'utf8')
    assert.ok(editor.includes("from 'lucide-react'"), 'lucide is already in use by this module')
  })

  test('the card carries no notification count', () => {
    assert.match(cardBlock, /notificationCount: null/)
  })

  test('no other launcher card changed', () => {
    // The exact set, pinned. A card removed, renamed or added elsewhere fails
    // here. Note the card `key` is the LAUNCHER's own identifier and is not
    // always the permission module key — 'samples' is sample_tracking,
    // 'assets' is assets_access — which is why this is a literal list.
    const keys = (LAUNCHER.match(/key: '[a-z_]+'/g) ?? [])
      .map(m => m.slice(6, -1)).sort()
    //
    // 'customer_reviews' is the Review Workflow Test card, added by a separate
    // module on another branch. It is NAMED here rather than admitted by
    // loosening the assertion, so a card appearing from anywhere else still
    // fails — which is the whole point of pinning the set.
    assert.deepEqual(keys, [
      'assets', 'attendance_payroll', 'control_center', 'customer_reviews',
      'finance', 'image_editor', 'meetings', 'members', 'orders', 'performance',
      'samples', 'showroom', 'tasks',
    ])
    // Exactly one Image Editor card, and an accent nobody else uses.
    assert.equal((LAUNCHER.match(/key: 'image_editor'/g) ?? []).length, 1)
    assert.equal((LAUNCHER.match(/#BE185D/g) ?? []).length, 1)
  })

  test('every other card keeps its own gate', () => {
    // The gates that were there before are untouched: this change adds a
    // branch, it does not re-gate anything.
    for (const gate of ["canOpenModule('finance')", "canOpenModule('meetings')",
      "canOpenModule('orders')", "canOpenModule('sample_tracking')",
      "effectiveProfile?.role === 'admin'"]) {
      assert.ok(LAUNCHER.includes(gate), `${gate} must still gate its card`)
    }
  })
})
