/**
 * An administrator rejects an approved custom review, or deletes a review (20270304000000) — what
 * the migration, the list and the dialog SAY, for the guarantees a browser cannot get around:
 *
 *   the database, not the button, decides who may act (an active administrator);
 *   an approval is taken back through one door, and the guard names it;
 *   a reason is required; the credit is reversed once; the ORIGINAL month is recounted;
 *   a delete is soft and idempotent; nothing is hard-deleted and no history is rewritten;
 *   the list shows Reviewer and Submitted by as two fields, "Not recorded" where nothing was recorded;
 *   a failed request is never reported as done.
 *
 * The same rules are EXECUTED against PostgreSQL by supabase/tests/custom_review_admin_actions_assertions.sql
 * (and two-session races by run_custom_review_edit_delete_race.sh, R6–R8).
 *
 * Run:
 *   npx tsx --test src/lib/customerReviews/customReviewAdminActions.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n')
const SQL = read('supabase/migrations/20270304000000_customer_review_admin_reject_and_delete.sql')
const code = SQL.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')
const SCREEN = read('src/app/customer-reviews/CustomSubmissionsScreen.tsx')
const LIST = read('src/components/customerReviews/CustomSubmissionList.tsx')
const ACTION = read('src/components/customerReviews/AdminSubmissionAction.tsx')
const PIECES = read('src/components/customerReviews/CustomSubmissionPieces.tsx')

/** The body of one function in the migration. */
function fn(name: string): string {
  const start = code.indexOf(`create or replace function public.${name}(`)
  assert.ok(start >= 0, `${name} is not created`)
  const end = code.indexOf('\n$$;', start)
  return code.slice(start, end)
}

