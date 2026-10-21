'use client'

import { useState, type ReactNode } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { CheckCircle2, Clock, Paperclip, Phone, Send, UserRound } from 'lucide-react'
import { colors, font } from '@/lib/tokens'
import { ACCEPTED_ATTACHMENT_TYPES } from '@/lib/attachment-utils'
import { formatDateTime } from '@/lib/ui'
import { MultilineText } from '@/components/ui/MultilineText'
import { TaskAttachmentGallery } from '@/components/tasks/TaskAttachmentGallery'
import type { GalleryEntry } from '@/lib/tasks/taskGallery'
import {
  attachmentStatusLabel, failureSummary, type PendingAttachment,
} from '@/lib/tasks/commentAttachments'
import { quotationSendGate, waitingLabel, type SentQuotation } from '@/lib/tasks/quotationSend'

// Quotation Details. A quotation request is not a to-do: sales asks, the
// quotation team answers with a quote. So the page is two halves — what sales
// asked for, and what the team sends back — instead of the Task Detail layout.
// It owns no data: every value and handler comes from the Task Detail page,
// which keeps the one attachment queue, the one status writer and the one
// activity feed.

export type QuotationComposer = {
  note:         string
  setNote:      (v: string) => void
  attachments:  readonly PendingAttachment[]
  dropActive:   boolean
  onDragOver:   (e: React.DragEvent) => void
  onDragEnter:  (e: React.DragEvent) => void
  onDragLeave:  (e: React.DragEvent) => void
  onDrop:       (e: React.DragEvent) => void
  onPaste:      (e: React.ClipboardEvent<HTMLTextAreaElement>) => void
  addFiles:     (files: File[]) => void
  removeFile:   (id: string) => void
  retryFile:    (id: string) => void
  error:        string | null
  saving:       boolean
  waitingUploads: boolean
}

export type QuotationTask = {
  title: string
  priority: string
  status: string
  note: string | null
  contact_number?: string | null
  customer_name?: string | null
  created_at: string
}

interface Props {
  task:          QuotationTask
  creatorName:   string | null
  /** The assignee who may send the quotation. */
  canSend:       boolean
  canReopen:     boolean
  canMessage:    boolean
  requestFiles:  readonly GalleryEntry[]
  sent:          SentQuotation | null
  sentCount:     number
  completedAt:   string | null
  supabase:      SupabaseClient
  onOpenFile:    (path: string, fileName: string) => void
  composer:      QuotationComposer
  onSend:        () => void
  onPostMessage: () => void
  onReopen:      () => void
  reopening:     boolean
  /** The activity card, rendered by the page (it owns edit/delete of updates). */
  timeline:      ReactNode
}

const PRIORITY: Record<string, { fg: string; bg: string }> = {
  high:   { fg: colors.red,   bg: colors.redTint   },
  medium: { fg: colors.amber, bg: colors.amberTint },
  low:    { fg: colors.muted, bg: colors.float     },
}

const LABEL: React.CSSProperties = {
  fontSize: '12px', fontWeight: 700, letterSpacing: '0.09em',
  textTransform: 'uppercase', color: colors.muted, margin: 0,
}

/** "Quotation - Koti Shetty Sir {Hotel}" → "Koti Shetty Sir {Hotel}". */
export function leadNameOf(task: Pick<QuotationTask, 'title' | 'customer_name'>): string {
  const stored = task.customer_name?.trim()
  if (stored) return stored
  return task.title.replace(/^Quotation\s*-\s*/i, '').trim() || task.title
}

