/**
 * 20261009000000 — READ AS A FILE, BEFORE IT IS EVER APPLIED.
 *
 * What a text test can prove, and what it cannot. It CANNOT prove that two
 * concurrent reservations take different numbers, or that a failed allocation
 * takes its payment with it — those need locks and real transactions, and they
 * are proved by supabase/tests/run_order_number_reservation_suite.sh against a
 * running PostgreSQL. What it CAN prove is the shape of the file: that it
 * deletes nothing, that it re-emits the five deployed functions it replaces
 * WITHOUT dropping any of their existing rules, that it grants nothing to a
 * client role that was not already granted, and that it writes its allocations
 * through the one canonical door rather than inserting them itself.
 *
 * THE MIGRATION IS NOT APPLIED. It is deliberately absent from the FROZEN list
 * in participantAndOrderTotalSecurity.test.ts, and present in that file's exact
 * "no migration has been added after 108 without being accounted for" list.
 *
 * Offline and pure: reads two files.
 *
 * Run:
 *   npx tsx --test src/lib/finance/splitPaymentAndReservationMigration.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'

const MIGRATION =
  'supabase/migrations/20261009000000_split_payment_entry_and_order_submission_number_reservation.sql'
const DEPLOYED_APPROVE =
  'supabase/migrations/20260923000000_order_submission_billing_percentage.sql'
const SUITE   = 'supabase/tests/run_order_number_reservation_suite.sh'
const SCHEMA  = 'supabase/tests/_order_number_reservation_shaped_schema.sql'
const ASSERTS = 'supabase/tests/order_number_reservation_assertions.sql'

const sql = readFileSync(MIGRATION, 'utf8')

/** One function's whole body, from its CREATE to the `$$;` that ends it. */
function body(source: string, name: string): string[] {
  const lines = source.split('\n')
  const start = lines.findIndex(l => l.startsWith(`create or replace function public.${name}(`))
  assert.notEqual(start, -1, `${name} is not created in this file`)
  const end = lines.indexOf('$$;', start)
  assert.notEqual(end, -1, `${name} has no terminating $$;`)
  return lines.slice(start, end + 1)
}

describe('it destroys nothing', () => {
  test('no table, column, constraint, index, policy or trigger is dropped', () => {
    // The one exception is stated and is not a loss: the activity ACTION check
    // is dropped and immediately re-added with every value it had plus two, and
    // the reservation-immutability trigger is dropped-if-exists before being
    // created, which is the project's own create idiom.
    const drops = sql.split('\n')
      .map(l => l.trim().toLowerCase())
      .filter(l => l.startsWith('drop ') || l.includes(' drop column') || l.includes(' drop constraint'))
      .sort()
    assert.deepEqual(drops, [
      'drop constraint if exists order_submission_activity_action_check;',
      'drop trigger if exists order_submissions_protect_reserved_number on public.order_submissions;',
    ])
  })

  test('no row is deleted, updated or truncated', () => {
    for (const forbidden of [/\btruncate\b/i, /\bdelete\s+from\b/i]) {
      assert.doesNotMatch(sql, forbidden, `${forbidden} has no place in this migration`)
    }
    // The only UPDATE statements are inside function BODIES — the cycle advance,
    // the reservation write, the approval's own writes. None runs at apply time.
    const applyTimeUpdates = sql.split('\n').filter(l => /^update /i.test(l))
    assert.deepEqual(applyTimeUpdates, [], 'a top-level UPDATE would rewrite live rows')
  })

  test('the columns it adds are nullable, with no default and no backfill', () => {
    const block = sql.slice(sql.indexOf('alter table public.order_submissions'))
      .split(';')[0]
    assert.match(block, /add column if not exists reserved_order_number\s+text,/)
    assert.doesNotMatch(block, /not null/i)
    assert.doesNotMatch(block, /\bdefault\b/i)
  })
})

