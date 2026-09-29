/**
 * TEST ORDER CLEANUP: KEEP OR REUSE THE ORDER NUMBER (20270217000000), read as
 * text, with the route that drives it.
 *
 * Executing it was done against a disposable copy of production's public schema
 * (every function, FK and trigger identical) loaded with the rows of Order
 * 0526's unfinished cleanup claim. The PR's first draft failed there: finalize
 * could never delete 0526, because deleting its PI SET NULLs the advance
 * exception's pi_version_id and the exception's immutability guard refuses that
 * UPDATE. With reuse chosen, that would also have paused every Order approval
 * with no way to finish. The assertions below hold the fixes.
 *
 * Run:
 *   npx tsx --test src/lib/orders/cleanupNumberChoice.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const stripSql = (s: string) => s.split('\n').map(l => l.replace(/--.*$/, '')).join('\n')

const NAME = '20270217000000_order_submission_cleanup_number_choice.sql'
const SQL = stripSql(read(`supabase/migrations/${NAME}`))
const ROUTE = read('src/app/api/orders/test-data-cleanup/route.ts')
const PAGE = read('src/app/admin/control-center/test-data-cleanup/page.tsx')

/** One `create or replace function` block, body included. */
function fn(name: string): string {
  const start = SQL.indexOf(`create or replace function public.${name}(`)
  assert.notEqual(start, -1, `${name} is missing`)
  const open = SQL.indexOf('$$', start)
  const close = SQL.indexOf('$$', open + 2)
  return SQL.slice(start, close + 2)
}

const CHOOSE = fn('choose_test_cleanup_order_number')
const PAUSE = fn('pause_order_allocation_for_reuse_cleanup')
const FINALIZE = fn('finalize_test_data_cleanup')

describe('the choice is fixed on the claim', () => {
  test('only keep or reuse, only by the active admin holding an open Order claim', () => {
    assert.ok(SQL.includes("check (order_number_choice in ('keep', 'reuse'))"))
    assert.ok(CHOOSE.includes("u.role = 'admin'"))
    assert.ok(CHOOSE.includes('u.is_active is true and u.is_deleted is false'))
    assert.ok(CHOOSE.includes('v_claim.claimed_by is distinct from v_actor'))
    assert.ok(CHOOSE.includes('v_claim.finalized_at is not null or v_claim.released_at is not null'))
  })

  test('a retry cannot switch it', () => {
    assert.ok(CHOOSE.includes('v_claim.order_number_choice <> p_choice'))
    assert.ok(CHOOSE.includes('resume it with the same choice'))
  })

  test('reuse is proved under the cycle lock: latest number, nothing above it, no foreign reservation', () => {
    const lock = CHOOSE.indexOf('where c.id = true for update')
    assert.ok(lock > 0)
    assert.ok(CHOOSE.indexOf('v_next <> v_number + 1') > lock)
    assert.ok(CHOOSE.includes('o.display_number::bigint >= v_number'))
    assert.ok(CHOOSE.includes('l.submission_id is distinct from v_claim.order_submission_id'))
  })

  test('callable by signed-in users only (it checks admin itself)', () => {
    assert.match(SQL, /revoke execute on function public\.choose_test_cleanup_order_number\(uuid, text\)\s+from public, anon, service_role;/)
    assert.match(SQL, /grant execute on function public\.choose_test_cleanup_order_number\(uuid, text\)\s+to authenticated;/)
  })
})

describe('approvals pause while a reuse claim is open', () => {
  test('the pause runs as its owner with a pinned path, and only blocks an advance', () => {
    assert.ok(PAUSE.includes('security definer'))
    assert.ok(PAUSE.includes('set search_path = public, pg_temp'))
    assert.ok(PAUSE.includes('new.next_number > old.next_number'))
    assert.ok(PAUSE.includes("c.order_number_choice = 'reuse' and c.finalized_at is null"))
    assert.ok(SQL.includes('before update of next_number on public.order_number_cycle'))
  })
})

describe('finalize', () => {
  test('refuses to delete an Order before the choice is recorded', () => {
    const required = FINALIZE.indexOf('ORDER_NUMBER_CHOICE_REQUIRED')
    assert.ok(required > 0)
    assert.ok(FINALIZE.includes('v_claim.order_id is not null and v_claim.order_number_choice is null'))
    assert.ok(required < FINALIZE.indexOf("set_config('boe.cleanup_context'"))
    assert.ok(required < FINALIZE.indexOf('delete from public.notifications'))
  })

  test('deletes the Order’s advance exceptions BEFORE its PI (the 0526 defect)', () => {
    const exceptions = FINALIZE.indexOf('delete from public.order_advance_exceptions where order_id = v_order')
    const pi = FINALIZE.indexOf('delete from public.order_submissions where id = v_submission')
    assert.ok(exceptions > 0 && pi > 0 && exceptions < pi)
    assert.ok(exceptions > FINALIZE.indexOf("set_config('boe.cleanup_context', 'test_data_cleanup', true)"))
    assert.ok(FINALIZE.includes("'order_advance_exceptions',     v_n_exceptions"))
  })

  test('reclaims a number only when reuse was chosen, and only from the top', () => {
    assert.ok(FINALIZE.includes("and v_claim.order_number_choice = 'reuse' then"))
    assert.ok(FINALIZE.includes('while v_next > greatest(v_highest + 1, 1)'))
    assert.ok(FINALIZE.includes('(v_next - 1) = any (v_freed)'))
    assert.ok(!FINALIZE.includes('configured_at'))
  })

  test('keeps every existing gate', () => {
    for (const gate of ['CLEANUP_CLAIM_INVALID', 'CLEANUP_NOT_ELIGIBLE', 'CLEANUP_CHAIN_CHANGED',
                        'CLEANUP_PROVENANCE_MISMATCH', "'already_finalized', true", 'set finalized_at = now()']) {
      assert.ok(FINALIZE.includes(gate), gate)
    }
  })
})

describe('the route', () => {
  test('records the choice before any storage is touched', () => {
    const choose = ROUTE.indexOf("'choose_test_cleanup_order_number'")
    assert.ok(choose > ROUTE.indexOf("'begin_test_data_cleanup'"))
    for (const sweep of ['removeAllObjectsForRequest(', "'test_cleanup_claim_storage'", 'removeAllObjectsForOrder(']) {
      assert.ok(choose < ROUTE.indexOf(sweep), `choice before ${sweep}`)
    }
  })

  test('never gives back a resumed claim — an earlier request may have removed files', () => {
    const release = ROUTE.slice(ROUTE.indexOf('const release = async'), ROUTE.indexOf('const release = async') + 300)
    assert.ok(release.includes('if (claim.resumed === true) return'))
    assert.ok(ROUTE.indexOf('const release = async') < ROUTE.indexOf("'choose_test_cleanup_order_number'"))
  })

  test('an Order cleanup needs a choice, and the screen asks for one', () => {
    assert.ok(ROUTE.includes("if (rootType === 'order' && orderNumberChoice == null)"))
    assert.ok(PAGE.includes('&& (!hasOrder || orderNumberChoice !== null)'))
    assert.ok(PAGE.includes('orderNumberChoice,'))
  })
})
