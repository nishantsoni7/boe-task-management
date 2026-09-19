// One idempotency key per GENUINE payment submission (20261219000000).
//
// The payment doors (submit_payment_request, record_payment_with_allocations,
// record_pi_submission_payment) take `p_idempotency_key`. The server keeps the
// first result under (actor, key) and returns it for any retry with the same
// payload, so a lost response, a timeout or a second press can never record the
// same money twice. The server is the protection; this module only decides
// WHICH key a press should carry:
//
//   * a NEW key for a new submission;
//   * the SAME key after a press whose outcome is unknown (no answer, a dropped
//     connection) — whatever the person changed since, so a changed payload is
//     REFUSED by the server (PAYMENT_IDEMPOTENCY_KEY_REUSED) rather than
//     recorded as a second payment;
//   * the same key after a refresh, when the same details are entered again in
//     the same tab — the pending key lives in sessionStorage (per tab, never
//     shared, cleared when the tab closes) and holds only the key, a hash of
//     the payload and a time. No amount, name or note is stored.
//
// A definitive answer — a success whose follow-up work is finished, or a refusal
// the database gave — settles the attempt, and the next press is a new payment.

export type KeyStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/** How long a pending, unanswered attempt is offered back after a refresh. */
export const PENDING_SUBMISSION_TTL_MS = 30 * 60 * 1000

const STORAGE_PREFIX = 'boe.pendingPaymentSubmission.'

/** The sentence a form shows when it cannot know whether the payment was recorded. */
export const SUBMISSION_OUTCOME_UNKNOWN =
  'The connection dropped before Finance answered, so this payment may or may not have been recorded. Press the button again — the same payment will not be recorded twice.'

/** The server's refusal of a key reused with different details. */
export const SUBMISSION_KEY_REUSED_MESSAGE =
  'This payment was already recorded with different details, so nothing new was recorded. Check the payment list before entering it again.'

export function sessionKeyStorage(): KeyStorage | null {
  try {
    return typeof window !== 'undefined' && window.sessionStorage ? window.sessionStorage : null
  } catch {
    return null
  }
}

/** JSON with object keys sorted, so the same payload always reads the same. */
function stableStringify(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
}

/** A 53-bit hash of the payload (cyrb53). Equality within one tab, nothing more. */
export function payloadFingerprint(payload: unknown): string {
  const text = stableStringify(payload)
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16)
}

/**
 * Did the call end without the database deciding anything we can read?
 *
 * A PostgreSQL or PostgREST refusal carries a `code` (P0001, 42501, PGRST202…)
 * and means the transaction did not commit. A dropped connection, a timeout or a
 * gateway page carries none — the payment may exist.
 */
export function isAmbiguousFailure(error: { code?: unknown } | null | undefined): boolean {
  if (!error) return true
  return typeof error.code !== 'string' || error.code.trim() === ''
}

export function isKeyReused(message: string | null | undefined): boolean {
  return (message ?? '').includes('PAYMENT_IDEMPOTENCY_KEY_REUSED')
}

type Pending = { key: string; fingerprint: string; at: number }

export class SubmissionAttempt {
  private current: Pending | null = null

  constructor(
    private readonly scope: string,
    private readonly storage: KeyStorage | null = sessionKeyStorage(),
    private readonly newKey: () => string = () => crypto.randomUUID(),
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** The key this press must carry. */
  begin(payload: unknown): string {
    const fingerprint = payloadFingerprint(payload)
    if (this.current) {
      // An unanswered press from THIS form: the same key, whatever changed.
      this.current = { ...this.current, fingerprint }
      this.write(this.current)
      return this.current.key
    }
    const stored = this.read()
    if (stored && stored.fingerprint === fingerprint && this.now() - stored.at < PENDING_SUBMISSION_TTL_MS) {
      this.current = stored
      return stored.key
    }
    this.current = { key: this.newKey(), fingerprint, at: this.now() }
    this.write(this.current)
    return this.current.key
  }

  /** The outcome is known: the next press is a new submission. */
  settle(): void {
    this.current = null
    try { this.storage?.removeItem(STORAGE_PREFIX + this.scope) } catch { /* storage unavailable */ }
  }

  /** Settle unless the call's outcome is unknown. */
  settleUnlessAmbiguous(error: { code?: unknown; message?: string | null } | null | undefined): void {
    if (isKeyReused(error?.message) || !isAmbiguousFailure(error)) this.settle()
  }

  private read(): Pending | null {
    try {
      const raw = this.storage?.getItem(STORAGE_PREFIX + this.scope)
      if (!raw) return null
      const parsed = JSON.parse(raw) as Partial<Pending>
      if (typeof parsed.key !== 'string' || typeof parsed.fingerprint !== 'string' || typeof parsed.at !== 'number') {
        return null
      }
      return { key: parsed.key, fingerprint: parsed.fingerprint, at: parsed.at }
    } catch {
      return null
    }
  }

  private write(pending: Pending): void {
    try { this.storage?.setItem(STORAGE_PREFIX + this.scope, JSON.stringify(pending)) } catch { /* storage unavailable */ }
  }
}
