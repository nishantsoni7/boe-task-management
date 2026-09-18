'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  ArrowLeft, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, ExternalLink,
  ImagePlus, Layers, Lock, Plus, RotateCcw, X,
} from 'lucide-react'
import { colors } from '@/lib/tokens'
import { MeetingBadge } from './MeetingModal'
import { EvidenceThumbs } from './EvidenceThumbs'
import { logMeetingFailure, meetingErrorMessage } from '@/lib/meetings/errors'
import {
  MEETING_EVIDENCE_ACCEPT, MEETING_EVIDENCE_BUCKET, MEETING_EVIDENCE_MAX_PER_SAVE,
  MEETING_EVIDENCE_TYPES_LABEL, buildEvidencePath, evidenceDisplayName,
  evidenceSaveOutcome, evidenceUploadErrorMessage, prepareEvidenceFile, resolveEvidenceType,
  type EvidenceExt, type EvidenceMime,
} from '@/lib/meetings/evidence'
import {
  AFTER_SALES_TAG_LABEL, DISCUSSION_CATEGORY_META, DISCUSSION_EVENT_LABEL,
  DISCUSSION_STATE_META, earlierDiscussionHistory,
  type DiscussionMeetingGroup, type DiscussionRow, type MeetingDiscussionEvent,
} from '@/lib/meetings/discussion'
import {
  formatMeetingDate, formatMeetingTimestamp, type LinkedTask, type Meeting,
} from '@/lib/meetings/types'

// One ISSUE's workspace inside a meeting.
//
// It is laid out for the sequence a review is actually conducted in:
//
//   1. what is this?          order, customer, category, the issue, where it came from
//   2. record today           update, decision, next review, a screenshot — ONE Save,
//                             inline, always visible on desktop
//   3. what came out of it?   the follow-up tasks, read live from Task Management
//   4. what was said before?  the same issue in earlier meetings, newest first,
//                             read-only
//   5. is it finished?        Resolve, or leave it Open and it moves forward
//
// THE ONE DESIGN RULE THIS FILE EXISTS TO KEEP: the composer is INLINE. A live
// meeting cannot depend on opening and closing a dialog for every item — that is
// the friction that makes people stop recording and start remembering. On mobile
// it is the same composer in the same place, simply stacked.
//
// It writes only to THIS meeting's appearance row. Earlier meetings are read-only
// here and nothing on this screen can change one.

type Props = {
  supabase: SupabaseClient
  meeting: Meeting
  row: DiscussionRow
  /** This meeting's events for this issue, oldest first. */
  events: MeetingDiscussionEvent[]
  /** This issue's whole thread, newest meeting first. Includes this meeting. */
  history: DiscussionMeetingGroup[]
  /** Linked tasks the CURRENT VIEWER may read. A task absent here is never linked. */
  readableTasks: Record<string, LinkedTask>
  editable: boolean
  canReopen: boolean
  isMobile: boolean
  /** 1-based place on the agenda, for the stepper. */
  index: number
  total: number
  onBoard: () => void
  onPrev?: () => void
  onNext?: () => void
  /** Reload the meeting. `message` is the toast, or null when the composer said it. */
  onSaved: (message: string | null) => Promise<void>
  onResolve: () => void
  onReopen: () => void
  onCreateTask?: () => void
  onOpenTask: (taskId: string) => void
  /** The Order's GENERAL history in this meeting, when the Order is on the rail. */
  onOpenOrder?: () => void
  /** Whoever raised the issue may be shown; the task itself only if readable. */
  sourceTask?: LinkedTask | null
}

const FIELD_LABEL: React.CSSProperties = {
  fontSize: '11px', fontWeight: 600, color: colors.muted,
  textTransform: 'uppercase', letterSpacing: '0.05em',
}

