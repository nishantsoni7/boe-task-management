'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { createClient } from '@/lib/supabase/client'
import { ChevronDown, ChevronRight, ImagePlus, Lock, X } from 'lucide-react'
import { colors } from '@/lib/tokens'
import { MeetingBadge } from './MeetingModal'
import { EvidenceThumbs } from './EvidenceThumbs'
import { fetchAllRows } from '@/lib/supabasePaging'
import { HISTORY_ENTRY_LABEL, hasUpdateText, historyChangeLines } from '@/lib/meetings/history'
import { logMeetingFailure, meetingErrorMessage } from '@/lib/meetings/errors'
import {
  earlierMeetingOrders, groupEarlierDiscussions, mergeDiscussionTimeline, orderNumberKey,
  type EarlierMeetingGroup, type EarlierMeetingOrder, type TimelineItem,
} from '@/lib/meetings/orderHistory'
import {
  MEETING_EVIDENCE_ACCEPT, MEETING_EVIDENCE_BUCKET, MEETING_EVIDENCE_MAX_PER_SAVE,
  MEETING_EVIDENCE_TYPES_LABEL, buildEvidencePath, evidenceDisplayName, evidenceSaveOutcome,
  evidenceUploadErrorMessage, prepareEvidenceFile, resolveEvidenceType,
  type EvidenceExt, type EvidenceMime,
} from '@/lib/meetings/evidence'
import {
  MEETING_EVIDENCE_COLUMNS, MEETING_HISTORY_COLUMNS, MEETING_STATUS_META, ORDER_POSITIONS,
  ORDER_POSITION_META, formatMeetingDate, formatMeetingTimestamp,
  type Meeting, type MeetingHistoryEntry, type MeetingOrder, type MeetingOrderEvidence,
  type OrderPosition,
} from '@/lib/meetings/types'

// One Order's discussion workspace inside a meeting.
//
// NOT an Order Detail page. It holds exactly what a live review needs about one
// Order, in the order it is needed:
//
//   1. This meeting — type today's update, set the position or next review if
//      they moved, attach the screenshot. One Save. Below it, everything already
//      recorded against this Order in this meeting.
//   2. Earlier meetings — found automatically by the Order's normalised number,
//      newest first, the most recent one open. Read-only: those rows belong to
//      the meetings that recorded them, and nothing here can write to them.
//
// Today's update is a NEW history row in today's meeting (the existing
// save_meeting_order_update RPC). Nothing is copied from an earlier meeting and
// nothing in an earlier meeting changes.

/** The app's browser client, as useMeetings() provides it. */
type MeetingsClient = ReturnType<typeof createClient>

const INITIAL_EARLIER_MEETINGS = 3
/** Rows of the same Order across meetings. Far above any real review cadence. */
const EARLIER_ORDER_ROW_LIMIT = 200

const FIELD_LABEL: React.CSSProperties = {
  fontSize: '11px', fontWeight: 600, color: colors.muted,
  textTransform: 'uppercase', letterSpacing: '0.05em',
}

// ─── Reads ────────────────────────────────────────────────────────────────────

/** Evidence rows for these meeting_order ids, with the uploader's name. Null on failure. */
export async function fetchEvidenceRows(
  supabase: MeetingsClient,
  meetingOrderIds: string[],
): Promise<MeetingOrderEvidence[] | null> {
  if (meetingOrderIds.length === 0) return []
  const result = await fetchAllRows<MeetingOrderEvidence & { uploader?: { full_name: string } | null }>((from, to) =>
    supabase
      .from('meeting_order_evidence')
      .select(`${MEETING_EVIDENCE_COLUMNS}, uploader:users!uploaded_by(full_name)`)
      .in('meeting_order_id', meetingOrderIds)
      .order('id', { ascending: true })
      .range(from, to),
  )
  if (!result.ok || result.truncated) {
    console.error('[meetings:evidence] load failed', result)
    return null
  }
  return result.rows.map(({ uploader, ...row }) => ({ ...row, uploader_name: uploader?.full_name ?? null }))
}

