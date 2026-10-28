import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The access matrix route is a READ. It must be gated exactly like its
// sibling Access Control routes, must show the same directory (soft-deleted
// accounts excluded, nothing else), must resolve through the one shared
// resolver, and must never write. It supersedes the per-module matrix route
// (/modules/[key]/employees), which is gone.

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const route = read('src/app/api/control-center/permissions/matrix/route.ts')
const sibling = read('src/app/api/control-center/permissions/employees/[id]/route.ts')

describe('the access matrix route', () => {
  test('is admin-gated with the same rule as the per-employee route', () => {
    for (const src of [route, sibling]) {
      assert.ok(src.includes("p.role !== 'admin' || p.is_active !== true || p.is_deleted === true"))
      assert.ok(src.includes('svc.auth.getUser(token)'))
      assert.ok(src.includes('SUPABASE_SERVICE_ROLE_KEY'))
    }
  })

  test('only exposes GET and performs no write', () => {
    assert.ok(route.includes('export async function GET('))
    assert.equal(/export async function (PUT|POST|PATCH|DELETE)/.test(route), false)
    assert.equal(/\.(upsert|insert|update|delete)\(/.test(route), false, 'a matrix is read-only')
  })

  test('shows the same directory as the People screen', () => {
    assert.ok(route.includes(".or('is_deleted.eq.false,is_deleted.is.null')"))
    const start = route.indexOf("'id, full_name, role, team, is_active'")
    const usersRead = route.slice(start, route.indexOf('// Every active override'))
    assert.ok(start > 0, 'the directory read must be present')
    assert.equal(usersRead.includes(".eq('is_active'"), false, 'inactive accounts stay visible')
  })

  test('resolves through the shared resolver, not a local precedence copy', () => {
    assert.ok(route.includes("from '@/lib/permissions/resolver'"))
    assert.ok(route.includes('getEffectivePermissionsForUser(svc, u.id)'))
    assert.equal(/COALESCE/.test(route), false)
    // The override table is read for PROVENANCE only — who granted it and when.
    // The `allowed` column is never selected, so nothing here can decide.
    assert.ok(route.includes(".select('user_id, module_id, action_id, granted_by, granted_at')"))
    assert.equal(/allowed,\s*granted_by|granted_by,\s*allowed/.test(route), false,
      'the override read must not carry a value the route could decide from')
  })

  test('the per-employee read reports provenance the same way', () => {
    assert.ok(sibling.includes(".select('module_id, action_id, allowed, granted_by, granted_at')"))
    assert.ok(sibling.includes("grantedBy: override?.granted_by"))
    assert.ok(sibling.includes("grantedAt: override?.granted_at ?? null"))
    assert.ok(sibling.includes(".is('revoked_at', null)"), 'a revoked override is not what the person holds')
  })

  test('the granter name comes from the safe profile columns', () => {
    for (const src of [route, sibling]) {
      assert.ok(src.includes("from('users').select('id, full_name').in('id', granterIds)"))
      assert.equal(/from\('users'\)\.select\('\*'\)/.test(src), false, 'select(*) on users is refused by the database')
    }
  })

  test('the superseded per-module route is gone', () => {
    assert.throws(() => read('src/app/api/control-center/permissions/modules/[key]/employees/route.ts'))
  })
})