export function DiscussionWorkspace({
  supabase, meeting, row, events, history, readableTasks, editable, canReopen, isMobile,
  index, total, onBoard, onPrev, onNext, onSaved, onResolve, onReopen, onCreateTask,
  onOpenTask, onOpenOrder, sourceTask,
}: Props) {
  const { item, appearance } = row
  // What THIS meeting recorded. For a completed meeting that is its state at
  // completion, replayed from the trail; for a live meeting it is the state now.
  const resolved = row.recordedState === 'resolved'
  // The issue as it stands today, which can differ only for a completed meeting.
  const resolvedNow = item.state === 'resolved'
  // This meeting's own group is rendered inline above. "Earlier" is strictly
  // earlier: this meeting and every later one are left out.
  const earlier = earlierDiscussionHistory(history, meeting)

  return (
    <div>
      <Header
        row={row}
        index={index}
        total={total}
        onBoard={onBoard}
        onPrev={onPrev}
        onNext={onNext}
        onOpenOrder={onOpenOrder}
        sourceTask={sourceTask}
        sourceTaskId={item.source_task_id}
        onOpenTask={onOpenTask}
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '12px' }}>

        {/* ── 1. This meeting ── */}
        <Panel>
          <PanelHeading
            title="This meeting"
            detail={`${formatMeetingDate(meeting.meeting_date)} · ${meeting.title}`}
          />

          {resolved ? (
            <Banner tone="success">
              {/* From the resolution EVENT in force at this meeting, not the item's
                  resolved_* columns — a later reopen clears those, and this meeting
                  must still say who resolved it, when, and why. */}
              <div>
                Resolved{row.resolution?.actor_name ? ` by ${row.resolution.actor_name}` : ''}
                {row.resolution ? ` on ${formatMeetingTimestamp(row.resolution.created_at)}` : ''}.
                {!row.changedSince && ' It will not appear in future meetings.'}
                {row.resolution?.detail && (
                  <div style={{ marginTop: '5px', fontWeight: 600 }}>{row.resolution.detail}</div>
                )}
              </div>
            </Banner>
          ) : editable ? (
            <DiscussionComposer
              supabase={supabase}
              appearance={appearance}
              isMobile={isMobile}
              onSaved={onSaved}
            />
          ) : (
            <Banner tone="muted">
              <Lock size={12} strokeWidth={2} style={{ flexShrink: 0 }} aria-hidden="true" />
              {meeting.status === 'completed'
                ? 'This meeting is completed and read-only. Reopen the meeting to correct the record.'
                : 'You can read this meeting, but not record in it.'}
            </Banner>
          )}

          {row.changedSince && (
            <SinceNote resolvedNow={resolvedNow} />
          )}

          {(appearance.latest_update || appearance.decision || appearance.next_review_date) && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={FIELD_LABEL}>Recorded in this meeting</div>
              {appearance.latest_update && (
                <Quote label="Latest position">{appearance.latest_update}</Quote>
              )}
              {appearance.decision && (
                <Quote label="Decision" accent={colors.green}>{appearance.decision}</Quote>
              )}
              {appearance.next_review_date && (
                <div style={{ fontSize: '12px', color: colors.secondary }}>
                  Next review <strong style={{ fontWeight: 600 }}>
                    {formatMeetingDate(appearance.next_review_date)}
                  </strong>
                </div>
              )}
            </div>
          )}

          {events.length > 0 && (
            <div>
              <div style={{ ...FIELD_LABEL, marginBottom: '6px' }}>What happened, in order</div>
              <EventList events={events} />
            </div>
          )}

          {row.evidenceCount > 0 && (
            <div>
              <div style={{ ...FIELD_LABEL, marginBottom: '6px' }}>
                Evidence · {row.evidenceCount} image{row.evidenceCount === 1 ? '' : 's'}
              </div>
              <EvidenceThumbs
                supabase={supabase}
                items={history.find(g => g.appearanceId === appearance.id)?.evidence ?? []}
              />
            </div>
          )}
        </Panel>

        {/* ── 2. Follow-up work ── */}
        <Panel>
          <PanelHeading
            title="Follow-up tasks"
            detail="Owner, due date and completion live in Tasks. This screen only shows where they stand."
          />
          <LinkedTasks
            taskIds={row.linkedTaskIds}
            readableTasks={readableTasks}
            onOpenTask={onOpenTask}
          />
          {onCreateTask && (
            <button
              type="button"
              onClick={onCreateTask}
              className="boe-btn boe-btn-ghost"
              style={{
                alignSelf: 'flex-start', padding: '6px 12px', fontSize: '12px',
                display: 'flex', alignItems: 'center', gap: '5px',
              }}
            >
              <Plus size={13} strokeWidth={2.2} /> Create a follow-up task
            </button>
          )}
        </Panel>

        {/* ── 3. Earlier meetings ── */}
        <EarlierMeetings supabase={supabase} groups={earlier} readableTasks={readableTasks} onOpenTask={onOpenTask} />

        {/* ── 4. Finish, or leave it open ── */}
        {/* Acts on the issue as it stands NOW. In a live meeting that is the same as
            what the meeting records; in a completed one it may not be, which is why
            this panel says "currently" and the panel above says "in this meeting". */}
        {(editable || (canReopen && resolvedNow)) && (
          <Panel>
            <PanelHeading
              title={resolvedNow ? 'This issue is currently resolved' : 'Is this issue finished?'}
              detail={resolvedNow
                ? 'Reopening returns the same item to Open and keeps the earlier history, including this meeting, unchanged.'
                : 'Leave it Open and it appears in the next meeting of this type on its own. Resolve it and it stops.'}
            />
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {!resolvedNow && editable && (
                <button
                  type="button"
                  onClick={onResolve}
                  className="boe-btn boe-btn-primary"
                  style={{ padding: '8px 15px', fontSize: '12.5px', display: 'flex', alignItems: 'center', gap: '6px' }}
                >
                  <CheckCircle2 size={14} strokeWidth={2} /> Mark Resolved
                </button>
              )}
              {resolvedNow && canReopen && (
                <button
                  type="button"
                  onClick={onReopen}
                  className="boe-btn boe-btn-ghost"
                  style={{ padding: '8px 15px', fontSize: '12.5px', display: 'flex', alignItems: 'center', gap: '6px' }}
                >
                  <RotateCcw size={14} strokeWidth={2} /> Reopen
                </button>
              )}
              {!resolvedNow && (
                <span style={{ fontSize: '12px', color: colors.muted, alignSelf: 'center' }}>
                  Still open — this moves to the next review automatically.
                </span>
              )}
            </div>
          </Panel>
        )}
      </div>
    </div>
  )
}

