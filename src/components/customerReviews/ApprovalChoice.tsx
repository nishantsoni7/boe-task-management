'use client'

import { Check, Layers, Replace } from 'lucide-react'
import { colors } from '@/lib/tokens'
import type { ApprovalMode } from '@/lib/customerReviews/status'

// ── Add, or Replace ──────────────────────────────────────────────────────────
//
// THE QUESTION IS ASKED AT APPROVAL AND NOWHERE ELSE.
//
// Not when the verifier presses Generate, and not when the model returns:
// either would make them decide the fate of the current list before reading a
// word of what was written. By the time this appears they have read the drafts,
// possibly revised them, and are choosing about text they have actually seen.
//
// IT IS ASKED EVERY TIME. Approving three now and five later asks twice, each
// against the state that exists then — nothing carries the earlier answer
// forward, because a remembered Replace is a Replace nobody is looking at.
//
// TWO CHOICES, AND THE DEFAULT IS THE SAFE ONE. `add` is preselected; Replace
// has to be chosen deliberately. Replace is not styled as destructive — it is a
// legitimate, ordinary thing to do with a fresh batch — but it states its
// consequence in a number rather than in adjectives.
//
// WHAT REPLACE DOES NOT TOUCH is the half people get wrong, so it is on the
// card rather than in a tooltip: booked, sent, submitted and verified reviews
// are somebody's work in progress and are left exactly where they are, as are
// pending drafts in any other batch.

export function ApprovalChoiceCards({
  mode,
  onChange,
  approveCount,
  availableCount,
  disabled,
}: {
  mode: ApprovalMode
  onChange: (next: ApprovalMode) => void
  /** How many drafts this approval releases. */
  approveCount: number
  /**
   * How many reviews are available right now, and would be displaced.
   *
   * A LIVE READ, NOT A PROMISE. It can move between this being drawn and the
   * button being pressed; the database picks and locks the set inside the
   * transaction and returns what it actually deleted.
   */
  availableCount: number
  disabled?: boolean
}) {
  return (
    <div
      role="radiogroup"
      aria-label="What happens to the reviews that are already available"
      style={{ display: 'grid', gap: '9px' }}
    >
      <ChoiceCard
        selected={mode === 'add'}
        disabled={disabled}
        onSelect={() => onChange('add')}
        Icon={Layers}
        title="Add to current list"
        detail={
          availableCount === 0
            ? `${approveCount === 1 ? 'This review joins' : `These ${approveCount} join`} an empty list.`
            : `${approveCount === 1 ? 'This review joins' : `These ${approveCount} join`} the ${availableCount} already available. Nothing is removed.`
        }
      />
      <ChoiceCard
        selected={mode === 'replace'}
        disabled={disabled}
        onSelect={() => onChange('replace')}
        Icon={Replace}
        title="Replace current available list"
        detail={
          availableCount === 0
            ? 'Nothing is available right now, so there is nothing to replace — this does the same as adding.'
            : `The ${availableCount === 1 ? '1 review' : `${availableCount} reviews`} currently available ${availableCount === 1 ? 'is' : 'are'} deleted in the same step, leaving only ${approveCount === 1 ? 'this one' : `these ${approveCount}`}.`
        }
        note="Reviews that are booked, sent, submitted or verified are not touched, and neither are drafts in other batches."
      />
    </div>
  )
}

function ChoiceCard({
  selected, disabled, onSelect, Icon, title, detail, note,
}: {
  selected: boolean
  disabled?: boolean
  onSelect: () => void
  Icon: typeof Layers
  title: string
  detail: string
  note?: string
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      disabled={disabled}
      style={{
        // THE WHOLE CARD IS THE TARGET, not a 5mm dot beside it. Comfortably
        // past 44px on any phone, and the same shape as the pending-draft rows
        // the verifier has just been reading.
        display: 'flex', gap: '10px', alignItems: 'flex-start', textAlign: 'left',
        width: '100%', minHeight: '44px', padding: '12px',
        borderRadius: '10px', cursor: disabled ? 'not-allowed' : 'pointer',
        border: `1px solid ${selected ? colors.blue : colors.border}`,
        background: selected ? '#F5F9FF' : colors.raised,
        boxShadow: selected ? `inset 0 0 0 1px ${colors.blue}` : 'none',
        fontFamily: 'inherit', opacity: disabled ? 0.6 : 1,
      }}
    >
      <span
        aria-hidden
        style={{
          flexShrink: 0, width: '20px', height: '20px', marginTop: '1px',
          borderRadius: '999px', display: 'inline-flex',
          alignItems: 'center', justifyContent: 'center',
          border: `1.5px solid ${selected ? colors.blue : colors.border}`,
          background: selected ? colors.blue : '#FFFFFF',
          color: '#FFFFFF',
        }}
      >
        {selected && <Check size={12} strokeWidth={3} />}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{
          display: 'flex', alignItems: 'center', gap: '6px',
          fontSize: '13px', fontWeight: 600,
          color: selected ? colors.blue : colors.primary,
        }}>
          <Icon size={14} strokeWidth={2} />
          {title}
        </span>
        <span style={{
          display: 'block', marginTop: '3px',
          fontSize: '12px', color: colors.secondary, lineHeight: 1.55,
        }}>
          {detail}
        </span>
        {note && (
          <span style={{
            display: 'block', marginTop: '4px',
            fontSize: '11px', color: colors.muted, lineHeight: 1.5,
          }}>
            {note}
          </span>
        )}
      </span>
    </button>
  )
}
