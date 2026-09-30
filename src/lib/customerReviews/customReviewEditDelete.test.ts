/**
 * Employee edit / delete of a custom review (20270223000000) — what the pure
 * rules, the migration, the route and the screens SAY, for the guarantees a
 * browser cannot get around:
 *
 *   ownership enforced in the route AND the database, no client write path;
 *   an edit keeps the row, the submission date and the month;
 *   an edited APPROVED review holds its credit and is never paid twice;
 *   a delete is soft, reverses a paid credit once and is idempotent;
 *   deleted rows leave every list and count but stay for verifiers.
 *
 * The same rules are EXECUTED against PostgreSQL by
 * supabase/tests/custom_review_edit_delete_assertions.sql (and two-session races
 * by run_custom_review_edit_delete_race.sh).
 *
 * Run:
 *   npx tsx --test src/lib/customerReviews/customReviewEditDelete.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  APPROVED_EDIT_NOTICE,
  CUSTOM_SUBMISSION_COLUMNS,
  CUSTOM_SUBMISSION_EVENT_LABELS,
  CUSTOM_SUBMISSION_EVENT_TYPES,
  canDeleteSubmission,
  canEditSubmission,
  customSubmissionFailureStatus,
  deleteConfirmationText,
  editSendsBackForApproval,
} from './customSubmissions'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n')
const SQL = read('supabase/migrations/20270223000000_customer_review_custom_edit_delete.sql')
const code = SQL.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')
const ROUTE = read('src/app/api/customer-reviews/custom-submissions/route.ts')
const WORKSPACE = read('src/components/customerReviews/CustomReviewSubmissions.tsx')
const QUEUE = read('src/app/customer-reviews/CustomSubmissionsScreen.tsx')
const BADGE = read('src/hooks/queries/useCustomReviewPendingCount.ts')

function fn(name: string): string {
  const start = code.indexOf(`create or replace function public.${name}(`)
  assert.ok(start !== -1, `${name} is not defined`)
  const body = code.indexOf('$$', start)
  const end = code.indexOf('$$;', body + 2)
  return code.slice(start, end)
}

const ME = 'me'
const row = (over: Record<string, unknown> = {}) => ({
  status: 'pending_verification' as const, submitted_by: ME, deleted_at: null,
  credits_awarded: null, submission_ref: 'CR-000042', ...over,
})

describe('who may edit or delete, by the pure rules the buttons use', () => {
  test('the owner edits a pending or an approved review, never a rejected one', () => {
    assert.equal(canEditSubmission(row(), ME), true)
    assert.equal(canEditSubmission(row({ status: 'approved' }), ME), true)
    assert.equal(canEditSubmission(row({ status: 'rejected' }), ME), false, 'a rejected review goes through Edit & Reapply')
  })
  test('nobody else, and nobody with no viewer, edits or deletes', () => {
    assert.equal(canEditSubmission(row(), 'someone-else'), false)
    assert.equal(canDeleteSubmission(row(), 'someone-else'), false)
    assert.equal(canEditSubmission(row(), null), false)
    assert.equal(canDeleteSubmission(row(), null), false)
  })
  test('a deleted review can be neither edited nor deleted again', () => {
    assert.equal(canEditSubmission(row({ deleted_at: '2026-09-30T00:00:00Z' }), ME), false)
    assert.equal(canDeleteSubmission(row({ deleted_at: '2026-09-30T00:00:00Z' }), ME), false)
  })
  test('the owner deletes a review in any status', () => {
    for (const status of ['pending_verification', 'approved', 'rejected'] as const) {
      assert.equal(canDeleteSubmission(row({ status }), ME), true, status)
    }
  })
  test('only an approved review is sent back for approval by an edit', () => {
    assert.equal(editSendsBackForApproval({ status: 'approved' }), true)
    assert.equal(editSendsBackForApproval({ status: 'pending_verification' }), false)
  })
})

describe('what the employee is told', () => {
  test('a paid review says the credit is taken back; an unpaid one does not', () => {
    assert.match(deleteConfirmationText(row({ status: 'approved', credits_awarded: 1.5 })), /1\.5.*taken back/)
    assert.doesNotMatch(deleteConfirmationText(row()), /taken back/)
    assert.doesNotMatch(deleteConfirmationText(row({ status: 'rejected', credits_awarded: null })), /taken back/)
  })
  test('the approved-edit notice states the status, the hold, the no-double-pay and the type lock', () => {
    assert.match(APPROVED_EDIT_NOTICE, /Pending Approval/)
    assert.match(APPROVED_EDIT_NOTICE, /stays in your BOE Credits balance/)
    assert.match(APPROVED_EDIT_NOTICE, /does not count in the leaderboard or eligible totals/)
    assert.match(APPROVED_EDIT_NOTICE, /pays nothing more/)
    assert.match(APPROVED_EDIT_NOTICE, /type cannot change/)
    // one unambiguous story: a balance, not a promise of ranking
    assert.doesNotMatch(APPROVED_EDIT_NOTICE, /credits are held|held for/i)
  })
  test('the new refusals map to a 409, and the new history events are labelled', () => {
    assert.equal(customSubmissionFailureStatus('CUSTOMER_REVIEW_CUSTOM_STALE: x'), 409)
    assert.equal(customSubmissionFailureStatus('CUSTOMER_REVIEW_CUSTOM_NOT_EDITABLE: x'), 409)
    for (const t of CUSTOM_SUBMISSION_EVENT_TYPES) assert.ok(CUSTOM_SUBMISSION_EVENT_LABELS[t], t)
    assert.ok(CUSTOM_SUBMISSION_EVENT_TYPES.includes('edited') && CUSTOM_SUBMISSION_EVENT_TYPES.includes('deleted'))
  })
  test('the screens read every new column', () => {
    for (const c of ['edit_count', 'last_edited_at', 'reward_held', 'deleted_at', 'deleted_by', 'reward_reversal_transaction_id']) {
      assert.ok(CUSTOM_SUBMISSION_COLUMNS.includes(c), c)
    }
  })
})

describe('the database is the boundary: no client write path', () => {
  const EDIT_SIG = 'public.edit_customer_review_custom_submission(uuid, uuid, text, date, text, integer, text, text, text, integer, text)'
  const DELETE_SIG = 'public.delete_customer_review_custom_submission(uuid, uuid)'

  test('edit and delete are service-role only', () => {
    assert.ok(code.includes(`revoke execute on function ${EDIT_SIG}\n  from public, anon, authenticated;`))
    assert.ok(code.includes(`grant  execute on function ${EDIT_SIG}\n  to service_role;`))
    assert.ok(code.includes(`revoke execute on function ${DELETE_SIG} from public, anon, authenticated;`))
    assert.ok(code.includes(`grant  execute on function ${DELETE_SIG} to service_role;`))
  })
  test('the reversal helper can be called by no client role and not the service role either', () => {
    assert.ok(code.includes('revoke execute on function public.reverse_customer_review_custom_reward(uuid, uuid, text) from public, anon, authenticated, service_role;'))
  })
  test('the actor is compared with the owner, and an administrator is no exception', () => {
    for (const name of ['edit_customer_review_custom_submission', 'delete_customer_review_custom_submission']) {
      const body = fn(name)
      assert.match(body, /s\.submitted_by <> p_actor_id/, name)
      assert.match(body, /CUSTOMER_REVIEW_CUSTOM_NOT_OWNER/, name)
      assert.doesNotMatch(body, /role\s*=\s*'admin'|can_manage_boe_credits/, `${name} reads no role`)
      assert.match(body, /resolve_permission\(p_actor_id, 'customer_review_requests', 'use'\)/, name)
    }
  })
  test('the table still has no client write privilege and exactly one policy', () => {
    assert.match(code, /has_table_privilege\('authenticated', 'public\.customer_review_custom_submissions', 'UPDATE'\)/)
    assert.match(code, /expected exactly one policy on the submissions table/)
    assert.equal((code.match(/create policy/g) ?? []).length, 1)
    assert.doesNotMatch(code, /grant\s+(insert|update|delete)[^;]*customer_review_custom_submissions/i)
  })
  test('a deleted row is hidden from its owner and kept for a verifier', () => {
    assert.match(code, /deleted_at is null or public\.resolve_permission\(auth\.uid\(\), 'customer_review_requests', 'verify'\)/)
  })
  test('a hard DELETE is still refused, and a deleted row is frozen', () => {
    const guard = fn('customer_review_custom_submissions_guard')
    assert.match(guard, /if tg_op = 'DELETE' then\s+raise exception 'CUSTOMER_REVIEW_CUSTOM_APPEND_ONLY/)
    assert.match(guard, /if old\.deleted_at is not null then\s+raise exception/)
  })
})

describe('a review is edited in place and its credit is never paid twice', () => {
  const edit = fn('edit_customer_review_custom_submission')

  test('the submission date, reference and month are not in the UPDATE', () => {
    const update = edit.slice(edit.indexOf('update public.customer_review_custom_submissions'))
    for (const column of ['submitted_at', 'submission_ref', 'submitted_by', 'credits_awarded', 'credit_transaction_id', 'approved_by']) {
      assert.doesNotMatch(update.slice(0, update.indexOf('returning')), new RegExp(`\\b${column}\\s*=`), `${column} is untouched by an edit`)
    }
  })
  test('an approved review goes back to pending with the credit held, and its type is locked', () => {
    assert.match(edit, /status\s+= 'pending_verification'/)
    assert.match(edit, /reward_held\s+= s\.status = 'approved' or s\.reward_held/)
    assert.match(edit, /The type of an approved review cannot change/)
  })
  test('the edit posts no ledger row and calls no reward function', () => {
    assert.doesNotMatch(edit, /post_boe_credit|boe_credit_transactions|reverse_customer_review_custom_reward/)
  })
  test('re-approval of a held review posts nothing', () => {
    const approve = fn('approve_customer_review_custom_submission')
    const held = approve.slice(approve.indexOf('if s.reward_held then'), approve.indexOf('if p_credits is null'))
    assert.match(held, /reward_held = false/)
    assert.doesNotMatch(held, /post_boe_credit_custom_review_reward/)
    assert.ok(approve.indexOf('if s.reward_held then') < approve.indexOf('post_boe_credit_custom_review_reward'))
  })
  test('rejecting a held review reverses the credit; delete reverses it too, both through one helper', () => {
    assert.match(fn('reject_customer_review_custom_submission'), /if s\.reward_held then\s+v_reversal := public\.reverse_customer_review_custom_reward/)
    assert.match(fn('delete_customer_review_custom_submission'), /reverse_customer_review_custom_reward\(s\.id, p_actor_id/)
    const helper = fn('reverse_customer_review_custom_reward')
    assert.match(helper, /transaction_type = 'reversal' and source_type = 'boe_credit_transaction' and source_id = s\.credit_transaction_id/)
    assert.match(helper, /return v_existing/, 'a repeat returns the existing reversal')
    assert.match(helper, /m\.status = 'lapsed'/, 'a lapsed month is not reversed a second time')
  })
  test('a repeated request is safe: stale counter, identical content and already-deleted answers', () => {
    assert.match(edit, /if v_same then\s+return jsonb_build_object\('submission', to_jsonb\(s\), 'unchanged', true/)
    assert.match(edit, /s\.edit_count <> p_expected_edit_count/)
    assert.match(edit, /CUSTOMER_REVIEW_CUSTOM_STALE/)
    assert.match(fn('delete_customer_review_custom_submission'), /if s\.deleted_at is not null then\s+return jsonb_build_object\('submission', to_jsonb\(s\), 'already_deleted', true/)
  })
  test('the locks are taken in one order: month, then the row, then credits', () => {
    for (const name of ['edit_customer_review_custom_submission', 'delete_customer_review_custom_submission']) {
      const body = fn(name)
      assert.ok(body.indexOf("hashtext('customer_review_custom_month')") < body.indexOf('for update'), name)
    }
    const helper = fn('reverse_customer_review_custom_reward')
    assert.match(helper, /pg_advisory_xact_lock\(hashtext\('boe_credits'\)/)
  })
  test('a closed month cannot be edited; it can still be deleted', () => {
    assert.match(edit, /CUSTOMER_REVIEW_CUSTOM_MONTH_CLOSED/)
    assert.doesNotMatch(fn('delete_customer_review_custom_submission'), /MONTH_CLOSED/)
  })
  test('a deleted review frees its slot and no longer blocks the same proof', () => {
    assert.match(fn('customer_review_custom_month_usage'), /s\.deleted_at is null/)
    assert.match(code, /where status <> 'rejected' and deleted_at is null/)
  })
  test('the history records edits and deletions', () => {
    const trail = fn('customer_review_custom_submissions_trail')
    assert.match(trail, /'deleted'/)
    assert.match(trail, /'edited'/)
    assert.match(code, /event_type in \('submitted', 'rejected', 'reapplied', 'approved', 'edited', 'deleted'\)/)
    assert.match(code, /after insert or update of status, deleted_at, edit_count/)
  })
})

describe('the route enforces ownership before the database does', () => {
  test('PUT and DELETE authenticate first and take the actor from the session', () => {
    for (const verb of ['PUT', 'DELETE']) {
      const start = ROUTE.indexOf(`export async function ${verb}(`)
      assert.ok(start !== -1, verb)
      const body = ROUTE.slice(start, ROUTE.indexOf('\nexport async function', start + 10) === -1 ? undefined : ROUTE.indexOf('\nexport async function', start + 10))
      assert.match(body, /const auth = await authorize\(caller\)/, verb)
      assert.match(body, /const actorId = auth\.userId/, verb)
      assert.match(body, /p_actor_id:\s+actorId/, verb)
      assert.match(body, /row\.submitted_by !== actorId/, `${verb} compares the owner`)
      assert.doesNotMatch(body, /form\.get\('(actor|userId|submittedBy)'\)/, `${verb} reads no actor from the form`)
    }
  })
  test('the route never answers with another employee\'s review: not-yours reads as not-found', () => {
    assert.match(ROUTE, /if \(!row \|\| row\.submitted_by !== actorId\) return fail\(404, MESSAGES\.not_found\)/)
  })
  test('a replaced screenshot is removed again when nothing was applied', () => {
    const put = ROUTE.slice(ROUTE.indexOf('export async function PUT('))
    assert.match(put, /if \(newPath\) await service\.storage\.from\(CUSTOM_PROOF_BUCKET\)\.remove\(\[newPath\]\)/)
    assert.match(put, /if \(result\.unchanged && newPath\)/)
  })
})

describe('the screens', () => {
  test('My Reviews offers Edit and Delete on the employee\'s own rows and asks before deleting', () => {
    assert.match(WORKSPACE, /canEditSubmission\(row, profileId\)/)
    assert.match(WORKSPACE, /canDeleteSubmission\(row, profileId\)/)
    assert.match(WORKSPACE, /DeleteConfirmSheet/)
    assert.match(WORKSPACE, /method: 'DELETE'/)
    assert.match(WORKSPACE, /method: 'PUT'/)
    assert.match(WORKSPACE, /expectedEditCount/)
  })
  test('a double click sends one request: a ref guards edit and delete', () => {
    assert.ok((WORKSPACE.match(/if \(acting\.current\) return|if \(submitting\.current\) return/g) ?? []).length >= 2)
  })
  test('the employee\'s lists and the verifier\'s queue leave deleted rows out', () => {
    assert.ok((WORKSPACE.match(/\.is\('deleted_at', null\)/g) ?? []).length >= 2)
    assert.match(QUEUE, /\.is\('deleted_at', null\)/)
    assert.match(QUEUE, /\.not\('deleted_at', 'is', null\)/, 'the Deleted tab reads them')
    assert.match(BADGE, /\.is\('deleted_at', null\)/)
  })
  test('a verifier can re-approve an edited review without an amount', () => {
    assert.match(QUEUE, /Approve again/)
    assert.match(QUEUE, /Edited after approval/)
  })
})
