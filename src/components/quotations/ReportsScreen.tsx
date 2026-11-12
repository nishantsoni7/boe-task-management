'use client'

// Quotations → Reports (phase 6). Everything is computed by quotation_report (20270618000000) from what is already
// recorded. Managers (Admin, See all) choose "Whole team"; everyone else always sees their own quotations.

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Download } from 'lucide-react'
import { AppLink as Link } from '@/components/ui/AppLink'
import { QuotationsLayout } from '@/components/layout/QuotationsLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { useQuotations } from '@/hooks/useQuotations'
import { formatINR } from '@/lib/currency'
import { istDateOf } from '@/lib/istDate'
import { errorText } from '@/lib/quotations/api'
import { formatDateIN } from '@/lib/quotations/math'
import { downloadCsv, fetchReport, periodRange, toCsv, type Group, type PeriodKey, type Report } from '@/lib/quotations/report'
import s from './quotations.module.css'

const PERIODS: [PeriodKey, string][] = [['week', 'This week'], ['month', 'This month'], ['quarter', 'This quarter'], ['year', 'This financial year'], ['custom', 'Custom']]
const pct = (v: number | null) => (v === null ? '–' : `${v}%`)

export default function ReportsScreen() {
  const { supabase, profile, loading, signOut, access, accessLoaded, notSetUp } = useQuotations()
  const today = istDateOf(new Date().toISOString())
  const [period, setPeriod] = useState<PeriodKey>('month')
  const [custom, setCustom] = useState(() => periodRange('month', today))
  const [scope, setScope] = useState<'mine' | 'all'>('all')
  const range = period === 'custom' ? custom : periodRange(period, today)
  const mayAll = access.admin || access.view_all
  const effectiveScope = mayAll ? scope : 'mine'
  const q = useQuery({
    queryKey: ['quotations', 'report', range.from, range.to, effectiveScope],
    queryFn: () => fetchReport(supabase, range.from, range.to, effectiveScope),
    enabled: accessLoaded && !notSetUp && range.from <= range.to, retry: false,
  })

  if (loading) return <LoadingScreen />
  return (
    <QuotationsLayout profile={profile} access={access} onSignOut={signOut} title="Reports"
      subtitle={`${formatDateIN(range.from)} – ${formatDateIN(range.to)} · ${effectiveScope === 'all' ? 'whole team' : 'my quotations'}`}>
      <div className={s.wrap}>
        <div className={s.card}>
          <div className={s.toolbar} style={{ flexWrap: 'wrap' }}>
            {PERIODS.map(([k, label]) => <button key={k} className={s.fchip} aria-pressed={period === k} onClick={() => setPeriod(k)}>{label}</button>)}
            {period === 'custom' && (
              <>
                <input type="date" className={s.input} style={{ width: 150 }} aria-label="From" value={custom.from} onChange={e => setCustom(c => ({ ...c, from: e.target.value }))} />
                <input type="date" className={s.input} style={{ width: 150 }} aria-label="To" value={custom.to} onChange={e => setCustom(c => ({ ...c, to: e.target.value }))} />
              </>
            )}
            {mayAll && (
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                <button className={s.fchip} aria-pressed={scope === 'all'} onClick={() => setScope('all')}>Whole team</button>
                <button className={s.fchip} aria-pressed={scope === 'mine'} onClick={() => setScope('mine')}>Mine</button>
              </span>
            )}
          </div>
        </div>
        {notSetUp && <div className={`${s.notice} ${s.noticeWarn}`}><b>Reports are being set up.</b> Their database part has not been applied yet.</div>}
        {q.isLoading && <div className={s.empty}>Working out the numbers…</div>}
        {q.isError && <div className={`${s.notice} ${s.noticeBad}`}>{errorText(q.error)}</div>}
        {q.data && <ReportBody r={q.data} />}
      </div>
    </QuotationsLayout>
  )
}

function Section({ title, csv, children, note }: { title: string; csv?: () => void; children: React.ReactNode; note?: string }) {
  return (
    <section className={s.card}>
      <div className={s.cardHead}><h2>{title}</h2><span className={s.spacer} />{csv && <button className={`${s.btn} ${s.btnSm}`} onClick={csv}><Download size={14} aria-hidden /> CSV</button>}</div>
      {note && <div className={`${s.cardBody} ${s.small} ${s.muted}`} style={{ paddingBottom: 0 }}>{note}</div>}
      {children}
    </section>
  )
}

