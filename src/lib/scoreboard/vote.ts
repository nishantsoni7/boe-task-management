// The monthly team vote and the owner's rating: when they are open, and what a person may send (owner,
// 2026-11-12). Pure.
//
//   vote     the last 3 days of the month, closing at 23:00 IST on the last day (the final record is written
//            at 23:30). Each scored person gives 3 votes to 3 different colleagues, never themselves, once.
//            Secret: nobody, the owner included, is ever shown who voted for whom.
//   rating   the owner's 1-5 with one line of reason, from the 25th until the same 23:00 close.

export const VOTE_DAYS = 3
export const VOTE_CLOSE_MINUTES = 23 * 60
export const RATING_OPENS_DAY = 25
export const VOTES_PER_PERSON = 3
export const NOTE_MAX = 200

const pad = (n: number) => String(n).padStart(2, '0')

export function monthOf(date: string): string {
  return `${date.slice(0, 7)}-01`
}

export function lastDayOf(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return `${y}-${pad(m)}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`
}

/** The instant the month's vote and ratings close: 23:00 IST on its last day. */
export function closesAt(month: string): string {
  return new Date(`${lastDayOf(month)}T23:00:00+05:30`).toISOString()
}

export function voteOpensOn(month: string): string {
  const last = lastDayOf(month)
  return `${last.slice(0, 8)}${pad(Number(last.slice(8)) - (VOTE_DAYS - 1))}`
}

export function ratingOpensOn(month: string): string {
  return `${month.slice(0, 8)}${pad(RATING_OPENS_DAY)}`
}

function istDate(now: Date): string {
  return new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10)
}

export type Window = { month: string; opensOn: string; closesAt: string; open: boolean; closed: boolean }

function windowFor(now: Date, opensOn: (m: string) => string): Window {
  const month = monthOf(istDate(now))
  const opens = opensOn(month)
  const close = closesAt(month)
  const open = istDate(now) >= opens && now.toISOString() < close
  return { month, opensOn: opens, closesAt: close, open, closed: now.toISOString() >= close }
}

export const voteWindow = (now: Date) => windowFor(now, voteOpensOn)
export const ratingWindow = (now: Date) => windowFor(now, ratingOpensOn)

export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

/** Three different colleagues from the list, never yourself; an optional short line for each. */
export function validateVotes(
  body: Record<string, unknown>,
  voterId: string,
  candidates: ReadonlySet<string>,
): Result<{ nominee_id: string; note: string | null }[]> {
  const raw = Array.isArray(body.nominees) ? body.nominees : []
  const ids = raw.filter((x): x is string => typeof x === 'string')
  if (ids.length !== VOTES_PER_PERSON) return { ok: false, error: `Choose exactly ${VOTES_PER_PERSON} colleagues.` }
  if (new Set(ids).size !== ids.length) return { ok: false, error: 'Choose three different people.' }
  if (ids.includes(voterId)) return { ok: false, error: 'You cannot vote for yourself.' }
  if (ids.some(id => !candidates.has(id))) return { ok: false, error: 'One of those people cannot be voted for.' }
  const notes = (body.notes && typeof body.notes === 'object' ? body.notes : {}) as Record<string, unknown>
  return {
    ok: true,
    value: ids.map(id => {
      const n = typeof notes[id] === 'string' ? (notes[id] as string).trim().slice(0, NOTE_MAX) : ''
      return { nominee_id: id, note: n.length >= 2 ? n : null }
    }),
  }
}

export function validateRating(body: Record<string, unknown>): Result<{ rating: number; reason: string }> {
  const rating = Number(body.rating)
  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return { ok: false, error: 'Choose a rating from 1 to 5.' }
  if (reason.length < 3) return { ok: false, error: 'Give one line of reason: the person will read it.' }
  if (reason.length > 300) return { ok: false, error: 'Keep the reason under 300 characters.' }
  return { ok: true, value: { rating, reason } }
}
