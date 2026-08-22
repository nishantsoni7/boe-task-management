/**
 * PI CLIENT DETAILS EDITING — what migration 20260928000000 promises.
 *
 * A repository check in this module's established style. The behavioural proof
 * is supabase/tests/order_submission_client_details_assertions.sql; this guards
 * the properties a later edit could quietly drop, and in particular the ones
 * the whole safety argument rests on: that this write path cannot reach a
 * derived value, a status, a payment or the Order link.
 *
 * Run:
 *   npx tsx --test src/lib/orders/clientDetailsEditSchema.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATION = 'supabase/migrations/20260928000000_order_submission_client_details_edit.sql'
const sql = readFileSync(join(process.cwd(), MIGRATION), 'utf8')

/** Code only: prose in a comment must never satisfy a guard about behaviour. */
const code = sql
  .split('\n')
  .filter(line => !line.trimStart().startsWith('--'))
  .join('\n')

const fn = code.slice(code.indexOf('create or replace function public.update_order_submission_client_details'))
const body = fn.slice(0, fn.indexOf('$$;') + 3)

// ══ 1. The dead end this exists for ══════════════════════════════════════════

describe('the reported dead end', () => {
  test('is named, so the next reader knows why this write path exists', () => {
    assert.match(sql, /imported without a client name/)
    assert.match(sql, /ORDER_SUBMISSION_NO_CLIENT/)
  })

  test('records WHY this is one section and not the whole PI', () => {
    // The scope decision is the interesting part, and it should not have to be
    // rediscovered by whoever adds the next section.
    assert.match(sql, /Nothing here feeds\s*\n?--\s*a total/)
    assert.match(sql, /must atomically recompute/)
  })
})

// ══ 2. Authority ═════════════════════════════════════════════════════════════

describe('who may edit', () => {
  test('accepts EITHER the owner rule or the admin rule', () => {
    assert.match(body, /v_is_admin := public\.can_admin_edit_order_submission/)
    assert.match(body, /v_is_owner := public\.can_edit_order_submission/)
    assert.match(body, /if not \(v_is_admin or v_is_owner\) then/)
    assert.match(body, /ORDER_SUBMISSION_NOT_EDITABLE/)
  })

  test('requires a reason for an admin edit after submission, and not otherwise', () => {
    assert.match(body, /ORDER_SUBMISSION_REASON_REQUIRED/)
    assert.match(body, /if v_after_sub and not v_is_owner then/)
  })

  test('takes the row lock BEFORE judging state, authority or staleness', () => {
    const lockAt = body.indexOf('for update')
    const authAt = body.indexOf('can_admin_edit_order_submission(p_submission_id)')
    const staleAt = body.indexOf('p_expected_version is not null')
    assert.ok(lockAt > 0)
    assert.ok(lockAt < authAt, 'authority is judged after the lock')
    assert.ok(lockAt < staleAt, 'staleness is judged after the lock')
  })

  test('is SECURITY DEFINER with a fixed search path, revoked from public and anon', () => {
    assert.match(body, /security definer/)
    assert.match(body, /set search_path = public, pg_temp/)
    assert.match(code, /revoke all\s+on function public\.update_order_submission_client_details\(uuid, jsonb, integer, text\) from public, anon/)
    assert.match(code, /grant  execute on function public\.update_order_submission_client_details\(uuid, jsonb, integer, text\) to authenticated/)
  })
})

// ══ 3. The allow-list — the safety argument ══════════════════════════════════