// ─── Header ───────────────────────────────────────────────────────────────────

function Header({
  row, index, total, onBoard, onPrev, onNext, onOpenOrder, sourceTask, sourceTaskId, onOpenTask,
}: {
  row: DiscussionRow
  index: number
  total: number
  onBoard: () => void
  onPrev?: () => void
  onNext?: () => void
  onOpenOrder?: () => void
  sourceTask?: LinkedTask | null
  sourceTaskId: string | null
  onOpenTask: (taskId: string) => void
}) {
  const { item, appearance } = row
  const meta = DISCUSSION_CATEGORY_META[item.category]

  return (
    <div style={{
      background: colors.base, border: `1px solid ${colors.border}`,
      borderLeft: `3px solid ${meta.color}`,
      borderRadius: '10px', padding: '10px 15px 13px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={onBoard}
          style={{
            display: 'flex', alignItems: 'center', gap: '4px', padding: '4px 8px 4px 0',
            background: 'none', border: 'none', cursor: 'pointer',
            fontSize: '12.5px', fontWeight: 600, color: colors.secondary,
          }}
        >
          <ArrowLeft size={14} strokeWidth={2} /> Meeting board
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
          <span style={{ fontSize: '11.5px', color: colors.muted, marginRight: '3px' }}>
            Item {index} of {total}
          </span>
          <IconAction label="Previous item" onClick={() => onPrev?.()} disabled={!onPrev}>
            <ChevronLeft size={14} strokeWidth={2} />
          </IconAction>
          <IconAction label="Next item" onClick={() => onNext?.()} disabled={!onNext}>
            <ChevronRight size={14} strokeWidth={2} />
          </IconAction>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '7px', flexWrap: 'wrap', marginTop: '4px' }}>
        <MeetingBadge meta={meta} />
        {item.after_sales_tag && (
          <span style={{ fontSize: '11.5px', color: colors.muted }}>
            {AFTER_SALES_TAG_LABEL[item.after_sales_tag]}
          </span>
        )}
        <span className="meeting-discussion-sr-only">In this meeting:</span>
        <MeetingBadge meta={DISCUSSION_STATE_META[row.recordedState]} />
        {row.changedSince && (
          <span style={{ fontSize: '11.5px', color: colors.muted }}>
            Now {DISCUSSION_STATE_META[item.state].label}
          </span>
        )}
        {appearance.carried_from_id && (
          <span style={{ fontSize: '11.5px', color: colors.muted }}>
            Carried forward from the previous review
          </span>
        )}
      </div>

      <h2 style={{
        margin: '6px 0 0', fontSize: '17px', fontWeight: 700, color: colors.primary,
        letterSpacing: '-0.01em', lineHeight: 1.35,
      }}>
        {item.title}
      </h2>

      <div style={{ fontSize: '12.5px', color: colors.muted, marginTop: '3px' }}>
        Order <strong style={{ fontWeight: 700, color: colors.secondary }}>{item.order_number}</strong>
        {item.customer_name ? ` · ${item.customer_name}` : ' · No customer recorded'}
      </div>

      {item.details && (
        <p style={{
          margin: '8px 0 0', fontSize: '12.5px', color: colors.secondary,
          lineHeight: 1.55, whiteSpace: 'pre-wrap',
        }}>
          {item.details}
        </p>
      )}

      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '9px', alignItems: 'center' }}>
        {/* THE SOURCE TASK. A link appears only when the task came back from a
            read made under THIS viewer's own permissions. A meeting viewer who
            cannot see the task is told the issue came from one — which is honest
            context — and gets no route to it. */}
        {sourceTaskId && (sourceTask ? (
          <button
            type="button"
            onClick={() => onOpenTask(sourceTaskId)}
            style={LINK_BUTTON}
          >
            <ExternalLink size={12} strokeWidth={2.2} aria-hidden="true" />
            Raised from task: {sourceTask.title}
          </button>
        ) : (
          <span style={{ fontSize: '11.5px', color: colors.muted }}>
            Raised from a task you do not have access to
          </span>
        ))}
        {onOpenOrder && (
          <button type="button" onClick={onOpenOrder} style={LINK_BUTTON}>
            <Layers size={12} strokeWidth={2.2} aria-hidden="true" />
            Order {item.order_number} — general history
          </button>
        )}
      </div>
    </div>
  )
}