function GroupTable({ rows, withValue }: { rows: Group[]; withValue: boolean }) {
  if (rows.length === 0) return <div className={s.empty}>Nothing in this period.</div>
  return (
    <div className={s.tableWrap}>
      <table className={s.table}>
        <thead><tr><th>Name</th><th className={s.right}>Made</th><th className={s.right}>Confirmed</th><th className={s.right}>Lost</th><th className={s.right}>Win rate</th>{withValue && <th className={s.right}>Confirmed value</th>}</tr></thead>
        <tbody>{rows.map(g => (
          <tr key={g.name} style={{ cursor: 'default' }}><td>{g.name}</td><td className={s.right}>{g.made}</td><td className={s.right}>{g.confirmed}</td><td className={s.right}>{g.lost}</td><td className={s.right}>{pct(g.win_rate)}</td>{withValue && <td className={s.right}>{formatINR(Number(g.confirmed_value ?? 0))}</td>}</tr>
        ))}</tbody>
      </table>
    </div>
  )
}

const groupCsv = (rows: Group[]) => toCsv(['Name', 'Made', 'Confirmed', 'Lost', 'Win rate %', 'Confirmed value (Rs)'], rows.map(g => [g.name, g.made, g.confirmed, g.lost, g.win_rate, Number(g.confirmed_value ?? 0)]))

