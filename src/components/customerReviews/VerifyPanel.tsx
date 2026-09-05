'use client'

import { useEffect, useState } from 'react'
import { colors } from '@/lib/tokens'
import { formatCredits } from '@/lib/boeCredits/ledger'
import { rewardForReviewType } from '@/lib/boeCredits/settings'
import type { BoeCreditSettings } from '@/lib/boeCredits/types'
import { REVIEW_TYPE_META, type TestCard } from '@/lib/customerReviews/types'

// ── What a verifier is about to do, said before they do it ───────────────────
//
// FOUR FACTS, because those are the four a verification turns on:
//
//   THE TYPE          text or image. It decides what the candidate was asked to
//                     do and what they are paid.
//   THE REWARD        what this verification will post to the ledger.
//   THE EVIDENCE      the screenshot, which the verifier scrolls to; this panel
//                     says whether there is one rather than repeating it.
//   THE PROJECT       for an image review, which project's photographs it was.
//
// ── THE NUMBER HERE IS A LABEL, AND THE DATABASE IS THE AUTHORITY ──────────
//
// This panel reads the active settings and shows the reward for THIS review's
// stored type. What is actually paid is chosen inside
// transition_customer_review_test_card(), from the newest settings row and
// `c.review_type` read off the row it has already locked, in the same
// transaction that verifies the review.
//
// So if the settings change between this render and the press, the database
// pays the new amount and this panel was showing the old one. That is the
// correct order of authority and it is why NOTHING FROM THIS COMPONENT IS SENT
// TO THE RPC: the transition takes three arguments — a card id, a status and a
// note — and there is no field in which a browser could offer a type, a reward
// or a recipient. A candidate cannot select their own reward because there is
// no parameter through which anyone could.
//
// THE RECIPIENT IS NOT THE VERIFIER. The reward goes to `booked_by`, the
// employee who did the work; the verifier is recorded as the actor on the
// ledger row. This panel names them so the person pressing the button can see
// which of those two they are.

export function VerifyPanel({
  card, holderName, groupLabel, hasEvidence,
}: {
  card: Pick<TestCard, 'review_type' | 'image_group_id' | 'card_ref'>
  /** The employee who will receive the credits. Never the verifier. */
  holderName: string | null
  /** The project group's internal label, for an image review. */
  groupLabel: string | null
  hasEvidence: boolean
}) {
  const [settings, setSettings] = useState<BoeCreditSettings | null>(null)

  useEffect(() => {
    let active = true
    const startFetch = () => {
      void (async () => {
        try {
          const res = await fetch('/api/boe-credits/settings', { cache: 'no-store' })
          if (!active || !res.ok) return
          const payload = await res.json() as { settings?: BoeCreditSettings }
          if (active && payload?.settings) setSettings(payload.settings)
        } catch {
          // A reward the panel could not read is a reward it does not name.
          // Falling back to a guessed number would be worse than a dash: the
          // database pays what it pays either way, and a wrong figure in front
          // of the person approving it is the one outcome to avoid.
        }
      })()
    }
    startFetch()
    return () => { active = false }
  }, [])

  const meta = REVIEW_TYPE_META[card.review_type]
  const reward = settings ? rewardForReviewType(settings, card.review_type) : null

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: '8px',
      padding: '11px 13px', borderRadius: '9px',
      border: `1px solid ${meta.border}`, background: meta.bg,
    }}>
      <div style={{ fontSize: '13px', fontWeight: 700, color: meta.color, lineHeight: 1.5 }}>
        Verify {meta.label} Review
        {reward === null
          ? ''
          : ` · Award ${formatCredits(reward, { signed: true })}`}
      </div>

      <dl style={{ margin: 0, display: 'grid', gap: '4px', fontSize: '12px', lineHeight: 1.55 }}>
        <Row label="Review" value={card.card_ref} />
        <Row label="Type" value={meta.label} />
        <Row
          label="Reward"
          value={reward === null
            // NOT ZERO, AND NOT THE DEFAULT DRESSED UP AS THE TRUTH. An unread
            // setting is an unknown number, and the panel says so.
            ? `Not read — the database will award the active ${card.review_type} review reward`
            : `${formatCredits(reward)} to ${holderName ?? 'the employee who booked it'}`}
        />
        {card.review_type === 'image' && (
          <Row
            label="Project images"
            value={groupLabel ?? (card.image_group_id ? 'Attached' : 'None attached')}
          />
        )}
        <Row label="Evidence" value={hasEvidence ? 'A screenshot is attached below' : 'No screenshot attached'} />
      </dl>

      <p style={{ margin: 0, fontSize: '11px', color: meta.color, opacity: 0.85, lineHeight: 1.6 }}>
        The credits are posted to the employee who booked this review, not to you, in the same
        transaction that verifies it. Verifying twice is refused — a verified review is final.
      </p>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', gap: '8px' }}>
      <dt style={{ minWidth: '104px', color: colors.secondary }}>{label}</dt>
      <dd style={{ margin: 0, color: colors.primary, fontWeight: 600, overflowWrap: 'anywhere' }}>{value}</dd>
    </div>
  )
}

