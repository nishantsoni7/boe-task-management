/**
 * 20261124000000 — READ AS A FILE, BEFORE IT IS EVER APPLIED.
 *
 * The business decision: a PI Excel no longer needs to carry the reserved
 * Order number before a Confirmed Order can be created from it, and BOE now
 * assigns permanent BOE item codes (BE001, BE002, ...) and the combined Order
 * Product Code ({operational number}-BE00N) once the Order exists.
 *
 * What a text test can prove, and what it cannot: it CANNOT prove that two
 * concurrent code assignments never collide on a sequence number, or that a
 * real INSERT INTO orders actually skips the removed refusal — those need a
 * running PostgreSQL, and are the functional smoke test run by hand against
 * an isolated database (see the PR description). What it CAN prove is the
 * shape of the file: which rule was removed and which were kept, that the
 * new table's identity/uniqueness/RLS is as designed, and that both callers
 * of assign_order_product_codes were actually updated to call it.
 *
 * Offline and pure: reads one file.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATION =
  'supabase/migrations/20261124000000_order_submission_reserved_number_gate_removed_and_boe_item_codes.sql'
const sql = readFileSync(join(process.cwd(), MIGRATION), 'utf8').replace(/\r\n/g, '\n')

/** One function's whole body, from its CREATE to the `$$;` that ends it. */
function body(source: string, name: string): string {
  const lines = source.split('\n')
  const start = lines.findIndex(l => l.startsWith(`create or replace function public.${name}(`))
  assert.notEqual(start, -1, `${name} is not created in this file`)
  const end = lines.indexOf('$$;', start)
  assert.notEqual(end, -1, `${name} has no terminating $$;`)
  return lines.slice(start, end + 1).join('\n')
}

describe('the obsolete PI-reprint gate is removed, and only it', () => {
  const gate = body(sql, 'assign_order_display_number')

  test('the door no longer asks the revised-PI rule', () => {
    assert.doesNotMatch(gate, /order_submission_revised_pi_refusal/,
      'the Order door must not require the source PI to carry the reserved number')
  })

  test('every other rule the door enforced is still there', () => {
    assert.match(gate, /ORDER_FROM_RESERVED_PI_REQUIRES_APPROVAL/)
    assert.match(gate, /ORDER_SUBMISSION_RESERVATION_REQUIRED/)
    assert.match(gate, /ORDER_SUBMISSION_CONVERTED/)
    assert.match(gate, /ORDER_NUMBER_RESERVATION_IN_USE/)
    assert.match(gate, /new\.display_number := v_sub\.reserved_order_number/)
    assert.match(gate, /public\.allocate_confirmed_order_number\(\)/,
      'the fallback to the shared cycle for a PI with no reservation is unchanged')
  })

  test('the rule function itself is not restated — only unreferenced', () => {
    assert.doesNotMatch(sql, /create or replace function public\.order_submission_revised_pi_refusal/,
      'this migration must not touch the rule; it only stops calling it')
  })

  test('this file does not restate order_submissions_require_revised_pi_on_submit either', () => {
    // The submit-time door was already fixed by 20261121000000; this file
    // only ever needed to touch the Order-creation door.
    assert.doesNotMatch(sql, /create or replace function public\.order_submissions_require_revised_pi_on_submit/)
  })
})

