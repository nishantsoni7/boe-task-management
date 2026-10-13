// The database raises "INVENTORY_<KIND>: <sentence>"; the sentence is written for people.

export type InventoryErrorKind =
  | 'auth' | 'forbidden' | 'not_found' | 'duplicate_code' | 'insufficient' | 'invalid' | 'uncertain' | 'unknown'

export type InventoryErrorDetail = { kind: InventoryErrorKind; message: string }

type Raw = { message?: string; code?: string; status?: number } | null | undefined
const AFTER_PREFIX = /^INVENTORY_[A-Z_]+:\s*/

export function classifyInventoryError(err: Raw): InventoryErrorDetail {
  const message = (err?.message ?? '').trim()
  const code = err?.code ?? ''
  const sentence = message.replace(AFTER_PREFIX, '')

  if (/JWT|not authenticated|Auth session missing/i.test(message) || code === 'PGRST301' || err?.status === 401) {
    return { kind: 'auth', message: 'Your session has expired. Sign in again.' }
  }
  if (message.startsWith('INVENTORY_FORBIDDEN') || code === '42501') {
    return { kind: 'forbidden', message: 'You do not have access to this.' }
  }
  if (message.startsWith('INVENTORY_NOT_FOUND')) return { kind: 'not_found', message: sentence || 'That is no longer available.' }
  if (message.startsWith('INVENTORY_DUPLICATE_CODE')) return { kind: 'duplicate_code', message: sentence }
  if (message.startsWith('INVENTORY_INSUFFICIENT')) return { kind: 'insufficient', message: sentence }
  if (message.startsWith('INVENTORY_INVALID')) return { kind: 'invalid', message: sentence }
  if (err?.status === 0 || /Failed to fetch|NetworkError|Load failed|network/i.test(message)) {
    return { kind: 'uncertain', message: 'No connection. Check your network and try again.' }
  }
  return { kind: 'unknown', message: 'Something went wrong. Try again.' }
}

export class InventoryRequestError extends Error {
  readonly detail: InventoryErrorDetail
  constructor(detail: InventoryErrorDetail) {
    super(detail.message)
    this.name = 'InventoryRequestError'
    this.detail = detail
  }
  get kind() { return this.detail.kind }
}

export const errorMessage = (e: unknown) =>
  e instanceof InventoryRequestError ? e.message : e instanceof Error ? e.message : 'Something went wrong. Try again.'