describe('the two new doors are reachable, and the internals are not', () => {
  const clientCallable = [
    'public.record_payment_with_allocations(numeric, date, text, text, text, text, text, jsonb)',
    'public.reserve_order_number_for_submission(uuid)',
  ]

  for (const fn of clientCallable) {
    test(`${fn.split('(')[0]} is revoked from public and anon, granted to authenticated`, () => {
      assert.ok(sql.includes(`revoke execute on function ${fn}\n  from public, anon;`)
             || sql.includes(`revoke execute on function ${fn} from public, anon;`),
        'it must be revoked from public and anon')
      assert.ok(sql.includes(`grant  execute on function ${fn}\n  to authenticated;`)
             || sql.includes(`grant  execute on function ${fn} to authenticated;`),
        'and granted to authenticated')
    })
  }

  test('the number allocator stays unreachable from a browser', () => {
    // Granting it would let any client take a number outside every workflow —
    // the hole 20260703000000 §7 exists to close.
    assert.match(sql,
      /revoke execute on function public\.allocate_confirmed_order_number\(\) from public, anon, authenticated;/)
    assert.doesNotMatch(sql,
      /grant\s+execute on function public\.allocate_confirmed_order_number/)
  })

  test('the display-number trigger function stays unreachable too', () => {
    assert.match(sql,
      /revoke execute on function public\.assign_order_display_number\(\) from public, anon, authenticated;/)
  })

  test('the immutability trigger function is revoked from every client role', () => {
    assert.match(sql,
      /revoke execute on function public\.prevent_reserved_order_number_change\(\)\s*\n\s*from public, anon, authenticated;/)
  })
})

describe('payment entry goes through the ONE allocation door', () => {
  const fn = body(sql, 'record_payment_with_allocations').join('\n')

  test('it never inserts an allocation itself', () => {
    // A second implementation of the capacity rule, the duplicate rule and the
    // target-eligibility rule is how two implementations come to disagree.
    assert.doesNotMatch(fn, /insert\s+into\s+public\.finance_payment_allocations/i)
    assert.match(fn, /public\.allocate_payment_to_target_internal\(/)
  })

  test('it asks BOTH gates: Finance module entry and finance.allocate', () => {
    assert.match(fn, /public\.module_entry_open\('finance'\)/)
    assert.match(fn, /actor_has_module_permission\('finance', 'allocate'\)/)
    // And both refusals come before the first read of anything.
    const entry = fn.indexOf("module_entry_open('finance')")
    const insert = fn.indexOf('insert into public.finance_payment_requests')
    assert.ok(entry > 0 && entry < insert, 'the gates must precede the write')
  })

  test('the payment is written Awaiting Verification, and verification is not touched', () => {
    assert.match(fn, /'pending_approval'/)
    for (const forbidden of [/approved_linked/, /approved_unlinked/, /approved_at/, /approved_by/]) {
      assert.doesNotMatch(fn, forbidden,
        'recording that money arrived must never assert that Finance verified it')
    }
  })

  test('no direct linkage is written beside the allocations', () => {
    // Under the canonical rule active allocations are authoritative and the
    // direct link is only a fallback, so writing one here would be a second,
    // weaker claim beside the true one.
    const columns = fn.slice(fn.indexOf('insert into public.finance_payment_requests'))
      .split('values')[0]
    assert.doesNotMatch(columns, /\border_id\b/)
    assert.doesNotMatch(columns, /order_request_id/)
  })

  test('there is no parameter that could name an Order Request', () => {
    const signature = fn.slice(0, fn.indexOf('returns jsonb'))
    assert.doesNotMatch(signature, /request/i)
    assert.match(fn, /'order', 'submission'/, 'the two kinds the business has, and no third')
  })

  test('the actor, the number, the status and every allocation’s provenance are derived', () => {
    const signature = fn.slice(0, fn.indexOf('returns jsonb'))
    for (const forbidden of [/p_actor/, /p_status/, /p_request_number/, /p_submitted_by/]) {
      assert.doesNotMatch(signature, forbidden, 'a caller must not be able to supply this')
    }
    assert.match(fn, /status, submitted_by, sales_note, order_number\)/,
      'the column list is fixed here, so nothing a caller sends can reach another column')
  })
})

describe('the reservation cannot be taken twice, or taken back', () => {
  const fn = body(sql, 'reserve_order_number_for_submission').join('\n')

  test('an existing reservation is ANSWERED, before anything is written', () => {
    const answer = fn.indexOf("'already_reserved',      true")
    const allocate = fn.indexOf('public.allocate_confirmed_order_number()')
    assert.ok(answer > 0 && answer < allocate,
      'the idempotent answer must come before the allocator is ever reached')
  })

  test('the PI is locked before its state is judged', () => {
    const lock = fn.indexOf('for update')
    const judge = fn.indexOf('reserved_order_number is not null')
    assert.ok(lock > 0 && lock < judge)
  })

  test('the number comes from the cycle, never from a max() preview', () => {
    assert.match(fn, /public\.allocate_confirmed_order_number\(\)/)
    assert.doesNotMatch(fn, /max\(/i, 'a max()+1 preview is the defect this replaces')
  })

  test('the authority is the workbook editor’s, and only its draft branch', () => {
    assert.match(fn, /assert_order_submission_workbook_editor\(p_submission_id, v_actor, null, false\)/)
    assert.match(fn, /after_submission.*::boolean, true\)/)
  })

  test('a unique index — not a function’s own check — is what stops a shared number', () => {
    assert.match(sql,
      /create unique index if not exists order_submissions_reserved_order_number_uidx\s*\n\s*on public\.order_submissions \(reserved_order_number\)\s*\n\s*where reserved_order_number is not null;/)
  })

  test('nothing in the file releases a reservation', () => {
    // Rule: a gap in the series is safe; a reused number is two commercial
    // documents claiming to be the same Order.
    assert.doesNotMatch(sql, /set\s+reserved_order_number\s*=\s*null/i)
    assert.match(body(sql, 'prevent_reserved_order_number_change').join('\n'),
      /RESERVED_ORDER_NUMBER_IMMUTABLE/)
  })
})