describe('the migration', () => {
  test('both functions are SECURITY DEFINER, pin the search path, and are callable by signed-in users only', () => {
    for (const name of ['admin_reject_customer_review_custom_submission', 'admin_delete_customer_review_custom_submission']) {
      const body = fn(name)
      assert.match(body, /security definer/)
      assert.match(body, /set search_path = public, pg_temp/)
    }
    assert.match(code, /revoke execute on function public\.admin_reject_customer_review_custom_submission\(uuid, text\) from public, anon;/)
    assert.match(code, /grant\s+execute on function public\.admin_reject_customer_review_custom_submission\(uuid, text\) to authenticated;/)
    assert.match(code, /revoke execute on function public\.admin_delete_customer_review_custom_submission\(uuid\) from public, anon;/)
    assert.match(code, /grant\s+execute on function public\.admin_delete_customer_review_custom_submission\(uuid\) to authenticated;/)
    assert.ok(!/grant[^;]*to (anon|public)/.test(code), 'nothing is granted to anon or public')
  })

  test('the administrator is checked in the database, from auth.uid(), before anything is read or changed', () => {
    for (const name of ['admin_reject_customer_review_custom_submission', 'admin_delete_customer_review_custom_submission']) {
      const body = fn(name)
      assert.match(body, /v_uid\s+uuid := auth\.uid\(\)/)
      assert.ok(body.indexOf('customer_review_custom_is_admin(v_uid)') > 0)
      assert.ok(body.indexOf('customer_review_custom_is_admin(v_uid)') < body.indexOf('for update'), 'the check comes before the row is locked')
      assert.ok(body.indexOf('customer_review_custom_is_admin(v_uid)') < body.indexOf('reverse_customer_review_custom_reward'))
    }
    const admin = fn('customer_review_custom_is_admin')
    assert.match(admin, /u\.role::text = 'admin'/)
    assert.match(admin, /u\.is_active = true/)
    assert.match(admin, /coalesce\(u\.is_deleted, false\) = false/)
    assert.match(code, /revoke execute on function public\.customer_review_custom_is_admin\(uuid\) from public, anon, authenticated, service_role;/)
  })

  test('rejecting needs a reason (≤ 300), refuses the administrator\'s own review, and handles a repeat', () => {
    const body = fn('admin_reject_customer_review_custom_submission')
    assert.match(body, /length\(v_reason\) > 300/)
    assert.match(body, /v_reason is null/)
    assert.match(body, /s\.submitted_by = v_uid/)
    assert.match(body, /CUSTOMER_REVIEW_CUSTOM_SELF/)
    assert.match(body, /s\.status = 'rejected'[\s\S]{0,200}already_decided/)
    assert.match(body, /s\.status <> 'approved'[\s\S]{0,300}CUSTOMER_REVIEW_CUSTOM_NOT_APPROVED/)
    assert.match(body, /for update/)
  })

  test('the credit goes through the existing ledger helper and the ORIGINAL month is recounted', () => {
    for (const name of ['admin_reject_customer_review_custom_submission', 'admin_delete_customer_review_custom_submission']) {
      const body = fn(name)
      assert.match(body, /public\.reverse_customer_review_custom_reward\(s\.id, v_uid,/)
      assert.match(body, /v_credit_id\s+:= s\.credit_transaction_id/)
      assert.match(body, /s\.reward_reversal_transaction_id is null/, 'a repeat posts nothing')
      // The month comes from the reward's own review month — read BEFORE the row stops pointing at it.
      assert.match(body, /boe_credit_review_rewards r[\s\S]{0,200}boe_credit_review_months m[\s\S]{0,200}r\.transaction_id = v_credit_id/)
      assert.match(body, /refresh_boe_credit_review_month\(v_employee, v_month\)/)
      assert.ok(!/now\(\)\s+at time zone[\s\S]{0,60}review_month/.test(body), 'the month of the action is never used')
    }
    assert.ok(!/insert into public\.boe_credit_transactions/.test(code), 'no ledger row type or payroll adjustment is invented')
  })

  test('rejection keeps the row, the proof and the history; delete is soft and idempotent', () => {
    const reject = fn('admin_reject_customer_review_custom_submission')
    assert.ok(!/delete from/.test(code), 'nothing is hard-deleted')
    assert.ok(!/proof_storage_path/.test(reject.replace(/--.*$/gm, '')), 'the screenshot columns are not touched')
    const del = fn('admin_delete_customer_review_custom_submission')
    assert.match(del, /set deleted_at = now\(\),\s+deleted_by = v_uid/)
    assert.match(del, /s\.deleted_at is not null then\s+return jsonb_build_object\([^;]*already_deleted/)
  })

  test('the guard opens approved → rejected only for the function\'s own transaction, and re-checks the administrator', () => {
    const guard = fn('customer_review_custom_submissions_guard')
    assert.match(guard, /coalesce\(current_setting\('boe\.custom_review_admin_reject', true\), ''\) = old\.id::text/, 'an unset marker is NULL and must not pass')
    assert.match(guard, /public\.customer_review_custom_is_admin\(new\.rejected_by\)/)
    assert.match(guard, /fl\.decision = 'duplicate' and fl\.decided_at = now\(\)/, 'the confirmed-duplicate door is unchanged')
    const reject = fn('admin_reject_customer_review_custom_submission')
    assert.match(reject, /set_config\('boe\.custom_review_admin_reject', s\.id::text, true\)/, 'transaction-local')
    assert.match(reject, /set_config\('boe\.custom_review_admin_reject', '', true\)/, 'cleared again')
  })

  test('the history names the previous status, the administrator and the approval taken back', () => {
    const trail = fn('customer_review_custom_submissions_trail')
    for (const key of ['previous_status', 'new_status', 'reversed_approval', 'previous_approved_by', 'previous_approved_at', 'previous_credits_awarded', 'by_owner']) {
      assert.ok(trail.includes(`'${key}'`), key)
    }
    assert.match(trail, /values \(new\.id, 'rejected', new\.rejected_by, new\.rejection_reason/)
    assert.ok(!/event_type[^;]*update|delete from public\.customer_review_custom_submission_events/.test(code), 'history is only appended to')
  })

  test('no table, column or policy is changed: clients still hold no write on the submissions table', () => {
    assert.ok(!/alter table|create table|drop table|create policy|drop policy/.test(code))
    assert.match(code, /has_table_privilege\('authenticated', 'public\.customer_review_custom_submissions', 'UPDATE'\)/)
  })
})

describe('the list', () => {
  test('it filters by status, review month and employee — server-side, on the existing screen', () => {
    assert.match(SCREEN, /SUBMISSION_STATUS_FILTERS\.map/)
    assert.match(SCREEN, /aria-label="Filter by review month"/)
    assert.match(SCREEN, /aria-label="Filter by employee"/)
    assert.match(SCREEN, /query\.eq\('status', f\.status\)/)
    assert.match(SCREEN, /query\.eq\('submitted_by', f\.employeeId\)/)
    assert.match(SCREEN, /\.gte\('submitted_at', range\.from\)\.lt\('submitted_at', range\.to\)/)
    assert.match(SCREEN, /query\.is\('deleted_at', null\)/, 'deleted reviews are in no normal list')
    assert.match(SCREEN, /export function CustomSubmissionsScreen/, 'no second screen was created')
  })

  test('Reviewer and Submitted by are separate columns; missing data reads "Not recorded"', () => {
    assert.match(LIST, /<th scope="col">Reviewer<\/th>/)
    assert.match(LIST, /<th scope="col">Submitted by<\/th>/)
    assert.match(LIST, /<Person value=\{row\.reviewer_name\} \/>/, 'the reviewer is the customer\'s name, not the employee')
    assert.match(LIST, /names\.get\(row\.submitted_by\)/)
    assert.match(LIST, /recordedOrNot\(row\.reviewer_name\)/)
    assert.ok(!/reviewer_name \?\? names|names\.get\([^)]*\) \?\? row\.reviewer_name/.test(LIST), 'one is never used as a fallback for the other')
    for (const col of ['Screenshot', 'Status', 'Review month', 'Submitted']) assert.ok(LIST.includes(`>${col}</th>`), col)
    assert.match(PIECES, /label: 'Submitted By'/)
    assert.match(PIECES, /label: 'Reviewer Name', value: recordedOrNot\(row\.reviewer_name\)/)
  })

  test('the thumbnail opens a full-size preview in place, and says when there is no image', () => {
    assert.match(LIST, /Preview the screenshot of/)
    assert.match(LIST, /Image not available/)
    assert.match(LIST, /onError=\{\(\) => setBroken\(true\)\}/)
    assert.match(SCREEN, /new Map<string, string \| null>\(paths\.map\(p => \[p, null\]\)\)/, 'a file that cannot be signed is "not available", never "Loading…" forever')
    assert.match(SCREEN, /createSignedUrls\(paths, THUMB_TTL_SECONDS\)/)
    assert.match(SCREEN, /<CustomSubmissionProof[\s\S]{0,200}path=\{previewing\.proof_storage_path\}/, 'the preview re-requests the file itself')
    assert.ok(!/router\.push|window\.open/.test(SCREEN), 'the preview does not leave the list')
  })

  test('desktop is a table and phone is cards, from the same rows', () => {
    assert.match(LIST, /className=\{styles\.tableWrap\}/)
    assert.match(LIST, /className=\{styles\.cards\}/)
    const css = read('src/components/customerReviews/customSubmissionList.module.css')
    assert.match(css, /@media \(max-width: 960px\)[\s\S]{0,120}\.tableWrap \{ display: none; \}[\s\S]{0,60}\.cards \{ display: flex; \}/)
  })

  test('the administrator\'s buttons are drawn only for an administrator, and the screen never writes the table', () => {
    assert.match(LIST, /canAdminRejectApproved\(row, viewerId, isAdmin\)/)
    assert.match(LIST, /canAdminDelete\(row, isAdmin\)/)
    assert.match(SCREEN, /const isAdmin = profile\?\.role === 'admin'/)
    for (const src of [SCREEN, LIST, ACTION]) {
      assert.ok(!/\.from\('customer_review_custom_submissions'\)\s*\.(update|delete|insert)/.test(src), 'no direct write')
    }
  })
})

describe('the dialog', () => {
  test('it calls the two administrator functions and nothing else', () => {
    assert.match(ACTION, /supabase\.rpc\('admin_reject_customer_review_custom_submission', \{\s*p_submission_id: row\.id,\s*p_reason: reason\.trim\(\)/)
    assert.match(ACTION, /supabase\.rpc\('admin_delete_customer_review_custom_submission', \{\s*p_submission_id: row\.id/)
  })

  test('a reason is required before the request is made, and the button says what will happen', () => {
    assert.match(ACTION, /rejectionReasonIssue\(reason\)/)
    assert.match(ACTION, /disabled=\{busy \|\| \(reject && reason\.trim\(\) === ''\)\}/)
    assert.match(ACTION, /Confirm rejection/)
    assert.match(ACTION, /Confirm delete/)
    assert.match(ACTION, /adminRejectWarning\(row, employee\)/)
    assert.match(ACTION, /adminDeleteWarning\(row, employee\)/)
  })

  test('repeated clicks, a refusal and a failed request never report success', () => {
    assert.match(ACTION, /const acting = useRef\(false\)/)
    assert.match(ACTION, /if \(acting\.current\) return/)
    assert.match(ACTION, /finally \{\s+acting\.current = false/)
    // onDone is reached only after the error branch has returned.
    const okIdx = ACTION.indexOf('await onDone(')
    const errIdx = ACTION.indexOf('if (rpcError) {')
    assert.ok(errIdx > 0 && okIdx > errIdx)
    assert.match(ACTION.slice(errIdx, okIdx), /return\s+\}/)
    assert.match(ACTION, /result == null/, 'an empty answer is not a confirmation')
    assert.match(ACTION, /The request failed\. Check your connection/)
    assert.match(ACTION, /dismissOnBackdrop=\{!busy\}/)
  })

  test('after success the list, the filter menus and every count are refreshed at once', () => {
    assert.match(SCREEN, /invalidateQueries\(\{ queryKey: CUSTOM_REVIEW_PENDING_COUNT_KEY \}\)/)
    assert.match(SCREEN, /invalidateQueries\(\{ queryKey: \['customer-reviews'\] \}\)/)
    assert.match(SCREEN, /await Promise\.all\(\[load\(filters, limit\), loadFilterSource\(\)\]\)/)
    assert.match(SCREEN, /onDone=\{async message => \{[\s\S]{0,200}await refreshAfterChange\(\)/)
  })
})