describe('what can be written', () => {
  const TEN = [
    'client_name', 'contact_number',
    'bill_to_name', 'bill_to_phone', 'bill_to_gst', 'billing_address',
    'ship_to_name', 'ship_to_phone', 'ship_to_gst', 'shipping_address',
  ]

  test('is exactly ten named text columns', () => {
    const list = body.slice(body.indexOf('c_fields constant text[]'))
    const declared = list.slice(0, list.indexOf('];'))
    for (const f of TEN) assert.ok(declared.includes(`'${f}'`), `${f} is missing`)
    assert.equal((declared.match(/'/g) ?? []).length / 2, TEN.length,
      'the allow-list has grown or shrunk')
  })

  test('an unknown key is REFUSED, never silently ignored', () => {
    // Dropping an unrecognised field would let a caller believe it saved
    // something it did not.
    assert.match(body, /ORDER_SUBMISSION_UNKNOWN_FIELD/)
    assert.match(body, /if not \(v_key = any \(c_fields\)\) then/)
  })

  test('a non-text value is refused rather than coerced', () => {
    assert.match(body, /ORDER_SUBMISSION_BAD_FIELD_TYPE/)
    assert.match(body, /jsonb_typeof\(p_fields -> v_key\) not in \('string', 'null'\)/)
  })

  test('values are bounded', () => {
    assert.match(body, /ORDER_SUBMISSION_FIELD_TOO_LONG/)
    assert.match(body, /length\(v_new\) > 500/)
  })

  test('NOTHING DERIVED OR SYSTEM-OWNED is ever assigned', () => {
    // The whole safety argument for editing this section without recomputing
    // anything. Checked here AND again by the migration at apply time.
    const update = body.slice(body.indexOf('update public.order_submissions set'))
    const stmt = update.slice(0, update.indexOf('where id = p_submission_id'))
    for (const forbidden of [
      'status', 'total_before_gst', 'gst_amount', 'grand_total',
      'subtotal_after_discount', 'gross_product_amount', 'billing_percentage',
      'order_id', 'created_by', 'submitted_by', 'submitted_at',
      'source_workbook_path', 'source_workbook_sha256', 'parse_blocking_issues',
    ]) {
      assert.ok(!new RegExp(`\\b${forbidden}\\s*=`).test(stmt),
        `the editor assigns ${forbidden}, which is derived or system-owned`)
    }
  })

  test('the migration re-checks that itself, at apply time', () => {
    assert.match(code, /which is derived or system-owned/)
  })

  test('blank becomes NULL, matching the parser exactly', () => {
    // Otherwise "empty" would mean two different things depending on whether a
    // human or the parser last touched the field.
    assert.match(body, /nullif\(btrim\(coalesce\(p_fields ->> 'client_name', ''\)\), ''\)/)
  })

  test('an ABSENT key leaves its column alone', () => {
    // Not the same as a null one. This is what lets two people correct
    // different halves of the same PI.
    assert.match(body, /case when p_fields \? 'client_name'\s+then .* else client_name\s+end/)
  })
})

// ══ 4. Optimistic concurrency ════════════════════════════════════════════════

describe('two people editing at once', () => {
  test('is guarded by a COUNTER, never a timestamp', () => {
    // now() is transaction-scoped, so two writes in one transaction stamp the
    // identical updated_at and a stale edit compares equal to a fresh one. The
    // first cut of this migration used updated_at and its own assertions caught
    // it. Clock resolution is not a version.
    assert.match(code, /add column if not exists row_version integer not null default 0/)
    assert.match(body, /v_sub\.row_version is distinct from p_expected_version/)
    assert.ok(!/updated_at is distinct from p_expected/.test(body),
      'a timestamp must not be used as a version again')
  })

  test('the reason why is recorded where the next reader will look', () => {
    assert.match(sql, /`?now\(\)`? is TRANSACTION-scoped/)
  })

  test('the counter advances on every write that changes something', () => {
    assert.match(body, /row_version      = row_version \+ 1/)
  })

  test('and NOT on a save that changed nothing', () => {
    const noop = body.slice(body.indexOf('if v_changed = 0 then'))
    const block = noop.slice(0, noop.indexOf('end if;'))
    assert.ok(!block.includes('row_version = row_version + 1'))
    assert.ok(!block.includes('update public.order_submissions'))
    assert.match(block, /'row_version',   v_sub\.row_version/)
  })

  test('a stale write is refused with its own code', () => {
    assert.match(body, /ORDER_SUBMISSION_STALE/)
  })
})

// ══ 5. Continuity with the Order ═════════════════════════════════════════════

describe('when an Order exists', () => {
  test('the corrected client name reaches it', () => {
    assert.match(body, /update public\.orders\s*\n\s*set client_name =/)
  })

  test('and NOTHING else about it is written', () => {
    const at = body.indexOf('update public.orders')
    const stmt = body.slice(at, body.indexOf(';', at))
    for (const forbidden of [
      'display_number', 'source_order_submission_id', 'total_value', 'status',
      'billing_percentage', 'confirm_date',
    ]) {
      assert.ok(!stmt.includes(forbidden),
        `the amendment writes ${forbidden} on the Order; it must not`)
    }
  })

  test('the Order trail records it', () => {
    assert.match(body, /'order_client_details_amended'/)
  })
})

// ══ 6. Documents ═════════════════════════════════════════════════════════════

describe('confirmed documents', () => {
  test('are superseded ONLY by a field that appears on them', () => {
    // Superseding for a phone number would make people regenerate for nothing.
    const printed = body.slice(body.indexOf('c_printed constant text[]'))
    const declared = printed.slice(0, printed.indexOf('];'))
    for (const f of ['client_name', 'bill_to_name', 'billing_address', 'ship_to_name', 'shipping_address']) {
      assert.ok(declared.includes(`'${f}'`), `${f} is printed but not listed`)
    }
    for (const f of ['contact_number', 'bill_to_phone', 'ship_to_phone', 'bill_to_gst', 'ship_to_gst']) {
      assert.ok(!declared.includes(`'${f}'`), `${f} is not printed and must not supersede`)
    }
  })

  test('through the shared helper, which never deletes or rewrites a file', () => {
    assert.match(body, /public\.supersede_order_documents\(v_sub\.order_id, 'pi_data_amended'\)/)
    assert.ok(!/delete\s+from\s+public\.order_document_versions/i.test(body))
  })
})

// ══ 7. The trail ═════════════════════════════════════════════════════════════

describe('activity', () => {
  test('records BEFORE and AFTER for every changed field', () => {
    assert.match(body, /jsonb_build_object\(\s*\n?\s*v_key, jsonb_build_object\('from', v_old, 'to', v_new\)\)/)
  })

  test('owner and admin edits are DIFFERENT actions', () => {
    assert.match(body, /'client_details_amended_by_admin'/)
    assert.match(body, /'client_details_updated'/)
  })

  test('is written in the SAME transaction as the change', () => {
    // No queue, no trigger that could be disabled, no second call that could
    // fail on its own.
    const updateAt = body.indexOf('update public.order_submissions set')
    const logAt = body.indexOf('log_order_submission_activity')
    assert.ok(updateAt > 0 && logAt > updateAt)
    assert.ok(!/commit|autonomous/i.test(body))
  })

  test('carries no image bytes and no secret, because it cannot', () => {
    // The allow-list admits ten named text columns; there is no path by which
    // binary or credential material could reach the metadata.
    assert.ok(!/bytea|encode\(|decode\(|image_storage_path/.test(body))
  })

  test('an unchanged save writes NO event', () => {
    const noop = body.slice(body.indexOf('if v_changed = 0 then'))
    const block = noop.slice(0, noop.indexOf('end if;'))
    assert.ok(!block.includes('log_order_submission_activity'))
    assert.ok(!block.includes('order_activity_log'))
  })
})

// ══ 8. A submitted PI keeps its client name ══════════════════════════════════

describe('clearing the client name', () => {
  test('is refused on a submitted PI, in words rather than a constraint name', () => {
    // order_submissions_reviewable_is_complete already forbids it, but a CHECK
    // violation reaches the caller as a catalog identifier.
    assert.match(body, /ORDER_SUBMISSION_CLIENT_NAME_REQUIRED/)
    assert.match(body, /v_sub\.status not in \('draft', 'needs_changes'\)/)
  })
})

// ══ 9. Migration hygiene ═════════════════════════════════════════════════════

describe('the migration itself', () => {
  test('is forward-only, after 20260927000000', () => {
    assert.ok(Number(MIGRATION.split('/').pop()!.split('_')[0]) > 20260927000000)
  })

  test('refuses to apply before its dependency', () => {
    assert.match(code, /DEPENDENCY MISSING: 20260927000000 must be applied before/)
  })

  test('drops nothing an earlier migration owns', () => {
    assert.ok(!/drop (table|column|policy|constraint|function)/i.test(code))
  })

  test('does not redefine the owner rule', () => {
    assert.ok(!code.includes('create or replace function public.can_edit_order_submission'))
    assert.match(code, /can_edit_order_submission has been altered/)
  })
})
