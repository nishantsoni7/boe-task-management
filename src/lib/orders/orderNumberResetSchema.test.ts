/**
 * Repository check: returning the Confirmed Order number cycle to 0001.
 *
 * WHAT THIS PHASE IS, AND WHAT IT DELIBERATELY IS NOT
 * ---------------------------------------------------
 * Every Order Management record in the system today is TEST DATA, and real
 * numbering must begin at 0001 once it is gone. The REMOVAL already exists and
 * is not touched: begin_test_data_cleanup → storage removal →
 * finalize_test_data_cleanup, driven by /api/orders/test-data-cleanup.
 *
 * THE AUDIT OF WHAT WAS ALREADY THERE, which decided what this phase had to add:
 *
 *   ✓ removes every Order Management test record — notifications, payments
 *     (proofs and activity by cascade), the Order Request, the PI with its items
 *     and images, and the Order with its activity log
 *   ✓ removes associated storage safely — the route sweeps before it finalizes,
 *     and a partial sweep KEEPS the claim rather than releasing the records
 *   ✓ removes payments and allocations correctly — allocations go with their
 *     payment rows
 *   ✓ preserves non-Order production data — the chain resolver refuses any
 *     record that is not test data, and finalization re-validates under locks
 *   ~ resets the number cycle — PARTIALLY. finalize gives back numbers it freed
 *     FROM THE TOP OF THE RANGE, which reaches 1 only if Orders happen to be
 *     cleaned in descending order. Clean 0003, then 0001, then 0002 and the
 *     cycle stops at 2.
 *   ✗ AND, once this branch added generated documents, the cleanup could not
 *     delete an Order that had any: order_document_versions holds a no-cascade
 *     foreign key, and its files live under a prefix the sweep never visited.
 *
 * So this phase adds exactly three things, and these tests are what keeps each
 * of them honest:
 *
 *   1. a deliberate, gated, AUDITED reset to 1;
 *   2. the trigger that lets a cleanup delete an Order that has documents;
 *   3. the read-only key lister the route sweeps those documents with.
 *
 * Reads repository files only. No database, no network.
 *
 * Run:
 *   npx tsx --test src/lib/orders/orderNumberResetSchema.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const MIGRATIONS = join(ROOT, 'supabase', 'migrations')
const lf = (s: string) => s.replace(/\r\n/g, '\n')
const readMigration = (file: string) => lf(readFileSync(join(MIGRATIONS, file), 'utf8'))

const FILE = '20260926000000_order_number_cycle_reset.sql'
const DOCUMENTS = '20260925000000_order_document_generation.sql'
const FOUR_DIGIT = '20260704000000_confirmed_order_four_digit_numbers.sql'
const PROTECT = '20260705000000_protect_finalized_orders_and_payments.sql'

const sql = readMigration(FILE)

/** The migration with `--` comments removed. The header NAMES what this phase
 *  must not do; a raw search would find its own prohibitions. */
const code = sql
  .split('\n')
  .map(line => {
    const at = line.indexOf('--')
    return at === -1 ? line : line.slice(0, at)
  })
  .join('\n')