describe('approve_order_submission is re-emitted whole, and loses nothing', () => {
  const deployed = body(readFileSync(DEPLOYED_APPROVE, 'utf8'), 'approve_order_submission')
  const restated = body(sql, 'approve_order_submission')

  test('every line of the deployed body survives, except six that were extended', () => {
    // THE CONTINUITY CHECK. `create or replace` cannot change a signature, and
    // the house rule for this function is to restate it in full — which is also
    // the easiest way to drop a rule by accident. So the deployed body's lines
    // are compared as a multiset: anything MISSING is either a deliberate,
    // enumerated change or a rule that has silently gone.
    //
    // All six below are the same line with something appended — a trailing
    // comma, or a key added beside it — never a rule removed.
    const counts = new Map<string, number>()
    for (const line of restated) counts.set(line, (counts.get(line) ?? 0) + 1)
    const missing: string[] = []
    for (const line of deployed) {
      const left = counts.get(line) ?? 0
      if (left === 0) missing.push(line)
      else counts.set(line, left - 1)
    }

    assert.deepEqual(missing.sort(), [
      '         order_id    = v_order_id',
      "      'already_approved', true",
      "      'display_number',   v_number,",
      "      'order_id',         v_sub.order_id,",
      "      'submission_id',    p_submission_id,",
      "    'moved_allocations', v_moved_count",
    ])
  })

  test('the money gates, the workbook gates and the allocation move are all still there', () => {
    const text = restated.join('\n')
    for (const rule of [
      'ORDER_SUBMISSION_FINANCE_NOT_VERIFIED',
      'ORDER_SUBMISSION_PAYMENT_INSUFFICIENT',
      'ORDER_SUBMISSION_PAYMENT_AWAITING_VERIFICATION',
      'ORDER_SUBMISSION_EXCEPTION_STALE',
      'ORDER_SUBMISSION_WORKBOOK_NOT_STORED',
      'ORDER_SUBMISSION_BAD_IMAGE_PATH',
      'ORDER_SUBMISSION_ALLOCATION_NOT_MOVED',
      "actor_has_module_permission('orders', 'approve_order')",
    ]) {
      assert.ok(text.includes(rule), `${rule} must survive the re-emission`)
    }
  })

  test('the reservation clause is dead code for a PI that holds none', () => {
    const text = restated.join('\n')
    const guard = 'if v_sub.reserved_order_number is not null then'
    assert.ok(text.includes(guard))
    // Every new refusal sits inside that guard, so an unreserved PI is approved
    // exactly as it always has been.
    for (const raised of ['ORDER_SUBMISSION_REVISED_PI_MISSING', 'ORDER_NUMBER_RESERVATION_IN_USE']) {
      assert.ok(text.indexOf(raised) > text.indexOf(guard))
    }
  })

  test('the revised-PI test is the WORKBOOK HASH, not a flag anybody can tick', () => {
    const text = restated.join('\n')
    assert.match(text,
      /source_workbook_sha256 is not distinct from v_sub\.reserved_number_workbook_sha256/)
    // A null live hash is refused too: it is not evidence a revised file exists.
    assert.match(text, /v_sub\.source_workbook_sha256 is null\s*\n\s*or v_sub\.source_workbook_sha256 is not distinct/)
  })

  test('the number is still assigned by the trigger, never written here', () => {
    const insert = restated.join('\n')
    const columns = insert.slice(insert.indexOf('insert into public.orders'))
      .split('values')[0]
    assert.doesNotMatch(columns, /display_number/,
      'a second place a number can be assigned is a second place it can be wrong')
  })
})

