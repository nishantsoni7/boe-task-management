/**
 * The Custom Review phase (20261206000000) — what the migration, the routes and
 * the screens SAY, for the rules a browser cannot get around:
 *
 *   notifications to reviewers, never the actor, exactly once per change;
 *   the pending badge for verifiers only, moving with every decision;
 *   reapplication on the SAME row, owner only, rejected only;
 *   the monthly rules under a lock, before the insert;
 *   a closed month that earns nothing new — and no negative penalty anywhere;
 *   generated reviews paused for candidates, in the database and on every route.
 *
 * The same rules are EXECUTED against PostgreSQL by
 * supabase/tests/custom_review_phase_assertions.sql.
 *
 * Run:
 *   npx tsx --test src/lib/customerReviews/customReviewPhase.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  REVIEW_NOTIFICATION_TYPES,
  getNotificationCategoryFilter,
  resolveNotificationCategory,
} from '../notifications'
import { NOTIFICATION_CATEGORIES, notificationKeys } from '../notificationCache'
import { CANDIDATE_GENERATED_REVIEWS_ENABLED, candidateGeneratedReviewsHidden } from './generatedWorkflow'
import {
  CUSTOM_SUBMISSION_STATUS_META,
  canReapplySubmission,
  customSubmissionFailureStatus,
  parseCustomReapplicationInput,
} from './customSubmissions'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n')
const SQL = read('supabase/migrations/20261206000000_customer_review_custom_reapply_and_monthly_rules.sql')
const code = SQL.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')

function fn(name: string): string {
  const start = code.indexOf(`create or replace function public.${name}(`)
  assert.ok(start !== -1, `${name} is not defined`)
  const body = code.indexOf('$$', start)
  const end = code.indexOf('$$;', body + 2)
  return code.slice(start, end)
}

const ROUTE = read('src/app/api/customer-reviews/custom-submissions/route.ts')
const LAYOUT = read('src/components/layout/CustomerReviewsLayout.tsx')
const QUEUE = read('src/app/customer-reviews/CustomSubmissionsScreen.tsx')
const WORKSPACE = read('src/components/customerReviews/CustomReviewSubmissions.tsx')

// ── 1. Notifications ─────────────────────────────────────────────────────────

describe('a submission and a reapplication notify the reviewers', () => {
  test('two notification types, added before any code can write them', () => {
    assert.deepEqual([...REVIEW_NOTIFICATION_TYPES], ['customer_review_submitted', 'customer_review_reapplied'])
    for (const t of REVIEW_NOTIFICATION_TYPES) {
      assert.ok(SQL.includes(`alter type notification_type add value if not exists '${t}';`), t)
    }
  })

  test('the database writes them, in the trail trigger, after the change — never a route', () => {
    const trail = fn('customer_review_custom_submissions_trail')
    assert.ok(trail.includes('insert into public.notifications (user_id, task_id, entity_id, type, title, body, is_push_sent)'))
    assert.ok(trail.includes('select r.user_id, null, new.id, v_kind::notification_type, v_title, v_body, true'))
    assert.ok(trail.includes('from public.customer_review_custom_reviewer_ids(new.submitted_by) r;'))
    assert.match(code, /create trigger customer_review_custom_submissions_trail\s*\n\s*after insert or update of status on public\.customer_review_custom_submissions/)
    // Nothing in the route writes a notification: a notification exists only if
    // the change it announces committed.
    assert.equal(/notifications/.test(ROUTE), false)
  })

  test('only the submission and the reapplication notify; a decision does not', () => {
    const trail = fn('customer_review_custom_submissions_trail')
    const approvedAt = trail.indexOf("old.status = 'pending_verification' and new.status = 'approved'")
    const rejectedAt = trail.indexOf("old.status = 'pending_verification' and new.status = 'rejected'")
    const reappliedAt = trail.indexOf("old.status = 'rejected' and new.status = 'pending_verification'")
    assert.ok(approvedAt !== -1 && rejectedAt !== -1 && reappliedAt !== -1)
    assert.ok(trail.slice(approvedAt, reappliedAt).includes('return null;'), 'a decision returns before the notification')
    assert.ok(trail.slice(reappliedAt).includes("v_kind := 'customer_review_reapplied';"))
  })

  test('recipients are resolved by permission — verify — active, and never the submitter', () => {
    const reviewers = fn('customer_review_custom_reviewer_ids')
    assert.ok(reviewers.includes("public.resolve_permission(u.id, 'customer_review_requests', 'verify')"))
    assert.ok(reviewers.includes('u.is_active = true'))
    assert.ok(reviewers.includes('u.id is distinct from p_exclude'))
    assert.equal(/\brole\b/.test(reviewers), false, 'no role name decides who is told')
    assert.match(code, /revoke execute on function public\.customer_review_custom_reviewer_ids\(uuid\) from public, anon, authenticated;/)
  })

  test('the sentences name the person, the type, and that it needs approval', () => {
    const trail = fn('customer_review_custom_submissions_trail')
    assert.ok(trail.includes("'%s submitted a custom %s Review for approval.'"))
    assert.ok(trail.includes("'%s reapplied a rejected custom %s Review for approval.'"))
    assert.ok(trail.includes("v_type := case new.review_type when 'image' then 'Image' else 'Text' end;"))
  })

  test('they have their own feed, count and cache keys', () => {
    assert.equal(getNotificationCategoryFilter('review'), 'type.in.(customer_review_submitted,customer_review_reapplied)')
    assert.ok(resolveNotificationCategory('review').ok)
    assert.ok(NOTIFICATION_CATEGORIES.includes('review'))
    assert.deepEqual(notificationKeys.count('review'), ['notifications', 'count', 'review'])
    assert.ok(read('src/app/customer-reviews/notifications/page.tsx').includes('<NotificationsView category="review" Layout={ReviewNotificationsLayout} />'))
  })

  test('the link opens the submission in Custom Submissions, and the queue honours it', () => {
    assert.ok(read('src/lib/notificationMeta.ts').includes('`/customer-reviews/custom?submission=${n.entity_id}`'))
    assert.ok(QUEUE.includes("const wanted = searchParams.get('submission')"))
    assert.ok(read('src/app/customer-reviews/custom/page.tsx').includes('<Suspense fallback={<LoadingScreen />}>'))
  })
})

// ── 2. The pending badge ─────────────────────────────────────────────────────

describe('the pending badge', () => {
  test('counts pending custom reviews only, as a head count', () => {
    const hook = read('src/hooks/queries/useCustomReviewPendingCount.ts')
    assert.ok(hook.includes(".from('customer_review_custom_submissions')"))
    assert.ok(hook.includes(".select('id', { count: 'exact', head: true })"))
    assert.ok(hook.includes(".eq('status', 'pending_verification')"))
    assert.ok(hook.includes('staleTime: 30 * 1000'))
  })

  test('is asked for, and drawn, only for a verifier', () => {
    assert.ok(LAYOUT.includes('const pendingCustom = useCustomReviewPendingCount(canVerify)'))
    assert.ok(LAYOUT.includes('const unreadReviews = useUnreadReviewNotifications(canVerify)'))
    const entry = LAYOUT.slice(LAYOUT.indexOf("label: 'Custom Submissions'"), LAYOUT.indexOf("label: 'Batches'"))
    assert.ok(entry.includes('verifierOnly: true') && entry.includes("count: 'custom-pending'"))
    const notifyAt = LAYOUT.indexOf('<NotificationsNavItem')
    assert.ok(LAYOUT.slice(notifyAt - 40, notifyAt).includes('{canVerify && ('), 'the Notifications entry is a verifier\'s')
  })

  test('moves at once after a decision, a submission and a reapplication in this tab', () => {
    const invalidate = 'queryClient.invalidateQueries({ queryKey: CUSTOM_REVIEW_PENDING_COUNT_KEY })'
    assert.ok(QUEUE.includes(invalidate), 'after approve / reject')
    assert.ok(WORKSPACE.includes(invalidate), 'after submit / reapply')
  })
})

// ── 3. Reapply ───────────────────────────────────────────────────────────────

describe('reapplying a rejected review', () => {
  test('is the SAME row: an UPDATE that never moves the first submission or the submitter', () => {
    const reapply = fn('reapply_customer_review_custom_submission')
    assert.equal(reapply.includes('insert into public.customer_review_custom_submissions'), false)
    const update = reapply.slice(reapply.indexOf('update public.customer_review_custom_submissions'), reapply.indexOf('returning * into s;'))
    assert.ok(update.includes("status               = 'pending_verification'"))
    assert.ok(update.includes('reapplication_count  = reapplication_count + 1'))
    assert.equal(/submitted_at|submitted_by|submission_ref/.test(update), false, 'the slot and the owner never move')
  })

  test('only the owner, only a rejected review; a retry is a no-op', () => {
    const reapply = fn('reapply_customer_review_custom_submission')
    const lockAt = reapply.indexOf("pg_advisory_xact_lock(hashtext('customer_review_custom_month')")
    const rowAt = reapply.indexOf('for update;')
    const ownerAt = reapply.indexOf('if s.submitted_by <> p_actor_id then')
    const pendingAt = reapply.indexOf("if s.status = 'pending_verification' then")
    const updateAt = reapply.indexOf('update public.customer_review_custom_submissions')
    assert.ok(lockAt !== -1 && lockAt < rowAt && rowAt < ownerAt && ownerAt < pendingAt && pendingAt < updateAt)
    assert.ok(reapply.includes("'already_pending', true"))
    assert.ok(reapply.includes("CUSTOMER_REVIEW_CUSTOM_DECIDED: This review was already approved"))
  })

  test('is service role only, called by the route with the session\'s actor', () => {
    assert.match(code, /revoke execute on function public\.reapply_customer_review_custom_submission\([^)]*\)\s*\n\s*from public, anon, authenticated;/)
    assert.ok(ROUTE.includes('export async function PATCH(req: NextRequest)'))
    assert.ok(ROUTE.includes("service.rpc('reapply_customer_review_custom_submission'"))
    assert.ok(ROUTE.includes('p_actor_id:             actorId,'))
    assert.ok(ROUTE.includes("form.get('submissionId')"))
  })

  test('the guard admits rejected → pending with the corrections only, counted once', () => {
    const guard = fn('customer_review_custom_submissions_guard')
    assert.ok(guard.includes("if old.status = 'rejected' and new.status = 'pending_verification' then"))
    assert.ok(guard.includes('if new.reapplication_count <> old.reapplication_count + 1'))
    assert.equal(/'submitted_at'|'submitted_by'|'submission_ref'/.test(guard), false, 'none of these may change on a reapplication')
  })

  test('the history keeps the submission, the rejection and why, the reapplication and the note', () => {
    const trail = fn('customer_review_custom_submissions_trail')
    for (const needle of ["'submitted'", "'rejected', new.rejected_by, new.rejection_reason", "'reapplied', new.submitted_by, new.candidate_note", "'rejection_reason', old.rejection_reason"]) {
      assert.ok(trail.includes(needle), needle)
    }
    assert.match(code, /create trigger customer_review_custom_submission_events_append_only\s*\n\s*before update or delete/)
  })

  test('the form parses a reapplication without a new screenshot, and the screen offers it only on your own rejected review', () => {
    const r = parseCustomReapplicationInput({ reviewType: 'text', publishedOn: '2026-09-10', remark: '', note: '  full screenshot  ' }, '2026-09-12')
    assert.ok(r.ok && r.value.note === 'full screenshot')
    assert.equal(parseCustomReapplicationInput({ reviewType: 'text', publishedOn: '2026-09-10', remark: '', note: 'x'.repeat(501) }, '2026-09-12').ok, false)
    assert.ok(canReapplySubmission({ status: 'rejected', submitted_by: 'me' }, 'me'))
    assert.equal(canReapplySubmission({ status: 'rejected', submitted_by: 'them' }, 'me'), false)
    assert.equal(canReapplySubmission({ status: 'pending_verification', submitted_by: 'me' }, 'me'), false)
    assert.ok(WORKSPACE.includes("fetch('/api/customer-reviews/custom-submissions', { method: 'PATCH', body })"))
    assert.ok(WORKSPACE.includes("'Reapply for Approval'"))
    assert.equal(CUSTOM_SUBMISSION_STATUS_META.pending_verification.label, 'Pending Approval')
  })
})

// ── 4. The monthly rules ─────────────────────────────────────────────────────

describe('the monthly rules are the database\'s, under a lock', () => {
  test('the registration locks, checks, and only then inserts', () => {
    const create = fn('create_customer_review_custom_submission')
    const lockAt = create.indexOf("perform pg_advisory_xact_lock(hashtext('customer_review_custom_month'), hashtext(p_actor_id::text));")
    const checkAt = create.indexOf('perform public.check_customer_review_custom_month_rules(p_actor_id, v_month, p_review_type, null, null);')
    const insertAt = create.indexOf('insert into public.customer_review_custom_submissions')
    assert.ok(lockAt !== -1 && lockAt < checkAt && checkAt < insertAt)
    assert.ok(create.includes("v_month  date := date_trunc('month', (now() at time zone 'Asia/Kolkata')::date)::date;"))
  })

  test('the rules read the live settings, not literals', () => {
    const rules = fn('check_customer_review_custom_month_rules')
    assert.ok(rules.includes('v_settings.max_monthly_review_submissions'))
    assert.ok(rules.includes('v_settings.minimum_monthly_image_reviews'))
    assert.equal(/\b10\b|\b3\b/.test(rules.replace(/v_settings\.[a-z_]+/g, '')), false, 'no 10 and no 3 written into the rule')
  })

  test('the route refuses before uploading, and maps the database\'s refusals to a status', () => {
    assert.ok(ROUTE.indexOf('submissionAllowance(') < ROUTE.indexOf('const image = await processProof(proof)'))
    assert.equal(customSubmissionFailureStatus('CUSTOMER_REVIEW_CUSTOM_MONTHLY_LIMIT: You have reached…'), 422)
    assert.equal(customSubmissionFailureStatus('CUSTOMER_REVIEW_CUSTOM_IMAGE_REQUIRED: You have submitted…'), 422)
    assert.equal(customSubmissionFailureStatus('CUSTOMER_REVIEW_CUSTOM_NOT_OWNER: You can only…'), 403)
    assert.equal(customSubmissionFailureStatus('CUSTOMER_REVIEW_CUSTOM_MONTH_CLOSED: September…'), 409)
    assert.equal(customSubmissionFailureStatus('some other failure'), null)
  })
})

// ── 5. Credits: a closed month, and no penalty ───────────────────────────────

describe('credits', () => {
  test('an approval into a lapsed month is refused, under the credits lock, before any reward', () => {
    const approve = fn('approve_customer_review_custom_submission')
    const lockAt = approve.indexOf("perform pg_advisory_xact_lock(hashtext('boe_credits'), hashtext(s.submitted_by::text));")
    const closedAt = approve.indexOf('CUSTOMER_REVIEW_CUSTOM_MONTH_CLOSED')
    const rewardAt = approve.indexOf('v_reward := public.post_boe_credit_custom_review_reward(')
    assert.ok(lockAt !== -1 && lockAt < closedAt && closedAt < rewardAt)
    // The type still decides the amount, and an approved review still pays once.
    assert.ok(approve.includes("when 'image' then v_settings.image_review_reward_credits"))
    assert.ok(approve.indexOf("if s.status = 'approved' then") < rewardAt)
  })

  test('nothing in this phase posts a ledger row — no penalty, no negative credit', () => {
    assert.equal(code.includes('post_boe_credit_transaction('), false)
    assert.equal(code.includes('review_month_lapse'), false)
    assert.equal(/insert into public\.boe_credit_transactions/.test(code), false)
  })

  test('the approved credit is attributed to the month of the FIRST submission', () => {
    // post_boe_credit_custom_review_reward (20261205000000) reads submitted_at,
    // and nothing in this phase ever writes it.
    assert.ok(fn('approve_customer_review_custom_submission').includes('s.submitted_at,'))
    assert.equal(/set[\s\S]{0,400}submitted_at\s*=/.test(fn('reapply_customer_review_custom_submission')), false)
  })
})

// ── 6. Generated reviews, paused for candidates ──────────────────────────────

describe('the generated-review workflow is paused for candidates', () => {
  test('the application switch and the database switch agree', () => {
    assert.equal(CANDIDATE_GENERATED_REVIEWS_ENABLED, false)
    assert.ok(fn('customer_review_generated_booking_enabled').includes('select false;'))
    assert.equal(candidateGeneratedReviewsHidden({ canVerify: false }), true)
    assert.equal(candidateGeneratedReviewsHidden({ canVerify: true }), false, 'a verifier keeps every screen')
  })

  test('the database refuses a non-verifier\'s booking, whatever called it', () => {
    const guard = fn('customer_review_generated_booking_guard')
    assert.ok(guard.includes("public.resolve_permission(auth.uid(), 'customer_review_requests', 'verify')"))
    assert.ok(guard.includes('CUSTOMER_REVIEW_GENERATED_PAUSED'))
    assert.match(code, /before update of status on public\.customer_review_test_cards\s*\n\s*for each row\s*\n\s*when \(old\.status = 'available' and new\.status = 'booked'\)/)
  })

  test('nothing is deleted', () => {
    assert.equal(/drop table|delete from|truncate table|truncate public\./i.test(code), false)
  })

  test('both routes that render My Reviews give a candidate the Custom Review workspace', () => {
    assert.ok(read('src/app/customer-reviews/page.tsx').includes('candidateGeneratedReviewsHidden(caps) ? <CustomReviewsScreen /> : <MyReviewsScreen />'))
    assert.ok(read('src/app/customer-reviews/mine/page.tsx').includes('{candidateGeneratedReviewsHidden(caps) ? <CustomReviewsScreen /> : <MyReviewsScreen />}'))
    const screen = read('src/app/customer-reviews/CustomReviewsScreen.tsx')
    assert.equal(/customer_review_test_cards|book_customer_review_test_card/.test(screen + WORKSPACE), false)
  })

  test('a card URL typed by a candidate shows the pause, not the card', () => {
    const detail = read('src/app/customer-reviews/[id]/TestCardDetailScreen.tsx')
    const guardAt = detail.indexOf('if (!authLoading && candidateGeneratedReviewsHidden(caps)) {')
    assert.ok(guardAt !== -1)
    assert.ok(guardAt < detail.indexOf('if (authLoading || loading) return <LoadingScreen />'))
    assert.ok(guardAt < detail.indexOf('if (notFound || !card) {'))
  })
})
