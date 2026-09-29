// WHOSE ORDERS A SALES CANDIDATE MAY SEE — the words and the payload, for the
// Control Center screen (20270221000000).
//
// THE RULE IS THE DATABASE'S. A candidate's scope is one of three modes, and the
// database applies it to the Orders table itself (a SELECT policy), to the
// visibility predicate every Orders read asks, and therefore to the dashboard's
// counts and lists and to a direct API read. This module only names the modes,
// validates what set_order_visibility_scope / list_order_visibility_scopes
// return, and turns their refusals into sentences. Nothing here grants anything.
//
// A SCOPE WIDENS ORDERS, NEVER MONEY. It reveals Orders a candidate could not
// see before; it reveals no payment, no allocation, no payment total and no
// company revenue — those stay behind Finance and orders.view_all.

export type ScopeMode = 'own' | 'selected' | 'all_sales'

export type ScopeRow = {
  userId: string
  fullName: string
  mode: ScopeMode
  memberIds: string[]
}

export const SCOPE_MODES: readonly ScopeMode[] = ['own', 'selected', 'all_sales']

export const SCOPE_MODE_LABEL: Record<ScopeMode, string> = {
  own: 'Their own orders',
  selected: 'Their own orders plus selected sales candidates’ orders',
  all_sales: 'All sales candidates’ orders',
}

export const SCOPE_SECTION_TITLE = 'Order visibility'
export const SCOPE_SECTION_DESCRIPTION =
  'Which orders each sales candidate can see. It applies everywhere Orders are read — the dashboard, the lists, and direct access. It never shows payments or revenue, and it never lets anyone edit an order.'
export const SCOPE_CANDIDATES_NOTE =
  'A sales candidate is anyone on the sales team, or anyone granted “Can be order assignee”. Orders belong to a candidate through their salesperson or requester field.'

export type ParsedScopes = { ok: true; rows: ScopeRow[] } | { ok: false; message: string }

export function parseScopes(raw: unknown): ParsedScopes {
  if (!Array.isArray(raw)) return { ok: false, message: 'The visibility settings were not in the expected shape.' }
  const rows: ScopeRow[] = []
  for (const x of raw) {
    if (typeof x !== 'object' || x === null) return { ok: false, message: 'A visibility setting could not be read.' }
    const o = x as Record<string, unknown>
    const mode = o.mode
    if (typeof o.user_id !== 'string' || typeof o.full_name !== 'string'
        || (mode !== 'own' && mode !== 'selected' && mode !== 'all_sales')
        || !Array.isArray(o.member_ids) || o.member_ids.some(m => typeof m !== 'string')) {
      return { ok: false, message: 'A visibility setting could not be read.' }
    }
    rows.push({ userId: o.user_id, fullName: o.full_name, mode, memberIds: o.member_ids as string[] })
  }
  return { ok: true, rows }
}

/** What Save would send, or the reason it may not be sent. */
export function validateScopeChoice(mode: ScopeMode, memberIds: readonly string[]):
  { ok: true; members: string[] } | { ok: false; message: string } {
  if (mode !== 'selected') return { ok: true, members: [] }
  if (memberIds.length === 0) return { ok: false, message: 'Choose at least one sales candidate, or pick another option.' }
  return { ok: true, members: [...new Set(memberIds)] }
}

/** True when the draft differs from what is saved. */
export function scopeChanged(saved: ScopeRow, mode: ScopeMode, memberIds: readonly string[]): boolean {
  if (saved.mode !== mode) return true
  if (mode !== 'selected') return false
  const a = [...saved.memberIds].sort().join(',')
  const b = [...new Set(memberIds)].sort().join(',')
  return a !== b
}

const FAILURES: readonly { marker: string; message: string }[] = [
  { marker: 'ORDER_SCOPE_NOT_OWNER', message: 'Only the owner account can change Order visibility.' },
  { marker: 'ORDER_SCOPE_NOT_A_CANDIDATE', message: 'Only sales candidates have an Order visibility setting, and only they can be chosen.' },
  { marker: 'ORDER_SCOPE_SELF', message: 'A person’s own orders are always included; leave them out of the list.' },
  { marker: 'ORDER_SCOPE_MEMBERS_REQUIRED', message: 'Choose at least one sales candidate, or pick another option.' },
  { marker: 'ORDER_SCOPE_MODE_UNKNOWN', message: 'That option is not recognised.' },
  { marker: 'Authentication required', message: 'Your session has expired. Sign in again and try once more.' },
]
export const SCOPE_FALLBACK = 'Order visibility could not be changed just now. Try again in a moment.'

export function describeScopeFailure(error: unknown): string {
  const raw = typeof error === 'string' ? error : String((error as { message?: unknown } | null)?.message ?? '')
  return FAILURES.find(f => raw.includes(f.marker))?.message ?? SCOPE_FALLBACK
}
