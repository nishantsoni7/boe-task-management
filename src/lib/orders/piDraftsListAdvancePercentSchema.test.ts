/**
 * THE PI DRAFTS LIST'S BATCH ADVANCE PERCENTAGE (20270327000000), read as text.
 *
 * Holds the migration to its promises without a database:
 *   * it is read-only and changes no table, column or policy;
 *   * it counts exactly what pi_submission_payment_summary() counts for
 *     attached_percent (verified or awaiting verification, active allocations);
 *   * its base is Total before GST, with the same usability test, and the
 *     percentage is truncated, never rounded;
 *   * a PI the caller may not view returns no row (can_view_order_submission);
 *   * it needs a signed-in caller, bounds the batch, pins its search_path, and
 *     is executable by authenticated only.
 *
 * Run:
 *   npx tsx --test src/lib/orders/piDraftsListAdvancePercentSchema.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n')
const stripSql = (s: string) => s.split('\n').map(l => l.replace(/--.*$/, '')).join('\n')

const MIGRATION = read('supabase/migrations/20270327000000_pi_drafts_list_advance_percent.sql')
const SQL = stripSql(MIGRATION)
const SUMMARY = stripSql(read('supabase/migrations/20270227000000_order_submission_advance_on_total_before_gst.sql'))

describe('pi_submissions_advance_percent', () => {
  test('is read-only: it creates one function and writes nothing', () => {
    assert.equal((SQL.match(/create\s+(or\s+replace\s+)?function/gi) ?? []).length, 1)
    assert.ok(!/\b(insert|update|delete|alter|drop|truncate)\b/i.test(SQL.replace(/revoke[^;]*;|grant[^;]*;/gi, '')),
      'no DML or DDL beyond the function itself')
  })

  test('counts the same allocations as the single-PI summary', () => {
    for (const fragment of [
      "a.status = 'active'",
      'public.finance_payment_status_is_verified(f.status)',
      "f.status in ('pending_approval', 'needs_clarification')",
    ]) {
      assert.ok(SQL.includes(fragment), `batch function: ${fragment}`)
      assert.ok(SUMMARY.includes(fragment), `single-PI function: ${fragment}`)
    }
  })

  test('measures against Total before GST, usable only when positive and not above the grand total, truncated', () => {
    assert.ok(SQL.includes("s.total_before_gst <> 'NaN'::numeric"))
    assert.ok(SQL.includes('s.total_before_gst > 0'))
    assert.ok(SQL.includes('s.total_before_gst <= coalesce(s.grand_total, s.total_before_gst)'))
    assert.ok(SQL.includes('trunc(coalesce(p.attached, 0) * 100 / s.total_before_gst, 2)'))
    assert.ok(!/round\s*\(/i.test(SQL), 'never rounded: 39.999% must not read as 40%')
  })

  test('answers only for PIs the caller may view, and only when signed in', () => {
    assert.ok(SQL.includes('and public.can_view_order_submission(s.id)'))
    assert.ok(SQL.includes('auth.uid() is null'))
    assert.ok(SQL.includes('security definer'))
    assert.ok(/set search_path = public, pg_temp/.test(SQL))
  })

  test('bounds the batch', () => {
    assert.ok(SQL.includes('> 500'))
  })

  test('is executable by authenticated only', () => {
    assert.ok(SQL.includes('revoke execute on function public.pi_submissions_advance_percent(uuid[]) from public, anon;'))
    assert.ok(SQL.includes('grant  execute on function public.pi_submissions_advance_percent(uuid[]) to authenticated;'))
  })
})
