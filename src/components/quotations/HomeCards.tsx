'use client'

// The card on top of the Quotations list. Owner, 23 Nov 2026 (redesign of the 20 Nov report cards): only three things stay.
// Two tiles, "Waiting for you" (the pricing desk only) and "Open quotations", and, for the owner and anyone with "see all", the value each
// candidate quoted in the period as ranked bars (a tap on a bar shows that person's open quotations). The period belongs to the bars only.
// ONE database call (quotation_cards); the list below does not wait for it.

import { useMemo, useState, type CSSProperties } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ChartNoAxesCombined, ChevronDown, ChevronRight } from 'lucide-react'
import type { createClient } from '@/lib/supabase/client'
import { cardsKey, errorText, fetchCards, type Cards } from '@/lib/quotations/api'
import { formatINR } from '@/lib/currency'
import { AppLink as Link } from '@/components/ui/AppLink'
import { useIsPhone } from '@/components/ui/useIsPhone'
import { quotationWait } from '@/lib/tasks/quotationWait'
import s from './quotations.module.css'

type Supabase = ReturnType<typeof createClient>
export type PeriodKey = 'last' | 'this' | 'three'
export const PERIODS: [PeriodKey, string][] = [['last', 'Last month'], ['this', 'This month'], ['three', 'Last 3 months']]
const WHEN: Record<PeriodKey, string> = { last: 'last month', this: 'this month', three: 'in the last 3 months' }
/** The phone shows this many candidates until "Show all" is pressed. */
const PHONE_ROWS = 5

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

const quotations = (n: number) => `${n} quotation${n === 1 ? '' : 's'}`

const Stat = ({ label, value, sub, href, act }: { label: string; value: string; sub: string; href?: string; act?: boolean }) => {
  const body = <><div className={s.statLab}>{label}{href && <ChevronRight size={14} aria-hidden />}</div><div><div className={s.statVal}>{value}</div><div className={s.statSub}>{sub}</div></div></>
  const cls = `${s.stat}${act ? ` ${s.statAct}` : ''}`
  return href ? <Link href={href} className={cls}>{body}</Link> : <div className={cls}>{body}</div>
}

export function HomeCards({ supabase, enabled, userId, onSeeTheirs }: { supabase: Supabase; enabled: boolean; userId: string; onSeeTheirs: (name: string) => void }) {
  const [period, setPeriod] = useState<PeriodKey>('this')
  const [person, setPerson] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)
  // On a phone the bars are folded away until the heading is tapped, so the list is not pushed a screen down (owner, 23 Nov 2026).
  const [barsOpen, setBarsOpen] = useState(false)
  const phone = useIsPhone()
  const [now] = useState(() => Date.now())
  const { from, to } = useMemo(() => periodDates(period, now), [period, now])
  // keepPreviousData: tapping a bar or changing the period keeps the card on screen (dimmed) while the next answer comes.
  const q = useQuery({ queryKey: cardsKey(from, to, person), queryFn: () => fetchCards(supabase, from, to, person), enabled, staleTime: 60_000, retry: false, placeholderData: keepPreviousData })
  const c: Cards | undefined = q.data
  // Ranked by value; the database sends them by count.
  const people = useMemo(() => [...(c?.team?.people ?? [])].sort((a, b) => Number(b.value_made) - Number(a.value_made) || b.made - a.made), [c])
  if (!enabled || q.isError) return q.isError ? <div className={`${s.notice} ${s.noticeWarn}`}>{errorText(q.error)}</div> : null
  const theirs = !!c && c.me.person !== userId
  const wait = c?.desk?.oldest_at ? quotationWait(c.desk.oldest_at, now) : null
  const widest = Math.max(...people.map(p => Number(p.value_made)), 1)
  const folded = phone && !barsOpen

  return (
    <section className={`${s.card} ${s.top}${c && !c.team ? ` ${s.topSolo}` : ''}${q.isPlaceholderData ? ` ${s.topBusy}` : ''}`} aria-label="Report cards" aria-busy={q.isPlaceholderData}>
      {!c && <div className={`${s.small} ${s.muted}`}>Loading the numbers…</div>}
      {c && (
        <>
          <div className={s.stats}>
            {c.desk && !theirs && <Stat label="Waiting for you" value={String(c.desk.waiting)} sub={wait ? `oldest ${wait.label}` : 'nothing waiting'} href="/quotations/requests" act={c.desk.waiting > 0} />}
            <Stat label={theirs ? `Open · ${c.me.name ?? 'Them'}` : 'Open quotations'} value={String(c.me.open_count)} sub={`${formatINR(Number(c.me.open_value))} before GST`} />
          </div>
          {c.team && (
            <div className={s.chart}>
              <div className={s.chHead}>
                {phone
                  ? <h2 className={s.cardsTitle}><button type="button" className={s.chFold} aria-expanded={barsOpen} onClick={() => setBarsOpen(v => !v)}>Quotation value by candidate <ChevronDown size={16} aria-hidden className={barsOpen ? s.chevUp : undefined} /></button></h2>
                  : <h2 className={s.cardsTitle}>Quotation value by candidate</h2>}
                {people.length > 0 && <span className={s.chTotal}>{formatINR(Number(c.team.value_made))} · {quotations(c.team.made)}</span>}
                <span className={s.spacer} />
                {theirs && <button type="button" className={`${s.btn} ${s.btnSm}`} onClick={() => setPerson(null)}>Back to mine</button>}
                {theirs && <button type="button" className={`${s.btn} ${s.btnSm}`} onClick={() => onSeeTheirs(c.me.name ?? '')}>See their quotations</button>}
                {!folded && (
                  <select className={s.input} style={{ width: 'auto', height: 30 }} value={period} onChange={e => setPeriod(e.target.value as PeriodKey)} aria-label="Period">
                    {PERIODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                )}
              </div>
              {folded ? null : people.length === 0 ? (
                <div className={s.chEmpty}>
                  <ChartNoAxesCombined size={18} aria-hidden /> No quotations were made {WHEN[period]}.
                  {period !== 'this' && <button type="button" className={`${s.btn} ${s.btnSm}`} onClick={() => setPeriod('this')}>Show this month</button>}
                </div>
              ) : (
                <>
                  <ul className={s.bars} aria-label="Quotation value by candidate">
                    {people.map((p, i) => {
                      const value = Number(p.value_made), picked = person === p.id
                      return (
                        <li key={p.id} className={!showAll && i >= PHONE_ROWS ? s.barLate : undefined}>
                          <button type="button" className={`${s.barRow}${picked ? ` ${s.barPicked}` : ''}`} aria-pressed={picked} style={{ '--p': value / widest } as CSSProperties}
                            aria-label={`${p.name ?? '—'}: ${formatINR(value)} before GST, ${quotations(p.made)}`} onClick={() => setPerson(picked ? null : p.id)}>
                            <span className={s.barName}>{p.name ?? '—'}</span>
                            <span className={s.barTrack}><span className={s.bar} /><span className={s.barVal}>{formatINR(value)}</span></span>
                            <span className={s.tip} aria-hidden="true"><b>{p.name ?? '—'}</b>{formatINR(value)} before GST · {quotations(p.made)}<br /><span>{p.sent} sent · {p.confirmed} confirmed</span></span>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                  {people.length > PHONE_ROWS && (
                    <button type="button" className={s.barsMore} aria-expanded={showAll} onClick={() => setShowAll(v => !v)}>
                      {showAll ? 'Show fewer' : `Show all ${people.length}`} <ChevronDown size={16} aria-hidden />
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </>
      )}
    </section>
  )
}
