/**
 * ADMIN AMENDMENT — what migration 20260927000000 promises, read from its text.
 *
 * A repository check, in this module's established style: the promises a
 * migration makes live in SQL, fail silently in the permissive direction, and
 * TypeScript sees none of it. The behavioural proof is
 * supabase/tests/order_submission_admin_amendment_assertions.sql; this file
 * guards the properties a later edit could quietly drop.
 *
 * Run:
 *   npx tsx --test src/lib/orders/adminAmendmentSchema.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATION = 'supabase/migrations/20260927000000_order_submission_admin_amendment.sql'
const OWNER_RULE = 'supabase/migrations/20260908000000_order_pi_submissions.sql'

const sql = readFileSync(join(process.cwd(), MIGRATION), 'utf8')
const ownerRuleSql = readFileSync(join(process.cwd(), OWNER_RULE), 'utf8')

/** Code only: prose in a comment must never satisfy a guard about behaviour. */
const code = sql
  .split('\n')
  .filter(line => !line.trimStart().startsWith('--'))
  .join('\n')

// ══ 1. The failure this migration exists for ═════════════════════════════════

describe('the manual-test failure', () => {
  test('is named, so the next reader knows what this migration is for', () => {
    assert.match(sql, /ORDER_SUBMISSION_BILLING_NOT_EDITABLE/)
    assert.match(sql, /UNREACHABLE the moment a PI is submitted/)
  })

  test('the diagnosis is recorded, not just the fix', () => {
    // can_edit_order_submission ANDs the actor test after the state tests, so
    // the admin branch cannot be reached once a PI leaves draft.
    assert.match(sql, /actor test is ANDed AFTER the two state tests/)
  })
})

// ══ 2. The new authority ═════════════════════════════════════════════════════

describe('can_admin_edit_order_submission', () => {
  test('exists, and is SECURITY DEFINER with a fixed search path', () => {
    assert.match(code, /create or replace function public\.can_admin_edit_order_submission/)
    const fn = code.slice(code.indexOf('function public.can_admin_edit_order_submission'))
    const body = fn.slice(0, fn.indexOf('$$;') + 3)
    assert.match(body, /security definer/)
    assert.match(body, /set search_path = public, pg_temp/)
  })

  test('requires an ACTIVE, non-deleted admin — a deactivated admin is not one', () => {
    const fn = code.slice(code.indexOf('function public.can_admin_edit_order_submission'))
    const body = fn.slice(0, fn.indexOf('$$;') + 3)
    assert.match(body, /u\.role = 'admin'/)
    assert.match(body, /u\.is_active/)
    assert.match(body, /coalesce\(u\.is_deleted, false\) = false/)
  })

  test('says NOTHING about the PI stage, which is the whole point', () => {
    const fn = code.slice(code.indexOf('function public.can_admin_edit_order_submission'))
    const body = fn.slice(0, fn.indexOf('$$;') + 3)
    assert.ok(!body.includes("'draft'"), 'the admin authority must not be stage-gated')
    assert.ok(!body.includes("'needs_changes'"))
    assert.ok(!body.includes('order_id is null'))
  })

  test('is revoked from public and anon, granted only to authenticated', () => {
    assert.match(code, /revoke execute on function public\.can_admin_edit_order_submission\(uuid\) from public, anon/)
    assert.match(code, /grant  execute on function public\.can_admin_edit_order_submission\(uuid\) to authenticated/)
  })
})

// ══ 3. What was deliberately NOT widened ═════════════════════════════════════

describe('the owner rule', () => {
  test('is NOT redefined by this migration', () => {
    // Widening can_edit_order_submission would hand an admin every other write
    // path in the module at once — items, images, files, submission — with no
    // reason recorded and no concurrency protection.
    assert.ok(!code.includes('create or replace function public.can_edit_order_submission'),
      'this migration must add authority beside the owner rule, never inside it')
  })

  test('still says draft, needs_changes, and no Order', () => {
    assert.match(ownerRuleSql, /status in \('draft', 'needs_changes'\)/)
    assert.match(ownerRuleSql, /s\.order_id is null/)
  })

  test('the migration checks that for itself, at apply time', () => {
    assert.match(code, /can_edit_order_submission has been altered/)
  })
})

describe('approve_order_submission', () => {
  test('is not touched — billingContinuity.test.ts depends on it byte-for-byte', () => {
    assert.ok(!code.includes('create or replace function public.approve_order_submission'))
  })
})

// ══ 4. The billing percentage write path ═════════════════════════════════════