type MeetingClock = Pick<Meeting, 'id' | 'meeting_date' | 'created_at'>

/**
 * This Order's rows in EARLIER meetings. One indexed read on order_number_key;
 * RLS narrows it to meetings the reader may see, so nothing here re-implements
 * visibility.
 */
async function fetchEarlierOrders(
  supabase: MeetingsClient,
  key: string,
  meeting: MeetingClock,
): Promise<EarlierMeetingOrder[] | null> {
  const { data, error } = await supabase
    .from('meeting_orders')
    .select('id, meeting_id, order_number, position, latest_update, next_review_date, meeting:meetings!meeting_id(id, title, meeting_date, meeting_type, status, created_at)')
    .eq('order_number_key', key)
    .neq('meeting_id', meeting.id)
    .limit(EARLIER_ORDER_ROW_LIMIT)
  if (error) {
    console.error('[meetings:earlier-history] order lookup failed', { code: error.code, message: error.message })
    return null
  }
  return earlierMeetingOrders((data ?? []) as unknown as EarlierMeetingOrder[], meeting)
}

/** History and evidence for a set of earlier meeting_order rows, in parallel. */
async function fetchDiscussions(
  supabase: MeetingsClient,
  meetingOrderIds: string[],
): Promise<{ entries: MeetingHistoryEntry[]; evidence: MeetingOrderEvidence[] } | null> {
  if (meetingOrderIds.length === 0) return { entries: [], evidence: [] }
  const [historyResult, evidence] = await Promise.all([
    fetchAllRows<MeetingHistoryEntry & { actor?: { full_name: string } | null }>((from, to) =>
      supabase
        .from('meeting_update_history')
        .select(`${MEETING_HISTORY_COLUMNS}, actor:users!actor_id(full_name)`)
        .in('meeting_order_id', meetingOrderIds)
        .neq('entry_type', 'order_added')
        .order('id', { ascending: true })
        .range(from, to),
    ),
    fetchEvidenceRows(supabase, meetingOrderIds),
  ])
  if (!historyResult.ok || historyResult.truncated || !evidence) {
    console.error('[meetings:earlier-history] discussion load failed')
    return null
  }
  return {
    entries: historyResult.rows.map(({ actor, ...row }) => ({ ...row, actor_name: actor?.full_name ?? null })),
    evidence,
  }
}

// Earlier meetings do not change while a review is being run, so a read is kept
// for the life of the meeting screen: stepping back and forth between Orders
// costs nothing. The screen clears it when it mounts.
type EarlierReady = { status: 'ready'; earlier: EarlierMeetingOrder[]; groups: EarlierMeetingGroup[] }
type EarlierState = { status: 'loading' } | { status: 'error' } | EarlierReady

const earlierCache = new Map<string, EarlierReady>()

export function resetEarlierDiscussionCache(): void {
  earlierCache.clear()
}

// ─── The workspace ────────────────────────────────────────────────────────────

