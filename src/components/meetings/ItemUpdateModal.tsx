'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { colors } from '@/lib/tokens'
import { MeetingModal, MeetingField, MeetingModalActions, MeetingModalError } from './MeetingModal'
import { meetingErrorMessage, logMeetingFailure } from '@/lib/meetings/errors'
import { istToday } from '@/lib/istDate'
import {
  ITEM_STATUSES, ITEM_STATUS_META, formatMeetingDate,
  type ItemStatus, type MeetingOrder, type MeetingOrderItem,
} from '@/lib/meetings/types'

// The SKU update — the one interaction this module is built around.
//
// THREE INPUTS, and the modal opens with the first one focused: what happened,
// where it stands, when we look again. Stage, issue and department are here too
// but folded behind "More detail", because a routine update touches none of
// them and putting six fields in front of someone mid-meeting is how updates
// stop being entered.
//
// The previous commitment sits at the top, quoted. "What did we say last time?"
// is the first question asked about every SKU, and answering it in the same
// dialog where the answer is typed is the difference between a review that
// moves and one that stalls while somebody scrolls.
//
// Ctrl/Cmd+Enter saves. "Save & next" saves and advances to the next SKU
// without closing, which is how a lead walks a twelve-line order.

export function ItemUpdateModal({
  supabase, order, item, previousUpdate, focusField, hasNext, onClose, onSaved, onSavedNext,
}: {
  supabase: SupabaseClient
  order: MeetingOrder
  item: MeetingOrderItem
  /** The last update recorded before this one, quoted at the top. */
  previousUpdate: string | null
  /** 'follow_up' opens with the date focused — the "Set Follow-up" entry point. */
  focusField?: 'update' | 'follow_up'
  hasNext: boolean
  onClose: () => void
  onSaved: () => void
  onSavedNext: () => void
}) {
  const [update, setUpdate]   = useState('')
  const [status, setStatus]   = useState<ItemStatus>(item.status)
  const [followUp, setFollowUp] = useState<string>(item.next_follow_up_date ?? '')
  const [stage, setStage]     = useState(item.current_stage ?? '')
  const [issue, setIssue]     = useState(item.issue ?? '')
  const [showMore, setShowMore] = useState(false)
  const [saving, setSaving]   = useState(false)
  const [error, setError]     = useState<string | null>(null)

  const updateRef = useRef<HTMLTextAreaElement>(null)
  const dateRef   = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const target = focusField === 'follow_up' ? dateRef.current : updateRef.current
    target?.focus()
  }, [focusField])

  // Resolving retires the follow-up: a resolved line must never keep appearing
  // on the Overdue list. The database enforces the same rule on save; showing it
  // here means the user is not surprised by it afterwards.
  const followUpDisabled = status === 'resolved'

  // Today, EXCEPT when the line is already carrying an older date — an overdue
  // item's existing commitment must not render as an out-of-range value the
  // picker refuses to show. New dates still cannot be set in the past.
  const earliestFollowUp = useMemo(() => {
    const today = istToday()
    const existing = item.next_follow_up_date
    return existing && existing < today ? existing : today
  }, [item.next_follow_up_date])

  const dirty = useMemo(() => (
    update.trim() !== ''
    || status !== item.status
    || (followUp || '') !== (item.next_follow_up_date ?? '')
    || stage.trim() !== (item.current_stage ?? '')
    || issue.trim() !== (item.issue ?? '')
  ), [update, status, followUp, stage, issue, item])

  const save = async (advance: boolean) => {
    if (saving || !dirty) return
    setSaving(true)
    setError(null)

    const clearFollowUp = (item.next_follow_up_date ?? '') !== '' && followUp === ''
    const clearIssue    = (item.issue ?? '') !== '' && issue.trim() === ''

    const { error: rpcErr } = await supabase.rpc('save_meeting_item_update', {
      p_item_id: item.id,
      p_latest_update: update.trim() || null,
      p_status: status !== item.status ? status : null,
      p_next_follow_up_date: followUp || null,
      p_issue: issue.trim() || null,
      p_current_stage: stage.trim() || null,
      p_responsible_department: null,
      p_clear_follow_up: clearFollowUp,
      p_clear_issue: clearIssue,
    })

    if (rpcErr) {
      logMeetingFailure('update-item', rpcErr)
      setError(meetingErrorMessage('update-item', rpcErr))
      setSaving(false)
      return
    }

    setSaving(false)
    if (advance) onSavedNext()
    else onSaved()
  }

  // Ctrl/Cmd+Enter from anywhere in the dialog. The keyboard path matters:
  // desktop is where these meetings are run.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      save(false)
    }
  }

  return (
    <MeetingModal
      title={item.sku}
      subtitle={`${item.product_name} · Order ${order.order_number}`}
      onClose={onClose}
      width={520}
    >
      <div onKeyDown={onKeyDown} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        {error && <MeetingModalError message={error} />}

        {/* What is on record right now — the commitment this entry replaces.
            It must be `item.latest_update`, NOT the `previousUpdate` prop: the
            prop is "what the CURRENT update replaced", which is the right thing
            on a table row (where the current value is shown directly above it)
            and the wrong thing here, one step too far back. Opening this dialog
            to write the third update was showing the first. */}
        <div style={{
          padding: '10px 12px', borderRadius: '8px',
          background: colors.raised, border: `1px solid ${colors.border}`,
        }}>
          <div style={{
            fontSize: '10px', fontWeight: 700, color: colors.muted,
            textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '4px',
          }}>
            Standing commitment
          </div>
          <div style={{ fontSize: '12.5px', color: item.latest_update ? colors.secondary : colors.muted, lineHeight: 1.45, whiteSpace: 'pre-wrap' }}>
            {item.latest_update ?? 'No update recorded yet — this is the first.'}
          </div>
          {/* One step further back, for the reader who wants the direction of
              travel rather than just the last line. */}
          {previousUpdate && (
            <div style={{ fontSize: '11.5px', color: colors.muted, marginTop: '6px', lineHeight: 1.4 }}>
              <span style={{ fontWeight: 600 }}>Before that: </span>{previousUpdate}
            </div>
          )}
          {item.next_follow_up_date && (
            <div style={{ fontSize: '11.5px', color: colors.muted, marginTop: '6px' }}>
              Committed follow-up: {formatMeetingDate(item.next_follow_up_date)}
            </div>
          )}
        </div>

        <MeetingField label="Latest Update">
          <textarea
            ref={updateRef}
            className="boe-input"
            rows={3}
            value={update}
            onChange={e => setUpdate(e.target.value)}
            placeholder="What moved since last time?"
            style={{ resize: 'none' }}
          />
        </MeetingField>

        <MeetingField label="Status" group>
          <div style={{ display: 'flex', gap: '6px' }}>
            {ITEM_STATUSES.map(s => {
              const meta = ITEM_STATUS_META[s]
              const selected = status === s
              return (
                <button
                  key={s}
                  onClick={() => setStatus(s)}
                  aria-pressed={selected}
                  style={{
                    flex: 1, padding: '7px 6px', borderRadius: '8px', cursor: 'pointer',
                    fontSize: '12.5px', fontWeight: selected ? 700 : 500,
                    border: `1px solid ${selected ? meta.color : colors.border}`,
                    background: selected ? meta.bg : 'transparent',
                    color: selected ? meta.color : colors.secondary,
                    transition: 'all 0.12s',
                  }}
                >
                  {meta.label}
                </button>
              )
            })}
          </div>
        </MeetingField>

        <MeetingField
          label="Next Follow-up"
          optional
          group
          hint={followUpDisabled
            ? 'A resolved item needs no follow-up — any date on it is cleared when you save.'
            : 'Leave empty if nothing needs chasing.'}
        >
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            <input
              ref={dateRef}
              type="date"
              aria-label="Next follow-up date"
              className="boe-input"
              value={followUpDisabled ? '' : followUp}
              disabled={followUpDisabled}
              min={earliestFollowUp}
              onChange={e => setFollowUp(e.target.value)}
              style={{ colorScheme: 'light', opacity: followUpDisabled ? 0.5 : 1 }}
            />
            {!followUpDisabled && followUp && (
              <button
                onClick={() => setFollowUp('')}
                className="boe-btn boe-btn-ghost"
                style={{ padding: '7px 12px', fontSize: '12px', flexShrink: 0 }}
              >
                Clear
              </button>
            )}
          </div>
        </MeetingField>

        {/* Stage, issue and department change rarely. Behind a disclosure so the
            three fields above stay the whole form for a routine update. */}
        {showMore ? (
          <>
            <MeetingField label="Current Stage" optional>
              <input
                className="boe-input"
                value={stage}
                onChange={e => setStage(e.target.value)}
                placeholder="e.g. Polishing, Packing"
              />
            </MeetingField>
            <MeetingField label="Issue or Blocker" optional>
              <textarea
                className="boe-input"
                rows={2}
                value={issue}
                onChange={e => setIssue(e.target.value)}
                placeholder="What is holding this up?"
                style={{ resize: 'none' }}
              />
            </MeetingField>
          </>
        ) : (
          <button
            onClick={() => setShowMore(true)}
            style={{
              alignSelf: 'flex-start', background: 'none', border: 'none', padding: 0,
              fontSize: '12px', fontWeight: 600, color: colors.blue, cursor: 'pointer',
            }}
          >
            More detail — stage and issue
          </button>
        )}

        <MeetingModalActions
          onClose={onClose}
          onSave={() => save(false)}
          saving={saving}
          disabled={!dirty}
          saveLabel="Save Update"
          secondary={hasNext ? (
            <button
              onClick={() => save(true)}
              disabled={saving || !dirty}
              className="boe-btn boe-btn-ghost"
              style={{ padding: '8px 14px', fontSize: '13px', opacity: saving || !dirty ? 0.5 : 1 }}
            >
              Save &amp; next SKU
            </button>
          ) : undefined}
        />

        <div style={{ fontSize: '11px', color: colors.muted, textAlign: 'right' }}>
          Ctrl + Enter saves
        </div>
      </div>
    </MeetingModal>
  )
}
