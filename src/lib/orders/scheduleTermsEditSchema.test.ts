/**
 * PI SCHEDULE AND TERMS EDITING — what migration 20260929000000 promises.
 *
 * Behavioural proof lives in
 * supabase/tests/order_submission_schedule_terms_assertions.sql. This guards the
 * properties a later edit could quietly drop.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATION = 'supabase/migrations/20260929000000_order_submission_schedule_terms_edit.sql'
const sql = readFileSync(join(process.cwd(), MIGRATION), 'utf8')
const code = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')
const fn = code.slice(code.indexOf('create or replace function public.update_order_submission_schedule_terms'))
const body = fn.slice(0, fn.indexOf('$$;') + 3)

describe('the five fields', () => {
  test('are exactly the schedule and terms columns, and no more', () => {
    const list = body.slice(body.indexOf('c_fields constant text[]'))
    const declared = list.slice(0, list.indexOf('];'))
    for (const f of ['order_confirmation_date', 'due_date', 'dispatch_commitment',
                     'payment_terms', 'billing_terms']) {
      assert.ok(declared.includes(`'${f}'`), `${f} is missing`)
    }
    assert.equal((declared.match(/'/g) ?? []).length / 2, 5)
  })

  test('billing_percentage is refused BY NAME, pointing at its own RPC', () => {
    // Not merely "unknown field": a caller aiming it here has made an
    // understandable mistake and deserves the right door.
    assert.match(body, /ORDER_SUBMISSION_WRONG_EDITOR/)
    assert.match(body, /set_order_submission_billing_percentage/)
  })

  test('and this function never assigns it', () => {
    const update = body.slice(body.indexOf('update public.order_submissions set'))
    const stmt = update.slice(0, update.indexOf('where id = p_submission_id'))
    for (const forbidden of ['billing_percentage', 'grand_total', 'total_before_gst',
                             'status', 'order_id', 'client_name']) {
      assert.ok(!new RegExp(`\\b${forbidden}\\s*=`).test(stmt), `it assigns ${forbidden}`)
    }
  })
})

describe('dates', () => {
  test('require the ISO SHAPE before the cast', () => {
    // PostgreSQL accepts 'yesterday', 'today', 'now', 'epoch', 'infinity'. A
    // cast-only check stored those silently as relative dates — the behavioural
    // assertions caught exactly that. A PI date is a fact, not an expression.
    assert.ok(body.includes("v_new !~ '^") && body.includes("{4}-") && body.includes("{2}$'"),
      'the ISO shape must be required before the cast')
    assert.ok(body.indexOf('!~') < body.indexOf('perform v_new::date'),
      'the shape check must come BEFORE the cast, or the cast accepts relative dates')
    assert.match(body, /ORDER_SUBMISSION_BAD_DATE/)
  })

  test('the reason is recorded where the next reader will look', () => {
    assert.match(sql, /'yesterday', 'today', 'tomorrow', 'now', 'epoch', 'infinity'/)
  })

  test('are re-spelled through the type, so an identical date is not a change', () => {
    assert.match(body, /v_new := \(v_new::date\)::text/)
  })
})

describe('supersession follows what is PRINTED', () => {
  test('the two dates supersede; the three text fields do not', () => {
    const printed = body.slice(body.indexOf('c_printed constant text[]'))
    const declared = printed.slice(0, printed.indexOf('];'))
    assert.ok(declared.includes("'order_confirmation_date'"))
    assert.ok(declared.includes("'due_date'"))
    for (const f of ['dispatch_commitment', 'payment_terms', 'billing_terms']) {
      assert.ok(!declared.includes(`'${f}'`),
        `${f} is not on the confirmed documents and must not supersede`)
    }
  })

  test('and that list was derived from the PDF, not guessed', () => {
    const pdf = readFileSync(join(process.cwd(), 'src/lib/orders/confirmedPdf.ts'), 'utf8')
    assert.ok(pdf.includes("label: 'Due date'"), 'the PDF prints the due date')
    assert.ok(pdf.includes("label: 'Confirm date'"), 'the PDF prints the confirm date')
    for (const absent of ['dispatch_commitment', 'payment_terms', 'billing_terms']) {
      assert.ok(!pdf.includes(absent), `the PDF now prints ${absent}; the list must grow`)
    }
  })
})

describe('authority, concurrency and no-ops', () => {
  test('accept either authority and refuse when neither holds', () => {
    assert.match(body, /if not \(v_is_admin or v_is_owner\) then/)
    assert.match(body, /ORDER_SUBMISSION_NOT_EDITABLE/)
  })

  test('require a reason for an admin edit after submission', () => {
    assert.match(body, /ORDER_SUBMISSION_REASON_REQUIRED/)
  })

  test('lock the row before judging anything', () => {
    const lockAt = body.indexOf('for update')
    assert.ok(lockAt > 0 && lockAt < body.indexOf('can_admin_edit_order_submission(p_submission_id)'))
    assert.ok(lockAt < body.indexOf('p_expected_version is not null'))
  })

  test('use the row_version counter, never a timestamp', () => {
    assert.match(body, /v_sub\.row_version is distinct from p_expected_version/)
    assert.ok(!/updated_at is distinct from p_expected/.test(body))
  })

  test('write nothing at all when nothing changed', () => {
    const noop = body.slice(body.indexOf('if v_changed = 0 then'))
    const block = noop.slice(0, noop.indexOf('end if;'))
    assert.ok(!block.includes('update public.order_submissions'))
    assert.ok(!block.includes('log_order_submission_activity'))
    assert.ok(!block.includes('supersede_order_documents'))
  })
})

describe('the linked Order', () => {
  test('takes both dates and nothing else', () => {
    const at = body.indexOf('update public.orders')
    const stmt = body.slice(at, body.indexOf('where id = v_sub.order_id', at))
    assert.ok(stmt.includes('confirm_date'))
    assert.ok(stmt.includes('due_date'))
    for (const forbidden of ['display_number', 'source_order_submission_id',
                             'total_value', 'status', 'client_name', 'billing_percentage']) {
      assert.ok(!stmt.includes(forbidden), `the amendment writes ${forbidden}`)
    }
  })

  test('an UNSENT date is left alone', () => {
    // `case when v_changes ? key` rather than an unconditional assignment: an
    // absent key must not blank the Order's other date.
    assert.match(body, /confirm_date = case when v_changes \? 'order_confirmation_date'/)
    assert.match(body, /due_date = case when v_changes \? 'due_date'/)
  })

  test('and the Order trail records it', () => {
    assert.match(body, /'order_schedule_terms_amended'/)
  })
})

describe('the migration itself', () => {
  test('is forward-only and dependency-checked', () => {
    assert.ok(Number(MIGRATION.split('/').pop()!.split('_')[0]) > 20260928000000)
    assert.match(code, /DEPENDENCY MISSING: 20260928000000/)
  })

  test('drops nothing an earlier migration owns', () => {
    assert.ok(!/drop (table|column|policy|constraint|function)/i.test(code))
  })

  test('records what it deliberately does NOT validate', () => {
    // A due date before the confirm date is not refused, because no such
    // constraint exists today and inventing one would refuse a correction a
    // workbook legitimately carried.
    assert.match(sql, /WHAT IS DELIBERATELY NOT VALIDATED/)
  })
})