const LINK_BUTTON: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: '4px',
  background: 'none', border: 'none', cursor: 'pointer', padding: '2px 0',
  fontSize: '11.5px', fontWeight: 600, color: colors.blue, textAlign: 'left',
}

function IconAction({
  label, onClick, disabled, children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 26, height: 26, borderRadius: '7px',
        border: `1px solid ${colors.border}`, background: colors.base,
        color: disabled ? colors.muted : colors.secondary,
        cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  )
}

// ─── The inline composer ──────────────────────────────────────────────────────

type StagedState = 'preparing' | 'ready' | 'uploading' | 'recording' | 'failed'

type Staged = {
  id: string
  name: string
  preview: string
  state: StagedState
  file: File | null
  mime: EvidenceMime | null
  ext: EvidenceExt | null
  error: string | null
}

const STAGE_LABEL: Record<StagedState, string> = {
  preparing: 'Preparing…',
  ready: 'Ready to attach',
  uploading: 'Uploading…',
  recording: 'Recording…',
  failed: 'Not attached',
}

/**
 * Today's update, the decision, the next review date and any images — one Save.
 *
 * The order of operations is the promise, and it is the same one
 * OrderDiscussion's composer makes:
 *
 *   1. the UPDATE first, so a refused update uploads nothing at all;
 *   2. then, per image: get the Order folder, upload, RECORD. An image is
 *      evidence only once the RPC has verified and recorded it, and anything
 *      short of that has its stray object removed and is reported as not
 *      attached.
 */
