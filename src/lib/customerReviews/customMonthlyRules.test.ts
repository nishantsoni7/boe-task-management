/**
 * Custom Reviews — the monthly rules and the month summaries (20261206000000).
 *
 * The database decides; these are the same rules as pure functions, used by the
 * form (to explain BEFORE an upload) and by the Current Month / Last Month
 * panels. The sentences are pinned to the migration so the form and the
 * database say the same thing. The rules are exercised against a real
 * PostgreSQL by supabase/tests/custom_review_phase_assertions.sql.
 *
 * Run:
 *   npx tsx --test src/lib/customerReviews/customMonthlyRules.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  imageRequiredMessage,
  istMonthBoundsUtc,
  istMonthOf,
  monthRulesFromSettings,
  monthlyLimitMessage,
  previousMonth,
  reapplicationIssue,
  reapplyImageRequiredMessage,
  submissionAllowance,
  summarizeCustomReviewMonth,
  usageForMonth,
  type CustomReviewMonthRules,
  type SummaryRow,
} from './customMonthlyRules'
import { DEFAULT_BOE_CREDIT_SETTINGS } from '../boeCredits/settings'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n')
const SQL = read('supabase/migrations/20261206000000_customer_review_custom_reapply_and_monthly_rules.sql')

const RULES: CustomReviewMonthRules = { maxMonthlySubmissions: 10, minMonthlyImageReviews: 3, minMonthlyApprovedReviews: 3 }
const usage = (submitted: number, imageReviews: number) => ({ submitted, imageReviews })

describe('the rules come from the settings, not from literals', () => {
  test('the phase defaults: 10 a month, 3 of them images, 3 approved to qualify', () => {
    assert.deepEqual(monthRulesFromSettings(DEFAULT_BOE_CREDIT_SETTINGS), RULES)
  })
})

describe('the monthly cap', () => {
  test('9 unique submitted → the 10th is allowed', () => {
    const a = submissionAllowance(usage(9, 3), RULES)
    assert.equal(a.canSubmitAny, true)
    assert.equal(a.remainingSlots, 1)
  })

  test('10 unique submitted → the 11th is blocked, with the sentence', () => {
    const a = submissionAllowance(usage(10, 3), RULES)
    assert.equal(a.canSubmitAny, false)
    assert.equal(a.canSubmitImage, false)
    assert.equal(a.canSubmitText, false)
    assert.equal(a.remainingSlots, 0)
    assert.equal(a.limitMessage, 'You have reached your monthly limit of 10 review submissions.')
  })

  test('a reapplication is never checked against the cap — the slot is its own', () => {
    // Ten slots used, one of them the rejected review being reapplied.
    assert.equal(reapplicationIssue(usage(9, 3), 'text', 'text', RULES), null)
    assert.equal(reapplicationIssue(usage(9, 2), 'image', 'image', RULES), null)
  })

  test('a draft never submitted does not count — only stored rows do', () => {
    // Nothing is stored before Submit, so the only rows are submitted ones.
    const rows: SummaryRow[] = []
    assert.deepEqual(usageForMonth(rows, '2026-09-01'), usage(0, 0))
  })
})

describe('the image mix — the general formula', () => {
  test('7 text + 0 image → text blocked, in the brief\'s own words', () => {
    const a = submissionAllowance(usage(7, 0), RULES)
    assert.equal(a.canSubmitText, false)
    assert.equal(a.textBlockedMessage,
      'You have submitted 7 reviews this month. Your remaining 3 reviews must be Image Reviews to complete the monthly requirement of 3 Image Reviews.')
  })

  test('7 text + 0 image → image allowed', () => {
    const a = submissionAllowance(usage(7, 0), RULES)
    assert.equal(a.canSubmitImage, true)
    assert.equal(a.imagesStillRequired, 3)
  })

  test('7 total + 2 image → text still allowed (2 slots left after it, 1 image needed)', () => {
    const a = submissionAllowance(usage(7, 2), RULES)
    assert.equal(a.canSubmitText, true)
    assert.equal(a.textBlockedMessage, null)
  })

  test('8 total + 1 image → text blocked', () => {
    const a = submissionAllowance(usage(8, 1), RULES)
    assert.equal(a.canSubmitText, false)
    assert.match(a.textBlockedMessage ?? '', /Your remaining 2 reviews must be Image Reviews/)
  })

  test('9 total + 2 image → text blocked; the final slot must be an image', () => {
    const a = submissionAllowance(usage(9, 2), RULES)
    assert.equal(a.canSubmitText, false)
    assert.equal(a.canSubmitImage, true)
    assert.match(a.textBlockedMessage ?? '', /Your remaining 1 review must be an Image Review/)
  })

  test('9 total + 3 image → the final text is allowed', () => {
    assert.equal(submissionAllowance(usage(9, 3), RULES).canSubmitText, true)
  })

  test('exhaustively: text is allowed exactly when the slots left after it cover the images still needed', () => {
    for (let submitted = 0; submitted <= 10; submitted++) {
      for (let images = 0; images <= submitted; images++) {
        const a = submissionAllowance(usage(submitted, images), RULES)
        const expected = submitted < 10 && (10 - (submitted + 1)) >= Math.max(0, 3 - images)
        assert.equal(a.canSubmitText, expected, `${submitted} submitted, ${images} images`)
      }
    }
  })

  test('changed settings move the formula — nothing assumes 10 and 3', () => {
    const five: CustomReviewMonthRules = { maxMonthlySubmissions: 5, minMonthlyImageReviews: 1, minMonthlyApprovedReviews: 2 }
    assert.equal(submissionAllowance(usage(4, 0), five).canSubmitText, false)
    assert.equal(submissionAllowance(usage(4, 0), five).textBlockedMessage,
      'You have submitted 4 reviews this month. Your remaining 1 review must be an Image Review to complete the monthly requirement of 1 Image Review.')
    assert.equal(submissionAllowance(usage(3, 0), five).canSubmitText, true)
    assert.equal(submissionAllowance(usage(5, 1), five).limitMessage, 'You have reached your monthly limit of 5 review submissions.')
    const off: CustomReviewMonthRules = { maxMonthlySubmissions: 10, minMonthlyImageReviews: 0, minMonthlyApprovedReviews: 3 }
    assert.equal(submissionAllowance(usage(9, 0), off).canSubmitText, true, 'a zero image minimum turns the rule off')
  })

  test('a reapplication is checked against the mix only when an image review becomes text', () => {
    // E3 in the SQL suite: 7 text + 2 image; one image rejected → without it 8 and 1.
    assert.equal(reapplicationIssue(usage(8, 1), 'image', 'text', RULES), reapplyImageRequiredMessage(RULES))
    assert.equal(reapplicationIssue(usage(8, 1), 'image', 'image', RULES), null)
    assert.equal(reapplicationIssue(usage(8, 1), 'text', 'text', RULES), null)
    assert.equal(reapplicationIssue(usage(3, 3), 'image', 'text', RULES), null, 'plenty of room')
  })
})

describe('the sentences are the database\'s own', () => {
  test('the cap sentence', () => {
    assert.ok(SQL.includes('You have reached your monthly limit of % review submissions.'))
    assert.equal(monthlyLimitMessage(RULES), 'You have reached your monthly limit of 10 review submissions.')
  })

  test('the image sentence has the same words and the same plural rules', () => {
    assert.ok(SQL.includes("'You have submitted %s %s this month. Your remaining %s %s to complete the monthly requirement of %s %s.'"))
    assert.ok(SQL.includes("case when v_remaining + 1 = 1 then 'review must be an Image Review' else 'reviews must be Image Reviews' end"))
    assert.ok(SQL.includes("case when v_settings.minimum_monthly_image_reviews = 1 then 'Image Review' else 'Image Reviews' end"))
    assert.ok(imageRequiredMessage(usage(7, 0), RULES).includes('Your remaining 3 reviews must be Image Reviews'))
  })

  test('the reapplication sentence', () => {
    assert.ok(SQL.includes("'Changing this review to a Text Review would leave too few slots for the monthly requirement of %s %s. Keep it as an Image Review.'"))
  })

  test('the database formula is the same formula', () => {
    assert.ok(SQL.includes('v_remaining := v_settings.max_monthly_review_submissions - v_after;'))
    assert.ok(SQL.includes('v_required  := greatest(0, v_settings.minimum_monthly_image_reviews - v_images);'))
    assert.ok(SQL.includes('if v_remaining < v_required then'))
    assert.ok(SQL.includes("if p_reapplying_id is null and v_submitted + 1 > v_settings.max_monthly_review_submissions then"))
    assert.ok(SQL.includes("if p_review_type = 'text' and (p_reapplying_id is null or p_previous_type = 'image') then"))
  })
})

describe('months are Asia/Kolkata months', () => {
  test('the instant decides the month in IST, not UTC', () => {
    // 30 Sep 23:59 IST is 30 Sep 18:29 UTC — September.
    assert.equal(istMonthOf('2026-09-30T18:29:00.000Z'), '2026-09-01')
    // 1 Oct 00:00 IST is 30 Sep 18:30 UTC — October.
    assert.equal(istMonthOf('2026-09-30T18:30:00.000Z'), '2026-10-01')
  })

  test('the previous month, across a year', () => {
    assert.equal(previousMonth('2026-09-01'), '2026-08-01')
    assert.equal(previousMonth('2026-01-01'), '2025-12-01')
  })

  test('the UTC bounds of an IST month', () => {
    assert.deepEqual(istMonthBoundsUtc('2026-10-01'), { from: '2026-09-30T18:30:00.000Z', to: '2026-10-31T18:30:00.000Z' })
  })

  test('the database counts the same window', () => {
    assert.ok(SQL.includes("s.submitted_at >= (p_review_month::timestamp at time zone 'Asia/Kolkata')"))
    assert.ok(SQL.includes("s.submitted_at <  ((p_review_month + interval '1 month')::timestamp at time zone 'Asia/Kolkata')"))
  })
})

describe('the month summary', () => {
  const SEP = '2026-09-01'
  const at = (day: number) => new Date(Date.UTC(2026, 8, day, 6, 0)).toISOString()
  const row = (id: string, day: number, type: 'text' | 'image', status: SummaryRow['status'], reapplied = 0): SummaryRow =>
    ({ id, submitted_at: at(day), review_type: type, status, reapplication_count: reapplied })

  const ROWS: SummaryRow[] = [
    row('a', 2, 'image', 'approved'),
    row('b', 3, 'text', 'approved'),
    row('c', 4, 'text', 'rejected'),
    row('d', 5, 'image', 'pending_verification', 1),  // rejected once, reapplied: still one slot
    row('e', 6, 'text', 'pending_verification'),
    { id: 'old', submitted_at: '2026-08-20T06:00:00.000Z', review_type: 'image', status: 'approved', reapplication_count: 0 },
  ]

  test('submitted, types and statuses are counted separately — and a reapplication is one row', () => {
    const s = summarizeCustomReviewMonth({ month: SEP, rows: ROWS, monthRow: null, rules: RULES })
    assert.equal(s.submitted, 5)
    assert.equal(s.textReviews, 3)
    assert.equal(s.imageReviews, 2)
    assert.equal(s.pending, 2)
    assert.equal(s.approved, 2)
    assert.equal(s.rejected, 1)
    assert.equal(s.reapplied, 1)
    assert.equal(s.remainingSlots, 5)
    assert.equal(s.imagesStillRequired, 1)
    assert.equal(s.imageRequirementMet, false)
  })

  test('the target is read from BOE Credits, not derived from the approved count', () => {
    // One reward was reversed: two approved rows, one still counting.
    const s = summarizeCustomReviewMonth({
      month: SEP, rows: ROWS, rules: RULES,
      monthRow: { review_month: SEP, minimum_reviews_snapshot: 3, qualifying_review_count: 1, earned_review_credits: 1.5, status: 'open', finalized_at: null },
    })
    assert.equal(s.approved, 2)
    assert.equal(s.approvedForTarget, 1)
    assert.equal(s.minimumTargetMet, false)
  })

  test('0, 1 and 2 approved: nothing spendable, the credits pending', () => {
    for (const [count, credits] of [[0, 0], [1, 1], [2, 2.5]] as const) {
      const s = summarizeCustomReviewMonth({
        month: SEP, rows: ROWS, rules: RULES,
        monthRow: count === 0 ? null : { review_month: SEP, minimum_reviews_snapshot: 3, qualifying_review_count: count, earned_review_credits: credits, status: 'open', finalized_at: null },
      })
      assert.equal(s.spendableCredits, 0, `${count} approved`)
      assert.equal(s.pendingCredits, credits, `${count} approved`)
      assert.equal(s.qualified, false)
    }
  })

  test('the third approval qualifies: the credits are spendable', () => {
    const s = summarizeCustomReviewMonth({
      month: SEP, rows: ROWS, rules: RULES,
      monthRow: { review_month: SEP, minimum_reviews_snapshot: 3, qualifying_review_count: 3, earned_review_credits: 4, status: 'qualified', finalized_at: null },
    })
    assert.equal(s.qualified, true)
    assert.equal(s.minimumTargetMet, true)
    assert.equal(s.spendableCredits, 4)
    assert.equal(s.pendingCredits, 0)
  })

  test('a lapsed month earned nothing — and shows it as lapsed, never as a penalty', () => {
    const s = summarizeCustomReviewMonth({
      month: SEP, rows: ROWS, rules: RULES,
      monthRow: { review_month: SEP, minimum_reviews_snapshot: 3, qualifying_review_count: 2, earned_review_credits: 2.5, status: 'lapsed', finalized_at: '2026-10-02T05:00:00Z' },
    })
    assert.equal(s.spendableCredits, 0)
    assert.equal(s.lapsedCredits, 2.5)
    assert.equal(s.finalized, true)
    assert.ok(s.lapsedCredits >= 0 && s.spendableCredits >= 0 && s.pendingCredits >= 0, 'no figure is negative')
  })

  test('the minimum shown is the one snapshotted on the month, when there is one', () => {
    const s = summarizeCustomReviewMonth({
      month: SEP, rows: ROWS, rules: RULES,
      monthRow: { review_month: SEP, minimum_reviews_snapshot: 4, qualifying_review_count: 3, earned_review_credits: 3, status: 'open', finalized_at: null },
    })
    assert.equal(s.minimumApproved, 4)
    assert.equal(summarizeCustomReviewMonth({ month: SEP, rows: ROWS, rules: RULES, monthRow: null }).minimumApproved, 3)
  })

  test('last month is summarised from its own rows only', () => {
    const s = summarizeCustomReviewMonth({ month: '2026-08-01', rows: ROWS, monthRow: null, rules: RULES })
    assert.equal(s.submitted, 1)
    assert.equal(s.imageReviews, 1)
  })

  test('a month row for another month is ignored', () => {
    const s = summarizeCustomReviewMonth({
      month: SEP, rows: ROWS, rules: RULES,
      monthRow: { review_month: '2026-08-01', minimum_reviews_snapshot: 3, qualifying_review_count: 9, earned_review_credits: 9, status: 'qualified', finalized_at: null },
    })
    assert.equal(s.approvedForTarget, 0)
    assert.equal(s.monthStatus, 'none')
  })

  test('usage for a reapplication leaves the review itself out', () => {
    assert.deepEqual(usageForMonth(ROWS, SEP, 'd'), usage(4, 1))
  })
})
