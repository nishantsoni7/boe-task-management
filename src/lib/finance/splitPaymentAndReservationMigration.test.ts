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
import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const MIGRATION =
  'supabase/migrations/20261009000000_split_payment_entry_and_order_submission_number_reservation.sql'
const SUITE   = 'supabase/tests/run_order_number_reservation_suite.sh'
const SCHEMA  = 'supabase/tests/_order_number_reservation_shaped_schema.sql'
const ASSERTS = 'supabase/tests/order_number_reservation_assertions.sql'

const sql = readFileSync(MIGRATION, 'utf8').replace(/\r\n/g, '\n')

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
  test('exactly one applied function is restated, and it is the smallest one', () => {
    // THE AUDIT PROPERTY. An earlier form of this migration restated five
    // applied functions — allocate_confirmed_order_number,
    // set_next_confirmed_order_number, assign_order_display_number,
    // approve_order_submission and reset_confirmed_order_number_cycle — roughly
    // 950 lines of correct, deployed code, for the sake of a clause or two in
    // each. Every one of those clauses is a trigger now, which binds every
    // writer rather than one function's callers.
    const restated = [...sql.matchAll(/^create or replace function public\.(\w+)\(/gm)]
      .map(m => m[1])
    const APPLIED_ELSEWHERE = [
      'allocate_confirmed_order_number',
      'set_next_confirmed_order_number',
      'approve_order_submission',
      'reset_confirmed_order_number_cycle',
      'replace_order_submission_parse',
      'create_order_submission',
    ]
    for (const fn of APPLIED_ELSEWHERE) {
      assert.ok(!restated.includes(fn),
        `${fn} is applied and correct — a trigger must carry the new rule instead of restating it`)
    }
    assert.ok(restated.includes('assign_order_display_number'),
      'the one exception: it IS the trigger that decides a new Order’s number')
  })

  test('and it asserts, at apply time, that the four it does NOT restate are intact', () => {
    for (const rule of [
      'allocate_confirmed_order_number has lost its exhaustion rule',
      'set_next_confirmed_order_number has lost its floor rule',
      'reset_confirmed_order_number_cycle has lost its empty-register gate',
      'approve_order_submission has lost its stranded-money refusal',
    ]) {
      assert.ok(sql.includes(rule), `${rule} must be checked against the live catalog`)
    }
  })

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
      'drop trigger if exists order_number_cycle_respects_reservations on public.order_number_cycle;',
      'drop trigger if exists order_submissions_auto_reserve_order_number on public.order_submissions;',
      'drop trigger if exists order_submissions_log_reservation on public.order_submissions;',
      'drop trigger if exists order_submissions_protect_reserved_number on public.order_submissions;',
      'drop trigger if exists order_submissions_require_revised_pi_on_submit on public.order_submissions;',
      'drop trigger if exists orders_consume_reserved_number on public.orders;',
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

  test('the five reservation columns are nullable, with no default and no backfill', () => {
    const block = sql.slice(sql.indexOf('alter table public.order_submissions'))
      .split(';')[0]
    assert.match(block, /add column if not exists reserved_order_number\s+text,/)
    assert.doesNotMatch(block, /not null/i)
    assert.doesNotMatch(block, /\bdefault\b/i)
  })

  test('the obligation grandfathers every existing draft, by DDL and not by UPDATE', () => {
    // ADD COLUMN ... NOT NULL DEFAULT false fills every existing row with false
    // without rewriting the table and without this migration executing a single
    // UPDATE against live data. The default is THEN changed to true, so the two
    // populations are separated by the one event that actually distinguishes
    // them: whether the row existed when this ran.
    assert.match(sql, /add column if not exists reservation_required boolean not null default false;/)
    assert.match(sql, /alter column reservation_required set default true;/)
    const addAt = sql.indexOf('add column if not exists reservation_required')
    const setAt = sql.indexOf('alter column reservation_required set default true')
    assert.ok(addAt > 0 && addAt < setAt, 'the grandfathering default must be in force first')
  })

  test('and it proves both halves of that at apply time', () => {
    assert.match(sql, /existing PI submission\(s\) were made subject to the new reservation rule/)
    assert.match(sql, /new PI submissions would not require a reserved Order number/)
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

  test('the number allocator is neither restated NOR granted to a client role', () => {
    // It is not touched at all — that is the audit property above — so what
    // matters here is that this file does not widen it. Granting it would let
    // any client take a number outside every workflow, which is the hole
    // 20260703000000 §7 exists to close.
    assert.doesNotMatch(sql,
      /grant\s+execute on function public\.allocate_confirmed_order_number/)
    // And the apply-time block proves the deployed revoke still stands.
    assert.match(sql, /allocate_confirmed_order_number\(\)',\s*\n\s*'public\.assign_order_display_number\(\)/,
      'both must be probed as unreachable by a client role')
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
    // The client door delegates; the answer lives in the implementation.
    const impl = body(sql, 'reserve_order_number_internal').join('\n')
    const answer = impl.indexOf("'already_reserved',      true")
    const allocate = impl.indexOf('public.allocate_confirmed_order_number()')
    assert.ok(answer > 0 && answer < allocate,
      'the idempotent answer must come before the allocator is ever reached')
    // And the door reaches the implementation without a second copy of the rule.
    assert.match(fn, /public\.reserve_order_number_internal\(p_submission_id, v_actor\)/)
  })

  test('the PI is locked before its state is judged', () => {
    const lock = fn.indexOf('for update')
    const judge = fn.indexOf('reserved_order_number is not null')
    assert.ok(lock > 0 && lock < judge)
  })

  test('the number comes from the cycle, never from a max() preview', () => {
    const impl = body(sql, 'reserve_order_number_internal').join('\n')
    const auto = body(sql, 'order_submissions_auto_reserve_order_number').join('\n')
    for (const source of [impl, auto]) {
      assert.match(source, /public\.allocate_confirmed_order_number\(\)/)
      assert.doesNotMatch(source, /max\(/i, 'a max()+1 preview is the defect this replaces')
    }
  })

  test('a NEW draft takes its number with nobody pressing anything', () => {
    const auto = body(sql, 'order_submissions_auto_reserve_order_number').join('\n')
    // Fires on the workbook, not on creation: a number recorded against a NULL
    // hash would read as "never revised" for the rest of that PI's life.
    assert.match(auto, /if not new\.reservation_required then return new; end if;/)
    assert.match(auto, /if new\.source_workbook_sha256 is null then return new; end if;/)
    assert.match(auto, /if new\.reserved_order_number is not null then return new; end if;/)
    assert.match(sql, /create trigger order_submissions_auto_reserve_order_number\s*\n\s*before insert or update on public\.order_submissions/)
  })

  test('exactly one audit row per reservation, written by watching the column', () => {
    // Two doors, one trail. Neither door writes its own row, so they cannot
    // disagree about what a reservation looks like or both record one.
    const log = body(sql, 'order_submissions_log_reservation').join('\n')
    assert.match(log, /if tg_op = 'UPDATE' and old\.reserved_order_number is not null then return null; end if;/)
    assert.match(log, /'order_number_reserved'/)
    for (const door of ['reserve_order_number_internal', 'order_submissions_auto_reserve_order_number']) {
      assert.doesNotMatch(body(sql, door).join('\n'), /'order_number_reserved'/,
        `${door} must not write its own reservation audit row`)
    }
  })

  test('the revised PI must CONTAIN the number, and the hash alone never suffices', () => {
    const rule = body(sql, 'order_submission_revised_pi_refusal').join('\n')
    // Three refusals, in the order that makes each answerable.
    const missing  = rule.indexOf('ORDER_SUBMISSION_REVISED_PI_MISSING')
    const noNumber = rule.indexOf('ORDER_SUBMISSION_REVISED_PI_NO_NUMBER')
    const mismatch = rule.indexOf('ORDER_SUBMISSION_REVISED_PI_NUMBER_MISMATCH')
    assert.ok(missing > 0 && missing < noNumber && noNumber < mismatch,
      'the hash is asked FIRST, so an unrevised workbook that happens to say the right thing is still refused')
    assert.match(rule, /v_found <> v_expected/, 'exact equality, never a prefix or a substring')
    // Comments stripped first: this function's own prose says the words
    // "substring" and "numeric" while explaining why it uses neither.
    const code = rule.split('\n').map(l => l.replace(/--.*$/, '')).join('\n')
    assert.doesNotMatch(code, /\blike\b|position\(|substr|::bigint|::numeric/i,
      'a partial, substring or numeric match would accept a document that says something else')
  })

  test('and the same rule is asked at BOTH gates, from one function', () => {
    for (const gate of ['assign_order_display_number', 'order_submissions_require_revised_pi_on_submit']) {
      assert.match(body(sql, gate).join('\n'), /public\.order_submission_revised_pi_refusal\(/,
        `${gate} must ask the one rule rather than restate it`)
    }
  })

  test('the reference it compares is the server-parsed cell, single-writer', () => {
    assert.match(sql, /function\(s\) other than replace_order_submission_parse write source_order_number/)
    assert.match(sql, /replace_order_submission_parse is client-callable/)
  })

  test('the cycle rule binds the TABLE, so a raw UPDATE cannot walk it back', () => {
    assert.match(sql, /create trigger order_number_cycle_respects_reservations\s*\n\s*before insert or update on public\.order_number_cycle/)
    assert.match(sql, /ORDER_NUMBER_CYCLE_BEHIND_RESERVATION/)
    // Compared as bigint, because '0009' > '00010' is true as text.
    assert.match(body(sql, 'order_number_cycle_respects_reservations').join('\n'),
      /reserved_order_number::bigint/)
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
    // Read the mode git actually tracks, not fs.statSync's: NTFS has no execute
    // bit, so a Windows checkout reports 100666 for every file regardless of
    // what is committed, and the check would fail for a reason that has nothing
    // to do with the runner.
    const tracked = execFileSync('git', ['ls-files', '-s', SUITE], { encoding: 'utf8' })
    assert.match(tracked, /^100755 /, 'the runner must be executable')
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

  test('every case is asserted: A–O, the nine split cases, and the permission block', () => {
    const asserts = readFileSync(ASSERTS, 'utf8')
    for (const letter of 'ABCDEFGHIJKLMNO') {
      assert.match(asserts, new RegExp(`${letter} pass|${letter} FAILED`),
        `case ${letter} is not covered`)
    }
    for (let i = 1; i <= 9; i++) {
      assert.match(asserts, new RegExp(`S${i} pass|S${i} FAILED`), `split case S${i} is not covered`)
    }
    for (let i = 1; i <= 8; i++) {
      assert.match(asserts, new RegExp(`P${i} FAILED`), `permission case P${i} is not covered`)
    }
    // The revised-PI rule is asked directly, case by case, before it is asked
    // through a workflow — nine refusals the hash alone could not produce.
    for (let i = 1; i <= 9; i++) {
      assert.match(asserts, new RegExp(`E${i} FAILED`), `revised-PI case E${i} is not covered`)
    }
  })
})
