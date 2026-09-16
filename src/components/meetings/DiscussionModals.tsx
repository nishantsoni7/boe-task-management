'use client'

import { useEffect, useMemo, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { colors } from '@/lib/tokens'
import { MeetingBadge, MeetingModal, MeetingField, MeetingModalActions, MeetingModalError } from './MeetingModal'
import { logMeetingFailure, meetingErrorMessage } from '@/lib/meetings/errors'
import {
  AFTER_SALES_TAGS, AFTER_SALES_TAG_LABEL, DISCUSSION_CATEGORIES,
  DISCUSSION_CATEGORY_HELP, DISCUSSION_CATEGORY_META, categoryForMeetingType, meetingTypeForCategory,
  type AfterSalesTag, type DiscussionCategory, type MeetingDiscussionItem,
} from '@/lib/meetings/discussion'
import { formatMeetingDate, MEETING_TYPE_META, type Meeting } from '@/lib/meetings/types'

// The four dialogs the order-discussion workflow needs, all on the one form-modal
// shell every other Meetings dialog uses — so Escape, ✕ and Cancel close, a
// backdrop click does not, and a FAILED save keeps every value intact with the
// error inside the dialog.
//
// Each one submits exactly one RPC, and each RPC authorizes for itself. Nothing
// here decides a permission: the caller decides whether to RENDER the dialog, the
// database decides whether the write happens.

// ─── The category picker, shared by every form that captures an issue ─────────

/**
 * Two buttons and a help line, not a dropdown. It is the one decision the person
 * has to make and it must be answerable without reading a manual — so the
 * dividing line (has it shipped?) is printed underneath the choice.
 *
 * Changing the category to Running Order CLEARS the after-sales tag, because the
 * database refuses that pairing (the
 * `meeting_discussion_items_tag_is_after_sales_only` CHECK). Clearing it here
 * means the user never sees a refusal for a field they cannot see.
 */
export function CategoryPicker({
  category, onChange, disabled,
}: {
  category: DiscussionCategory
  onChange: (next: DiscussionCategory) => void
  disabled?: boolean
}) {
  return (
    <>
      <div style={{ display: 'flex', gap: '6px' }}>
        {DISCUSSION_CATEGORIES.map(key => {
          const meta = DISCUSSION_CATEGORY_META[key]
          const selected = category === key
          return (
            <button
              key={key}
              type="button"
              aria-pressed={selected}
              disabled={disabled}
              onClick={() => onChange(key)}
              style={{
                flex: 1, padding: '9px 6px', borderRadius: '8px', cursor: 'pointer',
                fontSize: '12.5px', fontWeight: selected ? 700 : 500,
                border: `1px solid ${selected ? meta.color : colors.border}`,
                background: selected ? meta.bg : 'transparent',
                color: selected ? meta.color : colors.secondary,
              }}
            >
              {meta.label}
            </button>
          )
        })}
      </div>
      <p style={{ margin: '2px 0 0', fontSize: '11px', color: colors.muted, lineHeight: 1.5 }}>
        {DISCUSSION_CATEGORY_HELP[category]}
      </p>
    </>
  )
}

export function AfterSalesTagPicker({
  tag, onChange, disabled,
}: {
  tag: AfterSalesTag | null
  onChange: (next: AfterSalesTag | null) => void
  disabled?: boolean
}) {
  return (
    <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
      {AFTER_SALES_TAGS.map(key => {
        const selected = tag === key
        return (
          <button
            key={key}
            type="button"
            aria-pressed={selected}
            disabled={disabled}
            onClick={() => onChange(selected ? null : key)}
            style={{
              flex: '1 1 84px', padding: '6px 8px', borderRadius: '7px', cursor: 'pointer',
              fontSize: '12px', fontWeight: selected ? 700 : 500,
              border: `1px solid ${selected ? colors.borderMed : colors.border}`,
              background: selected ? colors.float : 'transparent',
              color: selected ? colors.primary : colors.secondary,
            }}
          >
            {AFTER_SALES_TAG_LABEL[key]}
          </button>
        )
      })}
    </div>
  )
}

// ─── New issue, from inside a meeting ────────────────────────────────────────

/**
 * The same capture RPC Task Detail calls, with the meeting already known. There is
 * no source task on this path: the issue was raised in the room.
 */
export function NewDiscussionItemModal({
  supabase, meeting, onClose, onSaved,
}: {
  supabase: SupabaseClient
  meeting: Meeting
  onClose: () => void
  onSaved: (message: string) => void
}) {
  // Fixed by the meeting being run, not chosen: a New Order review holds Running
  // Order issues and a Repair Order review holds After Sales ones, and the database
  // refuses any other pairing. An issue of the other kind is raised from its task,
  // or waits in the Meeting Inbox for its own review.
  const category: DiscussionCategory = categoryForMeetingType(meeting.meeting_type)
  const [tag, setTag]           = useState<AfterSalesTag | null>(null)
  const [orderNumber, setOrder] = useState('')
  const [customer, setCustomer] = useState('')
  const [issue, setIssue]       = useState('')
  const [details, setDetails]   = useState('')
  const [saving, setSaving]     = useState(false)
  const [error, setError]       = useState<string | null>(null)

  const canSubmit = orderNumber.trim() !== '' && issue.trim() !== ''

  const save = async () => {
    if (!canSubmit || saving) return
    setSaving(true)
    setError(null)

    const { error: rpcError } = await supabase.rpc('capture_meeting_discussion_item', {
      p_category: category,
      p_order_number: orderNumber.trim(),
      p_title: issue.trim(),
      p_meeting_id: meeting.id,
      p_customer_name: customer.trim() || null,
      p_after_sales_tag: category === 'after_sales' ? tag : null,
      p_details: details.trim() || null,
      p_source_task_id: null,
    })

    if (rpcError) {
      logMeetingFailure('capture-discussion', rpcError)
      setError(meetingErrorMessage('capture-discussion', rpcError))
      setSaving(false)
      return
    }

    setSaving(false)
    onSaved('Discussion item added to this meeting')
  }

  return (
    <MeetingModal
      title="New Discussion Item"
      subtitle={`${meeting.title} · ${formatMeetingDate(meeting.meeting_date)}`}
      onClose={onClose}
      width={520}
    >
      {error && <MeetingModalError message={error} />}

      <MeetingField label="Category" group>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <MeetingBadge meta={DISCUSSION_CATEGORY_META[category]} />
          <span style={{ fontSize: '11.5px', color: colors.muted }}>
            Set by this {MEETING_TYPE_META[meeting.meeting_type].label} review
          </span>
        </div>
        <p style={{ margin: '2px 0 0', fontSize: '11px', color: colors.muted, lineHeight: 1.5 }}>
          {DISCUSSION_CATEGORY_HELP[category]}
        </p>
      </MeetingField>

      {category === 'after_sales' && (
        <MeetingField label="After Sales type" optional group hint="A quick label. Not a separate category.">
          <AfterSalesTagPicker tag={tag} onChange={setTag} disabled={saving} />
        </MeetingField>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
        <MeetingField label="Order Number">
          <input
            className="boe-input"
            value={orderNumber}
            disabled={saving}
            onChange={e => setOrder(e.target.value)}
            placeholder="e.g. 2041"
          />
        </MeetingField>
        <MeetingField label="Customer" optional>
          <input
            className="boe-input"
            value={customer}
            disabled={saving}
            onChange={e => setCustomer(e.target.value)}
          />
        </MeetingField>
      </div>

      <MeetingField label="Short issue" hint="One line the board can show. The detail goes below.">
        <input
          className="boe-input"
          value={issue}
          disabled={saving}
          onChange={e => setIssue(e.target.value)}
          placeholder="What is the problem?"
        />
      </MeetingField>

      <MeetingField label="Details" optional>
        <textarea
          className="boe-input"
          rows={3}
          value={details}
          disabled={saving}
          onChange={e => setDetails(e.target.value)}
          style={{ resize: 'vertical' }}
        />
      </MeetingField>

      <MeetingModalActions
        onClose={onClose}
        onSave={save}
        saving={saving}
        disabled={!canSubmit}
        saveLabel="Add to Meeting"
      />
    </MeetingModal>
  )
}

// ─── Resolve ─────────────────────────────────────────────────────────────────

/**
 * The note is mandatory, and that is a business rule rather than a form
 * preference: an issue that ran through five meetings and then simply stopped
 * appearing is the exact failure this workflow exists to prevent. The database
 * refuses a blank note too.
 */
export function ResolveDiscussionModal({
  supabase, appearanceId, item, onClose, onResolved,
}: {
  supabase: SupabaseClient
  appearanceId: string
  item: MeetingDiscussionItem
  onClose: () => void
  onResolved: (message: string) => void
}) {
  const [note, setNote]     = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState<string | null>(null)

  const save = async () => {
    if (note.trim() === '' || saving) return
    setSaving(true)
    setError(null)

    const { error: rpcError } = await supabase.rpc('resolve_meeting_discussion_item', {
      p_appearance_id: appearanceId,
      p_note: note.trim(),
    })

    if (rpcError) {
      logMeetingFailure('resolve-discussion', rpcError)
      setError(meetingErrorMessage('resolve-discussion', rpcError))
      setSaving(false)
      return
    }

    setSaving(false)
    onResolved('Discussion item resolved')
  }

  return (
    <MeetingModal
      title="Resolve this issue"
      subtitle={`${item.order_number} · ${item.title}`}
      onClose={onClose}
      width={480}
    >
      {error && <MeetingModalError message={error} />}

      <p style={{ margin: 0, fontSize: '12.5px', color: colors.secondary, lineHeight: 1.6 }}>
        Resolving stops this issue appearing in future meetings. Every earlier meeting, update and
        image stays exactly as it is, and the note below is recorded against your name.
      </p>

      <MeetingField label="How was it resolved?" hint="One line. Required — this is what the record will say.">
        <textarea
          className="boe-input"
          rows={3}
          autoFocus
          value={note}
          disabled={saving}
          onChange={e => setNote(e.target.value)}
          placeholder="e.g. Repair completed and accepted on site on 14 Sep."
          style={{ resize: 'vertical' }}
        />
      </MeetingField>

      <MeetingModalActions
        onClose={onClose}
        onSave={save}
        saving={saving}
        disabled={note.trim() === ''}
        saveLabel="Resolve"
      />
    </MeetingModal>
  )
}

// ─── Reopen ──────────────────────────────────────────────────────────────────

/**
 * Keyed on the ITEM, not on an appearance: the meeting that resolved an issue is
 * usually completed by the time somebody discovers the repair did not hold, and
 * that completed meeting must stay read-only. Nothing in it changes — the reopen
 * writes to the issue.
 */
export function ReopenDiscussionModal({
  supabase, item, onClose, onReopened,
}: {
  supabase: SupabaseClient
  item: MeetingDiscussionItem
  onClose: () => void
  onReopened: (message: string) => void
}) {
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState<string | null>(null)

  const save = async () => {
    if (reason.trim() === '' || saving) return
    setSaving(true)
    setError(null)

    const { error: rpcError } = await supabase.rpc('reopen_meeting_discussion_item', {
      p_item_id: item.id,
      p_reason: reason.trim(),
    })

    if (rpcError) {
      logMeetingFailure('reopen-discussion', rpcError)
      setError(meetingErrorMessage('reopen-discussion', rpcError))
      setSaving(false)
      return
    }

    setSaving(false)
    onReopened('Discussion item reopened')
  }

  return (
    <MeetingModal
      title="Reopen this issue"
      subtitle={`${item.order_number} · ${item.title}`}
      onClose={onClose}
      width={480}
    >
      {error && <MeetingModalError message={error} />}

      <p style={{ margin: 0, fontSize: '12.5px', color: colors.secondary, lineHeight: 1.6 }}>
        The same issue returns to Open and becomes eligible for the next meeting. The earlier
        history, including the resolution recorded before, is kept unchanged.
      </p>

      {item.resolution_note && (
        <div style={{
          padding: '9px 12px', borderRadius: '8px', background: colors.raised,
          border: `1px solid ${colors.border}`, fontSize: '12px', color: colors.secondary, lineHeight: 1.55,
        }}>
          <strong style={{ fontWeight: 600, color: colors.primary }}>Resolved earlier as: </strong>
          {item.resolution_note}
        </div>
      )}

      <MeetingField label="Why is it being reopened?" hint="One line. Required, and recorded against your name.">
        <textarea
          className="boe-input"
          rows={3}
          autoFocus
          value={reason}
          disabled={saving}
          onChange={e => setReason(e.target.value)}
          placeholder="e.g. Customer reports the same fault again."
          style={{ resize: 'vertical' }}
        />
      </MeetingField>

      <MeetingModalActions
        onClose={onClose}
        onSave={save}
        saving={saving}
        disabled={reason.trim() === ''}
        saveLabel="Reopen"
      />
    </MeetingModal>
  )
}

// ─── Attach an Inbox item to a meeting ───────────────────────────────────────

type MeetingOption = Pick<Meeting, 'id' | 'title' | 'meeting_date' | 'meeting_type' | 'status'>

/**
 * The manual half of the Meeting Inbox. Automatic carry-forward already brings an
 * Inbox item into the next relevant meeting when that meeting is CREATED; this is
 * for the meeting that already exists.
 *
 * The list is the live meetings this person can actually write to — RLS narrows it
 * to meetings they may see, and the RPC refuses any they may not edit, so a
 * refusal here is a bug in the list rather than a surprise for the user. A
 * completed meeting is never offered: it is read-only.
 */
export function AttachDiscussionItemModal({
  supabase, item, onClose, onAttached,
}: {
  supabase: SupabaseClient
  item: MeetingDiscussionItem
  onClose: () => void
  onAttached: (message: string, meetingId: string) => void
}) {
  const [meetings, setMeetings] = useState<MeetingOption[] | null>(null)
  const [chosen, setChosen]     = useState('')
  const [saving, setSaving]     = useState(false)
  const [error, setError]       = useState<string | null>(null)

  // Only the review this category belongs in. The database refuses any other
  // pairing, so a meeting of the other type is not offered at all.
  const preferredType = useMemo(() => meetingTypeForCategory(item.category), [item.category])

  useEffect(() => {
    let active = true
    supabase
      .from('meetings')
      .select('id, title, meeting_date, meeting_type, status')
      .in('status', ['draft', 'in_progress'])
      .eq('meeting_type', preferredType)
      .order('meeting_date', { ascending: true })
      .then(({ data, error: loadError }) => {
        if (!active) return
        if (loadError) { setMeetings([]); setError(meetingErrorMessage('attach-discussion', loadError)); return }
        const rows = (data ?? []) as MeetingOption[]
        setMeetings(rows)
        if (rows.length > 0) setChosen(rows[0].id)
      })
    return () => { active = false }
  }, [supabase, preferredType])

  const save = async () => {
    if (chosen === '' || saving) return
    setSaving(true)
    setError(null)

    const { error: rpcError } = await supabase.rpc('attach_meeting_discussion_item', {
      p_meeting_id: chosen,
      p_item_id: item.id,
    })

    if (rpcError) {
      logMeetingFailure('attach-discussion', rpcError)
      setError(meetingErrorMessage('attach-discussion', rpcError))
      setSaving(false)
      return
    }

    setSaving(false)
    onAttached('Added to the meeting agenda', chosen)
  }

  return (
    <MeetingModal
      title="Add to a meeting"
      subtitle={`${item.order_number} · ${item.title}`}
      onClose={onClose}
      width={480}
    >
      {error && <MeetingModalError message={error} />}

      {meetings === null ? (
        <p style={{ margin: 0, fontSize: '12.5px', color: colors.muted }}>Loading meetings…</p>
      ) : meetings.length === 0 ? (
        <p style={{ margin: 0, fontSize: '12.5px', color: colors.secondary, lineHeight: 1.6 }}>
          There is no live meeting to add this to. It will stay in the Meeting Inbox and be brought
          into the next {MEETING_TYPE_META[preferredType].label} review as soon as one is created.
        </p>
      ) : (
        <MeetingField label="Meeting" hint="Live meetings only. A completed meeting is read-only.">
          <select
            className="boe-input"
            value={chosen}
            disabled={saving}
            onChange={e => setChosen(e.target.value)}
          >
            {meetings.map(meeting => (
              <option key={meeting.id} value={meeting.id}>
                {meeting.title} — {formatMeetingDate(meeting.meeting_date)}
              </option>
            ))}
          </select>
        </MeetingField>
      )}

      <MeetingModalActions
        onClose={onClose}
        onSave={save}
        saving={saving}
        disabled={chosen === ''}
        saveLabel="Add to Meeting"
      />
    </MeetingModal>
  )
}
