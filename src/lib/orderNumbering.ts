// Confirmed Order number cycle — shared client helpers.
//
// The database raises numbering failures with a stable, greppable code prefix
// (migration 20260703000000): every message starts with ORDER_NUMBER_* followed
// by a colon and a human-readable detail. Two surfaces need to render those
// failures — the admin control in Control Center and the Order Request
// conversion modal — so the mapping lives here rather than being duplicated and
// drifting apart.
//
// The rule this file exists to enforce: never show the raw Postgres message, and
// never swallow a real error behind a generic "something went wrong". Each known
// code gets a sentence that tells the reader what actually happened and who can
// fix it. Anything unrecognised falls through to the original message, which is
// still far more useful than a generic string.

/** Error codes raised by the numbering contract, in the order the UI meets them. */
export type OrderNumberErrorCode =
  | 'ORDER_NUMBER_CYCLE_MISSING'
  | 'ORDER_NUMBER_CYCLE_INVALID'
  | 'ORDER_NUMBER_CYCLE_BEHIND'
  | 'ORDER_NUMBER_CYCLE_EXHAUSTED'
  | 'ORDER_NUMBER_IN_USE'
  | 'ORDER_NUMBER_TOO_LOW'
  | 'ORDER_NUMBER_TOO_HIGH'
  | 'ORDER_NUMBER_INVALID'
  | 'ORDER_NUMBER_IMMUTABLE'

const CODES: OrderNumberErrorCode[] = [
  'ORDER_NUMBER_CYCLE_MISSING',
  'ORDER_NUMBER_CYCLE_INVALID',
  'ORDER_NUMBER_CYCLE_BEHIND',
  'ORDER_NUMBER_CYCLE_EXHAUSTED',
  'ORDER_NUMBER_IN_USE',
  'ORDER_NUMBER_TOO_LOW',
  'ORDER_NUMBER_TOO_HIGH',
  'ORDER_NUMBER_INVALID',
  'ORDER_NUMBER_IMMUTABLE',
]

// ── The four-digit format ────────────────────────────────────────────────────
//
// Mirrors public.format_confirmed_order_number(bigint) from migration
// 20260704000000. The database is authoritative — every Order number is STORED
// four-digit, so nothing in the app ever has to pad a value it read back. These
// helpers exist for the one place that works with a number the database has not
// stamped yet: the admin control's live preview of what the next Order will be
// called.

/** Confirmed Order numbers run 0001–9999. Also enforced by the database. */
export const MAX_ORDER_NUMBER = 9999

/** 25 -> '0025'. Null for anything outside 1–9999, matching the SQL function. */
export function formatOrderNumber(n: number | null | undefined): string | null {
  if (n == null || !Number.isInteger(n) || n < 1 || n > MAX_ORDER_NUMBER) return null
  return String(n).padStart(4, '0')
}

export type OrderNumberInput =
  | { ok: true;  value: number }
  | { ok: false; error: string }

/**
 * Validates what an admin typed into the next-Order-number box.
 *
 * Leading zeros are optional and meaningless on the way in — '25' and '0025'
 * both resolve to 25 — because the padding is a display convention, not part of
 * what the admin is choosing. Anything that is not a plain whole number is
 * refused here rather than sent to the server, so an obvious typo does not cost
 * a round trip. This is a convenience only: every one of these rules is
 * independently enforced by set_next_confirmed_order_number().
 */
export function parseOrderNumberInput(raw: string): OrderNumberInput {
  const trimmed = raw.trim()

  if (!trimmed) return { ok: false, error: 'Enter the next Order number.' }

  // Rejects '-1', '25.5', '2e3', '1 7' and 'ORD-25' in one rule, and says which
  // of those it was rather than a blanket "invalid".
  if (/[.,]/.test(trimmed)) {
    return { ok: false, error: 'Order numbers are whole numbers — no decimals.' }
  }
  if (trimmed.startsWith('-')) {
    return { ok: false, error: 'Enter a positive whole number.' }
  }
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, error: 'Enter digits only — no letters, spaces or symbols.' }
  }

  const value = Number(trimmed)
  if (!Number.isSafeInteger(value)) {
    return { ok: false, error: 'That number is too large.' }
  }
  if (value < 1) {
    return { ok: false, error: 'The next Order number must be at least 1 (0001).' }
  }
  if (value > MAX_ORDER_NUMBER) {
    return {
      ok: false,
      error: `Order numbers are four digits, so the highest possible is ${MAX_ORDER_NUMBER}.`,
    }
  }

  return { ok: true, value }
}

/** Returns the numbering error code carried by a database message, if any. */
export function orderNumberErrorCode(message?: string | null): OrderNumberErrorCode | null {
  if (!message) return null
  return CODES.find(c => message.includes(c)) ?? null
}

// The detail the database appended after "CODE: ". Carries the real numbers
// (which Order number clashed, what the highest existing one is), so it is worth
// surfacing rather than replacing with a generic sentence.
function detail(message: string, code: OrderNumberErrorCode): string {
  const idx = message.indexOf(code)
  return message.slice(idx + code.length).replace(/^:\s*/, '').trim()
}

/**
 * Turns a database error message into one clean user-facing sentence.
 *
 * `surface` only changes who is told to act: on the admin control the reader IS
 * the person who can fix it, so pointing them at "an admin" would be nonsense.
 */
export function orderNumberErrorMessage(
  message: string | null | undefined,
  surface: 'admin' | 'conversion',
): string | null {
  const code = orderNumberErrorCode(message)
  if (!code || !message) return null

  const d = detail(message, code)
  const askAdmin = surface === 'conversion'

  switch (code) {
    case 'ORDER_NUMBER_CYCLE_MISSING':
      return askAdmin
        ? 'Confirmed Order numbering is not configured. Ask an admin to set the next Order number in Control Center.'
        : 'Confirmed Order numbering is not configured yet.'

    case 'ORDER_NUMBER_CYCLE_INVALID':
      return askAdmin
        ? 'The configured next Order number is not valid. Ask an admin to review the Order number cycle in Control Center.'
        : 'The stored next Order number is not a valid positive number.'

    case 'ORDER_NUMBER_CYCLE_BEHIND':
      return askAdmin
        ? `The configured next Order number is no longer valid because it is not above the highest existing Order number. ${d} Ask an admin to set a higher next Order number.`
        : `The configured next Order number is no longer valid. ${d}`

    case 'ORDER_NUMBER_CYCLE_EXHAUSTED':
      return askAdmin
        ? 'Confirmed Order numbers run out at 9999 and that limit has been reached. Ask an admin before any further Orders can be created.'
        : 'Confirmed Order numbers run out at 9999 and that limit has been reached. The numbering scheme needs to be extended before another Order can be created.'

    case 'ORDER_NUMBER_TOO_HIGH':
      return capitalize(d)

    case 'ORDER_NUMBER_IN_USE':
      return askAdmin
        ? `${capitalize(d)}. Ask an admin to review the Order number cycle in Control Center.`
        : `${capitalize(d)}. Choose a different next Order number.`

    case 'ORDER_NUMBER_TOO_LOW':
      return capitalize(d)

    case 'ORDER_NUMBER_INVALID':
      return capitalize(d)

    case 'ORDER_NUMBER_IMMUTABLE':
      return 'An Order number cannot be changed once the Order exists.'
  }
}

function capitalize(s: string): string {
  if (!s) return s
  return s.charAt(0).toUpperCase() + s.slice(1)
}
