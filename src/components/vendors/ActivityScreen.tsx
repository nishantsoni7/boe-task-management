'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { VendorsLayout } from '@/components/layout/VendorsLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { useVendors } from '@/hooks/useVendors'
import { istAddDays, istToday } from '@/lib/istDate'
import { VENDORS_KEY, fetchActivity } from '@/lib/vendors/api'
import { VENDOR_STATUSES, labelOf } from '@/lib/vendors/constants'
import { formatDay, formatWhen } from './VendorBits'
import s from './vendors.module.css'

// Admin: who is visiting, how often, whether the phone was really at the vendor, and which vendors have gone quiet.

const PERIODS = [
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
] as const

export default function ActivityScreen() {
  const { supabase, profile, isAdmin, loading, signOut } = useVendors()
  const [days, setDays] = useState<number>(30)
  const to = istToday()
  const from = istAddDays(to, -(days - 1))

  const { data, isLoading, error } = useQuery({
    queryKey: [VENDORS_KEY, 'activity', from, to],
    queryFn: () => fetchActivity(supabase, from, to),
    enabled: !!profile && isAdmin,
  })

  if (loading || !profile) return <LoadingScreen />

  return (
    <VendorsLayout profile={profile} isAdmin={isAdmin} onSignOut={signOut} title="Visit Activity" subtitle={`${formatDay(from)} – ${formatDay(to)}`}>
      <div className={s.wrapWide}>
        {!isAdmin && <div className={`${s.banner} ${s.bannerErr}`} role="alert">Only an administrator can see this page.</div>}
        {isAdmin && (
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
                  <div className={s.kpi}><div className={s.kpiValue}>{data.totals.visits}</div><div className={s.kpiLabel}>Visits</div></div>
                  <div className={s.kpi}><div className={s.kpiValue}>{data.totals.vendors_visited}</div><div className={s.kpiLabel}>Different vendors visited</div></div>
                  <div className={s.kpi}><div className={s.kpiValue}>{data.totals.at_site}</div><div className={s.kpiLabel}>Visits confirmed at the vendor</div></div>
                  <div className={s.kpi}><div className={s.kpiValue}>{data.totals.no_location}</div><div className={s.kpiLabel}>Visits with no location</div></div>
                </div>

                <section className={s.card} aria-labelledby="h-people">
                  <h2 id="h-people" className={s.cardTitle}>By person</h2>
                  {data.by_person.length === 0 ? <div className={s.empty}>No visits in this period.</div> : (
                    <div className={s.tableScroll}>
                      <table className={s.table}>
                        <thead><tr>
                          <th>Person</th><th className={s.num}>Visits</th><th className={s.num}>Vendors</th><th className={s.num}>Repeat</th>
                          <th className={s.num}>At vendor</th><th className={s.num}>No location</th><th className={s.num}>New vendors</th><th>Last visit</th>
                        </tr></thead>
                        <tbody>
                          {data.by_person.map(p => (
                            <tr key={p.user_id}>
                              <td>{p.name ?? 'Unknown'}</td>
                              <td className={s.num}>{p.visits}</td><td className={s.num}>{p.vendors_visited}</td>
                              <td className={s.num}>{p.repeat_visits}</td><td className={s.num}>{p.at_site}</td>
                              <td className={s.num}>{p.no_location}</td><td className={s.num}>{p.vendors_added}</td>
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
                    <h2 id="h-quiet" className={s.cardTitle}>Vendors not visited for 30 days</h2>
                    {data.quiet_vendors.length === 0 ? <div className={s.muted}>Every live vendor was visited recently.</div> : (
                      <ul className={s.listPlain}>
                        {data.quiet_vendors.map(q => (
                          <li key={q.id}>
                            <Link href={`/vendors/${q.id}`}>{q.company_name}</Link>
                            <span className={s.muted}>
                              {q.city} · {labelOf(VENDOR_STATUSES, q.status)} · {q.days_since_visit === null ? 'never visited' : `${q.days_since_visit} days`}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                </div>

                <section className={s.card} aria-labelledby="h-days">
                  <h2 id="h-days" className={s.cardTitle}>Visits by day</h2>
                  {data.by_day.length === 0 ? <div className={s.muted}>No visits in this period.</div> : (
                    <ul className={s.listPlain}>
                      {data.by_day.map(d => <li key={d.day}><span>{formatDay(d.day)}</span><strong>{d.visits}</strong></li>)}
                    </ul>
                  )}
                </section>
              </>
            )}
          </>
        )}
      </div>
    </VendorsLayout>
  )
}
