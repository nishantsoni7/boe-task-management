/**
 * registerModule / getRegisteredModule / getRegisteredModules — behavioural tests
 *
 * Pure in-process registry logic (no DB calls). syncPermissionRegistry() and
 * the SQL resolver functions are exercised manually against a live Supabase
 * project (see verification steps in the PR description), not here.
 *
 * Run:
 *   npx tsx --test src/lib/permissions/registry.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { registerModule, getRegisteredModule, getRegisteredModules } from './registry'

describe('permission module registry', () => {
  test('registerModule stores a module retrievable by key', () => {
    registerModule({
      moduleKey: 'test_module_a',
      displayName: 'Test Module A',
      actions: [{ actionKey: 'view', displayName: 'View' }],
    })
    const mod = getRegisteredModule('test_module_a')
    assert.equal(mod?.displayName, 'Test Module A')
    assert.equal(mod?.actions[0].actionKey, 'view')
  })

  test('registering the same moduleKey twice replaces the previous definition', () => {
    registerModule({ moduleKey: 'test_module_b', displayName: 'First', actions: [] })
    registerModule({ moduleKey: 'test_module_b', displayName: 'Second', actions: [] })
    assert.equal(getRegisteredModule('test_module_b')?.displayName, 'Second')
  })

  test('getRegisteredModules includes every registered module', () => {
    const before = getRegisteredModules().length
    registerModule({ moduleKey: 'test_module_c', displayName: 'C', actions: [] })
    assert.equal(getRegisteredModules().length, before + 1)
  })

  test('unregistered key returns undefined', () => {
    assert.equal(getRegisteredModule('does_not_exist'), undefined)
  })
})