export function OrderDiscussion({
  supabase, meeting, order, entries, evidence, editable, isMobile, onSaved,
}: {
  supabase: MeetingsClient
  meeting: Meeting
  order: MeetingOrder
  /** This meeting's history rows for this Order. */
  entries: MeetingHistoryEntry[]
  /** This meeting's evidence for this Order. */
  evidence: MeetingOrderEvidence[]
  editable: boolean
  isMobile: boolean
  /** Reload the meeting. `message` is the toast to show, or null when the composer already says it. */
  onSaved: (message: string | null) => Promise<void>
}) {
  const timeline = mergeDiscussionTimeline(entries, evidence)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <Panel>
        <PanelHeading
          title="This meeting"
          detail={`${formatMeetingDate(meeting.meeting_date)} · ${meeting.title}`}
        />
        {editable ? (
          <DiscussionComposer supabase={supabase} order={order} isMobile={isMobile} onSaved={onSaved} />
        ) : (
          <div style={{
            display: 'flex', alignItems: 'center', gap: '7px', padding: '8px 11px', borderRadius: '8px',
            background: colors.raised, fontSize: '12px', color: colors.secondary,
          }}>
            <Lock size={12} strokeWidth={2} style={{ flexShrink: 0 }} />
            {meeting.status === 'completed'
              ? 'This meeting is completed and read-only. Reopen it to correct the record.'
              : 'You can read this meeting, but not record in it.'}
          </div>
        )}

        <div style={{ ...FIELD_LABEL, marginTop: '4px' }}>Recorded in this meeting</div>
        {timeline.length === 0 ? (
          <Muted>Nothing has been recorded for this order in this meeting yet.</Muted>
        ) : (
          <Timeline supabase={supabase} items={timeline} />
        )}
      </Panel>

      <EarlierDiscussions supabase={supabase} meeting={meeting} order={order} />
    </div>
  )
}

// ─── Today's update + evidence ────────────────────────────────────────────────

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

// Stages that map to real work. No percentage: nothing here reports one, and an
// invented number would be the one dishonest thing on an evidence screen.
const STAGE_LABEL: Record<StagedState, string> = {
  preparing: 'Preparing…',
  ready: 'Ready to attach',
  uploading: 'Uploading…',
  recording: 'Recording…',
  failed: 'Not attached',
}