function fnBody(name: string): string {
  const start = code.search(new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\s*\\(`, 'i'))
  assert.ok(start >= 0, `${name} is not defined in ${FILE}`)
  const end = code.indexOf('\n$$;', start)
  assert.ok(end > start, `no closing dollar tag for ${name}`)
  return code.slice(start, end + 4)
}

// ══ 1. Placement ═════════════════════════════════════════════════════════════

describe('the migration takes its place without disturbing anything applied', () => {
  test('it lands immediately after the document phase', () => {
    const files = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()
    assert.equal(files[files.indexOf(DOCUMENTS) + 1], FILE)
  })

  test('no applied migration has been modified on this branch', () => {
    const changed = execFileSync('git', ['diff', '--name-only', 'origin/main', '--', 'supabase/migrations'], {
      encoding: 'utf8', cwd: ROOT,
    }).split('\n').map(s => s.trim()).filter(Boolean)

    const atBase = new Set(
      execFileSync('git', ['ls-tree', '--name-only', 'origin/main:supabase/migrations'], {
        encoding: 'utf8', cwd: ROOT,
      }).split('\n').map(s => s.trim()).filter(Boolean))

    const edited = changed.filter(path => atBase.has(path.split('/').pop() ?? path))
    assert.deepEqual(edited, [], `applied migrations were edited: ${edited.join(', ')}`)
  })

  test('THE CLEANUP PROTOCOL IS NOT RE-EMITTED', () => {
    // finalize_test_data_cleanup deletes payments, requests, PIs and Orders in a
    // lock order that took a migration of its own to get right. Re-emitting it
    // to add one DELETE would put all of that at risk.
    for (const fn of [
      'begin_test_data_cleanup', 'finalize_test_data_cleanup',
      'release_test_data_cleanup', 'resolve_test_data_cleanup_chain',
      'test_cleanup_claim_storage',
      'allocate_confirmed_order_number', 'set_next_confirmed_order_number',
      'approve_order_submission',
    ]) {
      assert.ok(
        !new RegExp(`create\\s+(or\\s+replace\\s+)?function\\s+public\\.${fn}\\s*\\(`, 'i').test(code),
        `${fn} must not be redefined by the reset phase`)
    }
  })

  test('and the existing numbering doors are untouched', () => {
    // set_next_confirmed_order_number stays exactly as it is; this is a second,
    // narrower door, not a relaxation of the first.
    assert.match(readMigration(FOUR_DIGIT), /create or replace function public\.set_next_confirmed_order_number/i)
    assert.ok(!code.includes('ORDER_NUMBER_TOO_LOW'), 'the admin door\'s own rules are not restated')
  })
})

// ══ 2. The reset destroys nothing ════════════════════════════════════════════

describe('what the reset never does', () => {
  const body = fnBody('reset_confirmed_order_number_cycle')

  test('IT DELETES NOTHING', () => {
    assert.ok(!/\bdelete\s+from\b/i.test(body))
    assert.ok(!/\btruncate\b/i.test(body))
  })

  test('it never writes an Order display number — those are immutable', () => {
    assert.ok(!/display_number\s*=/.test(body))
    assert.ok(!body.includes('update public.orders'))
  })

  test('it writes EXACTLY two things: the cycle, and its own audit', () => {
    const updates = [...body.matchAll(/update\s+public\.(\w+)/gi)].map(m => m[1])
    assert.deepEqual([...new Set(updates)], ['order_number_cycle'])
    const inserts = [...body.matchAll(/insert\s+into\s+public\.(\w+)/gi)].map(m => m[1])
    assert.deepEqual([...new Set(inserts)], ['order_number_cycle_resets'])
  })

  test('and the migration refuses to apply if that ever stops being true', () => {
    assert.match(sql, /the cycle reset contains a DELETE; it must destroy nothing/)
    assert.match(sql, /the cycle reset updates something other than the cycle/)
    assert.match(sql, /the cycle reset inserts into something other than its own audit/)
  })

  test('applying the migration resets nothing by itself', () => {
    assert.ok(!/select\s+public\.reset_confirmed_order_number_cycle/i.test(code))
    assert.match(sql, /applying this migration wrote a reset; it must reset nothing/)
  })
})

// ══ 3. The six gates ═════════════════════════════════════════════════════════

describe('when the cycle may be returned to 1', () => {
  const body = fnBody('reset_confirmed_order_number_cycle')

  test('an ACTIVE admin, and nobody else', () => {
    assert.match(body, /u\.role = 'admin'/)
    assert.match(body, /u\.is_active/)
    assert.match(body, /coalesce\(u\.is_deleted, false\) = false/)
    assert.match(body, /ORDER_NUMBER_RESET_FORBIDDEN/)
  })

  test('a claim is REQUIRED — the reset cannot happen outside the protocol', () => {
    assert.match(body, /ORDER_NUMBER_RESET_NO_CLAIM/)
    assert.match(body, /p_claim_token is null/)
  })

  test('a mismatched claim is refused', () => {
    assert.match(body, /ORDER_NUMBER_RESET_CLAIM_INVALID/)
    assert.match(body, /where claim_token = p_claim_token/)
  })

  test('an UNFINALIZED claim is refused — which is also the storage gate', () => {
    // The protocol is begin → remove storage → finalize, so finalized_at cannot
    // be set until the files are gone. One check, two guarantees.
    assert.match(body, /v_claim\.finalized_at is null/)
    assert.match(body, /ORDER_NUMBER_RESET_CLAIM_UNFINISHED/)
  })

  test('NOT ONE ORDER ROW MAY REMAIN — and not "no test Orders"', () => {
    assert.match(body, /select count\(\*\) into v_orders from public\.orders;/)
    assert.ok(!/is_test_data/.test(body),
      'a cancelled REAL Order is a row like any other, and must close this door')
    assert.match(body, /ORDER_NUMBER_RESET_ORDERS_EXIST/)
  })

  test('no PI may be submitted or approved', () => {
    assert.match(body, /s\.status in \('submitted', 'approved'\)/)
    assert.match(body, /s\.order_id is not null/)
    assert.match(body, /ORDER_NUMBER_RESET_APPROVAL_PENDING/)
  })

  test('no payment allocation may still point at an Order or a PI', () => {
    assert.match(body, /a\.order_id is not null or a\.order_submission_id is not null/)
    assert.match(body, /ORDER_NUMBER_RESET_ALLOCATIONS_REMAIN/)
  })
})

// ══ 4. The race ══════════════════════════════════════════════════════════════

describe('a concurrent approval cannot race the reset', () => {
  const body = fnBody('reset_confirmed_order_number_cycle')

  test('the cycle row is locked FOR UPDATE', () => {
    assert.match(body, /from public\.order_number_cycle c\s*\n?\s*where c\.id = true\s*\n?\s*for update/i)
  })

  test('and it is the SAME row the allocator locks before handing out a number', () => {
    const allocator = readMigration(FOUR_DIGIT)
    assert.match(allocator, /from public\.order_number_cycle c\s*\n?\s*where c\.id = true\s*\n?\s*for update/i)
  })

  test('THE LOCK COMES BEFORE THE GATES — a reading taken before it is stale', () => {
    const lockAt = body.toLowerCase().indexOf('for update')
    const ordersGateAt = body.indexOf('ORDER_NUMBER_RESET_ORDERS_EXIST')
    const approvalGateAt = body.indexOf('ORDER_NUMBER_RESET_APPROVAL_PENDING')
    const allocGateAt = body.indexOf('ORDER_NUMBER_RESET_ALLOCATIONS_REMAIN')
    assert.ok(lockAt > 0)
    for (const gate of [ordersGateAt, approvalGateAt, allocGateAt]) {
      assert.ok(lockAt < gate, 'every gate must be read under the lock')
    }
  })

  test('and the migration refuses to apply if that ordering is ever inverted', () => {
    assert.match(sql, /the cycle reset reads its gates before taking the lock/)
    assert.match(sql, /the cycle reset does not lock the cycle row/)
  })
})

// ══ 5. The audit ═════════════════════════════════════════════════════════════

describe('every reset is permanently recorded', () => {
  test('in a table of its own, not folded into the deletion audit', () => {
    assert.match(code, /create table if not exists public\.order_number_cycle_resets/i)
    assert.ok(!code.includes('test_data_cleanup_audit'),
      'a numbering decision answers none of the deletion audit\'s columns')
  })

  test('it records who, when, from what, to what, and under which claim', () => {
    const at = code.indexOf('create table if not exists public.order_number_cycle_resets')
    const decl = code.slice(at, code.indexOf(');', at))
    for (const column of [
      'performed_by', 'performed_by_email', 'performed_at',
      'claim_id', 'previous_number', 'new_number', 'evidence',
    ]) {
      assert.ok(decl.includes(column), column)
    }
  })

  test('AND THE EVIDENCE EACH GATE SAW, not merely that it passed', () => {
    const body = fnBody('reset_confirmed_order_number_cycle')
    for (const key of [
      'claim_token_matched', 'claim_finalized_at',
      'orders_remaining', 'submissions_in_flight', 'allocations_remaining',
    ]) {
      assert.ok(body.includes(`'${key}'`), key)
    }
  })

  test('admins may read it and nobody may write it from a client', () => {
    assert.match(code, /revoke all on table public\.order_number_cycle_resets from public, anon, authenticated/i)
    assert.match(code, /grant select on table public\.order_number_cycle_resets to authenticated/i)
    assert.match(code, /create policy "order_number_cycle_resets_admin_select"/i)
    // The policy itself, not the rest of the file — `for update` legitimately
    // appears later as the cycle-row lock.
    const at = code.indexOf('create policy "order_number_cycle_resets_admin_select"')
    const policy = code.slice(at, code.indexOf(';', at))
    assert.match(policy, /for select to authenticated/i)
    assert.ok(!/for\s+(insert|update|delete|all)/i.test(policy))
    // And no other policy on that table exists at all.
    assert.equal((code.match(/on\s*\n?\s*public\.order_number_cycle_resets/g) ?? []).length, 1)
  })

  test('a second call answers rather than writing a second decision', () => {
    const body = fnBody('reset_confirmed_order_number_cycle')
    assert.match(body, /if v_prev = 1 then/)
    assert.match(body, /'already_at_start', true/)
  })
})

// ══ 6. The defect this branch introduced, and closed ═════════════════════════

describe('a cleanup can still delete an Order that has documents', () => {
  test('the register keeps its NO-CASCADE foreign key — the cascade is not the fix', () => {
    const documents = readMigration(DOCUMENTS)
    const at = documents.indexOf('order_id      uuid        not null references public.orders(id)')
    assert.ok(at > 0, 'the foreign key must still be there')
    assert.ok(!/references public\.orders\(id\)\s*on delete/i.test(documents),
      'a silent cascade would hide what a cleanup destroyed')
  })

  test('a BEFORE DELETE trigger removes the register rows instead', () => {
    assert.match(code, /create trigger orders_remove_document_versions_trg\s*\n?\s*before delete on public\.orders/i)
  })

  test('and it deletes NOTHING ELSE', () => {
    const body = fnBody('orders_remove_document_versions')
    const targets = [...body.matchAll(/delete\s+from\s+public\.(\w+)/gi)].map(m => m[1])
    assert.deepEqual([...new Set(targets)], ['order_document_versions'])
  })

  test('it is not a back door: every other DELETE on orders is already refused', () => {
    assert.match(readMigration(PROTECT), /orders_prevent_delete/i)
    assert.match(code, /revoke execute on function public\.orders_remove_document_versions\(\)\s*\n?\s*from public, anon, authenticated, service_role/i)
  })

  test('the migration refuses to apply without it', () => {
    assert.match(sql, /the document rows would block a Test Data Cleanup of an Order that has documents/)
  })
})

describe('and its files are swept with everything else', () => {
  const route = lf(readFileSync(join(ROOT, 'src/app/api/orders/test-data-cleanup/route.ts'), 'utf8'))
  const helper = lf(readFileSync(join(ROOT, 'src/lib/orders/submissionFilesServer.ts'), 'utf8'))

  test('the route sweeps the Order\'s OWN prefix, before it finalizes', () => {
    const sweepAt = route.indexOf('removeAllObjectsForOrder(')
    const finalizeAt = route.indexOf("rpc(\n    'finalize_test_data_cleanup'")
    assert.ok(sweepAt > 0, 'the Order documents must be swept')
    assert.ok(finalizeAt < 0 || sweepAt < finalizeAt)
    assert.ok(route.indexOf('removeAllObjectsForOrder(') < route.indexOf("'finalize_test_data_cleanup'"))
  })

  test('THE PREFIX COMES FROM THE CLAIM, never from a request', () => {
    assert.ok(route.includes('removeAllObjectsForOrder(\n        service, claim.order_id'))
  })

  test('the recorded keys come from a READ-ONLY, admin-only RPC', () => {
    assert.ok(route.includes("rpc(\n      'order_document_storage_paths'"))
    const body = fnBody('order_document_storage_paths')
    assert.ok(!/\b(insert|update|delete|truncate)\b/i.test(body))
    assert.match(code, /revoke execute on function public\.order_document_storage_paths\(uuid\) from public, anon/i)
  })

  test('and the sweep marks its attempt, exactly as the other two do', () => {
    assert.equal((route.match(/onRemoveAttempt: markRemovalAttempt/g) ?? []).length, 3,
      'Order Request attachments, PI files AND the Order\'s generated documents')
  })

  test('the Order remover cannot reach a PI\'s prefix, or the reverse', () => {
    assert.ok(helper.includes('removeAllObjectsUnderPrefix(service, `orders/${orderId}`'))
    assert.ok(!helper.includes('`orders/${submissionId}`'))
    assert.ok(!helper.includes('`submissions/${orderId}`'))
  })
})

// ══ 7. The behavioural script ════════════════════════════════════════════════

describe('the assertions script', () => {
  const script = lf(readFileSync(join(ROOT, 'supabase', 'tests', 'order_number_cycle_reset_assertions.sql'), 'utf8'))

  test('exists and rolls back — including the reset itself', () => {
    assert.match(script, /^\\set ON_ERROR_STOP on/m)
    assert.match(script, /\nrollback;\s*$/)
    assert.match(script, /ALL ASSERTIONS PASSED/)
  })

  test('proves every claim this phase makes', () => {
    for (const claim of [
      'RESET IS REFUSED WHILE ANY ORDER EXISTS',
      'RESET IS REFUSED OUTSIDE THE CLEANUP PROTOCOL',
      'RESET IS REFUSED WITH A MISMATCHED CLAIM',
      'SUCCESSFUL FINALIZED CLEANUP MAKES THE NEXT ALLOCATION 0001',
      'CONCURRENT APPROVAL CANNOT RACE THE RESET',
      'A CANCELLED ORDER PREVENTS RESET',
    ]) {
      assert.ok(script.includes(claim), `the script must prove: ${claim}`)
    }
  })

  test('and never deletes a real Order to get there', () => {
    // Section C creates its own fixture, proves the refusal against it, and
    // removes only what it created — and the whole thing rolls back anyway.
    assert.ok(script.includes('the fixture Order was removed and no real Order was touched'))
    assert.ok(!/delete from public\.orders;/.test(script), 'never an unqualified delete')
  })
})
