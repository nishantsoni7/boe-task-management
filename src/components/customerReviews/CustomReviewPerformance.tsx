'use client'

import { colors } from '@/lib/tokens'
import { formatCredits, reviewMonthLabel } from '@/lib/boeCredits/ledger'
import { formatCreditValue } from '@/lib/boeCredits/settings'
import type { BoeCreditSettings } from '@/lib/boeCredits/types'
import type { CustomReviewMonthSummary, SubmissionAllowance } from '@/lib/customerReviews/customMonthlyRules'

// The candidate's Review position, in plain rows: the reward rules, this month
// and last month. No charts and no scores — every number answers one question
// ("have I reached the minimum?", "can I still submit a Text Review?").
//
// EVERY NUMBER COMES FROM THE LIVE SETTINGS OR THE SUMMARY. Nothing here writes
// 1, 1.5, ₹50, 3 or 10; summarizeCustomReviewMonth() and the settings row are
// the only sources, so a settings change reaches this screen on its next load.

const GREEN = '#047857'
const AMBER = '#92400E'
const RED = '#B91C1C'

/** The rules, as a row of small chips beside the primary action. */
export function ReviewRewardRules({ settings }: { settings: BoeCreditSettings }) {
  const rupees = (credits: number) => formatCreditValue(credits * settings.credit_value)
  const chips: { label: string; value: string }[] = [
    { label: 'Text Review',           value: `${formatCredits(settings.review_reward_credits)} · ${rupees(settings.review_reward_credits)}` },
    { label: 'Image Review',          value: `${formatCredits(settings.image_review_reward_credits)} · ${rupees(settings.image_review_reward_credits)}` },
    { label: '1 Credit',              value: formatCreditValue(settings.credit_value) },
    { label: 'Monthly minimum',       value: `${settings.minimum_monthly_reviews} approved ${settings.minimum_monthly_reviews === 1 ? 'review' : 'reviews'}` },
    { label: 'Maximum submissions',   value: `${settings.max_monthly_review_submissions} a month` },
    { label: 'Minimum Image Reviews', value: `${settings.minimum_monthly_image_reviews} a month` },
  ]
  return (
    <ul aria-label="Review reward rules" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
      {chips.map(c => (
        <li key={c.label} style={{
          fontSize: '12px', padding: '4px 10px', borderRadius: '999px',
          border: `1px solid ${colors.borderSoft}`, background: colors.base, color: colors.secondary,
        }}>
          {c.label}: <strong style={{ color: colors.primary, fontVariantNumeric: 'tabular-nums' }}>{c.value}</strong>
        </li>
      ))}
    </ul>
  )
}

type Row = { label: string; value: string; tone?: string; detail?: string | null }

function Panel({ title, rows, footnote }: { title: string; rows: Row[]; footnote?: string | null }) {
  return (
    <section style={{
      flex: '1 1 300px', minWidth: 0, padding: '12px 14px', borderRadius: '10px',
      border: `1px solid ${colors.borderSoft}`, background: colors.base,
      display: 'flex', flexDirection: 'column', gap: '8px',
    }}>
      <h3 style={{ margin: 0, fontSize: '12px', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: colors.primary }}>
        {title}
      </h3>
      <dl style={{ margin: 0, display: 'grid', gap: '6px' }}>
        {rows.map(r => (
          <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', fontSize: '12.5px', lineHeight: 1.45 }}>
            <dt style={{ color: colors.secondary }}>{r.label}</dt>
            <dd style={{ margin: 0, textAlign: 'right', minWidth: 0 }}>
              <span style={{ fontWeight: 700, color: r.tone ?? colors.primary, fontVariantNumeric: 'tabular-nums' }}>{r.value}</span>
              {r.detail && <span style={{ display: 'block', fontSize: '11.5px', color: colors.muted }}>{r.detail}</span>}
            </dd>
          </div>
        ))}
      </dl>
      {footnote && <p style={{ margin: 0, fontSize: '11.5px', color: colors.muted, lineHeight: 1.5 }}>{footnote}</p>}
    </section>
  )
}

function targetStatus(s: CustomReviewMonthSummary): { label: string; tone: string } {
  if (s.monthStatus === 'qualified') return { label: 'Qualified', tone: GREEN }
  if (s.monthStatus === 'lapsed') return { label: 'Closed below the minimum', tone: RED }
  return { label: 'Not yet qualified', tone: AMBER }
}

function imageRequirement(s: CustomReviewMonthSummary): Row {
  if (s.minImageReviews === 0) return { label: 'Image Review requirement', value: 'None this month' }
  return {
    label: 'Image Review requirement',
    value: `${s.imageReviews} / ${s.minImageReviews}`,
    tone: s.imageRequirementMet ? GREEN : AMBER,
    detail: s.imageRequirementMet ? 'Complete' : `${s.imagesStillRequired} more Image ${s.imagesStillRequired === 1 ? 'Review' : 'Reviews'} needed`,
  }
}

