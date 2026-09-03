import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The By Module matrix route is a READ. It must be gated exactly like its
// sibling Access Control routes, must show the same directory (soft-deleted
// accounts excluded, nothing else), must resolve through the one shared
// resolver, and must never write.

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const route = read('src/app/api/control-center/permissions/modules/[key]/employees/route.ts')
const sibling = read('src/app/api/control-center/permissions/employees/[id]/route.ts')

describe('the module matrix route', () => {
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

  test('shows the same directory as By Employee', () => {
    assert.ok(route.includes(".or('is_deleted.eq.false,is_deleted.is.null')"))
    assert.equal(route.includes(".eq('is_active'"), false, 'inactive accounts stay visible')
  })

  test('resolves through the shared resolver, not a local precedence copy', () => {
    assert.ok(route.includes("from '@/lib/permissions/resolver'"))
    assert.ok(route.includes('getEffectivePermissionsForUser(svc, u.id)'))
    assert.equal(/COALESCE|employee_permission_overrides/.test(route), false)
  })

  test('refuses an unknown or inactive module', () => {
    assert.ok(route.includes("if (!mod || !mod.is_active) return NextResponse.json({ error: 'Module not found' }, { status: 404 })"))
  })
})
