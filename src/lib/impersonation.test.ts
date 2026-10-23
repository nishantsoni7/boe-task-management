/**
 * Login as member — the gate and the stash, plus source pins for the routes.
 *
 * Run: npx tsx --test src/lib/impersonation.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { isEligibleImpersonator, startRefusal, parseStash } from './impersonation'

const read = (p: string) => readFileSync(p, 'utf8')

describe('who may log in as a member', () => {
  test('only an active, non-deleted administrator', () => {
    assert.equal(isEligibleImpersonator({ role: 'admin' }), true)
    assert.equal(isEligibleImpersonator({ role: 'admin', is_active: false }), false)
    assert.equal(isEligibleImpersonator({ role: 'admin', is_deleted: true }), false)
    assert.equal(isEligibleImpersonator({ role: 'manager' }), false)
    assert.equal(isEligibleImpersonator({ role: 'member' }), false)
    assert.equal(isEligibleImpersonator(null), false)
  })

  test('a start request needs a target other than yourself', () => {
    assert.ok(startRefusal('a', null))
    assert.ok(startRefusal('a', 'a'))
    assert.equal(startRefusal('a', 'b'), null)
  })
})

describe('the stash', () => {
  const good = {
    sessionId: 's', startedAt: 'x',
    admin: { id: 'a', fullName: 'A', accessToken: 't', refreshToken: 'r' },
    target: { id: 'b', fullName: 'B', subtitle: '' },
  }
  test('round-trips and rejects anything malformed', () => {
    assert.deepEqual(parseStash(JSON.stringify(good)), good)
    assert.equal(parseStash(null), null)
    assert.equal(parseStash('not json'), null)
    assert.equal(parseStash(JSON.stringify({ sessionId: 's' })), null)
  })
})

describe('the routes', () => {
  test('start and members are admin-gated; start audits before issuing the token', () => {
    const start = read('src/app/api/impersonation/start/route.ts')
    assert.ok(start.includes('requireAdmin(req)'))
    assert.ok(start.includes('isEligibleImpersonator'))
    assert.ok(start.indexOf("from('admin_impersonation_sessions')") < start.indexOf('auth.admin.generateLink'))
    assert.ok(read('src/app/api/impersonation/members/route.ts').includes('requireAdmin(req)'))
  })

  test('end only closes a session whose target is the caller', () => {
    const end = read('src/app/api/impersonation/end/route.ts')
    assert.ok(end.includes('row.target_user_id !== caller.id'))
  })

  test('the audit table has no browser access', () => {
    const sql = read('supabase/migrations/20270409000000_admin_impersonation_sessions.sql')
    assert.ok(sql.includes('enable row level security'))
    assert.ok(sql.includes('revoke all on public.admin_impersonation_sessions from anon, authenticated'))
  })

  test('the widget is mounted once, globally, and never calls signOut on a swap', () => {
    assert.ok(read('src/components/layout/Providers.tsx').includes('<LoginAsMemberWidget />'))
    const w = read('src/components/layout/LoginAsMemberWidget.tsx')
    const swap = w.slice(w.indexOf('const loginAs'), w.indexOf('const filtered'))
    assert.equal(swap.includes('signOut'), true) // only the failure fallback
    assert.ok(swap.indexOf('writeStash({') < swap.indexOf('verifyOtp'), 'stash before the swap')
  })
})