export function QuotationDetailView(p: Props) {
  const { task, composer: c } = p
  const done = task.status === 'completed'
  const lead = leadNameOf(task)
  const prio = PRIORITY[task.priority] ?? PRIORITY.low
  const [mode, setMode] = useState<'send' | 'message'>('send')
  const [now] = useState(() => Date.now())
  const sending = p.canSend && !done && mode === 'send'
  const gate = quotationSendGate(c.attachments)
  const failed = c.attachments.some(a => a.status === 'failed')
  const requester = p.creatorName ?? 'sales'

  const stripCell = (label: string, value: ReactNode, color?: string) => (
    <div style={{ minWidth: 0 }}>
      <p style={LABEL}>{label}</p>
      <p style={{ margin: '3px 0 0', fontSize: '14px', fontWeight: 600, color: color ?? colors.primary }}>{value}</p>
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>

      {/* ── Status strip ─────────────────────────────────────────────── */}
      <div className="boe-card" style={{
        padding: '14px 22px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '12px 36px',
        background: done ? colors.greenTint : colors.raised,
        borderLeft: `3px solid ${done ? colors.green : colors.brand}`,
      }}>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: '6px',
          fontSize: '13px', fontWeight: 700, color: done ? colors.green : colors.brandInk,
        }}>
          {done ? <CheckCircle2 size={16} /> : <Clock size={16} />}
          {done ? 'Quotation sent' : 'Waiting for quotation'}
        </span>
        {stripCell('Requested', formatDateTime(task.created_at))}
        {done
          ? stripCell('Sent', p.completedAt ? formatDateTime(p.completedAt) : '—', colors.green)
          : stripCell('Waiting', waitingLabel(task.created_at, now), colors.brandInk)}
        <span style={{
          marginLeft: 'auto', padding: '3px 12px', borderRadius: '12px',
          background: prio.bg, color: prio.fg, border: `1px solid ${prio.fg}30`,
          fontSize: '12px', fontWeight: 700, textTransform: 'capitalize',
        }}>
          {task.priority} priority
        </span>
      </div>

      <div className="boe-task-2col">

        {/* ── What sales asked for ─────────────────────────────────── */}
        <div className="boe-task-left-col" style={{ display: 'flex', flexDirection: 'column', gap: '12px', minWidth: 0 }}>
          <div className="boe-card" style={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <p style={LABEL}>What sales asked for</p>
            <h2 style={{ margin: 0, fontSize: '20px', fontWeight: 800, color: colors.primary, letterSpacing: '-0.02em', lineHeight: 1.25 }}>
              {lead}
            </h2>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 22px', fontSize: '13px' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', color: colors.secondary }}>
                <UserRound size={15} color={colors.brand} />
                Requested by <strong style={{ color: colors.brandInk }}>{requester}</strong>
              </span>
              {task.contact_number && (
                <a href={`tel:${task.contact_number.replace(/\s+/g, '')}`} style={{
                  display: 'inline-flex', alignItems: 'center', gap: '6px',
                  color: colors.secondary, textDecoration: 'none', fontWeight: 600,
                }}>
                  <Phone size={14} color={colors.brand} />
                  {task.contact_number}
                </a>
              )}
            </div>
            <div style={{ borderTop: `1px solid ${colors.border}`, paddingTop: '12px' }}>
              <p style={LABEL}>Requirement</p>
              {task.note
                ? <MultilineText style={{ margin: '6px 0 0', fontSize: '13.5px', lineHeight: 1.6, color: colors.primary }}>{task.note}</MultilineText>
                : <p style={{ margin: '6px 0 0', fontSize: '12.5px', color: colors.muted, fontStyle: 'italic' }}>Sales added no written requirement — see the files below.</p>}
            </div>
          </div>

          <TaskAttachmentGallery
            entries={p.requestFiles}
            taskTitle={task.title}
            supabase={p.supabase}
            onOpenFile={p.onOpenFile}
          />
        </div>

        {/* ── What the team sends back ─────────────────────────────── */}
        <div className="boe-task-right-col" style={{ minWidth: 0 }}>

          {done && (
            <div className="boe-card" style={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: '12px', borderLeft: `3px solid ${colors.green}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                <p style={{ ...LABEL, color: colors.green }}>Quotation sent</p>
                {p.sentCount > 1 && (
                  <span style={{ fontSize: '12px', color: colors.muted }}>revision {p.sentCount} — earlier versions are in the Timeline</span>
                )}
              </div>
              {p.sent ? (
                <>
                  <p style={{ margin: 0, fontSize: '12.5px', color: colors.secondary }}>
                    {p.sent.actorName ? <strong>{p.sent.actorName}</strong> : 'The quotation team'} sent it on {formatDateTime(p.sent.at)}
                  </p>
                  {p.sent.note && (
                    <MultilineText style={{ margin: 0, fontSize: '13px', lineHeight: 1.6, color: colors.primary }}>{p.sent.note}</MultilineText>
                  )}
                  <TaskAttachmentGallery
                    entries={p.sent.files}
                    taskTitle={`${task.title} - quotation`}
                    supabase={p.supabase}
                    onOpenFile={p.onOpenFile}
                  />
                </>
              ) : (
                <p style={{ margin: 0, fontSize: '12.5px', color: colors.muted }}>
                  This quotation was completed before sent files were recorded here. See the Timeline.
                </p>
              )}
              {p.canReopen && (
                <button
                  type="button"
                  onClick={p.onReopen}
                  disabled={p.reopening}
                  style={{
                    alignSelf: 'flex-start', padding: '7px 16px', borderRadius: '8px',
                    border: `1.5px solid ${colors.amber}60`, background: colors.amberTint, color: colors.amber,
                    fontSize: '12.5px', fontWeight: 600, fontFamily: font.body,
                    cursor: p.reopening ? 'not-allowed' : 'pointer', opacity: p.reopening ? 0.6 : 1,
                  }}
                >
                  {p.reopening ? 'Reopening…' : 'Reopen for revision'}
                </button>
              )}
            </div>
          )}

          {(p.canSend && !done) || p.canMessage ? (
            <div className="boe-card" style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: '10px', background: '#ffffff' }}>
              {p.canSend && !done ? (
                <div role="tablist" style={{ display: 'flex', gap: '6px' }}>
                  {([['send', 'Your quotation'], ['message', 'Message sales']] as const).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      role="tab"
                      aria-selected={mode === key}
                      onClick={() => setMode(key)}
                      style={{
                        padding: '5px 12px', borderRadius: '8px', cursor: 'pointer', fontFamily: font.body,
                        fontSize: '12px', fontWeight: 700, letterSpacing: '0.04em',
                        border: `1.5px solid ${mode === key ? colors.brand : colors.border}`,
                        background: mode === key ? colors.brandTint : 'transparent',
                        color: mode === key ? colors.brandInk : colors.muted,
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              ) : (
                <p style={LABEL}>Messages</p>
              )}

              <p style={{ margin: 0, fontSize: '12.5px', color: colors.secondary }}>
                {sending
                  ? `Attach the quotation file(s) and add a note for ${requester} if needed. Sending completes this request and tells ${requester}.`
                  : `Messages and files you post here appear in the Timeline below.`}
              </p>

              <div
                style={{ position: 'relative' }}
                onDragOver={c.onDragOver}
                onDragEnter={c.onDragEnter}
                onDragLeave={c.onDragLeave}
                onDrop={c.onDrop}
              >
                <textarea
                  value={c.note}
                  onChange={e => c.setNote(e.target.value)}
                  onPaste={c.onPaste}
                  placeholder={sending ? `Note to ${requester} (optional)…` : 'Write a message…'}
                  className="boe-input"
                  style={{
                    resize: 'none', height: '98px', paddingBottom: '36px',
                    width: '100%', boxSizing: 'border-box',
                    border: `1.5px dashed ${c.dropActive ? colors.brand : colors.border}`,
                    background: c.dropActive ? colors.brandTint : '#F1EEE9',
                    borderRadius: '8px', fontSize: '12.5px', lineHeight: 1.5,
                    transition: 'border-color 0.15s, background 0.15s',
                  }}
                />
                {c.dropActive && (
                  <div style={{
                    position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    pointerEvents: 'none', fontSize: '12px', fontWeight: 600, color: colors.brand,
                    background: 'rgba(255,255,255,0.6)', borderRadius: '8px',
                  }}>
                    Drop files to attach
                  </div>
                )}
              </div>

              <label style={{
                display: 'inline-flex', alignItems: 'center', gap: '6px', alignSelf: 'flex-start',
                padding: '6px 12px', borderRadius: '8px', cursor: 'pointer',
                border: `1.5px solid ${colors.border}`, background: '#ffffff',
                fontSize: '12px', fontWeight: 600, color: colors.secondary,
              }}>
                <Paperclip size={13} />
                {sending ? 'Attach quotation file' : 'Attach file'}
                <input
                  type="file"
                  multiple
                  accept={ACCEPTED_ATTACHMENT_TYPES.join(',')}
                  onChange={e => { c.addFiles(Array.from(e.target.files ?? [])); e.target.value = '' }}
                  style={{ display: 'none' }}
                />
              </label>
              <p style={{ margin: 0, fontSize: '12px', color: colors.muted }}>Drop files here, paste copied files, or browse</p>

              {c.attachments.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  {c.attachments.map(a => (
                    <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span style={{ fontSize: '12px', color: colors.brand, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        📎 {a.fileName} <span style={{ color: colors.tertiary }}>({(a.size / 1024).toFixed(0)} KB)</span>
                      </span>
                      <span role="status" title={a.error ?? undefined} style={{
                        fontSize: '12px', fontWeight: 600, flexShrink: 0,
                        color: a.status === 'failed' ? colors.red : a.status === 'uploaded' ? colors.green : colors.secondary,
                      }}>
                        {a.status === 'uploaded' ? '✓ ' : ''}{attachmentStatusLabel(a)}
                      </span>
                      {a.status === 'failed' && (
                        <button type="button" onClick={() => c.retryFile(a.id)} style={{
                          background: 'none', border: `1px solid ${colors.brand}`, borderRadius: '6px', cursor: 'pointer',
                          color: colors.brandInk, fontSize: '12px', fontWeight: 600, padding: '1px 6px', fontFamily: font.body,
                        }}>Retry</button>
                      )}
                      <button type="button" onClick={() => c.removeFile(a.id)} aria-label={`Remove ${a.fileName}`} style={{
                        background: 'none', border: 'none', cursor: 'pointer', color: colors.tertiary, fontSize: '12px', padding: '0 2px',
                      }}>✕</button>
                    </div>
                  ))}
                </div>
              )}
              {(c.error ?? failureSummary(c.attachments)) && (
                <p style={{ margin: 0, fontSize: '12px', color: colors.red }}>{c.error ?? failureSummary(c.attachments)}</p>
              )}

              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: '12px', color: colors.muted }}>{c.note.length}/1000</span>
                {sending ? (
                  <button
                    type="button"
                    onClick={p.onSend}
                    disabled={c.saving || !gate.ok}
                    title={!gate.ok ? gate.message : undefined}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: '6px',
                      padding: '9px 20px', borderRadius: '8px', border: `1.5px solid ${colors.green}`,
                      background: colors.green, color: '#ffffff', fontSize: '13px', fontWeight: 700, fontFamily: font.body,
                      cursor: c.saving || !gate.ok ? 'not-allowed' : 'pointer', opacity: c.saving || !gate.ok ? 0.55 : 1,
                    }}
                  >
                    <Send size={14} />
                    {c.saving ? (c.waitingUploads ? 'Finishing uploads…' : 'Sending…') : `Send Quotation to ${requester}`}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={p.onPostMessage}
                    disabled={c.saving || failed}
                    style={{
                      padding: '7px 18px', borderRadius: '8px', border: `1.5px solid ${colors.brand}`,
                      background: colors.brand, color: '#ffffff', fontSize: '12px', fontWeight: 600, fontFamily: font.body,
                      cursor: c.saving || failed ? 'not-allowed' : 'pointer', opacity: c.saving || failed ? 0.6 : 1,
                    }}
                  >
                    {c.saving ? (c.waitingUploads ? 'Finishing uploads…' : 'Sending…') : 'Send Message'}
                  </button>
                )}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* ── Timeline ─────────────────────────────────────────────────── */}
      {p.timeline}
    </div>
  )
}
