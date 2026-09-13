/**
 * Custom Review Submissions (20261205000000).
 *
 * An employee submits proof that a review THEY arranged was published; a
 * verifier approves it (BOE Credits, exactly once) or rejects it with a reason.
 *
 * The database is the boundary, so most of this file reads the migration: the
 * rules below are the ones a browser cannot get around. The behaviour itself is
 * exercised against a real PostgreSQL by
 * supabase/tests/custom_review_submissions_assertions.sql.
 *
 * Run:
 *   npx tsx --test src/lib/customerReviews/customSubmissions.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CUSTOM_PROOF_BUCKET,
  CUSTOM_SUBMISSION_STATUS_META,
  approvalCreditsIssue,
  customSubmissionErrorMessage,
  formatSubmissionDay,
  isCalendarDate,
  parseCustomSubmissionInput,
  rejectionReasonIssue,
} from './customSubmissions'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const SQL = read('supabase/migrations/20261205000000_customer_review_custom_submissions.sql')
const code = SQL.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')

function fn(name: string): string {
  const start = code.indexOf(`create or replace function public.${name}(`)
  assert.ok(start !== -1, `${name} is not defined`)
  const body = code.indexOf('$$', start)
  const end = code.indexOf('$$;', body + 2)
  return code.slice(start, end)
}

const TODAY = '2026-09-12'
const VALID = { reviewType: 'image', publishedOn: '2026-09-10', remark: 'Posted on Google', hasProof: true }

// ── 1–3. The employee's submission ──────────────────────────────────────────

describe('1. an employee creates their own pending submission', () => {
  test('a complete submission parses, remark trimmed', () => {
    const r = parseCustomSubmissionInput({ ...VALID, remark: '  Posted on Google  ' }, TODAY)
    assert.ok(r.ok)
    assert.deepEqual(r.ok && r.value, { reviewType: 'image', publishedOn: '2026-09-10', remark: 'Posted on Google' })
  })

  test('the row is created Pending Verification, by the service-role registration only', () => {
    assert.match(code, /status\s+text\s+not null default 'pending_verification'/)
    assert.match(code, /revoke execute on function public\.create_customer_review_custom_submission\([^)]*\)\s*\n\s*from public, anon, authenticated/)
    assert.match(code, /grant  execute on function public\.create_customer_review_custom_submission\([^)]*\)\s*\n\s*to service_role/)
  })

  test('the submitter is the session user the route authenticated, re-verified as an active `use` holder', () => {
    const create = fn('create_customer_review_custom_submission')
    assert.ok(create.includes("public.resolve_permission(p_actor_id, 'customer_review_requests', 'use')"))
    assert.match(create, /values \(\s*\n\s*p_submission_id, p_actor_id,/)
    const route = read('src/app/api/customer-reviews/custom-submissions/route.ts')
    assert.ok(route.includes('p_actor_id:             user.id'))
    assert.ok(route.includes("p_action_key: 'use'"))
    // Nothing in the form names a person.
    assert.equal(/form\.get\('(submittedBy|submitted_by|employee|employeeId|actor)'\)/.test(route), false)
  })

  test('the proof is decoded and re-encoded, stored under a generated path, and removed if registration fails', () => {
    const route = read('src/app/api/customer-reviews/custom-submissions/route.ts')
    assert.ok(route.includes('processReviewImage(bytes, TEST_SCREENSHOT_MAX_BYTES)'))
    assert.ok(route.includes('const storagePath = `${submissionId}/proof/${randomUUID()}.${extension}`'))
    assert.ok(route.includes('.remove([storagePath])'))
    assert.ok(route.indexOf('.upload(storagePath') < route.indexOf("rpc('create_customer_review_custom_submission'"))
  })
})

describe('2. required fields are validated', () => {
  test('type, date and screenshot are each required; the remark is not', () => {
    const r = parseCustomSubmissionInput({ reviewType: null, publishedOn: '', remark: '', hasProof: false }, TODAY)
    assert.equal(r.ok, false)
    const fields = !r.ok ? r.issues.map(i => i.field).sort() : []
    assert.deepEqual(fields, ['proof', 'published_on', 'review_type'])
    const noRemark = parseCustomSubmissionInput({ ...VALID, remark: '' }, TODAY)
    assert.ok(noRemark.ok && noRemark.value.remark === null)
  })

  test('only the Review Workflow types are accepted', () => {
    assert.equal(parseCustomSubmissionInput({ ...VALID, reviewType: 'video' }, TODAY).ok, false)
    assert.ok(parseCustomSubmissionInput({ ...VALID, reviewType: 'text' }, TODAY).ok)
    assert.match(code, /review_type\s+text\s+not null check \(review_type in \('text', 'image'\)\)/)
  })

  test('a malformed or impossible date is refused', () => {
    assert.equal(isCalendarDate('2026-02-30'), false)
    assert.equal(isCalendarDate('12/09/2026'), false)
    assert.equal(parseCustomSubmissionInput({ ...VALID, publishedOn: '2026-02-30' }, TODAY).ok, false)
  })

  test('the remark is short, in the form and in the table', () => {
    assert.equal(parseCustomSubmissionInput({ ...VALID, remark: 'x'.repeat(301) }, TODAY).ok, false)
    assert.ok(parseCustomSubmissionInput({ ...VALID, remark: 'x'.repeat(300) }, TODAY).ok)
    assert.match(code, /remark\s+text\s+check \(remark is null or \(btrim\(remark\) <> '' and length\(remark\) <= 300\)\)/)
  })

  test('the database requires the proof to belong to this submission', () => {
    assert.match(code, /check \(split_part\(proof_storage_path, '\/', 1\) = id::text\)/)
    assert.ok(fn('create_customer_review_custom_submission').includes("split_part(p_proof_storage_path, '/', 1) <> p_submission_id::text"))
  })
})

describe('3. a future published date is rejected', () => {
  test('tomorrow is refused; today and earlier are accepted', () => {
    const tomorrow = parseCustomSubmissionInput({ ...VALID, publishedOn: '2026-09-13' }, TODAY)
    assert.equal(tomorrow.ok, false)
    assert.ok(!tomorrow.ok && tomorrow.issues[0].message.includes('future'))
    assert.ok(parseCustomSubmissionInput({ ...VALID, publishedOn: TODAY }, TODAY).ok)
  })

  test('the database refuses it against Asia/Kolkata today, and the table can never hold one after its submission', () => {
    const create = fn('create_customer_review_custom_submission')
    assert.ok(create.includes("v_today  date := (now() at time zone 'Asia/Kolkata')::date;"))
    assert.ok(create.includes('if p_published_on > v_today then'))
    assert.match(code, /check \(published_on <= \(submitted_at at time zone 'Asia\/Kolkata'\)::date\)/)
  })
})

// ── 4–9. The decision ───────────────────────────────────────────────────────

describe('4. an employee cannot approve their own submission', () => {
  test('both decisions refuse the submitter — administrators included — before anything else changes', () => {
    for (const name of ['approve_customer_review_custom_submission', 'reject_customer_review_custom_submission']) {
      const body = fn(name)
      const selfAt = body.indexOf('if s.submitted_by = v_uid then')
      assert.ok(selfAt !== -1, `${name} does not refuse the submitter`)
      assert.ok(selfAt < body.indexOf('update public.customer_review_custom_submissions'), name)
    }
    assert.match(code, /\(approved_by is null or approved_by <> submitted_by\)\s*\n\s*and \(rejected_by is null or rejected_by <> submitted_by\)/)
  })

  test('deciding needs `verify`, resolved from the permission engine for auth.uid()', () => {
    for (const name of ['approve_customer_review_custom_submission', 'reject_customer_review_custom_submission']) {
      const body = fn(name)
      assert.ok(body.includes('v_uid      uuid := auth.uid();') || body.includes('v_uid    uuid := auth.uid();'), name)
      assert.ok(body.includes("public.resolve_permission(v_uid, 'customer_review_requests', 'verify')"), name)
    }
  })

  test('no client role can write the table, and the only policy reads', () => {
    assert.match(code, /revoke insert, update, delete, truncate, references, trigger\s*\n\s*on public\.customer_review_custom_submissions from authenticated, anon;/)
    assert.equal((code.match(/create policy "customer_review_custom_submissions_/g) ?? []).length, 1)
    assert.match(code, /on public\.customer_review_custom_submissions\s*\n\s*for select/)
  })
})

describe('5. management can approve', () => {
  test('approval is a browser RPC for authenticated, never anon, and records who, when and how much', () => {
    assert.match(code, /revoke execute on function public\.approve_customer_review_custom_submission\(uuid, numeric\) from public, anon;/)
    assert.match(code, /grant  execute on function public\.approve_customer_review_custom_submission\(uuid, numeric\) to authenticated;/)
    const approve = fn('approve_customer_review_custom_submission')
    for (const needle of [
      "status                = 'approved'",
      'approved_by           = v_uid',
      'approved_at           = now()',
      'credits_awarded       = p_credits',
      "credit_transaction_id = (v_reward ->> 'transaction_id')::uuid",
    ]) assert.ok(approve.includes(needle), needle)
  })

  test('the amount defaults to the configured reward for the type; only a BOE Credits manager may change it', () => {
    const approve = fn('approve_customer_review_custom_submission')
    assert.ok(approve.includes("when 'image' then v_settings.image_review_reward_credits"))
    assert.ok(approve.includes('else v_settings.review_reward_credits'))
    assert.ok(approve.includes('if p_credits <> v_default and not public.can_manage_boe_credits() then'))
    assert.ok(approve.includes('if p_credits <> round(p_credits, 2) then'))
  })

  test('the verifier screen calls the RPC, and shows the amount it will post', () => {
    const screen = read('src/app/customer-reviews/CustomSubmissionsScreen.tsx')
    assert.ok(screen.includes("supabase.rpc('approve_customer_review_custom_submission'"))
    assert.ok(screen.includes("supabase.rpc('reject_customer_review_custom_submission'"))
    assert.equal(/fetch\('\/api\/customer-reviews\/(approve|reject)/.test(screen), false)
    assert.ok(screen.includes("router.replace('/customer-reviews')"), 'a non-verifier is sent away')
  })

  test('Custom Submissions is a verifier-only destination', () => {
    const layout = read('src/components/layout/CustomerReviewsLayout.tsx')
    const at = layout.indexOf("label: 'Custom Submissions'")
    assert.ok(at !== -1)
    assert.ok(layout.slice(at, at + 200).includes("path: '/customer-reviews/custom'"))
    assert.ok(layout.slice(at, at + 200).includes('verifierOnly: true'))
  })
})

describe('6. management can reject with a reason', () => {
  test('a reason is required and kept; nothing is deleted', () => {
    const reject = fn('reject_customer_review_custom_submission')
    assert.ok(reject.includes("raise exception 'CUSTOMER_REVIEW_CUSTOM_REASON: Give a short reason for rejecting'"))
    for (const needle of ["status           = 'rejected'", 'rejected_by      = v_uid', 'rejected_at      = now()', 'rejection_reason = v_reason']) {
      assert.ok(reject.includes(needle), needle)
    }
    assert.ok(fn('customer_review_custom_submissions_guard').includes("if tg_op = 'DELETE' then"))
    assert.equal(/delete from public\.customer_review_custom_submissions/.test(code), false)
  })

  test('the form refuses an empty or long reason', () => {
    assert.ok(rejectionReasonIssue(''))
    assert.ok(rejectionReasonIssue('   '))
    assert.ok(rejectionReasonIssue('x'.repeat(301)))
    assert.equal(rejectionReasonIssue('The screenshot does not show a published review'), null)
  })
})

describe('7. an approved review creates one credit transaction', () => {
  test('the approval posts through the custom reward function, which posts ONE standard review_reward', () => {
    const approve = fn('approve_customer_review_custom_submission')
    assert.equal((approve.match(/post_boe_credit_custom_review_reward\(/g) ?? []).length, 1)
    const reward = fn('post_boe_credit_custom_review_reward')
    assert.equal((reward.match(/public\.post_boe_credit_transaction\(/g) ?? []).length, 1)
    assert.match(reward, /'review_reward',\s*\n\s*p_credits,\s*\n\s*'customer_review_custom_submission',\s*\n\s*p_submission_id,/)
    assert.equal(/insert into public\.boe_credit_transactions/.test(code), false, 'the ledger is written only by the one write path')
  })

  test('it counts toward the monthly minimum exactly like a verified generated review', () => {
    const reward = fn('post_boe_credit_custom_review_reward')
    assert.ok(reward.includes('insert into public.boe_credit_review_rewards'))
    assert.ok(reward.includes('v_row := public.refresh_boe_credit_review_month(p_employee_id, v_month);'))
    assert.ok(reward.includes("v_month := date_trunc('month', (p_submitted_at at time zone 'Asia/Kolkata')::date)::date;"))
  })

  test('the reward function is service role only', () => {
    assert.match(code, /revoke execute on function public\.post_boe_credit_custom_review_reward\([^)]*\)\s*\n\s*from public, anon, authenticated;/)
  })

  test('the approval amount form mirrors the database: above 0, two decimals', () => {
    assert.equal(approvalCreditsIssue(1.5), null)
    assert.equal(approvalCreditsIssue('1.5'), null)
    for (const bad of [0, -1, 1.555, '', 'x', 100_001]) assert.ok(approvalCreditsIssue(bad), String(bad))
  })
})

describe('8. a repeated approval creates no duplicate credit', () => {
  test('the row is locked, and an already-approved submission is returned BEFORE any reward is posted', () => {
    const approve = fn('approve_customer_review_custom_submission')
    const lockAt = approve.indexOf('where id = p_submission_id for update;')
    const alreadyAt = approve.indexOf("if s.status = 'approved' then")
    const postAt = approve.indexOf('post_boe_credit_custom_review_reward(')
    assert.ok(lockAt !== -1 && alreadyAt !== -1 && postAt !== -1)
    assert.ok(lockAt < alreadyAt && alreadyAt < postAt)
    assert.ok(approve.includes("'already_decided', true"))
  })

  test('and the schema holds it even if a path forgot: one transaction per submission, one ledger row per source', () => {
    assert.match(code, /credit_transaction_id uuid\s+unique references public\.boe_credit_transactions\(id\)/)
    // The ledger's (employee, type, source_type, source_id) index is 20261101000000's.
    assert.ok(read('supabase/migrations/20261101000000_boe_credits_foundation.sql')
      .includes('on public.boe_credit_transactions (employee_id, transaction_type, source_type, source_id)'))
  })

  test('the screen stops a second click, and says so when the database found it already approved', () => {
    const screen = read('src/app/customer-reviews/CustomSubmissionsScreen.tsx')
    assert.ok(screen.includes('if (acting.current) return'))
    assert.ok(screen.includes('was already approved. Nothing more was awarded.'))
  })
})

describe('9. a rejected review creates no credits', () => {
  test('the rejection posts nothing, and the table refuses a rejected row carrying credits', () => {
    const reject = fn('reject_customer_review_custom_submission')
    assert.equal(/post_boe_credit/.test(reject), false)
    assert.match(code, /when 'rejected' then[\s\S]*?credits_awarded is null and credit_transaction_id is null\s*\n\s*end/)
  })

  test('an approved submission cannot be rejected, and a rejected one cannot be approved', () => {
    assert.ok(fn('reject_customer_review_custom_submission').includes("if s.status = 'approved' then"))
    assert.ok(fn('approve_customer_review_custom_submission').includes("if s.status = 'rejected' then"))
    assert.ok(fn('customer_review_custom_submissions_guard').includes("if old.status <> 'pending_verification' then"))
  })
})

// ── The proof and the screens ───────────────────────────────────────────────

describe('the proof screenshot', () => {
  test('lives in its own private bucket, readable only by who may read the submission', () => {
    assert.equal(CUSTOM_PROOF_BUCKET, 'customer-review-custom-proofs')
    assert.match(code, /'customer-review-custom-proofs',\s*\n\s*'customer-review-custom-proofs',\s*\n\s*false,/)
    assert.equal((code.match(/on storage\.objects/g) ?? []).length, 2, 'one drop and one SELECT policy, nothing else')
    assert.match(code, /on storage\.objects\s*\n\s*for select to authenticated/)
  })
})

describe('the employee screen', () => {
  test('My Reviews offers Submit Custom Review, separate from the assigned reviews', () => {
    const mine = read('src/app/customer-reviews/MyReviewsScreen.tsx')
    assert.ok(mine.includes('<CustomReviewSubmissions supabase={supabase} profileId={profile.id} canSubmit={caps.canUse} />'))
    const form = read('src/components/customerReviews/CustomReviewSubmissions.tsx')
    for (const label of ['Submit Custom Review', 'Review Type', 'Review Published On', 'Screenshot / Proof', 'Remark', 'Submit for Verification', 'View Proof']) {
      assert.ok(form.includes(label), label)
    }
    assert.ok(form.includes("fetch('/api/customer-reviews/custom-submissions', { method: 'POST', body })"))
    assert.ok(form.includes('URL.createObjectURL(next)'), 'the screenshot is previewed before submission')
  })

  test('status words and dates read as the brief asks', () => {
    assert.deepEqual(Object.values(CUSTOM_SUBMISSION_STATUS_META).map(m => m.label), ['Pending Verification', 'Approved', 'Rejected'])
    assert.equal(formatSubmissionDay('2026-09-05'), '5 Sep 2026')
    assert.equal(customSubmissionErrorMessage('CUSTOMER_REVIEW_CUSTOM_SELF: You cannot approve or reject your own submission', 'x'),
      'You cannot approve or reject your own submission')
  })
})