describe('order_operational_number: display only, storage untouched', () => {
  const fn = body(sql, 'order_operational_number')

  test('strips leading zeros and stays total', () => {
    assert.match(fn, /ltrim\(p_number, '0'\)/)
    assert.match(fn, /nullif\(/, 'a value with no non-zero digit reads as null, not an empty string')
  })

  test('it is IMMUTABLE and pure SQL — no table read, no side effect', () => {
    assert.match(fn, /language sql\s*\nimmutable/)
  })

  test('the self-assertion actually exercises the examples from the business decision', () => {
    assert.match(sql, /order_operational_number\('0524'\) is distinct from '524'/)
    assert.match(sql, /order_operational_number\(null\) is not null/)
  })

  test('display_number itself is never altered: no UPDATE, no ALTER on its column, no dropped constraint', () => {
    assert.doesNotMatch(sql, /alter table public\.orders/i)
    assert.doesNotMatch(sql, /drop constraint/i)
    assert.doesNotMatch(sql, /update public\.orders\b/i)
  })
})

describe('public.order_product_codes: the new table', () => {
  test('it exists, with the identity and uniqueness the design requires', () => {
    assert.match(sql, /create table public\.order_product_codes/)
    assert.match(sql, /order_id\s+uuid not null references public\.orders\(id\) on delete cascade/)
    assert.match(sql, /submission_item_id\s+uuid references public\.order_submission_items\(id\) on delete set null/,
      'SET NULL, not CASCADE: an issued code must survive the row it was issued for')
    assert.match(sql, /boe_sequence\s+integer not null check \(boe_sequence > 0\)/)
    assert.match(sql, /unique \(order_id, submission_item_id\)/)
    assert.match(sql, /unique \(order_id, boe_sequence\)/)
  })

  test('the source PI code is preserved, separately from the identity a code is matched on', () => {
    assert.match(sql, /source_product_code\s+text/)
    assert.match(sql, /source_item_sequence\s+text/)
  })

  test('row level security is enabled and gated on the Order itself', () => {
    assert.match(sql, /alter table public\.order_product_codes enable row level security/)
    assert.match(sql,
      /create policy "order_product_codes_select" on public\.order_product_codes\s*\n\s*for select to authenticated\s*\n\s*using \(public\.can_view_order\(order_id\)\)/)
  })

  test('no client role may write it directly', () => {
    assert.match(sql, /revoke all on public\.order_product_codes from public, anon, authenticated/)
    assert.doesNotMatch(sql,
      /create policy[^;]*on public\.order_product_codes[^;]*for (insert|update|delete)/i)
  })

  test('can_view_order is SECURITY INVOKER — it must run as the caller, not this function\'s owner', () => {
    const fn = body(sql, 'can_view_order')
    assert.doesNotMatch(fn, /security definer/i)
  })
})

describe('assign_order_product_codes: the one place a code is ever issued', () => {
  const fn = body(sql, 'assign_order_product_codes')

  test('it is internal only', () => {
    assert.match(sql,
      /revoke all on function public\.assign_order_product_codes\(uuid, uuid\) from public, anon, authenticated/)
    assert.doesNotMatch(sql, /grant\s+execute on function public\.assign_order_product_codes/)
  })

  test('the next sequence is the highest ever issued for the Order, plus one — never a count', () => {
    // A count would reuse a retired sequence; max()+1 never does, even once a
    // row has gone orphaned.
    assert.match(fn, /coalesce\(max\(boe_sequence\), 0\)/)
  })

  test('it only ever adds rows for items that do not already have one', () => {
    assert.match(fn, /not exists \(\s*\n\s*select 1 from public\.order_product_codes c/)
  })

  test('assignment order is the document\'s own layout, not arrival order', () => {
    assert.match(fn, /order by i\.sort_order, i\.source_row/)
  })

  test('it never deletes or updates a row in its own table', () => {
    assert.doesNotMatch(fn, /delete from public\.order_product_codes/)
    assert.doesNotMatch(fn, /update public\.order_product_codes/)
  })
})

describe('both approval paths assign codes, and log what they assigned', () => {
  test('approve_order_submission assigns codes right after the Order is inserted', () => {
    const fn = body(sql, 'approve_order_submission')
    const insertAt = fn.indexOf('insert into public.orders')
    const assignAt = fn.indexOf('assign_order_product_codes')
    assert.ok(insertAt > 0 && assignAt > insertAt,
      'codes must be assigned AFTER the Order row (and its id) exist')
    assert.match(fn, /order_product_codes_assigned/, 'a dedicated activity-log entry records what was issued')
  })

  test('approve_order_pi_revision assigns codes after the reparse is confirmed applied', () => {
    const fn = body(sql, 'approve_order_pi_revision')
    const reparseAt = fn.indexOf('replace_order_submission_parse')
    const notAppliedCheckAt = fn.indexOf('ORDER_PI_REVISION_NOT_APPLIED')
    const assignAt = fn.indexOf('assign_order_product_codes')
    assert.ok(reparseAt > 0 && notAppliedCheckAt > reparseAt && assignAt > notAppliedCheckAt,
      'codes must be assigned only after the revision is proved to have landed')
  })

  test('neither approval function is missing its unrelated, pre-existing rules', () => {
    const approve = body(sql, 'approve_order_submission')
    for (const rule of [
      'ORDER_SUBMISSION_FINANCE_NOT_VERIFIED',
      'ORDER_SUBMISSION_EXCEPTION_PENDING',
      'ORDER_SUBMISSION_PAYMENT_INSUFFICIENT',
      'ORDER_SUBMISSION_ALLOCATION_NOT_MOVED',
      'order_pi_versions',
    ]) {
      assert.match(approve, new RegExp(rule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        `re-emitting approve_order_submission must not drop ${rule}`)
    }

    const revision = body(sql, 'approve_order_pi_revision')
    for (const rule of [
      'ORDER_PI_REVISION_STALE',
      'ORDER_PI_REVISION_FILE_MISMATCH',
      'ORDER_PI_REVISION_ORDER_CLOSED',
      'boe.amendment_context',
    ]) {
      assert.match(revision, new RegExp(rule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        `re-emitting approve_order_pi_revision must not drop ${rule}`)
    }
  })

  test('neither re-emitted function widens its own grants', () => {
    assert.match(sql,
      /revoke execute on function public\.approve_order_submission\(uuid\) from public, anon;\s*\ngrant\s+execute on function public\.approve_order_submission\(uuid\) to authenticated;/)
    assert.match(sql,
      /revoke execute on function public\.approve_order_pi_revision\(uuid, uuid, jsonb\)\s*\n\s*from public, anon, authenticated;\s*\ngrant\s+execute on function public\.approve_order_pi_revision\(uuid, uuid, jsonb\) to service_role;/)
  })
})

describe('what this migration deliberately leaves alone', () => {
  test('PI approval permission, the payment gate and the advance-exception path are untouched functions', () => {
    for (const untouched of [
      'order_submission_finance_verified',
      'order_submission_advance_ready',
      'order_submission_exception_current',
      'order_submission_pi_approved',
      'actor_has_module_permission',
    ]) {
      assert.doesNotMatch(sql, new RegExp(`create or replace function public\\.${untouched}`),
        `${untouched} must not be restated by this migration`)
    }
  })

  test('no permission is granted or revoked beyond the two new objects this file adds', () => {
    const grants = sql.match(/^(grant|revoke)\b.*$/gim) ?? []
    for (const line of grants) {
      assert.match(line,
        /order_operational_number|order_product_codes|can_view_order|assign_order_product_codes|approve_order_submission|approve_order_pi_revision/i,
        `unexpected privilege statement: ${line}`)
    }
  })

  test('it does not touch Production Alignment or the amendment guard', () => {
    assert.doesNotMatch(sql, /create or replace function public\.set_order_production_alignment/)
    assert.doesNotMatch(sql, /create or replace function public\.orders_guard_amendable_columns/)
    assert.doesNotMatch(sql, /create or replace function public\.in_order_amendment/)
  })
})

describe('it proves itself against the deployed bodies, not against its own text', () => {
  test('a precondition guards against applying to the wrong database', () => {
    assert.match(sql, /PRECONDITION FAILED/)
    assert.match(sql, /DEPENDENCY MISSING/)
  })

  test('the closing block re-reads what it installed with pg_get_functiondef', () => {
    const tail = sql.slice(sql.lastIndexOf('-- ── 7. Read back'))
    assert.match(tail, /pg_get_functiondef\(to_regprocedure\('public\.assign_order_display_number\(\)'\)\)/)
    assert.match(tail, /ASSERTION FAILED: assign_order_display_number\(\) still asks the revised-PI rule/)
    assert.match(tail, /ASSERTION FAILED: approve_order_submission\(\) does not assign product codes/)
    assert.match(tail, /ASSERTION FAILED: approve_order_pi_revision\(\) does not assign product codes/)
    assert.match(tail, /to_regclass\('public\.order_product_codes'\) is null/)
  })

  test('the file begins and ends its own transaction', () => {
    assert.match(sql.trimStart(), /^-- /, 'starts with commentary, not a bare statement')
    assert.match(sql, /^begin;$/m)
    assert.match(sql, /^commit;$/m)
  })
})

describe('it sorts after everything that was on disk when it was written', () => {
  test('nothing between it and the migration it re-emits was added later', () => {
    // IT IS NO LONGER THE LAST FILE, and it does not need to be. What this
    // guard is for is that this migration APPLIES AFTER everything it depends
    // on — so what matters is that nothing sorts between it and the state it
    // was written against. 20261201000000 (the four fields a Confirmed Order
    // cannot be built without) sorts after it, re-emits
    // approve_order_submission from THIS file's text, and is accounted for
    // here by name.
    const files = readdirSync(join(process.cwd(), 'supabase/migrations'))
      .filter((f: string) => /^\d{14}_/.test(f))
      .sort()
    const mine = MIGRATION.split('/').pop() as string
    const at = files.indexOf(mine)
    assert.ok(at >= 0, 'the migration is on disk')
    assert.deepEqual(files.slice(at), [
      mine,
      '20261201000000_order_submission_confirmation_required_fields.sql',
      // Confirmed Order update notifications: four notification_type values,
      // one configuration table of its own (public.order_notification_recipients)
      // and one partial index on public.notifications. It creates nothing else,
      // alters no existing table and defines no function, so it reaches nothing
      // asserted here.
      '20261202000000_order_update_notifications.sql',
    ], 'every migration at or after this one is accounted for')
  })
})
