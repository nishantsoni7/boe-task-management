'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { VendorsLayout } from '@/components/layout/VendorsLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { useVendors } from '@/hooks/useVendors'
import { istAddDays, istToday } from '@/lib/istDate'
import { VENDORS_KEY, fetchActivity, setPastEntriesUntil } from '@/lib/vendors/api'
import { VENDOR_STATUSES, labelOf } from '@/lib/vendors/constants'
import { formatDay, formatWhen } from './VendorBits'
import s from './vendors.module.css'

// Admin: who is visiting, how often, whether the phone was really at the vendor, which vendors have met us but
// still await a site visit, and which have gone quiet. Meetings at our factory and visits typed in afterwards are
// counted on their own: they are never proof of a visit to the vendor.

const PERIODS = [
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
] as const

export default function ActivityScreen() {
  const { supabase, profile, isAdmin, canSeeActivity, loading, signOut } = useVendors()
  const qc = useQueryClient()
  const [days, setDays] = useState<number>(30)
  const [until, setUntil] = useState('')
  const [windowBusy, setWindowBusy] = useState(false)
  const [windowProblem, setWindowProblem] = useState<string | null>(null)
  const to = istToday()
  const from = istAddDays(to, -(days - 1))

  const { data, isLoading, error } = useQuery({
    queryKey: [VENDORS_KEY, 'activity', from, to],
    queryFn: () => fetchActivity(supabase, from, to),
    enabled: !!profile && canSeeActivity,
  })

  if (loading || !profile) return <LoadingScreen />

  const windowOpen = !!data?.past_entries_until && to <= data.past_entries_until

  async function changeWindow(next: string) {
    setWindowBusy(true)
    setWindowProblem(null)
    try {
      await setPastEntriesUntil(supabase, next)
      await qc.invalidateQueries({ queryKey: [VENDORS_KEY] })
      setUntil('')
    } catch (e) {
      setWindowProblem(e instanceof Error ? e.message : 'Could not change the date.')
    } finally {
      setWindowBusy(false)
    }
  }

  return (
    <VendorsLayout profile={profile} isAdmin={isAdmin} onSignOut={signOut} title="Visit Activity" subtitle={`${formatDay(from)} – ${formatDay(to)}`}>
      <div className={s.wrapWide}>
        {!canSeeActivity && <div className={`${s.banner} ${s.bannerErr}`} role="alert">Your access level does not include the Visit Activity page.</div>}
        {canSeeActivity && (
          <>
            <div className={s.periodRow} role="group" aria-label="Period">
              {PERIODS.map(p => (
                <button key={p.days} type="button" className={`${s.chip}${days === p.days ? ` ${s.chipOn}` : ''}`} onClick={() => setDays(p.days)}>
                  {p.label}
                </button>
              ))}
            </div>
            {error && <div className={`${s.banner} ${s.bannerErr}`} role="alert">{error instanceof Error ? error.message : 'Could not load the activity.'}</div>}
            {isLoading && <div className={s.empty}>Loading…</div>}
            {data && (
              <>
                <div className={s.kpis}>
                  <div className={s.kpi}><div className={s.kpiValue}>{data.totals.visits}</div><div className={s.kpiLabel}>Site visits to vendors</div></div>
                  <div className={s.kpi}><div className={s.kpiValue}>{data.totals.vendors_visited}</div><div className={s.kpiLabel}>Different vendors visited</div></div>
                  <div className={s.kpi}><div className={s.kpiValue}>{data.totals.at_site}</div><div className={s.kpiLabel}>Confirmed at the vendor</div></div>
                  <div className={s.kpi}><div className={s.kpiValue}>{data.totals.no_location}</div><div className={s.kpiLabel}>Live visits with no location</div></div>
                  <div className={s.kpi}><div className={s.kpiValue}>{data.totals.at_our_factory}</div><div className={s.kpiLabel}>Vendors who came to our factory</div></div>
                  <div className={s.kpi}><div className={s.kpiValue}>{data.totals.entered_later}</div><div className={s.kpiLabel}>Entered afterwards (no proof)</div></div>
                  <div className={s.kpi}><div className={s.kpiValue}>{data.pipeline.potential}</div><div className={s.kpiLabel}>Potential, not contacted</div></div>
                  <div className={s.kpi}><div className={s.kpiValue}>{data.pipeline.contacted}</div><div className={s.kpiLabel}>Contacted, not visited</div></div>
                </div>

                <section className={s.card} aria-labelledby="h-wait">
                  <h2 id="h-wait" className={s.cardTitle}>Met us at our factory, still waiting for a site visit</h2>
                  {data.awaiting_site_visit.length === 0 ? <div className={s.muted}>None. Every vendor who came to us has been visited.</div> : (
                    <ul className={s.listPlain}>
                      {data.awaiting_site_visit.map(w => (
                        <li key={w.id}>
                          <Link href={`/vendors/${w.id}`}>{w.company_name}</Link>
                          <span className={s.muted}>
                            {labelOf(VENDOR_STATUSES, w.status)} · waiting {w.days_waiting === 0 ? 'since today' : `${w.days_waiting} day${w.days_waiting === 1 ? '' : 's'}`}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                <section className={s.card} aria-labelledby="h-people">
                  <h2 id="h-people" className={s.cardTitle}>By person</h2>
                  {data.by_person.length === 0 ? <div className={s.empty}>No meetings in this period.</div> : (
                    <div className={s.tableScroll}>
                      <table className={s.table}>
                        <thead><tr>
                          <th>Person</th><th className={s.num}>Site visits</th><th className={s.num}>Vendors</th><th className={s.num}>Repeat</th>
                          <th className={s.num}>At vendor</th><th className={s.num}>No location</th><th className={s.num}>At our factory</th>
                          <th className={s.num}>Added later</th><th className={s.num}>New vendors</th><th>Last meeting</th>
                        </tr></thead>
                        <tbody>
                          {data.by_person.map(p => (
                            <tr key={p.user_id}>
                              <td>{p.name ?? 'Unknown'}</td>
                              <td className={s.num}>{p.visits}</td><td className={s.num}>{p.vendors_visited}</td>
                              <td className={s.num}>{p.repeat_visits}</td><td className={s.num}>{p.at_site}</td>
                              <td className={s.num}>{p.no_location}</td><td className={s.num}>{p.at_our_factory}</td>
                              <td className={s.num}>{p.entered_later}</td><td className={s.num}>{p.vendors_added}</td>
                              <td>{formatWhen(p.last_visit)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>

                <div className={s.grid2}>
                  <section className={s.card} aria-labelledby="h-due">
                    <h2 id="h-due" className={s.cardTitle}>Follow-ups due in the next 7 days</h2>
                    {data.follow_ups_due.length === 0 ? <div className={s.muted}>Nothing due.</div> : (
                      <ul className={s.listPlain}>
                        {data.follow_ups_due.map(f => (
                          <li key={`${f.vendor_id}-${f.next_follow_up_on}`}>
                            <Link href={`/vendors/${f.vendor_id}`}>{f.company_name}</Link>
                            <span className={s.muted}>{formatDay(f.next_follow_up_on)}{f.visited_by_name ? ` · ${f.visited_by_name}` : ''}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                  <section className={s.card} aria-labelledby="h-quiet">
                    <h2 id="h-quiet" className={s.cardTitle}>Registered vendors not visited for 30 days</h2>
                    {data.quiet_vendors.length === 0 ? <div className={s.muted}>Every registered vendor was visited recently.</div> : (
                      <ul className={s.listPlain}>
                        {data.quiet_vendors.map(q => (
                          <li key={q.id}>
                            <Link href={`/vendors/${q.id}`}>{q.company_name}</Link>
                            <span className={s.muted}>
                              {labelOf(VENDOR_STATUSES, q.status)} · {q.days_since_visit === null ? 'never visited' : `${q.days_since_visit} days`}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                </div>

                <section className={s.card} aria-labelledby="h-days">
                  <h2 id="h-days" className={s.cardTitle}>Site visits by day</h2>
                  {data.by_day.length === 0 ? <div className={s.muted}>No site visits in this period.</div> : (
                    <ul className={s.listPlain}>
                      {data.by_day.map(d => <li key={d.day}><span>{formatDay(d.day)}</span><strong>{d.visits}</strong></li>)}
                    </ul>
                  )}
                </section>

                {isAdmin && <section className={s.card} aria-labelledby="h-window">
                  <h2 id="h-window" className={s.cardTitle}>Adding visits that already happened</h2>
                  <div className={s.muted}>
                    While this is open, the team can type in earlier visits without photographs or location (shown as “Added later”).
                    {' '}{windowOpen
                      ? `Open until ${formatDay(data.past_entries_until as string)}.`
                      : data.past_entries_until ? `Closed since ${formatDay(data.past_entries_until)}.` : 'Closed.'}
                  </div>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                    <input type="date" className={s.input} style={{ width: 'auto' }} aria-label="Open until" value={until}
                           min={istAddDays(to, -1)} max={istAddDays(to, 90)} onChange={e => setUntil(e.target.value)} />
                    <button type="button" className={s.secondary} disabled={windowBusy || !until} onClick={() => void changeWindow(until)}>Set date</button>
                    {windowOpen && <button type="button" className={s.danger} disabled={windowBusy} onClick={() => void changeWindow(istAddDays(to, -1))}>Close now</button>}
                  </div>
                  {windowProblem && <div className={`${s.banner} ${s.bannerErr}`} role="alert">{windowProblem}</div>}
                </section>}
              </>
            )}
          </>
        )}
      </div>
    </VendorsLayout>
  )
}
