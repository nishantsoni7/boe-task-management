'use client'

// Report cards on top of the Quotations list (owner, 20 Nov 2026): each person sees what matters for their own work; the owner and anyone with
// "see all" also see the team (who made the most, the total, the conversion, and a candidate-by-candidate table that opens that person's cards).
// ONE database call (quotation_cards); the list below does not wait for it.

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { createClient } from '@/lib/supabase/client'
import { cardsKey, errorText, fetchCards, type Cards } from '@/lib/quotations/api'
import { formatINR } from '@/lib/currency'
import { AppLink as Link } from '@/components/ui/AppLink'
import { quotationWait } from '@/lib/tasks/quotationWait'
import s from './quotations.module.css'

type Supabase = ReturnType<typeof createClient>
export type PeriodKey = 'last' | 'this' | 'three'
export const PERIODS: [PeriodKey, string][] = [['last', 'Last month'], ['this', 'This month'], ['three', 'Last 3 months']]

const pad = (n: number) => String(n).padStart(2, '0')
const day = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`

/** The India-date range of a period; `now` is an epoch in ms. Months are whole calendar months in India. */
export function periodDates(key: PeriodKey, now: number): { from: string; to: string } {
  const ist = new Date(now + 5.5 * 3_600_000)
  const y = ist.getUTCFullYear(), m = ist.getUTCMonth() + 1
  const startOf = (offset: number) => { const d = new Date(Date.UTC(y, m - 1 + offset, 1)); return [d.getUTCFullYear(), d.getUTCMonth() + 1] as const }
  const endOf = (offset: number) => { const d = new Date(Date.UTC(y, m + offset, 0)); return day(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()) }
  if (key === 'this') { const [yy, mm] = startOf(0); return { from: day(yy, mm, 1), to: endOf(0) } }
  if (key === 'last') { const [yy, mm] = startOf(-1); return { from: day(yy, mm, 1), to: endOf(-1) } }
  const [yy, mm] = startOf(-3); return { from: day(yy, mm, 1), to: endOf(-1) }
}

export const conversion = (confirmed: number, sent: number) => (sent > 0 ? `${Math.round((confirmed / sent) * 100)}%` : '—')
const Stat = ({ label, value, sub, href }: { label: string; value: string; sub?: string; href?: string }) => {
  const body = <><div className={s.statLab}>{label}</div><div className={s.statVal}>{value}</div>{sub && <div className={s.statSub}>{sub}</div>}</>
  return href ? <Link href={href} className={s.stat}>{body}</Link> : <div className={s.stat}>{body}</div>
}

export function HomeCards({ supabase, enabled, userId, onSeeTheirs }: { supabase: Supabase; enabled: boolean; userId: string; onSeeTheirs: (name: string) => void }) {
  const [period, setPeriod] = useState<PeriodKey>('last')
  const [person, setPerson] = useState<string | null>(null)
  const [now] = useState(() => Date.now())
  const { from, to } = useMemo(() => periodDates(period, now), [period, now])
  const q = useQuery({ queryKey: cardsKey(from, to, person), queryFn: () => fetchCards(supabase, from, to, person), enabled, staleTime: 60_000, retry: false })
  const c: Cards | undefined = q.data
  if (!enabled || q.isError) return q.isError ? <div className={`${s.notice} ${s.noticeWarn}`}>{errorText(q.error)}</div> : null
  const label = PERIODS.find(p => p[0] === period)![1].toLowerCase()
  const mine = person && person !== userId
  const wait = c?.desk?.oldest_at ? quotationWait(c.desk.oldest_at, now) : null

  return (
    <section className={`${s.card} ${s.cards}`} aria-label="Report cards">
      <div className={s.row}>
        <h2 className={s.cardsTitle}>{mine ? `${c?.me.name ?? 'Their'} · ` : ''}{label}</h2>
        <span className={s.spacer} />
        {mine && <button type="button" className={`${s.btn} ${s.btnSm}`} onClick={() => setPerson(null)}>Back to mine</button>}
        {mine && c && <button type="button" className={`${s.btn} ${s.btnSm}`} onClick={() => onSeeTheirs(c.me.name ?? '')}>See their quotations</button>}
        <select className={s.input} style={{ width: 'auto', height: 30 }} value={period} onChange={e => setPeriod(e.target.value as PeriodKey)} aria-label="Period">
          {PERIODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </div>
      {!c && <div className={`${s.small} ${s.muted}`}>Loading the numbers…</div>}
      {c && (
        <>
          <div className={s.stats}>
            {c.desk && !mine && <Stat label="Waiting for you" value={String(c.desk.waiting)} sub={wait ? `oldest ${wait.label}` : 'nothing waiting'} href="/quotations/requests" />}
            <Stat label="Open quotations" value={String(c.me.open_count)} sub={`${formatINR(Number(c.me.open_value))} before GST`} />
            <Stat label="With a senior" value={String(c.me.waiting_senior)} sub={c.me.waiting_senior ? 'waiting for an answer' : 'none'} href={mine ? undefined : '/quotations/requests'} />
            <Stat label={`Made, ${label}`} value={String(c.me.made)} sub={`${formatINR(Number(c.me.value_made))}`} />
            <Stat label="Conversion" value={conversion(c.me.confirmed, c.me.sent)} sub={`${c.me.confirmed} confirmed of ${c.me.sent} sent`} />
            {c.desk && !mine && <Stat label={`Answered, ${label}`} value={String(c.desk.answered)} sub={c.desk.avg_hours != null ? `about ${c.desk.avg_hours} h each` : 'none yet'} />}
          </div>
          {c.team && !mine && (
            <div className={s.teamBlock}>
              <div className={s.stats}>
                <Stat label="Most quotations" value={c.team.top ? (c.team.top.name ?? '—') : '—'} sub={c.team.top ? `${c.team.top.made} made` : `none ${label}`} />
                <Stat label="Team total" value={formatINR(Number(c.team.value_made))} sub={`${c.team.made} quotations`} />
                <Stat label="Confirmed" value={formatINR(Number(c.team.value_confirmed))} sub={`${c.team.confirmed} quotations`} />
                <Stat label="Team conversion" value={conversion(c.team.confirmed, c.team.sent)} sub={`${c.team.confirmed} of ${c.team.sent} sent`} />
              </div>
              {c.team.people.length > 0 && (
                <div className={s.tableWrap}>
                  <table className={s.table}>
                    <thead><tr><th>Candidate</th><th className={s.right}>Made</th><th className={`${s.right} ${s.desktopOnly}`}>Value</th><th className={`${s.right} ${s.desktopOnly}`}>Sent</th><th className={s.right}>Confirmed</th><th className={s.right}>Conversion</th></tr></thead>
                    <tbody>{c.team.people.map(p => (
                      <tr key={p.id} tabIndex={0} onClick={() => setPerson(p.id)} onKeyDown={e => { if (e.key === 'Enter') setPerson(p.id) }}>
                        <td><b>{p.name ?? '—'}</b></td><td className={`${s.right} ${s.num}`}>{p.made}</td>
                        <td className={`${s.right} ${s.num} ${s.desktopOnly}`}>{formatINR(Number(p.value_made))}</td><td className={`${s.right} ${s.num} ${s.desktopOnly}`}>{p.sent}</td>
                        <td className={`${s.right} ${s.num}`}>{p.confirmed}</td><td className={`${s.right} ${s.num}`}>{conversion(p.confirmed, p.sent)}</td>
                      </tr>))}</tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  )
}
