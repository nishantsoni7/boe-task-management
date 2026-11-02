'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { AlertTriangle, Megaphone } from 'lucide-react'
import { MarketingLayout } from '@/components/layout/MarketingLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { useMetaAccess } from '@/hooks/useMetaAccess'
import { usePermissionContext } from '@/hooks/queries/usePermissionContext'
import { fetchMetaInsights, fetchMetaStructure, type MetaStructure } from '@/lib/meta/api'
import {
  buildReport, rangeOf, RANGES, syncBadge, syncedWhen, syncView, type RangeDays, type Report, type SyncView,
} from '@/lib/meta/report'
import { istToday } from '@/lib/istDate'
import { createClient } from '@/lib/supabase/client'
import s from './meta.module.css'

// Every Meta Ads page: the shell, the shared reads, the date range, and the states (nothing read yet, first read
// running, last read failed), so each screen only draws its own data.

export type MetaCtx = {
  structure: MetaStructure
  report: Report
  sync: SyncView
  today: string
  days: RangeDays
  range: ReturnType<typeof rangeOf>
  canEdit: boolean
  accountLabel: string
}

type Props = {
  title: string
  subtitle?: string
  /** False for Settings, which needs no results and is useful before anything has been read. */
  gated?: boolean
  withRange?: boolean
  children: (ctx: MetaCtx) => React.ReactNode
}

const REFRESH_WHILE_RUNNING_MS = 15_000

export function MetaScreen({ title, subtitle, gated = true, withRange = true, children }: Props) {
  const { profile } = usePermissionContext()
  const { canEdit } = useMetaAccess()
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const [days, setDays] = useState<RangeDays>(30)
  const today = istToday()
  const range = rangeOf(days, today)

  const structureQuery = useQuery({
    queryKey: ['meta', 'structure', today],
    queryFn: () => fetchMetaStructure(supabase, today),
    enabled: !!profile,
    staleTime: 2 * 60_000,
    refetchInterval: query => (query.state.data && syncView(query.state.data.runs, new Date()).kind === 'first_running' ? REFRESH_WHILE_RUNNING_MS : false),
  })
  const sync = structureQuery.data ? syncView(structureQuery.data.runs, new Date()) : null
  const hasData = sync?.kind === 'ok' || (sync?.kind === 'failed' && sync.lastOkAt !== null)

  const insightsQuery = useQuery({
    queryKey: ['meta', 'insights', range.from, range.to],
    queryFn: () => fetchMetaInsights(supabase, range.from, range.to),
    enabled: !!structureQuery.data && hasData && gated,
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
  })

  const report = useMemo(
    () => buildReport({
      campaigns: structureQuery.data?.campaigns ?? [],
      adSets: structureQuery.data?.adSets ?? [],
      insights: insightsQuery.data ?? [],
      targetPaise: structureQuery.data?.settings.target_cost_per_enquiry_paise ?? null,
    }),
    [structureQuery.data, insightsQuery.data],
  )

  const signOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  const structure = structureQuery.data
  const badge = structure && sync ? syncBadge(sync, new Date(), today) : null
  const accountLabel = structure
    ? structure.accounts.length === 0 ? 'No ad account read yet'
      : `Ad account ${structure.accounts[0].account_id}${structure.accounts.length > 1 ? ` and ${structure.accounts.length - 1} more` : ''} · Indian rupees`
    : ''

  let body: React.ReactNode
  if (structureQuery.isError || (gated && insightsQuery.isError)) {
    body = (
      <div className="boe-empty">
        <p className="boe-empty-title">The Meta Ads figures could not be loaded</p>
        <p>Check your connection and try again.</p>
        <button className="boe-btn boe-btn-secondary" onClick={() => { structureQuery.refetch(); insightsQuery.refetch() }}>Try again</button>
      </div>
    )
  } else if (!structure || !sync) {
    body = <LoadingScreen message="Loading Meta Ads..." />
  } else if (gated && sync.kind === 'none') {
    body = (
      <div className={`boe-panel ${s.centre}`}>
        <span className={s.iconWrap}><Megaphone size={22} aria-hidden="true" /></span>
        <p className="boe-empty-title">No Meta data yet</p>
        <p className={s.note}>BOE One has not read the ad account. The daily read starts once an administrator has added the view-only Meta token, and the next 6:10 am read fills this page.</p>
      </div>
    )
  } else if (gated && sync.kind === 'first_running') {
    body = (
      <div className={`boe-panel ${s.centre}`}>
        <span className={s.iconWrap}><Megaphone size={22} aria-hidden="true" /></span>
        <p className="boe-empty-title">Reading your account</p>
        <p className={s.note}>This takes a few minutes. You can leave this page; it carries on, and this page checks again by itself.</p>
      </div>
    )
  } else {
    const failed = sync.kind === 'failed' ? sync : null
    const waitingForResults = gated && hasData && insightsQuery.data === undefined
    body = (
      <div className={s.stack}>
        {failed && (
          <div className="boe-callout boe-callout-error" role="alert">
            <AlertTriangle aria-hidden="true" />
            <div>
              <span className="boe-callout-title">{failed.message}</span>
              <span>
                {failed.lastOkAt
                  ? `The numbers below are from ${syncedWhen(failed.lastOkAt, today)}. The next daily read tries again at 6:10 am; if the token was removed or has expired, an administrator renews it in Vercel.`
                  : 'Nothing has been read yet. The next daily read tries again at 6:10 am; if the token was removed or has expired, an administrator renews it in Vercel.'}
              </span>
            </div>
          </div>
        )}
        {(gated || withRange) && (
          <div className={s.toolbar}>
            <div className={s.toolbarLeft}>
              <span className={s.account}>{accountLabel}</span>
              {badge && <span className={`boe-badge boe-badge-${badge.tone}`}>{badge.text}</span>}
            </div>
            {withRange && gated && hasData && (
              <select className={`boe-input ${s.range}`} aria-label="Period" value={days} onChange={e => setDays(Number(e.target.value) as RangeDays)}>
                {RANGES.map(d => <option key={d} value={d}>{rangeOf(d, today).label}</option>)}
              </select>
            )}
          </div>
        )}
        {waitingForResults
          ? <LoadingScreen message="Loading results..." />
          : (!gated || hasData) && children({ structure, report, sync, today, days, range, canEdit, accountLabel })}
      </div>
    )
  }

  return (
    <MarketingLayout profile={profile} title={title} subtitle={subtitle} onSignOut={signOut}>
      {body}
    </MarketingLayout>
  )
}
