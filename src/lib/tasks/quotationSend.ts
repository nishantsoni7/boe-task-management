// Quotation Details — the pure half.
//
// A quotation request is sent by the quotation team, not "completed". Sending
// posts ONE update that carries the quote file(s) and an optional note to sales,
// then completes the task. That update is tagged with QUOTATION_SENT_MARKER in
// the activity row's `new_val` column (no schema change), which is how the page
// tells the quote the team sent apart from the files sales attached with the
// request, and apart from ordinary messages.

import { buildGalleryEntries, type GalleryEntry } from '@/lib/tasks/taskGallery'
import type { LogEntry } from '@/lib/types'

export const QUOTATION_SENT_MARKER = 'quotation_sent'

/** The update that carried a sent quotation. */
export function isQuotationSentEntry(e: Pick<LogEntry, 'action' | 'new_val'>): boolean {
  return e.action === 'note_added' && e.new_val === QUOTATION_SENT_MARKER
}

export type SentQuotation = {
  entryId: string
  at:      string
  actorId: string
  actorName?: string
  note:    string | null
  files:   GalleryEntry[]
}

/** The newest sent quotation in a newest-first log, or null if none was ever sent. */
export function latestSentQuotation(log: readonly LogEntry[]): SentQuotation | null {
  const entry = log.find(isQuotationSentEntry)
  if (!entry) return null
  return {
    entryId:   entry.id,
    at:        entry.created_at,
    actorId:   entry.actor_id,
    actorName: entry.actor_name,
    note:      entry.note?.trim() || null,
    files:     buildGalleryEntries(null, entry.attachments ?? []),
  }
}

/** How many times a quotation has been sent (more than one means it was revised). */
export function sentQuotationCount(log: readonly LogEntry[]): number {
  return log.filter(isQuotationSentEntry).length
}

export type SendGate = { ok: true } | { ok: false; message: string }

/**
 * May the quotation be sent? At least one quote file must be attached, and none
 * may have failed to upload. A file still uploading is fine: sending waits for it.
 */
export function quotationSendGate(items: readonly { status: string }[]): SendGate {
  if (items.length === 0) {
    return { ok: false, message: 'Attach the quotation file before sending.' }
  }
  if (items.some(i => i.status === 'failed')) {
    return { ok: false, message: 'Retry or remove the failed attachment first.' }
  }
  return { ok: true }
}

/** "5 min", "3 h", "2 days" — how long a request has been waiting. */
export function waitingLabel(fromIso: string, toMs: number): string {
  const mins = Math.max(0, Math.floor((toMs - new Date(fromIso).getTime()) / 60000))
  if (mins < 60) return `${Math.max(1, mins)} min`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} h`
  const days = Math.floor(hours / 24)
  return `${days} ${days === 1 ? 'day' : 'days'}`
}
