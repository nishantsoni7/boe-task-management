/**
 * ORDER PENDENCIES (20270325000000) — what is still outstanding from the client.
 *
 * The approver lists them in the convert dialog; the Order page shows the open
 * ones inside Fabric & Finish. The database re-checks every rule here (length,
 * count, duplicates, who may change them); this file only lets the screens say
 * so before a round trip.
 */

export const PENDENCY_MAX_LENGTH = 200
export const PENDENCY_MAX_PER_CALL = 20

export const PENDENCIES_TITLE = 'Pending from client'
export const PENDENCIES_EMPTY = 'Nothing pending from the client.'

export type PersistedPendency = {
  id: string
  label: string
  created_at: string
  cleared_at: string | null
}

export const ORDER_PENDENCY_SELECT = 'id, label, created_at, cleared_at'

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
  if (m.includes('ORDER_PENDENCY_NOT_OPEN')) return 'Only an open pendency can be removed.'
  if (m.includes('ORDER_PENDENCY_TOO_LONG')) return `Keep each pendency under ${PENDENCY_MAX_LENGTH} characters.`
  return 'The pendency could not be saved. Try again.'
}

type RpcCaller = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ error: unknown }> }

/**
 * Saves the convert dialog's list on the Order that was just created. Lives
 * here, not on the PI page, because that page's writes are pinned to the status
 * RPCs (draftsAccess.test.ts). Resolves true when saved (or nothing to save).
 */
export async function saveNewOrderPendencies(
  client: RpcCaller,
  orderId: string,
  labels: readonly string[],
): Promise<boolean> {
  if (labels.length === 0) return true
  const { error } = await client.rpc('add_order_pendencies', { p_order_id: orderId, p_labels: [...labels] })
  return !error
}
