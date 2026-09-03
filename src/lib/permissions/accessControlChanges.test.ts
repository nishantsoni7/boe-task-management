import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  choicesForDesired,
  changesBetween,
  initialChoices,
  effectiveMap,
  summarizeSources,
  levelOf,
  moduleEntryAction,
  protectedActionWords,
  type ResolvedAction,
} from './accessControlChanges'
import { presetAllowedActions, enableModuleEntry } from './levels'

// The one write rule both Access Control screens share. These are the cases
// that decided the rule in production: the Aditya regression (enabling a module
// must not flatten child actions), needless rows (re-applying an inherited
// value must write nothing), and the revoke path (inherit → null).

const A = (actionKey: string, allowed: boolean, source: ResolvedAction['source']): ResolvedAction =>
  ({ actionKey, allowed, source })

const ASSETS: ResolvedAction[] = [
  A('view', false, 'system_default'),
  A('create', false, 'system_default'),
  A('edit', false, 'system_default'),
  A('delete', false, 'system_default'),
  A('manage', true, 'employee_override'),
  A('assign', true, 'employee_override'),
]
const KEYS = ASSETS.map(a => a.actionKey)

describe('choicesForDesired', () => {
  test('writes nothing where the inherited value already matches', () => {
    const next = choicesForDesired(ASSETS, presetAllowedActions('no_access', KEYS))
    assert.equal(next.get('view'), 'inherit', 'already denied by default')
    assert.equal(next.get('manage'), 'deny', 'an existing override must be flipped, not left')
    assert.equal(next.get('assign'), 'deny')
  })

  test('enabling a module preserves child overrides (the Aditya rule)', () => {
    const current = effectiveMap(ASSETS, initialChoices(ASSETS))
    const next = choicesForDesired(ASSETS, enableModuleEntry(KEYS, current))
    assert.equal(next.get('view'), 'allow')
    assert.equal(next.get('manage'), 'allow')
    assert.equal(next.get('assign'), 'allow')
    assert.equal(next.get('create'), 'inherit')
  })

  test('a preset is a complete statement', () => {
    const next = choicesForDesired(ASSETS, presetAllowedActions('viewer', KEYS))
    assert.equal(next.get('view'), 'allow')
    assert.equal(next.get('manage'), 'deny')
    assert.equal(next.get('assign'), 'deny')
  })
})

describe('changesBetween', () => {
  test('emits only what changed, with inherit as null', () => {
    const initial = initialChoices(ASSETS)
    const next = new Map(initial)
    next.set('view', 'allow')
    next.set('manage', 'inherit')
    const changes = changesBetween('assets_access', ASSETS, initial, next)
    assert.deepEqual(changes, [
      { moduleKey: 'assets_access', actionKey: 'view', allowed: true },
      { moduleKey: 'assets_access', actionKey: 'manage', allowed: null },
    ])
  })

  test('no changes for an untouched map', () => {
    const initial = initialChoices(ASSETS)
    assert.deepEqual(changesBetween('assets_access', ASSETS, initial, new Map(initial)), [])
  })
})

describe('summaries', () => {
  test('a module held entirely by override reads as one source', () => {
    const s = summarizeSources([A('use', true, 'employee_override'), A('verify', true, 'employee_override')])
    assert.deepEqual(s, { kind: 'single', source: 'employee_override', label: 'Employee override' })
  })

  test('a pending revert folds into mixed', () => {
    const s = summarizeSources(ASSETS.slice(4))
    assert.equal(s.kind, 'single')
    const reverted = summarizeSources(ASSETS.slice(4), k => (k === 'manage' ? 'inherit' : 'allow'))
    assert.equal(reverted.kind, 'mixed')
  })

  test('level and entry follow the shared model', () => {
    assert.equal(levelOf(ASSETS, effectiveMap(ASSETS, initialChoices(ASSETS))), 'custom')
    assert.equal(moduleEntryAction(['use', 'verify']), 'use')
    assert.equal(moduleEntryAction(['view', 'create']), 'view')
    assert.equal(moduleEntryAction(['create']), 'view', 'the fallback is view')
  })

  test('protected words are module-scoped where the key is ambiguous', () => {
    assert.equal(protectedActionWords(['view_all'], 'orders'), 'View all company orders')
    assert.equal(protectedActionWords(['manage', 'assign']), 'Manage and Assign assets')
  })
})

describe('By Employee delegates to the same rule', () => {
  const page = readFileSync(join(process.cwd(), 'src/app/admin/control-center/permissions/page.tsx'), 'utf8')
    .replace(/\r\n/g, '\n')
  const byModule = readFileSync(join(process.cwd(), 'src/app/admin/control-center/permissions/modules/page.tsx'), 'utf8')
    .replace(/\r\n/g, '\n')

  test('both screens import the shared rule and neither re-derives it', () => {
    for (const src of [page, byModule]) {
      assert.ok(src.includes("from '@/lib/permissions/accessControlChanges'"))
    }
    assert.ok(page.includes('choicesForDesired('), 'applyDesiredActions must delegate')
    assert.ok(byModule.includes('choicesForDesired('))
    assert.ok(byModule.includes('changesBetween('))
    assert.equal(byModule.includes('hasExistingOverride'), false, 'the rule lives in one place')
  })
})
