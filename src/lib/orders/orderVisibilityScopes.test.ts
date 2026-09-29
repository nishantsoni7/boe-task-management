// ORDER VISIBILITY SCOPES, AS THE CONTROL CENTER SCREEN USES THEM (20270221000000).
//
// The rule is the database's (supabase/tests/orders_dashboard_assertions.sql pins all
// three modes, direct access outside the scope, and that Finance and revenue do not
// widen). These pin what the screen does with it: it reads only what the database
// sends, never sends a choice the database would refuse, and says why in words.
//
// Run with: npx tsx --test "src/lib/orders/orderVisibilityScopes.test.ts"

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SCOPE_MODES,
  SCOPE_MODE_LABEL,
  describeScopeFailure,
  parseScopes,
  scopeChanged,
  validateScopeChoice,
} from './orderVisibilityScopes'

const ROOT = join(__dirname, '..', '..', '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8').replace(/\r/g, '')

describe('the three modes', () => {
  test('exactly own, selected and all sales candidates, each in words', () => {
    assert.deepEqual([...SCOPE_MODES], ['own', 'selected', 'all_sales'])
    assert.equal(SCOPE_MODE_LABEL.own, 'Their own orders')
    assert.match(SCOPE_MODE_LABEL.selected, /own orders plus selected sales candidates/)
    assert.match(SCOPE_MODE_LABEL.all_sales, /All sales candidates/)
  })
})

describe('what the database sends is validated, not trusted', () => {
  test('a well-formed list', () => {
    const r = parseScopes([{ user_id: 'a', full_name: 'Kavya', mode: 'selected', member_ids: ['b'] }, { user_id: 'b', full_name: 'Meera', mode: 'own', member_ids: [] }])
    assert.ok(r.ok)
    assert.deepEqual(r.ok && r.rows.map(x => x.mode), ['selected', 'own'])
  })
  for (const bad of [null, {}, [{ user_id: 'a' }], [{ user_id: 'a', full_name: 'K', mode: 'everyone', member_ids: [] }], [{ user_id: 'a', full_name: 'K', mode: 'own', member_ids: [1] }]]) {
    test(`refuses ${JSON.stringify(bad)}`, () => assert.equal(parseScopes(bad).ok, false))
  }
})

describe('the screen never sends a choice the database would refuse', () => {
  test('"selected" needs at least one candidate; the other modes send none', () => {
    assert.equal(validateScopeChoice('selected', []).ok, false)
    assert.deepEqual(validateScopeChoice('selected', ['b', 'b', 'c']), { ok: true, members: ['b', 'c'] })
    assert.deepEqual(validateScopeChoice('all_sales', ['b']), { ok: true, members: [] })
    assert.deepEqual(validateScopeChoice('own', ['b']), { ok: true, members: [] })
  })
  test('Save is offered only for a real change', () => {
    const saved = { userId: 'a', fullName: 'K', mode: 'selected' as const, memberIds: ['b', 'c'] }
    assert.equal(scopeChanged(saved, 'selected', ['c', 'b']), false)
    assert.equal(scopeChanged(saved, 'selected', ['b']), true)
    assert.equal(scopeChanged(saved, 'own', []), true)
    assert.equal(scopeChanged({ ...saved, mode: 'own', memberIds: [] }, 'own', ['zzz']), false)
  })
  test('every refusal has its own sentence', () => {
    for (const code of ['ORDER_SCOPE_NOT_OWNER', 'ORDER_SCOPE_NOT_A_CANDIDATE', 'ORDER_SCOPE_SELF', 'ORDER_SCOPE_MEMBERS_REQUIRED', 'ORDER_SCOPE_MODE_UNKNOWN']) {
      assert.doesNotMatch(describeScopeFailure({ message: `${code}: x` }), /could not be changed just now/, code)
    }
    assert.match(describeScopeFailure({ message: 'boom' }), /could not be changed just now/)
  })
})

describe('the Control Center entry', () => {
  test('is its own tab, wired through the layout and the page', () => {
    const layout = read('src/components/layout/ControlCenterLayout.tsx')
    const page = read('src/app/admin/control-center/page.tsx')
    assert.ok(layout.includes("'order-visibility'"))
    assert.ok(layout.includes('label="Order Visibility"'))
    assert.ok(page.includes("tab === 'order-visibility' && <OrderVisibilityTab />"))
  })
  test('the screen calls only the two owner-only RPCs, and touches no table', () => {
    const tab = read('src/components/controlCenter/OrderVisibilityTab.tsx')
    assert.ok(tab.includes("supabase.rpc('list_order_visibility_scopes')"))
    assert.ok(tab.includes("supabase.rpc('set_order_visibility_scope'"))
    assert.equal(/\.from\(/.test(tab), false, 'the scope tables have no client grant, so the screen cannot read them directly')
  })
})
