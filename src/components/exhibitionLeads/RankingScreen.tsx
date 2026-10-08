'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { ExhibitionLeadsLayout } from '@/components/layout/ExhibitionLeadsLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { useExhibitionLeads, useExhibitions } from '@/hooks/useExhibitionLeads'
import { useListUrlState } from '@/hooks/useListUrlState'
import { idParam } from '@/lib/listState'
import { EXHIBITION_LEADS_KEY, fetchRanking } from '@/lib/exhibitionLeads/api'
import { joinNames, leadersOf, summariseRanking } from '@/lib/exhibitionLeads/ranking'
import { exhibitionDates, exhibitionLabel, longDate, shortDate } from '@/lib/exhibitionLeads/format'
import { NoExhibitionNotice } from './LeadBits'
import s from './leads.module.css'

const PARAMS = { ex: idParam() }

export default function RankingScreen() {
  const router = useRouter()
  const { supabase, profile, isAdmin, loading, signOut } = useExhibitionLeads()
  const { exhibitions, defaultExhibition, isLoading: exhibitionsLoading } = useExhibitions(supabase, !loading)
  const { state, setState } = useListUrlState(PARAMS)

  useEffect(() => {
    if (!loading && !isAdmin) router.replace('/exhibition-leads/my')
  }, [loading, isAdmin, router])

  const exhibitionId = state.ex || defaultExhibition?.id || null
  const q = useQuery({
    queryKey: [...EXHIBITION_LEADS_KEY, 'ranking', exhibitionId],
    queryFn: () => fetchRanking(supabase, exhibitionId as string),
    enabled: !loading && isAdmin && !!exhibitionId,
    // The fair is live while people are collecting; keep the board current.
    refetchInterval: 60_000,
  })

  if (loading || !isAdmin) return <LoadingScreen />

  const data = q.data
  const sum = data ? summariseRanking(data) : null
  const dayTopNames = (day: string) => new Set(
    (leadersOf(data?.rows ?? [], r => r.per_day[day] ?? 0)?.names) ?? [],
  )
  const overallTop = new Set(sum?.overall?.names ?? [])

  return (
    <ExhibitionLeadsLayout
      profile={profile} isAdmin={isAdmin} onSignOut={signOut}
      title="Ranking"
      subtitle={data ? `${data.exhibition.name} · ${exhibitionDates(data.exhibition)}` : undefined}
      actions={exhibitions.length > 1 ? (
        <select className={s.select} style={{ width: 'auto' }} aria-label="Exhibition" value={exhibitionId ?? ''} onChange={e => setState({ ex: e.target.value })}>
          {exhibitions.map(x => <option key={x.id} value={x.id}>{exhibitionLabel(x)}</option>)}
        </select>
      ) : undefined}
    >
      <div className={s.wrapWide}>
        <div className={s.scopeLine}>
          Scope: every active lead collected for {data?.exhibition.name ?? 'the exhibition'} on its own days
          {data ? ` (${shortDate(data.exhibition.starts_on)} – ${shortDate(data.exhibition.ends_on)}, India time)` : ''}.
          <details className={s.scopeMore}>
            <summary>How is this counted?</summary>
            Credit goes to the person who collected the lead — reassigning or editing it does not move it. Archived leads and
            entries outside those days are not counted. The list filters do not apply here.
          </details>
        </div>

        {!exhibitionId && !exhibitionsLoading && exhibitions.length === 0 && <NoExhibitionNotice isAdmin={isAdmin} />}
        {q.isLoading && <div className={s.skeleton} />}
        {q.error && (
          <div className={`${s.notice} ${s.noticeErr}`} role="alert">
            {(q.error as Error).message}
            <div className={s.noticeActions}><button className={s.btn} onClick={() => q.refetch()}>Try again</button></div>
          </div>
        )}

        {data && sum && (
          <>
            <div className={s.leaderGrid}>
              <div className={`${s.leaderCard} ${s.leaderCardMain}`}>
                <div className={s.leaderLabel}>{sum.overallLabel}</div>
                <div className={s.leaderName}>
                  {sum.overall ? joinNames(sum.overall.names) : 'No leads yet'}
                </div>
                <div className={s.leaderMeta}>
                  {sum.overall
                    ? `${sum.overall.count} lead${sum.overall.count === 1 ? '' : 's'}${sum.overall.names.length > 1 ? ' each — joint leaders' : ''}`
                    : 'Nobody has collected a lead yet'}
                </div>
              </div>
              {data.days.map(d => {
                const l = sum.perDay[d]
                return (
                  <div key={d} className={s.leaderCard}>
                    <div className={s.leaderLabel}>Top collector · {longDate(d)}</div>
                    <div className={s.leaderName}>{l ? joinNames(l.names) : 'No leads'}</div>
                    <div className={s.leaderMeta}>
                      {l ? `${l.count} lead${l.count === 1 ? '' : 's'}${l.names.length > 1 ? ' each — joint leaders' : ''}` : '—'}
                    </div>
                  </div>
                )
              })}
            </div>

            <div className={s.rankScroll}>
              <table className={s.rankTable}>
                <thead>
                  <tr>
                    <th>Salesperson</th>
                    {data.days.map(d => <th key={d}>{shortDate(d)}</th>)}
                    <th>Fair Total</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.length === 0 && (
                    <tr><td colSpan={data.days.length + 2} style={{ textAlign: 'center' }}>No salespeople to rank yet.</td></tr>
                  )}
                  {data.rows.map(r => (
                    <tr key={r.user_id}>
                      <td>{r.name}</td>
                      {data.days.map(d => (
                        <td key={d} className={dayTopNames(d).has(r.name) ? s.topCell : undefined}>{r.per_day[d] ?? 0}</td>
                      ))}
                      <td className={`${s.totalCell}${overallTop.has(r.name) ? ` ${s.topCell}` : ''}`}>{r.total}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className={s.hint}>Highlighted cells mark the top collector for that day and overall (ties are all highlighted).</div>
          </>
        )}
      </div>
    </ExhibitionLeadsLayout>
  )
}