function DiscussionComposer({
  supabase, order, isMobile, onSaved,
}: {
  supabase: MeetingsClient
  order: MeetingOrder
  isMobile: boolean
  onSaved: (message: string | null) => Promise<void>
}) {
  const [update, setUpdate]     = useState('')
  const [position, setPosition] = useState<OrderPosition>(order.position)
  const [review, setReview]     = useState(order.next_review_date ?? '')
  const [staged, setStaged]     = useState<Staged[]>([])
  const [busy, setBusy]         = useState(false)
  const [notice, setNotice]     = useState<{ tone: 'success' | 'error'; message: string } | null>(null)

  const fileInput = useRef<HTMLInputElement>(null)
  const previews  = useRef(new Set<string>())

  // Preview object URLs are released when the composer goes away.
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

  const drop = (item: Staged) => {
    URL.revokeObjectURL(item.preview)
    previews.current.delete(item.preview)
    setStaged(prev => prev.filter(s => s.id !== item.id))
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
    if (refused.length > 0) problems.push(`${refused.join(', ')}: only ${MEETING_EVIDENCE_TYPES_LABEL} images can be attached.`)
    if (images.length > room) problems.push(`Up to ${MEETING_EVIDENCE_MAX_PER_SAVE} images can be attached in one save.`)
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

    accepted.forEach((file, index) => {
      const item = added[index]
      void prepareEvidenceFile(file).then(result => {
        if (result.ok) {
          patch(item.id, { state: 'ready', file: result.file, mime: result.mime, ext: result.ext })
        } else {
          drop(item)
          setNotice({ tone: 'error', message: `${item.name}: ${result.error}` })
        }
      })
    })
  }

  const textToSave      = update.trim()
  const positionChanged = position !== order.position
  const reviewChanged   = review !== (order.next_review_date ?? '')
  const writesUpdate    = textToSave !== '' || positionChanged || reviewChanged
  const attachable      = staged.filter(s => (s.state === 'ready' || s.state === 'failed') && s.file && s.mime && s.ext)
  const preparing       = staged.some(s => s.state === 'preparing')
  const canSave         = !busy && !preparing && (writesUpdate || attachable.length > 0)

  const save = async () => {
    if (!canSave) return
    setBusy(true)
    setNotice(null)

    // 1. The update — first, so a refused update uploads nothing at all.
    let updateSaved = false
    if (writesUpdate) {
      const { error } = await supabase.rpc('save_meeting_order_update', {
        p_order_id: order.id,
        p_latest_update: textToSave || null,
        p_position: positionChanged ? position : null,
        p_next_review_date: review || null,
        p_remarks: null,
        p_customer_name: null,
        p_expected_dispatch_date: null,
        p_clear_next_review: (order.next_review_date ?? '') !== '' && review === '',
      })
      if (error) {
        logMeetingFailure('update-order', error)
        setNotice({ tone: 'error', message: meetingErrorMessage('update-order', error) })
        setBusy(false)
        return
      }
      updateSaved = true
      setUpdate('')
    }

    // 2. Each image: upload, then record. An image is evidence only once the
    //    RPC has verified and recorded it; anything short of that is reported
    //    as not attached and its stray object removed.
    let attached = 0
    let failed = 0
    const bucket = supabase.storage.from(MEETING_EVIDENCE_BUCKET)
    for (const item of attachable) {
      // A fresh key per attempt, so a retry never collides with an earlier one.
      const path = buildEvidencePath(order.id, item.ext!)
      patch(item.id, { state: 'uploading', error: null })

      const { error: uploadError } = await bucket.upload(path, item.file!, {
        contentType: item.mime!, upsert: false, cacheControl: '3600',
      })
      if (uploadError) {
        failed += 1
        patch(item.id, { state: 'failed', error: evidenceUploadErrorMessage(uploadError) })
        continue
      }

      patch(item.id, { state: 'recording' })
      const { error: recordError } = await supabase.rpc('add_meeting_order_evidence', {
        p_order_id: order.id,
        p_storage_path: path,
        p_file_name: evidenceDisplayName(item.name),
      })
      if (recordError) {
        logMeetingFailure('add-evidence', recordError)
        // Permitted only because no evidence row references this object.
        await bucket.remove([path])
        failed += 1
        patch(item.id, { state: 'failed', error: meetingErrorMessage('add-evidence', recordError) })
        continue
      }

      attached += 1
      drop(item)
    }

    const outcome = evidenceSaveOutcome({ updateSaved, attached, failed })
    if (failed > 0) setNotice(outcome)
    // Still busy while the meeting reloads, so a second click cannot resend a
    // position the screen has not yet caught up with.
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
        <span style={FIELD_LABEL}>Today’s update</span>
        <textarea
          className="boe-input"
          rows={3}
          autoFocus={!isMobile}
          value={update}
          disabled={busy}
          onChange={e => setUpdate(e.target.value)}
          onKeyDown={e => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault()
              void save()
            }
          }}
          placeholder="What was said about this order? Who is doing what next?"
          style={{ resize: 'vertical' }}
        />
      </label>

      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div role="group" aria-label="Position" style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: '1 1 280px' }}>
          <span style={FIELD_LABEL}>Position</span>
          <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
            {ORDER_POSITIONS.map(p => {
              const meta = ORDER_POSITION_META[p]
              const selected = position === p
              return (
                <button
                  key={p}
                  type="button"
                  aria-pressed={selected}
                  disabled={busy}
                  onClick={() => setPosition(p)}
                  style={{
                    flex: '1 1 70px', padding: '6px 6px', borderRadius: '8px', cursor: 'pointer',
                    fontSize: '12px', fontWeight: selected ? 700 : 500,
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
        </div>
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
      </div>

      {staged.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
          {staged.map(item => (
            <div key={item.id} style={{ width: 108 }}>
              <div style={{ position: 'relative' }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={item.preview}
                  alt={item.name}
                  style={{
                    width: 108, height: 80, objectFit: 'cover', borderRadius: '7px', display: 'block',
                    border: `1px solid ${item.state === 'failed' ? 'rgba(217,79,79,0.55)' : colors.border}`,
                    opacity: item.state === 'ready' || item.state === 'failed' ? 1 : 0.6,
                  }}
                />
                {!busy && (
                  <button
                    type="button"
                    aria-label={`Remove ${item.name}`}
                    title="Remove"
                    onClick={() => drop(item)}
                    style={{
                      position: 'absolute', top: 4, right: 4, width: 22, height: 22, borderRadius: '6px',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
                      border: 'none', background: 'rgba(17,19,24,0.7)', color: '#FFFFFF',
                    }}
                  >
                    <X size={12} strokeWidth={2.4} />
                  </button>
                )}
              </div>
              <div style={{
                fontSize: '10.5px', marginTop: '3px', lineHeight: 1.3,
                color: item.state === 'failed' ? colors.red : colors.muted,
              }}>
                {item.state === 'failed' && item.error ? item.error : STAGE_LABEL[item.state]}
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
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
            className="boe-btn boe-btn-ghost"
            disabled={busy || staged.length >= MEETING_EVIDENCE_MAX_PER_SAVE}
            onClick={() => fileInput.current?.click()}
            style={{ padding: '7px 12px', fontSize: '12.5px', display: 'flex', alignItems: 'center', gap: '5px' }}
          >
            <ImagePlus size={14} strokeWidth={2} /> Attach image
          </button>
          {!isMobile && (
            <span style={{ fontSize: '11.5px', color: colors.muted }}>or paste a screenshot here (Ctrl+V)</span>
          )}
        </div>
        <button
          type="button"
          className="boe-btn boe-btn-primary"
          onClick={() => void save()}
          disabled={!canSave}
          style={{ padding: '8px 20px', fontSize: '13px', opacity: canSave ? 1 : 0.6 }}
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>

      {notice && (
        <div role={notice.tone === 'error' ? 'alert' : 'status'} style={{
          padding: '9px 12px', borderRadius: '8px', fontSize: '12px', whiteSpace: 'pre-wrap',
          background: notice.tone === 'error' ? 'rgba(217,79,79,0.1)' : colors.greenTint,
          color: notice.tone === 'error' ? '#C13030' : '#2E8A58',
        }}>
          {notice.message}
        </div>
      )}
    </div>
  )
}

// ─── Earlier meetings ─────────────────────────────────────────────────────────

function EarlierDiscussions({
  supabase, meeting, order,
}: {
  supabase: MeetingsClient
  meeting: Meeting
  order: MeetingOrder
}) {
  const key = orderNumberKey(order)
  const cacheKey = `${meeting.id}:${key}`
  const meetingId = meeting.id
  const meetingDate = meeting.meeting_date
  const meetingCreatedAt = meeting.created_at

  const [state, setState] = useState<EarlierState>(() => earlierCache.get(cacheKey) ?? { status: 'loading' })
  // Groups whose open/closed state the reader flipped. The newest starts open.
  const [toggled, setToggled] = useState<Set<string>>(() => new Set())
  const [olderStatus, setOlderStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (earlierCache.has(cacheKey)) return
    let active = true
    const run = async () => {
      const clock = { id: meetingId, meeting_date: meetingDate, created_at: meetingCreatedAt }
      const earlier = await fetchEarlierOrders(supabase, key, clock)
      if (!active) return
      if (!earlier) { setState({ status: 'error' }); return }

      // Only the most recent few are read up front; older meetings load on request.
      const first = earlier.slice(0, INITIAL_EARLIER_MEETINGS)
      const found = await fetchDiscussions(supabase, first.map(o => o.id))
      if (!active) return
      if (!found) { setState({ status: 'error' }); return }

      const ready: EarlierReady = {
        status: 'ready', earlier, groups: groupEarlierDiscussions(first, found.entries, found.evidence),
      }
      earlierCache.set(cacheKey, ready)
      setState(ready)
    }
    void run()
    return () => { active = false }
  }, [supabase, cacheKey, key, meetingId, meetingDate, meetingCreatedAt, attempt])

  const retry = () => {
    setState({ status: 'loading' })
    setAttempt(a => a + 1)
  }

  const showOlder = async () => {
    if (state.status !== 'ready' || olderStatus === 'loading') return
    const loaded = new Set(state.groups.map(g => g.meetingOrder.id))
    const rest = state.earlier.filter(o => !loaded.has(o.id))
    setOlderStatus('loading')
    const found = await fetchDiscussions(supabase, rest.map(o => o.id))
    if (!found) { setOlderStatus('error'); return }
    const next: EarlierReady = {
      ...state, groups: [...state.groups, ...groupEarlierDiscussions(rest, found.entries, found.evidence)],
    }
    earlierCache.set(cacheKey, next)
    setState(next)
    setOlderStatus('idle')
  }

  const toggle = (id: string) => setToggled(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  if (state.status === 'loading') {
    return (
      <Panel>
        <PanelHeading title="Earlier meetings" detail="Looking for earlier meetings of this order…" />
      </Panel>
    )
  }

  if (state.status === 'error') {
    return (
      <Panel>
        <PanelHeading title="Earlier meetings" />
        <RetryLine message="Could not load the earlier meetings for this order." onRetry={retry} />
      </Panel>
    )
  }

  const { earlier, groups } = state
  if (earlier.length === 0) {
    return (
      <Panel>
        <PanelHeading title="Earlier meetings" />
        <Muted>
          No earlier meeting you can see has discussed order {order.order_number}. What is recorded
          today starts its history.
        </Muted>
      </Panel>
    )
  }

  const remaining = earlier.length - groups.length

  return (
    <Panel>
      <PanelHeading
        title="Earlier meetings"
        detail={`Discussed in ${earlier.length} earlier meeting${earlier.length === 1 ? '' : 's'} you can see · newest first · read-only`}
      />
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {groups.map((group, index) => {
          const id = group.meetingOrder.id
          const open = index === 0 ? !toggled.has(id) : toggled.has(id)
          return (
            <EarlierGroup key={id} supabase={supabase} group={group} open={open} onToggle={() => toggle(id)} />
          )
        })}
      </div>
      {remaining > 0 && (
        <button
          type="button"
          onClick={() => void showOlder()}
          disabled={olderStatus === 'loading'}
          className="boe-btn boe-btn-ghost"
          style={{ alignSelf: 'flex-start', padding: '6px 12px', fontSize: '12px' }}
        >
          {olderStatus === 'loading'
            ? 'Loading…'
            : `Show ${remaining} older meeting${remaining === 1 ? '' : 's'}`}
        </button>
      )}
      {olderStatus === 'error' && (
        <RetryLine message="Could not load the older meetings." onRetry={() => void showOlder()} />
      )}
    </Panel>
  )
}

function EarlierGroup({
  supabase, group, open, onToggle,
}: {
  supabase: MeetingsClient
  group: EarlierMeetingGroup
  open: boolean
  onToggle: () => void
}) {
  const { meetingOrder, items } = group
  const m = meetingOrder.meeting!
  const counts = [
    group.updateCount > 0 ? `${group.updateCount} update${group.updateCount === 1 ? '' : 's'}` : null,
    group.evidenceCount > 0 ? `${group.evidenceCount} image${group.evidenceCount === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(' · ') || 'Nothing recorded'

  return (
    <div style={{ border: `1px solid ${colors.border}`, borderRadius: '9px', overflow: 'hidden' }}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: '8px', padding: '9px 11px',
          background: colors.raised, border: 'none', cursor: 'pointer', textAlign: 'left',
        }}
      >
        {open
          ? <ChevronDown size={14} strokeWidth={2} color={colors.muted} style={{ flexShrink: 0 }} />
          : <ChevronRight size={14} strokeWidth={2} color={colors.muted} style={{ flexShrink: 0 }} />}
        <span style={{ fontSize: '12.5px', fontWeight: 700, color: colors.primary, whiteSpace: 'nowrap' }}>
          {formatMeetingDate(m.meeting_date)}
        </span>
        <span style={{
          fontSize: '12px', color: colors.secondary, flex: 1, minWidth: 0,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {m.title}
        </span>
        {m.status !== 'completed' && <MeetingBadge meta={MEETING_STATUS_META[m.status]} />}
        <span style={{ fontSize: '11px', color: colors.muted, whiteSpace: 'nowrap' }}>{counts}</span>
      </button>

      {open ? (
        <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '7px', flexWrap: 'wrap', fontSize: '11.5px', color: colors.muted }}>
            <span>Position recorded</span>
            <MeetingBadge meta={ORDER_POSITION_META[meetingOrder.position]} />
            {meetingOrder.next_review_date && <span>· Next review {formatMeetingDate(meetingOrder.next_review_date)}</span>}
          </div>
          {items.length === 0 ? (
            <Muted>The order was on this meeting’s list, but nothing was recorded against it.</Muted>
          ) : (
            <Timeline supabase={supabase} items={items} />
          )}
        </div>
      ) : group.lastUpdate ? (
        <div style={{
          padding: '7px 12px 9px 33px', fontSize: '12px', color: colors.secondary, lineHeight: 1.4,
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
        }}>
          {group.lastUpdate}
        </div>
      ) : null}
    </div>
  )
}

// ─── Shared pieces ────────────────────────────────────────────────────────────

/** Updates and evidence for one meeting's discussion of an Order, oldest first. */
function Timeline({ supabase, items }: { supabase: MeetingsClient; items: TimelineItem[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {items.map(item => item.kind === 'entry' ? (
        <EntryRow key={item.entry.id} entry={item.entry} />
      ) : (
        <div key={`evidence-${item.items[0].id}`}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: colors.primary, marginBottom: '6px' }}>
            Evidence
            <span style={{ fontWeight: 500, color: colors.muted }}>
              {' · '}{item.items.length} image{item.items.length === 1 ? '' : 's'}
            </span>
          </div>
          <EvidenceThumbs supabase={supabase} items={item.items} />
        </div>
      ))}
    </div>
  )
}

function EntryRow({ entry }: { entry: MeetingHistoryEntry }) {
  const changes = historyChangeLines(entry)
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '12px', fontWeight: 700, color: colors.primary }}>
          {HISTORY_ENTRY_LABEL[entry.entry_type]}
          {entry.sku && <span style={{ fontWeight: 500, color: colors.muted }}> · {entry.sku}</span>}
        </span>
        <span style={{ fontSize: '11px', color: colors.muted, whiteSpace: 'nowrap' }}>
          {entry.actor_name ?? 'Unknown'} · {formatMeetingTimestamp(entry.created_at)}
        </span>
      </div>
      {hasUpdateText(entry) && (
        <div style={{
          marginTop: '5px', padding: '8px 10px', borderRadius: '7px',
          background: colors.raised, borderLeft: `2px solid ${colors.blue}`,
          fontSize: '12.5px', color: colors.primary, lineHeight: 1.45, whiteSpace: 'pre-wrap',
        }}>
          {entry.new_update}
        </div>
      )}
      {changes.length > 0 && (
        <div style={{ marginTop: '4px', display: 'flex', flexDirection: 'column', gap: '2px' }}>
          {changes.map((line, i) => (
            <div key={i} style={{ fontSize: '11.5px', color: colors.secondary }}>{line}</div>
          ))}
        </div>
      )}
    </div>
  )
}

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
      <div style={{ fontSize: '13.5px', fontWeight: 700, color: colors.primary }}>{title}</div>
      {detail && <div style={{ fontSize: '11.5px', color: colors.muted, marginTop: '1px' }}>{detail}</div>}
    </div>
  )
}

function Muted({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: '12px', color: colors.muted, lineHeight: 1.5 }}>{children}</div>
}

function RetryLine({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px',
      padding: '8px 12px', borderRadius: '8px', background: colors.redTint,
      fontSize: '12px', color: colors.red,
    }}>
      <span>{message}</span>
      <button type="button" onClick={onRetry} className="boe-btn boe-btn-ghost" style={{ padding: '4px 12px', fontSize: '12px' }}>
        Retry
      </button>
    </div>
  )
}