function DiscussionComposer({
  supabase, appearance, isMobile, onSaved,
}: {
  supabase: SupabaseClient
  appearance: DiscussionRow['appearance']
  isMobile: boolean
  onSaved: (message: string | null) => Promise<void>
}) {
  const [update, setUpdate]     = useState('')
  const [decision, setDecision] = useState(appearance.decision ?? '')
  const [review, setReview]     = useState(appearance.next_review_date ?? '')
  const [staged, setStaged]     = useState<Staged[]>([])
  const [busy, setBusy]         = useState(false)
  const [notice, setNotice]     = useState<{ tone: 'success' | 'error'; message: string } | null>(null)

  const fileInput = useRef<HTMLInputElement>(null)
  const previews  = useRef(new Set<string>())

  useEffect(() => {
    const owned = previews.current
    return () => {
      for (const url of owned) URL.revokeObjectURL(url)
      owned.clear()
    }
  }, [])

  const patch = useCallback((id: string, next: Partial<Staged>) => {
    setStaged(prev => prev.map(s => (s.id === id ? { ...s, ...next } : s)))
  }, [])

  const drop = (target: Staged) => {
    URL.revokeObjectURL(target.preview)
    previews.current.delete(target.preview)
    setStaged(prev => prev.filter(s => s.id !== target.id))
  }

  const stageFiles = (files: File[]) => {
    if (busy || files.length === 0) return

    const refused: string[] = []
    const images = files.filter(file => {
      if (resolveEvidenceType(file)) return true
      refused.push(file.name || 'file')
      return false
    })
    const room = Math.max(0, MEETING_EVIDENCE_MAX_PER_SAVE - staged.length)
    const accepted = images.slice(0, room)

    const problems: string[] = []
    if (refused.length > 0) {
      problems.push(`${refused.join(', ')}: only ${MEETING_EVIDENCE_TYPES_LABEL} images can be attached.`)
    }
    if (images.length > room) {
      problems.push(`Up to ${MEETING_EVIDENCE_MAX_PER_SAVE} images can be attached in one save.`)
    }
    setNotice(problems.length > 0 ? { tone: 'error', message: problems.join(' ') } : null)
    if (accepted.length === 0) return

    const added: Staged[] = accepted.map(file => {
      const preview = URL.createObjectURL(file)
      previews.current.add(preview)
      return {
        id: crypto.randomUUID(), name: file.name || 'Pasted image', preview,
        state: 'preparing', file: null, mime: null, ext: null, error: null,
      }
    })
    setStaged(prev => [...prev, ...added])

    accepted.forEach((file, position) => {
      const target = added[position]
      void prepareEvidenceFile(file).then(result => {
        if (result.ok) {
          patch(target.id, { state: 'ready', file: result.file, mime: result.mime, ext: result.ext })
        } else {
          drop(target)
          setNotice({ tone: 'error', message: `${target.name}: ${result.error}` })
        }
      })
    })
  }

  const updateText    = update.trim()
  const decisionText  = decision.trim()
  const decisionMoved = decisionText !== (appearance.decision ?? '').trim()
  // Emptying a recorded decision is a deliberate act, sent as its own flag: the
  // database reads a NULL decision as "leave it alone", never as "remove it".
  const clearsDecision = decisionMoved && decisionText === ''
  const reviewMoved   = review !== (appearance.next_review_date ?? '')
  const writesUpdate  = updateText !== '' || decisionMoved || reviewMoved
  const attachable    = staged.filter(s => (s.state === 'ready' || s.state === 'failed') && s.file && s.mime && s.ext)
  const preparing     = staged.some(s => s.state === 'preparing')
  const canSave       = !busy && !preparing && (writesUpdate || attachable.length > 0)

  const save = async () => {
    if (!canSave) return
    setBusy(true)
    setNotice(null)

    let updateSaved = false
    if (writesUpdate) {
      const { error } = await supabase.rpc('save_meeting_discussion_update', {
        p_appearance_id: appearance.id,
        p_update: updateText || null,
        p_decision: decisionMoved && !clearsDecision ? decisionText : null,
        p_next_review_date: review || null,
        p_clear_next_review: (appearance.next_review_date ?? '') !== '' && review === '',
        p_clear_decision: clearsDecision,
      })
      if (error) {
        logMeetingFailure('update-discussion', error)
        setNotice({ tone: 'error', message: meetingErrorMessage('update-discussion', error) })
        setBusy(false)
        return
      }
      updateSaved = true
      setUpdate('')
    }

    let attached = 0
    let failed = 0

    if (attachable.length > 0) {
      // The private bucket authorizes on the first path segment, which is the
      // Order's row in THIS meeting — created on demand, so an agenda of twelve
      // inherited issues does not put twelve orders on the Order rail up front.
      const { data: orderId, error: folderError } = await supabase.rpc(
        'ensure_meeting_discussion_order', { p_appearance_id: appearance.id },
      )
      if (folderError || typeof orderId !== 'string') {
        logMeetingFailure('add-evidence', folderError ?? { message: 'no order id returned' })
        setNotice({ tone: 'error', message: meetingErrorMessage('add-evidence', folderError ?? {}) })
        if (updateSaved) await onSaved(null)
        setBusy(false)
        return
      }

      const bucket = supabase.storage.from(MEETING_EVIDENCE_BUCKET)
      for (const target of attachable) {
        // A fresh key per attempt, so a retry never collides with an earlier one.
        const path = buildEvidencePath(orderId, target.ext!)
        patch(target.id, { state: 'uploading', error: null })

        const { error: uploadError } = await bucket.upload(path, target.file!, {
          contentType: target.mime!, upsert: false, cacheControl: '3600',
        })
        if (uploadError) {
          failed += 1
          patch(target.id, { state: 'failed', error: evidenceUploadErrorMessage(uploadError) })
          continue
        }

        patch(target.id, { state: 'recording' })
        const { error: recordError } = await supabase.rpc('add_meeting_discussion_evidence', {
          p_appearance_id: appearance.id,
          p_storage_path: path,
          p_file_name: evidenceDisplayName(target.name),
        })
        if (recordError) {
          logMeetingFailure('add-evidence', recordError)
          // Permitted only because no evidence row references this object.
          await bucket.remove([path])
          failed += 1
          patch(target.id, { state: 'failed', error: meetingErrorMessage('add-evidence', recordError) })
          continue
        }

        attached += 1
        drop(target)
      }
    }

    const outcome = evidenceSaveOutcome({ updateSaved, attached, failed })
    if (failed > 0) setNotice(outcome)
    if (updateSaved || attached > 0) await onSaved(failed > 0 ? null : outcome.message)
    setBusy(false)
  }

  return (
    <div
      onPaste={e => {
        const files = Array.from(e.clipboardData?.files ?? [])
        if (files.length === 0) return
        e.preventDefault()
        stageFiles(files)
      }}
      onDragOver={e => { if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) e.preventDefault() }}
      onDrop={e => {
        const files = Array.from(e.dataTransfer?.files ?? [])
        if (files.length === 0) return
        e.preventDefault()
        stageFiles(files)
      }}
      style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}
    >
      <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <span style={FIELD_LABEL}>Today&rsquo;s update</span>
        <textarea
          className="boe-input"
          rows={3}
          autoFocus={!isMobile}
          value={update}
          disabled={busy}
          onChange={e => setUpdate(e.target.value)}
          onKeyDown={e => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void save() }
          }}
          placeholder="Where does this issue stand right now? Who is doing what next?"
          style={{ resize: 'vertical' }}
        />
      </label>

      <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <span style={FIELD_LABEL}>Decision</span>
        <textarea
          className="boe-input"
          rows={2}
          value={decision}
          disabled={busy}
          onChange={e => setDecision(e.target.value)}
          placeholder="What was decided in this meeting?"
          style={{ resize: 'vertical' }}
        />
      </label>

      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: '0 1 170px' }}>
          <span style={FIELD_LABEL}>Next review</span>
          <input
            type="date"
            className="boe-input"
            value={review}
            disabled={busy}
            onChange={e => setReview(e.target.value)}
            style={{ colorScheme: 'light' }}
          />
        </label>
        <div style={{ display: 'flex', gap: '8px', marginLeft: 'auto', alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            ref={fileInput}
            type="file"
            accept={MEETING_EVIDENCE_ACCEPT}
            multiple
            hidden
            onChange={e => {
              stageFiles(Array.from(e.target.files ?? []))
              e.target.value = ''
            }}
          />
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            disabled={busy}
            className="boe-btn boe-btn-ghost"
            style={{ padding: '7px 12px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '5px' }}
          >
            <ImagePlus size={13} strokeWidth={2} /> Attach image
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={!canSave}
            className="boe-btn boe-btn-primary"
            style={{ padding: '8px 16px', fontSize: '12.5px', opacity: canSave ? 1 : 0.6 }}
          >
            {busy ? 'Saving…' : 'Save update'}
          </button>
        </div>
      </div>

      {staged.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
          {staged.map(target => (
            <div key={target.id} style={{ width: 108 }}>
              <div style={{ position: 'relative' }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={target.preview}
                  alt={target.name}
                  style={{
                    width: 108, height: 78, objectFit: 'cover', borderRadius: '8px',
                    border: `1px solid ${colors.border}`, display: 'block',
                  }}
                />
                {!busy && (
                  <button
                    type="button"
                    onClick={() => drop(target)}
                    aria-label={`Remove ${target.name}`}
                    style={{
                      position: 'absolute', top: 3, right: 3,
                      width: 20, height: 20, borderRadius: 999, cursor: 'pointer',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      background: 'rgba(0,0,0,0.55)', border: 'none', color: '#fff',
                    }}
                  >
                    <X size={11} strokeWidth={2.5} />
                  </button>
                )}
              </div>
              <div style={{
                fontSize: '11px', marginTop: '3px', lineHeight: 1.35,
                color: target.state === 'failed' ? colors.red : colors.muted,
              }}>
                {target.error ?? STAGE_LABEL[target.state]}
              </div>
            </div>
          ))}
        </div>
      )}

      {notice && (
        <div role="alert" style={{
          padding: '8px 12px', borderRadius: '8px', fontSize: '12px', lineHeight: 1.5,
          background: notice.tone === 'error' ? colors.redTint : colors.greenTint,
          color: notice.tone === 'error' ? colors.red : '#2E8A58',
        }}>
          {notice.message}
        </div>
      )}
    </div>
  )
}

// ─── Reading pieces ───────────────────────────────────────────────────────────

function EventList({ events }: { events: MeetingDiscussionEvent[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {events.map(event => (
        <div key={event.id}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '12px', fontWeight: 700, color: colors.primary }}>
              {DISCUSSION_EVENT_LABEL[event.event_type]}
            </span>
            <span style={{ fontSize: '11px', color: colors.muted, whiteSpace: 'nowrap' }}>
              {event.actor_name ?? 'Unknown'} · {formatMeetingTimestamp(event.created_at)}
            </span>
          </div>
          {event.new_update && (
            <div style={{
              marginTop: '5px', padding: '8px 10px', borderRadius: '7px',
              background: colors.raised, borderLeft: `2px solid ${colors.blue}`,
              fontSize: '12.5px', color: colors.primary, lineHeight: 1.45, whiteSpace: 'pre-wrap',
            }}>
              {event.new_update}
            </div>
          )}
          {event.detail && (
            <div style={{ marginTop: '4px', fontSize: '11.5px', color: colors.secondary, lineHeight: 1.5 }}>
              {event.detail}
            </div>
          )}
          {event.new_review_date && (
            <div style={{ marginTop: '3px', fontSize: '11.5px', color: colors.secondary }}>
              Next review set to {formatMeetingDate(event.new_review_date)}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function LinkedTasks({
  taskIds, readableTasks, onOpenTask,
}: {
  taskIds: string[]
  readableTasks: Record<string, LinkedTask>
  onOpenTask: (taskId: string) => void
}) {
  if (taskIds.length === 0) {
    return <Muted>No follow-up task has been created from this issue yet.</Muted>
  }
  // A task id with no readable row is shown as existing and not opened. Saying
  // "one task you cannot see" is honest; offering a link that 404s is not, and
  // silently dropping it would make the count on the board disagree with this list.
  const hidden = taskIds.filter(id => !readableTasks[id]).length
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      {taskIds.map(id => {
        const task = readableTasks[id]
        if (!task) return null
        return (
          <button
            key={id}
            type="button"
            onClick={() => onOpenTask(id)}
            style={{
              display: 'flex', alignItems: 'center', gap: '4px 8px', flexWrap: 'wrap', textAlign: 'left',
              padding: '8px 11px', borderRadius: '8px', cursor: 'pointer',
              background: colors.raised, border: `1px solid ${colors.border}`,
            }}
          >
            {/* The title takes the row; the owner / due / status line wraps under it
                on a narrow screen instead of running past the edge — an owner's
                full name is often longer than a phone is wide. */}
            <span style={{ fontSize: '12.5px', fontWeight: 600, color: colors.primary, flex: '1 1 180px', minWidth: 0 }}>
              {task.title}
              {' '}
              <ExternalLink
                size={12}
                strokeWidth={2}
                color={colors.muted}
                aria-hidden="true"
                style={{ display: 'inline', verticalAlign: '-1px' }}
              />
            </span>
            <span style={{ fontSize: '11px', color: colors.muted, minWidth: 0, overflowWrap: 'anywhere' }}>
              {task.assignee_name ?? 'Unassigned'}
              {task.due_date ? ` · due ${formatMeetingDate(task.due_date)}` : ''}
              {' · '}{task.status}
            </span>
          </button>
        )
      })}
      {hidden > 0 && (
        <Muted>
          {hidden} more follow-up task{hidden === 1 ? '' : 's'} {hidden === 1 ? 'was' : 'were'} created
          from this issue, which you do not have access to.
        </Muted>
      )}
    </div>
  )
}

/**
 * The ISSUE's earlier meetings — newest first, grouped by meeting, read-only.
 *
 * This follows the ISSUE, not the order number: two separate issues on the same
 * order have two separate threads here, which is the whole reason the persistent
 * item exists. The Order's GENERAL history — every matter ever raised against that
 * order number — is a different list, reached from the link in the header, and the
 * two are never merged.
 *
 * Everything past the most recent is collapsed, because a six-meeting issue would
 * otherwise bury the composer above it.
 */
function EarlierMeetings({
  supabase, groups, readableTasks, onOpenTask,
}: {
  supabase: SupabaseClient
  groups: DiscussionMeetingGroup[]
  readableTasks: Record<string, LinkedTask>
  onOpenTask: (taskId: string) => void
}) {
  const [open, setOpen] = useState<Set<string>>(new Set())

  if (groups.length === 0) {
    return (
      <Panel>
        <PanelHeading title="Earlier meetings" />
        <Muted>
          This is the first meeting to discuss this issue. What is recorded today starts its history.
        </Muted>
      </Panel>
    )
  }

  // Earlier MEETINGS only; the outside-a-meeting group is shown but not counted as one.
  const meetingCount = groups.filter(group => group.meetingId !== null).length

  const toggle = (key: string) => setOpen(prev => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })

  return (
    <Panel>
      <PanelHeading
        title="Earlier meetings"
        detail={meetingCount === 0
          ? 'Nothing from an earlier meeting you can see · read-only'
          : `This issue in ${meetingCount} earlier ${meetingCount === 1 ? 'meeting' : 'meetings'} you can see · newest first · read-only`}
      />
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {groups.map((group, position) => {
          const key = group.appearanceId ?? `loose-${position}`
          const expanded = position === 0 ? !open.has(key) : open.has(key)
          return (
            <div key={key} style={{ border: `1px solid ${colors.border}`, borderRadius: '9px', overflow: 'hidden' }}>
              <button
                type="button"
                onClick={() => toggle(key)}
                aria-expanded={expanded}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', gap: '8px', padding: '9px 11px',
                  background: colors.raised, border: 'none', cursor: 'pointer', textAlign: 'left',
                }}
              >
                {expanded
                  ? <ChevronDown size={14} strokeWidth={2} color={colors.muted} aria-hidden="true" style={{ flexShrink: 0 }} />
                  : <ChevronRight size={14} strokeWidth={2} color={colors.muted} aria-hidden="true" style={{ flexShrink: 0 }} />}
                <span style={{ fontSize: '12.5px', fontWeight: 700, color: colors.primary, whiteSpace: 'nowrap' }}>
                  {group.meetingDate ? formatMeetingDate(group.meetingDate) : '—'}
                </span>
                <span style={{
                  fontSize: '12px', color: colors.secondary, flex: 1, minWidth: 0,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {group.meetingTitle}
                </span>
                <span style={{ fontSize: '11px', color: colors.muted, whiteSpace: 'nowrap' }}>
                  {summaryLine(group)}
                </span>
              </button>

              {expanded ? (
                <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {group.update && <Quote label="Position recorded">{group.update}</Quote>}
                  {group.decision && <Quote label="Decision" accent={colors.green}>{group.decision}</Quote>}
                  {group.nextReviewDate && (
                    <div style={{ fontSize: '11.5px', color: colors.muted }}>
                      Next review set to {formatMeetingDate(group.nextReviewDate)}
                    </div>
                  )}
                  {group.events.length > 0 && <EventList events={group.events} />}
                  {group.evidence.length > 0 && (
                    <div>
                      <div style={{ ...FIELD_LABEL, marginBottom: '6px' }}>
                        Evidence · {group.evidence.length} image{group.evidence.length === 1 ? '' : 's'}
                      </div>
                      <EvidenceThumbs supabase={supabase} items={group.evidence} />
                    </div>
                  )}
                  {group.linkedTaskIds.length > 0 && (
                    <div>
                      <div style={{ ...FIELD_LABEL, marginBottom: '6px' }}>Follow-up tasks</div>
                      <LinkedTasks
                        taskIds={group.linkedTaskIds}
                        readableTasks={readableTasks}
                        onOpenTask={onOpenTask}
                      />
                    </div>
                  )}
                  {!group.update && !group.decision && group.events.length === 0 && (
                    <Muted>The issue was on this meeting&rsquo;s agenda, but nothing was recorded against it.</Muted>
                  )}
                </div>
              ) : group.update ? (
                <div style={{
                  padding: '7px 12px 9px 33px', fontSize: '12px', color: colors.secondary, lineHeight: 1.4,
                  display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                }}>
                  {group.update}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
    </Panel>
  )
}

function summaryLine(group: DiscussionMeetingGroup): string {
  // The group of things that happened outside any meeting is described by what
  // happened — "Issue raised · Reopened" — not by meeting-style counts, which
  // would read "Nothing recorded" over two real events.
  if (group.meetingId === null) {
    return [...new Set(group.events.map(e => DISCUSSION_EVENT_LABEL[e.event_type]))].join(' · ') || 'Nothing recorded'
  }
  const parts: string[] = []
  const updates = group.events.filter(e => e.event_type === 'update').length
  if (updates > 0) parts.push(`${updates} update${updates === 1 ? '' : 's'}`)
  if (group.evidence.length > 0) parts.push(`${group.evidence.length} image${group.evidence.length === 1 ? '' : 's'}`)
  if (group.linkedTaskIds.length > 0) parts.push(`${group.linkedTaskIds.length} task${group.linkedTaskIds.length === 1 ? '' : 's'}`)
  return parts.join(' · ') || 'Nothing recorded'
}

// ─── Shared shells ────────────────────────────────────────────────────────────

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <section style={{
      background: colors.base, border: `1px solid ${colors.border}`, borderRadius: '10px',
      padding: '13px 15px', display: 'flex', flexDirection: 'column', gap: '10px',
    }}>
      {children}
    </section>
  )
}

function PanelHeading({ title, detail }: { title: string; detail?: string }) {
  return (
    <div>
      <h3 style={{ margin: 0, fontSize: '13.5px', fontWeight: 700, color: colors.primary }}>{title}</h3>
      {detail && (
        <p style={{ margin: '1px 0 0', fontSize: '11.5px', color: colors.muted, lineHeight: 1.5 }}>{detail}</p>
      )}
    </div>
  )
}

function Quote({
  label, children, accent = colors.blue,
}: {
  label: string
  children: React.ReactNode
  accent?: string
}) {
  return (
    <div>
      <div style={FIELD_LABEL}>{label}</div>
      <div style={{
        marginTop: '4px', padding: '8px 11px', borderRadius: '7px',
        background: colors.raised, borderLeft: `2px solid ${accent}`,
        fontSize: '12.5px', color: colors.primary, lineHeight: 1.5, whiteSpace: 'pre-wrap',
      }}>
        {children}
      </div>
    </div>
  )
}

function Banner({ tone, children }: { tone: 'success' | 'muted'; children: React.ReactNode }) {
  const success = tone === 'success'
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: '7px',
      padding: '9px 12px', borderRadius: '8px',
      background: success ? '#F0FDF4' : colors.raised,
      border: `1px solid ${success ? '#BBF7D0' : colors.border}`,
      fontSize: '12px', color: success ? '#166534' : colors.secondary, lineHeight: 1.55,
    }}>
      {children}
    </div>
  )
}

/**
 * Shown only in a COMPLETED meeting whose issue has moved since. It sits beside the
 * record rather than replacing any of it, so the meeting still reads exactly as it
 * did when it closed.
 */
function SinceNote({ resolvedNow }: { resolvedNow: boolean }) {
  return (
    <div role="note" style={{
      padding: '8px 12px', borderRadius: '8px', fontSize: '12px', lineHeight: 1.55,
      background: colors.raised, border: `1px solid ${colors.border}`, color: colors.secondary,
    }}>
      <strong style={{ fontWeight: 600, color: colors.primary }}>Since this meeting closed: </strong>
      {resolvedNow
        ? 'this issue has been resolved in a later meeting. It is now Resolved.'
        : 'this issue has been reopened. It is now Open again and moves to the next review.'}
      {' '}What this meeting recorded is unchanged.
    </div>
  )
}

function Muted({ children }: { children: React.ReactNode }) {
  return <p style={{ margin: 0, fontSize: '12px', color: colors.muted, lineHeight: 1.5 }}>{children}</p>
}