describe('set_order_submission_billing_percentage', () => {
  test('gains a three-argument overload, and KEEPS the two-argument form', () => {
    assert.match(code, /set_order_submission_billing_percentage\(\s*\n\s*p_submission_id uuid,\s*\n\s*p_percentage    numeric,\s*\n\s*p_reason        text/)
    assert.match(code, /p_percentage    numeric default null/)
  })

  test('the two-argument form DELEGATES rather than duplicating the rules', () => {
    // Two copies of an authority check is two things to keep in step, and the
    // one nobody looks at is the one that drifts.
    assert.match(code, /return public\.set_order_submission_billing_percentage\(p_submission_id, p_percentage, null\)/)
  })

  test('takes the row lock BEFORE judging state or authority', () => {
    const fn = code.slice(code.indexOf('p_reason        text'))
    const lockAt = fn.indexOf('for update')
    const authAt = fn.indexOf('can_admin_edit_order_submission(p_submission_id)')
    assert.ok(lockAt > 0 && authAt > 0)
    assert.ok(lockAt < authAt,
      'the state the check reads must be the state the write lands on')
  })

  test('accepts EITHER authority, and refuses when neither holds', () => {
    assert.match(code, /if not \(v_is_admin or v_is_owner\) then/)
    assert.match(code, /ORDER_SUBMISSION_BILLING_NOT_EDITABLE/)
  })

  test('requires a reason for an admin edit after submission, and not otherwise', () => {
    assert.match(code, /ORDER_SUBMISSION_BILLING_REASON_REQUIRED/)
    assert.match(code, /if v_after_sub and not v_is_owner then/)
    // an owner shaping their own draft is never asked
    assert.match(code, /v_reason := null;/)
  })

  test('bounds the reason, so the column cannot be used as free storage', () => {
    assert.match(code, /ORDER_SUBMISSION_BILLING_REASON_TOO_LONG/)
    assert.match(code, /length\(v_reason\) > 500/)
  })

  test('keeps the 35-100 range and the two-decimal precision rule', () => {
    assert.match(code, /p_percentage >= 35 and p_percentage <= 100/)
    assert.match(code, /ORDER_SUBMISSION_BILLING_OUT_OF_RANGE/)
    assert.match(code, /scale\(p_percentage\) > 2/)
    assert.match(code, /ORDER_SUBMISSION_BILLING_PRECISION/)
  })

  test('an unchanged value writes nothing and supersedes nothing', () => {
    assert.match(code, /if v_next is not distinct from v_previous then/)
    const unchanged = code.slice(code.indexOf('if v_next is not distinct from v_previous then'))
    const block = unchanged.slice(0, unchanged.indexOf('end if;'))
    assert.ok(!block.includes('update public.order_submissions'))
    assert.ok(!block.includes('supersede_order_documents'))
    assert.match(block, /'superseded_documents', 0/)
  })

  test('owner and admin edits are DIFFERENT actions in the trail', () => {
    // Not one action with a flag: a reader scanning Activity sees the
    // difference without opening anything.
    assert.match(code, /'billing_percentage_amended_by_admin'/)
    assert.match(code, /'billing_percentage_set'/)
  })
})

// ══ 5. The linked Order stays consistent ═════════════════════════════════════

describe('when an Order exists', () => {
  test('the Order carries the same declaration, in the same transaction', () => {
    assert.match(code, /update public\.orders\s*\n\s*set billing_percentage = v_next/)
  })

  test('NOTHING else about the Order is written', () => {
    const at = code.indexOf('update public.orders')
    const stmt = code.slice(at, code.indexOf(';', at))
    for (const forbidden of ['display_number', 'source_order_submission_id', 'total_value', 'status']) {
      assert.ok(!stmt.includes(forbidden),
        `the amendment writes ${forbidden} on the Order; it must not`)
    }
  })

  test('the Order trail records the amendment', () => {
    assert.match(code, /'order_billing_percentage_amended'/)
  })
})

// ══ 6. Document supersession ═════════════════════════════════════════════════

describe('supersede_order_documents', () => {
  test('marks ready versions stale WITHOUT deleting or rewriting anything', () => {
    const fn = code.slice(code.indexOf('function public.supersede_order_documents'))
    const body = fn.slice(0, fn.indexOf('$$;') + 3)
    assert.match(body, /set superseded_at     = now\(\)/)
    assert.ok(!/delete\s+from/i.test(body), 'history must survive')
    assert.ok(!body.includes('excel_path ='), 'a generated file must not be rewritten')
    assert.ok(!body.includes('pdf_path ='))
    assert.ok(!body.includes("status = 'failed'"), 'a ready version stays ready')
  })

  test('is idempotent — the FIRST invalidation is the true one', () => {
    const fn = code.slice(code.indexOf('function public.supersede_order_documents'))
    const body = fn.slice(0, fn.indexOf('$$;') + 3)
    assert.match(body, /and superseded_at is null/)
  })

  test('the reason comes from a fixed set, never from a user', () => {
    const fn = code.slice(code.indexOf('function public.supersede_order_documents'))
    const body = fn.slice(0, fn.indexOf('$$;') + 3)
    assert.match(body, /not in \('billing_percentage_changed', 'pi_data_amended'\)/)
    assert.match(body, /p_reason := 'pi_data_amended'/)
  })

  test('no client role may execute it', () => {
    assert.match(code, /revoke execute on function public\.supersede_order_documents\(uuid, text\) from public, anon, authenticated/)
    assert.match(code, /supersede_order_documents must not be executable by a client role/)
  })

  test('only a READY version can be superseded', () => {
    assert.match(code, /check \(superseded_at is null or status = 'ready'\)/)
  })
})

describe('the two new register columns', () => {
  test('are readable by clients, so the card can say "regenerate"', () => {
    assert.match(code, /grant select \(superseded_at, superseded_reason\) on public\.order_document_versions to authenticated/)
  })

  test('are writable by no client — only the function sets them', () => {
    assert.ok(!/grant (insert|update)[^;]*superseded_at/.test(code))
  })

  test('claim_token is STILL unreadable after the new grant', () => {
    // Adding a column grant is exactly the kind of edit that could sweep the
    // lease in beside it.
    assert.match(code, /claim_token has become readable by a client role/)
  })
})

// ══ 7. Migration hygiene ═════════════════════════════════════════════════════

describe('the migration itself', () => {
  test('is forward-only, after 20260926000000', () => {
    assert.ok(Number(MIGRATION.split('/').pop()!.split('_')[0]) > 20260926000000)
  })

  test('every function it defines has a fixed search path, checked at apply time', () => {
    assert.match(code, /has no fixed search_path/)
  })

  test('does not modify any already-applied migration', () => {
    // Nothing here may drop or alter an object an earlier migration owns,
    // beyond the two additive columns and the two re-emitted functions this
    // file declares in its header.
    assert.ok(!/drop (table|column|policy|constraint)/i.test(code))
  })
})
