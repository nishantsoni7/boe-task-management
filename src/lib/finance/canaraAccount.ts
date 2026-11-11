// ── Canara: who the money came from (owner 2026-11-11) ──────────────────────
//
// A Canara payment asks, in addition to "Where is this money now?" (it has the
// same handover journey as PNB and Paytm again, owner 2026-11-11 later that day),
// for the account the money CAME FROM:
//
//   Account holder   required
//   Account number   required
//   Bank             optional, any bank (the word "Canara" is only the name of
//                    BOE's own account, never the answer here)
//
// The payment is Confirmed when the company cash custodian (Nitish) accepts it
// (20270612000000), exactly like PNB and Paytm.
//
// NO SQL: the three answers are written as labelled lines at the top of the
// payment's note to Finance (sales_note), so they show wherever the note shows.
// There is no column for them. The check below is a form rule, not a database
// rule — the database accepts a Canara payment without them.

export type CanaraAccount = { holder: string; number: string; bank: string }

export const EMPTY_CANARA_ACCOUNT: CanaraAccount = { holder: '', number: '', bank: '' }

export const CANARA_HOLDER_MAX = 120
export const CANARA_BANK_MAX = 120
export const CANARA_NUMBER_MAX = 40

export function isCanaraMode(mode: string | null | undefined): boolean {
  return (mode ?? '').trim() === 'canara'
}

export type CanaraAccountProblems = { holder?: string; number?: string }

// Spaces and hyphens are how people type account numbers; letters are allowed
// because a foreign account is an IBAN. Everything else is refused.
const NUMBER_SHAPE = /^[A-Za-z0-9]{5,34}$/

export function canaraAccountProblems(a: CanaraAccount): CanaraAccountProblems {
  const out: CanaraAccountProblems = {}
  if (!a.holder.trim()) out.holder = 'Enter the account holder’s name.'
  const digits = a.number.replace(/[\s-]/g, '')
  if (!digits) out.number = 'Enter the account number the money came from.'
  else if (!NUMBER_SHAPE.test(digits)) out.number = 'This account number does not look right. Use 5 to 34 letters or digits.'
  return out
}

export function canaraAccountIsComplete(a: CanaraAccount): boolean {
  return Object.keys(canaraAccountProblems(a)).length === 0
}

export function canaraAccountIsEmpty(a: CanaraAccount): boolean {
  return !a.holder.trim() && !a.number.trim() && !a.bank.trim()
}

/**
 * The note to Finance as it is saved: the account lines, a blank line, then
 * whatever the person wrote themselves. Any other mode (or an empty form) saves
 * the person's own note untouched.
 */
export function composeCanaraNote(
  mode: string | null | undefined,
  a: CanaraAccount,
  ownNote: string,
): string {
  const own = ownNote.trim()
  if (!isCanaraMode(mode) || canaraAccountIsEmpty(a)) return own
  const lines = [`Account holder: ${a.holder.trim()}`, `Account number: ${a.number.trim()}`]
  if (a.bank.trim()) lines.push(`Bank: ${a.bank.trim()}`)
  return own ? `${lines.join('\n')}\n\n${own}` : lines.join('\n')
}
