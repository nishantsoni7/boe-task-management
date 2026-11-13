// THE MONTHLY REVIEW, server side (owner, 2026-11-12). The owner alone (the Day Close reviewer seat). The
// rules are in ./review.ts. Final scores come from the frozen nightly record (scoreboard_daily): each person's
// last written day of the month.

import type { Caller, ServiceClient } from '@/lib/security/attendancePayrollApiAuth'
import { istDayEndUtc, istDayStartUtc, istToday } from '@/lib/istDate'
import { BAND_LABEL, bandOf } from './score'
import { lastDayOf } from './vote'
import { isReviewer, scoredPeople, type Result } from './server'
import {
  AWARDS, STEP_LABEL, announcement, reviewFlags, suggestAwards, validateGoals,
  type AwardKey, type FinalRow,
} from './review'

const ok = (body: Record<string, unknown>, status = 200): Result => ({ status, body })
const fail = (status: number, error: string): Result => ({ status, body: { error } })
const MONTH_RE = /^\d{4}-\d{2}-01$/

export function previousMonth(month: string): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 2, 1))
  return d.toISOString().slice(0, 10)
}

export function monthLabel(month: string): string {
  return new Date(`${month}T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' })
}

/** Each person's last written day of the month. */
async function finalRows(svc: ServiceClient, month: string): Promise<Map<string, FinalRow & { score_date: string }>> {
  const { data, error } = await svc.from('scoreboard_daily')
    .select('employee_id, score_date, track, score, parts').eq('month', month).lte('score_date', lastDayOf(month))
    .order('score_date', { ascending: true })
  if (error) throw new Error(error.message)
  const out = new Map<string, FinalRow & { score_date: string }>()
  for (const r of (data ?? []) as { employee_id: string; score_date: string; track: 'general' | 'sales'; score: number | null; parts: FinalRow['parts'] }[]) {
    out.set(r.employee_id, { id: r.employee_id, name: '', track: r.track, score: r.score, parts: r.parts, score_date: r.score_date })
  }
  return out
}

export async function loadReview(caller: Caller, monthParam: string | null, now: Date = new Date()): Promise<Result> {
  if (!(await isReviewer(caller))) return fail(403, 'Only the owner holds the monthly review.')
  const svc = caller.svc
  const today = istToday(now)
  const thisMonth = `${today.slice(0, 7)}-01`
  const month = monthParam && MONTH_RE.test(monthParam) && monthParam <= thisMonth ? monthParam : previousMonth(thisMonth)
  const prev = previousMonth(month)
  const prev2 = previousMonth(prev)

  const [cur, last, before, people, frozen, awards, reviews, votes, sales] = await Promise.all([
    finalRows(svc, month), finalRows(svc, prev), finalRows(svc, prev2), scoredPeople(svc),
    svc.from('scoreboard_months').select('month, frozen_at, frozen_by').eq('month', month).maybeSingle(),
    svc.from('scoreboard_awards').select('award, employee_id, note').eq('month', month),
    svc.from('scoreboard_reviews').select('employee_id, goals, checkin_on, warning, note').eq('month', month),
    svc.from('scoreboard_votes').select('nominee_id').eq('month', month),
    svc.from('order_submissions').select('salesperson_id, total_before_gst')
      .eq('status', 'approved').gte('approved_at', istDayStartUtc(month)).lte('approved_at', istDayEndUtc(lastDayOf(month))),
  ])
  for (const r of [frozen, awards, reviews, votes]) if (r.error) throw new Error(r.error.message)

  // Names for everybody in the record, including anybody no longer scored.
  const names = new Map(people.map(p => [p.id, p.full_name ?? 'Unknown']))
  const missing = [...cur.keys()].filter(id => !names.has(id))
  if (missing.length) {
    const r = await svc.from('users').select('id, full_name').in('id', missing)
    for (const u of r.data ?? []) names.set(String(u.id), String(u.full_name ?? 'Unknown'))
  }
  const rows = [...cur.values()].map(r => ({ ...r, name: names.get(r.id) ?? 'Unknown' }))

  const previous = new Map([...last.values()].map(r => [r.id, r.score]))
  const history = new Map(rows.map(r => [r.id, [before.get(r.id)?.score ?? null, last.get(r.id)?.score ?? null]]))
  const voteCount = new Map<string, number>()
  for (const v of (votes.data ?? []) as { nominee_id: string }[]) voteCount.set(v.nominee_id, (voteCount.get(v.nominee_id) ?? 0) + 1)
  const salesBy = new Map<string, number>()
  for (const s of (sales.error ? [] : sales.data ?? []) as { salesperson_id: string | null; total_before_gst: number | null }[]) {
    if (s.salesperson_id) salesBy.set(s.salesperson_id, (salesBy.get(s.salesperson_id) ?? 0) + Number(s.total_before_gst ?? 0))
  }

  const suggestions = suggestAwards({ rows, previous, sales: salesBy, votes: voteCount })
  const flags = reviewFlags(rows, history)
  const saved = (awards.data ?? []) as { award: AwardKey; employee_id: string; note: string | null }[]
  const isFrozen = !!frozen.data

  const winners = AWARDS.map(a => ({
    award: a.key,
    names: saved.filter(s => s.award === a.key).map(s => names.get(s.employee_id) ?? 'Unknown'),
    note: saved.find(s => s.award === a.key)?.note ?? null,
  }))

  return ok({
    month,
    monthLabel: monthLabel(month),
    ended: today > lastDayOf(month),
    frozen: isFrozen ? frozen.data : null,
    rows: rows
      .sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.name.localeCompare(b.name))
      .map(r => ({
        id: r.id, name: r.name, track: r.track, score: r.score,
        band: r.score === null ? null : BAND_LABEL[bandOf(r.score)],
        change: r.score !== null && typeof previous.get(r.id) === 'number' ? r.score - (previous.get(r.id) as number) : null,
        votes: voteCount.get(r.id) ?? 0,
        sales: salesBy.get(r.id) ?? 0,
        flag: flags.has(r.id) ? { ...flags.get(r.id)!, label: STEP_LABEL[flags.get(r.id)!.step] } : null,
      })),
    awards: AWARDS.map(a => ({ ...a, suggested: suggestions[a.key], saved: saved.filter(s => s.award === a.key).map(s => s.employee_id) })),
    reviews: reviews.data ?? [],
    announcement: isFrozen ? announcement(monthLabel(month), winners) : null,
  })
}

export async function freezeMonth(caller: Caller, body: Record<string, unknown>, now: Date = new Date()): Promise<Result> {
  if (!(await isReviewer(caller))) return fail(403, 'Only the owner freezes a month.')
  const month = typeof body.month === 'string' && MONTH_RE.test(body.month) ? body.month : ''
  if (!month) return fail(400, 'Which month?')
  if (istToday(now) <= lastDayOf(month)) return fail(409, 'A month can be frozen only once it has ended.')
  const svc = caller.svc
  const done = await svc.from('scoreboard_months').select('month').eq('month', month).maybeSingle()
  if (done.error) throw new Error(done.error.message)
  if (done.data) return fail(409, 'This month is already frozen and announced.')

  const rows = await finalRows(svc, month)
  if (rows.size === 0) return fail(409, 'There is no record for this month yet.')
  const picks = (body.awards && typeof body.awards === 'object' ? body.awards : {}) as Record<string, unknown>
  const notes = (body.notes && typeof body.notes === 'object' ? body.notes : {}) as Record<string, unknown>
  const inserts: { month: string; award: AwardKey; employee_id: string; note: string | null }[] = []
  for (const a of AWARDS) {
    const ids = (Array.isArray(picks[a.key]) ? picks[a.key] as unknown[] : []).filter((x): x is string => typeof x === 'string')
    if (!a.many && ids.length > 1) return fail(400, `${a.label} has one winner.`)
    if (ids.some(id => !rows.has(id))) return fail(400, `${a.label}: that person has no score this month.`)
    const note = typeof notes[a.key] === 'string' && (notes[a.key] as string).trim().length >= 2 ? (notes[a.key] as string).trim().slice(0, 200) : null
    for (const id of new Set(ids)) inserts.push({ month, award: a.key, employee_id: id, note })
  }
  if (inserts.length) {
    const { error } = await svc.from('scoreboard_awards').insert(inserts)
    if (error) throw new Error(error.message)
  }
  const { error } = await svc.from('scoreboard_months').insert({ month, frozen_by: caller.id, frozen_at: now.toISOString() })
  if (error) throw new Error(error.message)
  return ok({ frozen: true })
}

export async function saveGoals(caller: Caller, body: Record<string, unknown>, now: Date = new Date()): Promise<Result> {
  if (!(await isReviewer(caller))) return fail(403, 'Only the owner writes review goals.')
  const month = typeof body.month === 'string' && MONTH_RE.test(body.month) ? body.month : ''
  const id = typeof body.employee_id === 'string' ? body.employee_id : ''
  if (!month) return fail(400, 'Which month?')
  const v = validateGoals(body, month)
  if (!v.ok) return fail(400, v.error)
  const rows = await finalRows(caller.svc, month)
  if (!rows.has(id)) return fail(404, 'That person has no score this month.')
  const { error } = await caller.svc.from('scoreboard_reviews').upsert({
    month, employee_id: id, ...v.value, created_by: caller.id, updated_at: now.toISOString(),
  }, { onConflict: 'month,employee_id' })
  if (error) throw new Error(error.message)
  return ok({ saved: true })
}

/** For everybody's card: last month's champions once announced, and the person's own private goals. */
export async function monthMessages(svc: ServiceClient, userId: string, today: string): Promise<{ champions: { label: string; names: string[] }[] | null; championsMonth: string | null; myGoals: { goals: string[]; checkin_on: string } | null }> {
  const month = previousMonth(`${today.slice(0, 7)}-01`)
  const [frozen, awards, mine] = await Promise.all([
    svc.from('scoreboard_months').select('month').eq('month', month).maybeSingle(),
    svc.from('scoreboard_awards').select('award, employee_id').eq('month', month),
    svc.from('scoreboard_reviews').select('goals, checkin_on').eq('month', month).eq('employee_id', userId).maybeSingle(),
  ])
  let champions: { label: string; names: string[] }[] | null = null
  if (!frozen.error && frozen.data && !awards.error) {
    const rows = (awards.data ?? []) as { award: AwardKey; employee_id: string }[]
    const ids = [...new Set(rows.map(r => r.employee_id))]
    const names = new Map<string, string>()
    if (ids.length) {
      const u = await svc.from('users').select('id, full_name').in('id', ids)
      for (const x of u.data ?? []) names.set(String(x.id), String(x.full_name ?? 'Unknown'))
    }
    champions = AWARDS.map(a => ({ label: a.label, names: rows.filter(r => r.award === a.key).map(r => names.get(r.employee_id) ?? 'Unknown') }))
      .filter(c => c.names.length > 0)
  }
  return {
    champions,
    championsMonth: champions ? monthLabel(month) : null,
    myGoals: !mine.error && mine.data ? { goals: mine.data.goals as string[], checkin_on: String(mine.data.checkin_on) } : null,
  }
}
