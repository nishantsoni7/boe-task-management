/**
 * ORDER PENDENCIES (20270325000000) — what is still outstanding from the client.
 *
 * The approver lists them in the convert dialog; the Order page shows the open
 * ones inside Fabric & Finish. The database re-checks every rule here (length,
 * count, duplicates, who may change them); this file only lets the screens say
 * so before a round trip.
 */

import { EVIDENCE_MAX_BYTES, EVIDENCE_MIME_TYPES } from '@/lib/orders/orderApprovals'

export const PENDENCY_MAX_LENGTH = 200
export const PENDENCY_MAX_PER_CALL = 20

export const PENDENCIES_TITLE = 'Pending from client'
export const PENDENCIES_EMPTY = 'Nothing pending from the client.'

export type PersistedPendency = {
  id: string
  label: string
  created_at: string
  cleared_at: string | null
  /** The ERP screenshot the approval stood on; null while open, and on one cleared before screenshots were required. */
  evidence_path: string | null
  /** Who approved it, resolved by the read; null while open. */
  approver?: { full_name: string | null } | null
}

export const ORDER_PENDENCY_SELECT =
  'id, label, created_at, cleared_at, evidence_path, approver:users!cleared_by(full_name)'

/** Said where a pendency was approved without a screenshot (before 20270421000000). */
export const PENDENCY_NO_PROOF_NOTE = 'Approved before screenshots were required'

/**
 * Where a pendency's screenshot goes: orders/<order>/pendency/<unique>.<ext>.
 * The prefix is what the storage policy and approve_order_pendency() check, so
 * a pendency proof can never be filed against another Order or as Fabric proof.
 */
export function pendencyEvidencePath(input: { orderId: string; objectId: string; fileName: string }): string {
  const dot = input.fileName.lastIndexOf('.')
  const raw = dot > 0 ? input.fileName.slice(dot + 1).toLowerCase() : ''
  const extension = /^[a-z0-9]{1,8}$/.test(raw) ? raw : 'png'
  return `orders/${input.orderId}/pendency/${input.objectId}.${extension}`
}

/** One sentence when the chosen screenshot cannot be used, or null when it can. */
export function checkPendencyScreenshot(file: { size: number; type: string } | null): string | null {
  if (!file || file.size <= 0) return 'An ERP screenshot is required to approve.'
  if (!EVIDENCE_MIME_TYPES.includes(file.type)) return 'The screenshot must be a PNG, JPEG or WebP image.'
  if (file.size > EVIDENCE_MAX_BYTES) return 'The screenshot must be 5 MB or smaller.'
  return null
}

/** Trim and collapse inner whitespace, exactly as add_order_pendencies does. */
export function cleanPendencyLabel(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim()
}

/**
 * Adds one typed pendency to the convert dialog's list. Returns the list
 * unchanged with a sentence when the entry cannot be added, so the dialog can
 * say why instead of silently dropping the text.
 */
export function addPendencyDraft(
  current: readonly string[],
  raw: string,
): { list: string[]; problem: string | null } {
  const label = cleanPendencyLabel(raw)
  if (label === '') return { list: [...current], problem: null }
  if (label.length > PENDENCY_MAX_LENGTH) {
    return { list: [...current], problem: `Keep each pendency under ${PENDENCY_MAX_LENGTH} characters.` }
  }
  if (current.some(c => c.toLowerCase() === label.toLowerCase())) {
    return { list: [...current], problem: 'That pendency is already in the list.' }
  }
  if (current.length >= PENDENCY_MAX_PER_CALL) {
    return { list: [...current], problem: `At most ${PENDENCY_MAX_PER_CALL} pendencies.` }
  }
  return { list: [...current, label], problem: null }
}

export const splitPendencies = (rows: readonly PersistedPendency[]) => ({
  open: rows.filter(r => r.cleared_at === null),
  cleared: rows.filter(r => r.cleared_at !== null),
})

/** One sentence for a refused pendency RPC; falls back to a generic line. */
export function describePendencyError(message: string | null | undefined): string {
  const m = message ?? ''
  if (m.includes('ORDER_PENDENCY_FORBIDDEN')) return 'You do not have permission to change pendencies on this Order.'
  if (m.includes('ORDER_PENDENCY_ORDER_CANCELLED')) return 'This Order is cancelled.'
  if (m.includes('ORDER_PENDENCY_NOT_OPEN')) return 'That pendency is not open any more. Refresh to see where it stands.'
  if (m.includes('ORDER_PENDENCY_EVIDENCE_REQUIRED')) return 'An ERP screenshot is required to approve.'
  if (m.includes('ORDER_PENDENCY_EVIDENCE_REUSED')) return 'That screenshot is already filed against another approval. Choose a different one.'
  if (m.includes('ORDER_PENDENCY_EVIDENCE_PATH') || m.includes('ORDER_PENDENCY_EVIDENCE_MISSING')) return 'The screenshot did not finish uploading. Try again.'
  if (m.includes('ORDER_PENDENCY_TOO_LONG')) return `Keep each pendency under ${PENDENCY_MAX_LENGTH} characters.`
  return 'The pendency could not be saved. Try again.'
}