describe('the cycle reset gains a gate and keeps its own', () => {
  const fn = body(sql, 'reset_confirmed_order_number_cycle').join('\n')

  test('every original gate is still there', () => {
    for (const gate of [
      'ORDER_NUMBER_RESET_FORBIDDEN',
      'ORDER_NUMBER_RESET_NO_CLAIM',
      'ORDER_NUMBER_RESET_CLAIM_INVALID',
      'ORDER_NUMBER_RESET_CLAIM_UNFINISHED',
      'ORDER_NUMBER_RESET_ORDERS_EXIST',
      'ORDER_NUMBER_RESET_APPROVAL_PENDING',
      'ORDER_NUMBER_RESET_ALLOCATIONS_REMAIN',
    ]) {
      assert.ok(fn.includes(gate), `${gate} must survive the re-emission`)
    }
  })

  test('and a reservation now blocks it', () => {
    assert.match(fn, /ORDER_NUMBER_RESET_RESERVATIONS_EXIST/)
    // Every reservation, used or not: a used one belongs to an Order, and an
    // unused one is a live promise. Neither survives a restart of the register.
    assert.match(fn, /where s\.reserved_order_number is not null/)
  })

  test('it still deletes nothing', () => {
    assert.doesNotMatch(fn, /\bdelete\b/i)
  })
})

describe('the file carries its own apply-time proof', () => {
  test('it asserts that it wrote no reservation onto a live record', () => {
    assert.match(sql, /PI submission\(s\) carry reservation data after a migration that writes none/)
  })

  test('it asserts historical Order numbers are well-formed and unique', () => {
    assert.match(sql, /Order\(s\) do not carry a four-digit number/)
    assert.match(sql, /Order number\(s\) are held by more than one Order/)
  })

  test('it re-asserts the Order Request retirement guards', () => {
    for (const guard of [
      'order_requests_refuse_new',
      'order_requests_refuse_conversion',
      'orders_refuse_request_provenance',
    ]) {
      assert.ok(sql.includes(guard), `${guard} must be re-asserted by a new payment-entry door`)
    }
  })

  test('it never uses RESET ROLE — the failure 20261007000000 hit three times', () => {
    assert.doesNotMatch(sql, /\breset\s+role\b/i)
  })
})

describe('the runnable suite exists, and proves what text cannot', () => {
  test('the runner, the shaped schema and the assertions are all present', () => {
    for (const file of [SUITE, SCHEMA, ASSERTS]) {
      assert.ok(existsSync(file), `${file} is missing`)
    }
    assert.ok(statSync(SUITE).mode & 0o111, 'the runner must be executable')
  })

  test('the runner applies THIS migration, and refuses to be vacuous', () => {
    const runner = readFileSync(SUITE, 'utf8')
    assert.ok(runner.includes('20261009000000_split_payment_entry_and_order_submission_number_reservation.sql'))
    // The negative case runs FIRST: drop a retirement guard, and the migration
    // must refuse itself and roll back completely. Without it, every assertion
    // after could pass against a migration that had not really applied.
    assert.ok(runner.includes('the migration refuses itself when a retirement guard is gone'))
    assert.ok(runner.includes('it did not roll back'))
  })

  test('it races two real connections, because one can never contend a lock', () => {
    const runner = readFileSync(SUITE, 'utf8')
    assert.ok(runner.includes('two concurrent reservations'))
    assert.ok(runner.includes('took the same number'))
    // Backgrounded and then waited on — one after the other would contend no
    // lock at all and would pass however broken the serialization was.
    assert.ok(runner.includes('PID_A=$!') && runner.includes('PID_B=$!'),
      'the two reservations must run concurrently')
    assert.ok(runner.includes('wait $PID_A; wait $PID_B'))
  })

  test('it installs the DEPLOYED bodies first, so the migration is seen to replace them', () => {
    const runner = readFileSync(SUITE, 'utf8')
    assert.ok(runner.includes('the DEPLOYED bodies the migration will replace'))
    for (const fn of [
      'set_next_confirmed_order_number',
      'reset_confirmed_order_number_cycle',
      'approve_order_submission',
    ]) {
      assert.ok(runner.includes(fn), `${fn} must be extracted from its own migration`)
    }
  })

  test('every case A–V is asserted', () => {
    const asserts = readFileSync(ASSERTS, 'utf8')
    for (const letter of 'ABCDEFGHIJKLMNOPQRSTUV') {
      assert.match(asserts, new RegExp(`${letter} pass|${letter} FAILED`),
        `case ${letter} is not covered`)
    }
  })
})