function ReportBody({ r }: { r: Report }) {
  const tag = `${r.from}_to_${r.to}`
  const f = r.funnel
  const tiles = useMemo(() => ([
    ['Made', f.made], ['Sent', f.sent], ['Negotiating', f.negotiating], ['Confirmed', f.confirmed], ['Lost', f.lost], ['Still open', f.open],
  ] as const), [f])
  const decided = f.confirmed.n + f.lost.n
  return (
    <>
      <Section title={`This week (${formatDateIN(r.week.from)} – ${formatDateIN(r.week.to)})`}>
        <div className={`${s.cardBody} ${s.kpis}`}>
          <Kpi label="Started" value={String(r.week.made)} sub={formatINR(Number(r.week.made_value))} />
          <Kpi label="Sent" value={String(r.week.sent)} />
          <Kpi label="Confirmed" value={String(r.week.confirmed)} sub={formatINR(Number(r.week.confirmed_value))} />
          <Kpi label="Lost" value={String(r.week.lost)} />
          <Kpi label="Waiting for price approval" value={String(r.price_waiting)} />
        </div>
      </Section>

      <Section title="Funnel" note={`Quotations started in the period, ${decided ? `win rate ${Math.round((100 * f.confirmed.n) / decided)}% of those decided` : 'none decided yet'}. Values are before GST.`}
        csv={() => downloadCsv(`quotation-funnel_${tag}.csv`, toCsv(['Stage', 'Quotations', 'Value before GST (Rs)'], tiles.map(([l, c]) => [l, c.n, Number(c.value)])))}>
        <div className={`${s.cardBody} ${s.kpis}`}>{tiles.map(([l, c]) => <Kpi key={l} label={l} value={String(c.n)} sub={formatINR(Number(c.value))} />)}</div>
      </Section>

      <div className={s.grid2} style={{ alignItems: 'start' }}>
        {r.scope === 'all' && <Section title="By salesperson" csv={() => downloadCsv(`quotations-by-salesperson_${tag}.csv`, groupCsv(r.by_owner))}><GroupTable rows={r.by_owner} withValue /></Section>}
        <Section title="By client type" csv={() => downloadCsv(`quotations-by-client-type_${tag}.csv`, groupCsv(r.by_client_type))}><GroupTable rows={r.by_client_type} withValue /></Section>
        <Section title="By source" csv={() => downloadCsv(`quotations-by-source_${tag}.csv`, groupCsv(r.by_source))}><GroupTable rows={r.by_source} withValue={false} /></Section>
        <Section title="Speed" note="Middle value (median) of the quotations in the period.">
          <div className={`${s.cardBody} ${s.kpis}`}>
            <Kpi label="Days from start to sent" value={r.speed.days_to_send === null ? '–' : String(r.speed.days_to_send)} sub={`${r.speed.sent_count} sent`} />
            <Kpi label="Days from sent to confirmed" value={r.speed.days_to_confirm === null ? '–' : String(r.speed.days_to_confirm)} sub={`${r.speed.confirmed_count} confirmed`} />
          </div>
        </Section>
        <Section title="Open now, by age" note="Days since it was sent (or started, if not sent yet), whatever the period."
          csv={() => downloadCsv(`open-quotations-by-age_${r.today}.csv`, toCsv(['Age', 'Quotations', 'Value before GST (Rs)'], r.ageing.map(a => [a.bucket, a.n, Number(a.value)])))}>
          <div className={s.tableWrap}><table className={s.table}><tbody>{r.ageing.map(a => <tr key={a.bucket} style={{ cursor: 'default' }}><td>{a.bucket}</td><td className={s.right}>{a.n}</td><td className={s.right}>{formatINR(Number(a.value))}</td></tr>)}</tbody></table></div>
        </Section>
        <Section title="Discount and wins" note="Decided quotations (confirmed or lost) in the period, by the discount they carried."
          csv={() => downloadCsv(`discount-and-wins_${tag}.csv`, toCsv(['Discount', 'Decided', 'Confirmed', 'Win rate %'], r.discount.map(d => [d.bucket, d.decided, d.confirmed, d.win_rate])))}>
          <div className={s.tableWrap}><table className={s.table}><thead><tr><th>Discount</th><th className={s.right}>Decided</th><th className={s.right}>Confirmed</th><th className={s.right}>Win rate</th></tr></thead>
            <tbody>{r.discount.map(d => <tr key={d.bucket} style={{ cursor: 'default' }}><td>{d.bucket}</td><td className={s.right}>{d.decided}</td><td className={s.right}>{d.confirmed}</td><td className={s.right}>{pct(d.win_rate)}</td></tr>)}</tbody></table></div>
        </Section>
        <Section title="Why quotations were lost" csv={() => downloadCsv(`lost-reasons_${tag}.csv`, toCsv(['Reason', 'Quotations'], r.lost_reasons.map(x => [x.reason, x.n])))}>
          {r.lost_reasons.length === 0 ? <div className={s.empty}>None lost in this period.</div> : (
            <div className={s.tableWrap}><table className={s.table}><tbody>{r.lost_reasons.map(x => <tr key={x.reason} style={{ cursor: 'default' }}><td>{x.reason}</td><td className={s.right}>{x.n}</td></tr>)}</tbody></table></div>
          )}
        </Section>
      </div>

      <Section title="Opened by the client, not followed up" note="Open quotations the client opened more than two days ago, with nothing done since."
        csv={() => downloadCsv(`opened-not-followed-up_${r.today}.csv`, toCsv(['Quotation', 'Client', 'Salesperson', 'Opened on', 'Value before GST (Rs)'], r.opened_no_followup.map(x => [x.quote_no, x.client_name, x.owner_name, istDateOf(x.opened_at), Number(x.value)])))}>
        {r.opened_no_followup.length === 0 ? <div className={s.empty}>Nothing waiting. Every opened quotation has been followed up.</div> : (
          <div className={s.tableWrap}><table className={s.table}>
            <thead><tr><th>Quotation</th><th>Salesperson</th><th>Opened on</th><th className={s.right}>Before GST</th></tr></thead>
            <tbody>{r.opened_no_followup.map(x => (
              <tr key={x.id} style={{ cursor: 'default' }}><td><Link className={s.name} href={`/quotations/${x.id}`}>{x.quote_no}</Link><div className={s.sub}>{x.client_name}</div></td><td>{x.owner_name ?? '–'}</td><td>{formatDateIN(istDateOf(x.opened_at))}</td><td className={s.right}>{formatINR(Number(x.value))}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </Section>
    </>
  )
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return <div className={s.kpi}><div className={`${s.small} ${s.muted}`}>{label}</div><div className={s.kpiValue}>{value}</div>{sub && <div className={`${s.small} ${s.muted}`}>{sub}</div>}</div>
}
