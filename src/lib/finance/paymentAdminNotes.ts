// ── The admin's private note on a payment (20270603000000) ──────────────────
//
// One note per payment, readable and writable ONLY by an active role admin. It is
// NOT the Finance decision note (finance_payment_requests.admin_note), which the
// person who sent the payment reads. The database is the authority: every call
// below goes through get_payment_admin_notes / set_payment_admin_note, which
// refuse anybody else, so the screens draw the note controls for admins only as a
// convenience and nothing here grants anything.

import type { createClient } from '@/lib/supabase/client'

type Client = ReturnType<typeof createClient>

export const ADMIN_NOTE_MAX = 2000

export type PaymentAdminNote = { note: string; updatedAt: string }

/** Reads the rows of get_payment_admin_notes. Anything malformed is left out. */
export function readPaymentAdminNotes(raw: unknown): Map<string, PaymentAdminNote> {
  const out = new Map<string, PaymentAdminNote>()
  if (!Array.isArray(raw)) return out
  for (const r of raw) {
    const o = (r ?? {}) as Record<string, unknown>
    if (typeof o.payment_id !== 'string' || typeof o.note !== 'string' || o.note.trim() === '') continue
    out.set(o.payment_id, { note: o.note, updatedAt: typeof o.updated_at === 'string' ? o.updated_at : '' })
  }
  return out
}

/** The notes of these payments. Throws when the read fails, so a failure is never read as "no notes". */
export async function loadPaymentAdminNotes(supabase: Client, paymentIds: string[]): Promise<Map<string, PaymentAdminNote>> {
  if (paymentIds.length === 0) return new Map()
  const { data, error } = await supabase.rpc('get_payment_admin_notes', { p_payment_ids: paymentIds })
  if (error) throw new Error(error.message)
  return readPaymentAdminNotes(data)
}

/** What the database said, in a sentence a person can act on. */
export function paymentAdminNoteErrorMessage(error: { code?: string; message?: string } | null | undefined): string {
  const message = error?.message ?? ''
  if (message.includes('ADMIN_NOTE_ADMIN_ONLY')) return 'Only an administrator can read or write these notes.'
  if (message.includes('ADMIN_NOTE_TOO_LONG')) return `A note can be at most ${ADMIN_NOTE_MAX.toLocaleString('en-IN')} characters.`
  if (message.includes('ADMIN_NOTE_PAYMENT_NOT_FOUND')) return 'That payment no longer exists. Press refresh.'
  // PostgREST / Postgres: the function is not there yet (the migration has not been applied).
  if (error?.code === 'PGRST202' || error?.code === '42883') return 'Admin notes are not switched on yet: the database update has not been applied.'
  return 'The note could not be saved. Try again.'
}

export type SavePaymentAdminNoteResult =
  | { ok: true; note: PaymentAdminNote | null }
  | { ok: false; message: string }

/** Saves a note; an empty text removes it (the result's note is then null). */
export async function savePaymentAdminNote(supabase: Client, paymentId: string, text: string): Promise<SavePaymentAdminNoteResult> {
  const note = text.trim()
  if (note.length > ADMIN_NOTE_MAX) return { ok: false, message: paymentAdminNoteErrorMessage({ message: 'ADMIN_NOTE_TOO_LONG' }) }
  try {
    const { data, error } = await supabase.rpc('set_payment_admin_note', { p_payment_id: paymentId, p_note: note })
    if (error) return { ok: false, message: paymentAdminNoteErrorMessage(error) }
    // The function returns when it saved, or null when it removed the note.
    return { ok: true, note: note === '' || typeof data !== 'string' ? null : { note, updatedAt: data } }
  } catch {
    return { ok: false, message: paymentAdminNoteErrorMessage(null) }
  }
}

/** The first words of a note, on one line, for a hover title. */
export function paymentAdminNotePreview(note: string, max = 140): string {
  const oneLine = note.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max - 1).trimEnd()}…` : oneLine
}