/** This month: where the candidate stands, and what they may still submit. */
export function CurrentMonthPanel({
  summary: s, allowance, settings,
}: {
  summary: CustomReviewMonthSummary
  allowance: SubmissionAllowance
  settings: BoeCreditSettings
}) {
  const status = targetStatus(s)
  const credits: Row = s.monthStatus === 'qualified'
    ? { label: 'Review credits', value: formatCredits(s.spendableCredits), tone: GREEN, detail: 'Spendable' }
    : s.monthStatus === 'lapsed'
      ? { label: 'Review credits', value: formatCredits(0), tone: RED, detail: 'The month closed below the minimum' }
      : { label: 'Review credits', value: formatCredits(s.pendingCredits), tone: s.pendingCredits > 0 ? AMBER : undefined,
          detail: s.pendingCredits > 0 ? `Pending — spendable at ${s.minimumApproved} approved` : null }

  const rows: Row[] = [
    { label: 'Monthly Review Target', value: `${s.approvedForTarget} / ${s.minimumApproved} approved`, tone: status.tone, detail: status.label },
    imageRequirement(s),
    { label: 'Submitted', value: `${s.submitted} / ${s.maxSubmissions}`, detail: `${s.remainingSlots} ${s.remainingSlots === 1 ? 'slot' : 'slots'} left` },
    { label: 'Text / Image', value: `${s.textReviews} text · ${s.imageReviews} image` },
    { label: 'Pending approval', value: String(s.pending) },
    { label: 'Rejected — to correct', value: String(s.rejected), tone: s.rejected > 0 ? RED : undefined },
    {
      label: 'Text Review now',
      value: allowance.canSubmitText ? 'Allowed' : 'Not allowed',
      tone: allowance.canSubmitText ? GREEN : RED,
      detail: allowance.canSubmitText ? null : allowance.textBlockedMessage,
    },
    credits,
    {
      label: 'Reward rates',
      value: `${formatCredits(settings.review_reward_credits)} text · ${formatCredits(settings.image_review_reward_credits)} image`,
      detail: `1 credit = ${formatCreditValue(settings.credit_value)}`,
    },
  ]

  return (
    <Panel
      title={`This month · ${reviewMonthLabel(s.month, { year: true })}`}
      rows={rows}
      footnote={`A month earns review credits only once it has ${s.minimumApproved} approved reviews. Below that nothing is earned for the month — and nothing you already hold is taken away.`}
    />
  )
}

/** Last month, closed or not: what happened, and what it earned. */
export function LastMonthPanel({ summary: s }: { summary: CustomReviewMonthSummary }) {
  const earned: Row = s.monthStatus === 'qualified'
    ? { label: 'Review credits earned', value: formatCredits(s.spendableCredits), tone: GREEN }
    : s.monthStatus === 'lapsed'
      ? { label: 'Review credits earned', value: formatCredits(0), tone: RED, detail: `${formatCredits(s.lapsedCredits)} pending did not become available` }
      : s.monthStatus === 'open'
        ? { label: 'Review credits earned', value: formatCredits(0), tone: AMBER, detail: `${formatCredits(s.pendingCredits)} still pending — the month is not closed yet` }
        : { label: 'Review credits earned', value: formatCredits(0) }

  const monthStatus = s.monthStatus === 'none' ? 'No approved reviews'
    : s.monthStatus === 'qualified' ? (s.finalized ? 'Qualified · closed' : 'Qualified')
    : s.monthStatus === 'lapsed' ? 'Closed below the minimum'
    : 'Not closed yet'

  const rows: Row[] = [
    { label: 'Approved reviews', value: String(s.approvedForTarget) },
    { label: 'Submitted', value: String(s.submitted) },
    { label: 'Text / Image', value: `${s.textReviews} text · ${s.imageReviews} image` },
    { label: 'Minimum target achieved', value: s.minimumTargetMet ? 'Yes' : 'No', tone: s.minimumTargetMet ? GREEN : RED },
    {
      label: 'Image requirement achieved',
      value: s.minImageReviews === 0 ? 'No requirement' : s.imageRequirementMet ? 'Yes' : 'No',
      tone: s.minImageReviews === 0 ? undefined : s.imageRequirementMet ? GREEN : RED,
    },
    earned,
    { label: 'Month status', value: monthStatus },
  ]

  return <Panel title={`Last month · ${reviewMonthLabel(s.month, { year: true })}`} rows={rows} />
}
