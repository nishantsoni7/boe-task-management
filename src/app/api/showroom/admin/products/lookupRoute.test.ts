/**
 * Repository check: the product lookup mode stays behind the module guard and
 * keeps returning only the four fields the sidebar renders.
 *
 * Why a source check
 * ------------------
 * The route runs with SUPABASE_SERVICE_ROLE_KEY, which bypasses RLS entirely —
 * `requireShowroomAccess` is the ONLY thing standing between a signed-in user
 * with no showroom access and the product catalogue. A future edit that adds a
 * branch above the guard, or widens the lookup's select to LIST_COLUMNS (which
 * carries `mrp`), would compile and pass every other test. Executing the route
 * here would need a live Supabase and a real token, so the invariants are
 * asserted against the source instead.
 *
 * Run:
 *   npx tsx --test src/app/api/showroom/admin/products/lookupRoute.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SOURCE = readFileSync(join(process.cwd(), 'src/app/api/showroom/admin/products/route.ts'), 'utf8')

/** The body of `export async function GET`, up to the next top-level export. */
function getHandler(): string {
  const start = SOURCE.indexOf('export async function GET')
  assert.ok(start > -1, 'GET handler must exist')
  const rest = SOURCE.slice(start + 1)
  const end = rest.indexOf('\nexport ')
  return end === -1 ? rest : rest.slice(0, end)
}

/** The body of the lookup helper. */
function lookupHelper(): string {
  const start = SOURCE.indexOf('async function productLookup')
  assert.ok(start > -1, 'productLookup helper must exist')
  const rest = SOURCE.slice(start)
  const end = rest.indexOf('\n// GET /api/showroom/admin/products')
  return end === -1 ? rest : rest.slice(0, end)
}

describe('lookup auth guard', () => {
  test('GET calls requireShowroomAccess and 403s before doing anything', () => {
    const body = getHandler()
    const guard = body.indexOf('requireShowroomAccess')
    const forbidden = body.indexOf("status: 403")
    assert.ok(guard > -1, 'the guard must be called')
    assert.ok(forbidden > -1, 'a refusal must return 403')
    assert.ok(guard < forbidden, 'the guard runs before the refusal is returned')
  })

  test('the lookup branch sits AFTER the guard, never above it', () => {
    const body = getHandler()
    assert.ok(
      body.indexOf('requireShowroomAccess') < body.indexOf("sp.get('lookup')"),
      'no request may reach the lookup without passing the guard',
    )
  })

  test('the lookup uses the guarded client, not a fresh service client', () => {
    // `client` is what requireShowroomAccess returns; calling serviceClient()
    // inside the helper would sidestep the check that produced it.
    const helper = lookupHelper()
    assert.ok(!helper.includes('serviceClient()'), 'must not build its own client')
    assert.match(helper, /client\s*\n?\s*\.from\('showroom_products'\)/)
  })
})

describe('lookup response fields', () => {
  test('an explicit four-column select — never * and never LIST_COLUMNS', () => {
    const helper = lookupHelper()
    assert.match(helper, /\.select\('id, product_code, name, category'\)/)
    assert.ok(!helper.includes("select('*')"), 'no star select')
    assert.ok(!helper.includes('LIST_COLUMNS'), 'the list shape carries mrp and must not be reused')
  })

  test('no pricing or unrelated product data is selected', () => {
    const helper = lookupHelper()
    for (const column of ['mrp', 'description', 'specifications', 'dimensions', 'image_url', 'images']) {
      assert.ok(!helper.includes(`${column}`), `lookup must not select ${column}`)
    }
  })

  test('a blank term returns nothing rather than the whole catalogue', () => {
    const helper = lookupHelper()
    assert.match(helper, /if \(!q\) return \{ products: \[\] \}/)
  })

  test('the row cap is applied server-side and cannot be raised by the client', () => {
    const helper = lookupHelper()
    assert.match(helper, /\.limit\(limit\)/)
    assert.match(helper, /Math\.min\(asked, LOOKUP_RESULT_LIMIT\)/)
  })

  test('no catalogue-wide extras crept into the lookup', () => {
    const helper = lookupHelper()
    for (const banned of ['count:', 'range(', 'fetchAllRows']) {
      assert.ok(!helper.includes(banned), `lookup must not use ${banned}`)
    }
  })
})

describe('no All Products route was restored', () => {
  test('the route still has no all-products mode', () => {
    assert.ok(!SOURCE.includes("'allCount'"), 'the removed allCount aggregate must stay removed')
    assert.ok(!SOURCE.includes('allCount:'), 'the removed allCount aggregate must stay removed')
  })
})
