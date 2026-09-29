/**
 * Repository check: a Test Data Cleanup that removed the files and then failed
 * to delete the records can be finished by running it again.
 *
 * THE PARTIAL FAILURE (Order 0526, 2026-09-27)
 * --------------------------------------------
 * The route swept storage, then finalize_test_data_cleanup() refused with
 * ORDER_ADVANCE_EXCEPTION_IMMUTABLE: deleting the PI cascades to its
 * order_pi_versions, and order_advance_exceptions.pi_version_id is ON DELETE
 * SET NULL — an UPDATE the immutability guard of 20270116000000 refused even
 * inside a cleanup. The claim was kept, correctly, but every retry failed the
 * same way. 20270216000000 lets exactly that SET NULL through, and only inside
 * a cleanup.
 *
 * And one retry hazard in the route: a RESUMED claim may be standing over files
 * a previous attempt already removed, so it must never be released — not even
 * when this attempt's sweep fails before issuing a remove.
 *
 * The behaviour itself is proved against real triggers by
 * supabase/tests/order_advance_exception_cleanup_assertions.sql (it fails
 * without the migration). This file pins the pieces so they cannot quietly
 * drift. Reads repository files only. No database, no network.
 *
 * Run:
 *   npx tsx --test src/lib/orders/testDataCleanupAdvanceExceptionRetry.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations')

/** Normalised to LF: a Windows checkout stores CRLF. */
const lf = (s: string) => s.replace(/\r\n/g, '\n')
const source = (path: string) => lf(readFileSync(join(process.cwd(), path), 'utf8'))
/** SQL with its `--` comments removed, so the checks read code, not prose. */
const sqlCode = (s: string) => s.split('\n').map(l => l.replace(/--.*$/, '')).join('\n')
/** TypeScript with its comment lines removed. */
const tsCode = (s: string) =>
  s.split('\n').filter(l => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*')).join('\n')

const FIX = '20270216000000_test_data_cleanup_pi_version_set_null.sql'
const ORIGIN = '20270116000000_order_pi_revision_in_force_at_admin_approval.sql'
const ROUTE = 'src/app/api/orders/test-data-cleanup/route.ts'
const SUITE = 'supabase/tests/order_advance_exception_cleanup_assertions.sql'

const fix = () => source(join('supabase', 'migrations', FIX))

describe('the cause is still what the fix answers', () => {
  test('pi_version_id is ON DELETE SET NULL, and the original guard refused every UPDATE', () => {
    const origin = source(join('supabase', 'migrations', ORIGIN))
    assert.match(origin, /pi_version_id\s+uuid references public\.order_pi_versions\(id\) on delete set null/)
    assert.match(origin,
      /if tg_op = 'DELETE' and public\.in_test_data_cleanup\(\) then return old; end if;\n\s*raise exception 'ORDER_ADVANCE_EXCEPTION_IMMUTABLE/)
  })
})

describe('20270216000000 relaxes the guard for exactly the SET NULL, inside a cleanup', () => {
  test('it sorts after production\'s newest applied migration (20270215000100)', () => {
    const files = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()
    assert.ok(files.includes(FIX))
    assert.ok(FIX > '20270215000100')
    assert.equal(files.filter(f => f.startsWith('20270216000000_')).length, 1)
  })

  test('it re-emits only the guard, and changes no table, trigger or cleanup function', () => {
    const code = sqlCode(fix())
    assert.deepEqual(
      [...code.matchAll(/create or replace function ([\w.]+)\(/g)].map(m => m[1]),
      ['public.order_advance_exceptions_immutable'])
    assert.doesNotMatch(code, /\b(alter|drop|create)\s+(table|trigger)\b/i)
    assert.doesNotMatch(code, /finalize_test_data_cleanup|begin_test_data_cleanup|release_test_data_cleanup/)
    assert.doesNotMatch(code, /\b(delete from|update public\.|insert into)\b/i)
  })

  test('it keeps the attributes 20270117000000 and 20270213000000 gave the guard', () => {
    const code = sqlCode(fix())
    assert.match(code, /security definer\s*\n\s*set search_path = public, pg_temp/)
    assert.match(code,
      /revoke execute on function public\.order_advance_exceptions_immutable\(\)\s*\n\s*from public, anon, authenticated, service_role;/)
  })

  test('every exemption sits behind in_test_data_cleanup()', () => {
    const code = sqlCode(fix())
    const body = code.slice(code.indexOf('as $$'), code.lastIndexOf('$$;'))
    const gate = body.indexOf('if public.in_test_data_cleanup() then')
    assert.ok(gate > 0)
    const returns = [...body.matchAll(/return (old|new);/g)].map(m => m.index!)
    assert.equal(returns.length, 2)
    const gateEnd = body.indexOf('\n  end if;', gate)
    for (const at of returns) assert.ok(at > gate && at < gateEnd, 'a return outside the cleanup gate')
  })

  test('the UPDATE allowed is pi_version_id to NULL with every other column unchanged', () => {
    const code = sqlCode(fix())
    assert.match(code, /tg_op = 'UPDATE'/)
    assert.match(code, /old\.pi_version_id is not null/)
    assert.match(code, /new\.pi_version_id is null/)
    assert.match(code, /\(to_jsonb\(new\) - 'pi_version_id'\) = \(to_jsonb\(old\) - 'pi_version_id'\)/)
  })

  test('anything else still raises the same error code', () => {
    assert.match(sqlCode(fix()),
      /raise exception 'ORDER_ADVANCE_EXCEPTION_IMMUTABLE: an advance exception is a record and cannot be changed'\s*\n\s*using errcode = '42501';/)
  })
})

describe('the route never gives back a resumed claim', () => {
  const route = () => tsCode(source(ROUTE))

  test('a resumed claim counts as "files may already be gone" before any sweep', () => {
    const code = route()
    const mark = code.indexOf("if (claim?.resumed === true) storageRemovalAttempted = true")
    assert.ok(mark > 0, 'resumed claims must set storageRemovalAttempted')
    assert.ok(mark > code.indexOf("if (!token) return bad('The cleanup claim could not be taken.'"))
    assert.ok(mark < code.indexOf('removeAllObjectsForRequest('))
    assert.ok(mark < code.indexOf("'test_cleanup_claim_storage'"))
    assert.ok(mark < code.indexOf('removeAllObjectsForOrder('))
  })

  test('release is still reached only when no remove was attempted', () => {
    // 20270217000000's keep/reuse choice adds release sites before the sweep;
    // every one of them keeps the same guard.
    const code = route()
    const sites = [...code.matchAll(/await release\(\)/g)]
    assert.ok(sites.length > 0)
    for (const site of sites) {
      const line = code.slice(code.lastIndexOf('\n', site.index!) + 1, site.index! + 15)
      assert.match(line, /if \(!storageRemovalAttempted\) await release\(\)/)
    }
  })

  test('a finalization refusal keeps the claim and logs the database\'s message', () => {
    const code = route()
    const refusal = code.slice(code.indexOf('if (finalErr) {'), code.indexOf("report('')"))
    assert.doesNotMatch(refusal, /release\(/)
    assert.match(refusal, /report\(`finalization refused after storage cleanup: \$\{detail\}`\)/)
    assert.match(refusal, /reserved: true/)
  })
})

describe('the partial failure is replayed against real triggers', () => {
  test('the SQL suite resumes the claim and finalizes an Order with a version-pinned advance exception', () => {
    const suite = source(SUITE)
    assert.match(suite, /20270216000000/)
    assert.match(suite, /insert into public\.order_advance_exceptions \(id, order_id, value_epoch, pi_version_id,/)
    assert.match(suite, /B1: the retry resumes the standing claim/)
    assert.match(suite, /B3: finalization completes/)
    assert.match(suite, /D1: a real Order cannot be claimed/)
    assert.match(suite, /D8: inside a cleanup, exactly the SET NULL is allowed/)
    assert.match(suite, /\nrollback;\s*$/)
  })
})
