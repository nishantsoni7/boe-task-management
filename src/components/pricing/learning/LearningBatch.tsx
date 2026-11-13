'use client'

// Quotations → Price learning → one learned batch: its score and the PIs in it (file names show here, to the pricing desk only).

import { useParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { AppLink as Link } from '@/components/ui/AppLink'
import { QuotationsLayout } from '@/components/layout/QuotationsLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { useQuotations } from '@/hooks/useQuotations'
import { formatINR } from '@/lib/currency'
import { fetchBatch, learningErrorText, learningKeys } from '@/lib/pricing/learning/api'
import { CLIENT_LABEL, dateIN, inNum, isDesk } from './common'
import s from '@/components/quotations/quotations.module.css'
import l from './learning.module.css'

export default function LearningBatch() {
  const { id } = useParams<{ id: string }>()
  const { supabase, profile, loading, signOut, access, accessLoaded, notSetUp } = useQuotations()
  const desk = isDesk(access)
  const q = useQuery({ queryKey: learningKeys.batch(id), queryFn: () => fetchBatch(supabase, id), enabled: accessLoaded && !notSetUp && desk, retry: false })
  if (loading) return <LoadingScreen />
  const b = q.data?.batch
  return (
    <QuotationsLayout profile={profile} access={access} onSignOut={signOut} title={b ? `Batch ${b.batch_no}` : 'Batch'}
      subtitle={b ? `Learned ${dateIN(b.created_at)}${b.created_by_name ? ` by ${b.created_by_name}` : ''}` : undefined}
      actions={<Link href="/quotations/learning" className={s.btn}>All batches</Link>}>
      <div className={s.wrap}>
        {accessLoaded && !desk && <div className={`${s.notice} ${s.noticeWarn}`}>Price learning is for the pricing desk.</div>}
        {q.isError && <div className={`${s.notice} ${s.noticeBad}`}>{learningErrorText(q.error)}</div>}
        {q.isLoading && <div className={s.empty}>Loading…</div>}
        {b && q.data && (
          <>
            <section className={s.card}><div className={`${s.cardBody} ${s.kpis}`}>
              <div className={s.kpi}><div className={`${s.small} ${s.muted}`}>PIs learned</div><div className={s.kpiValue}>{b.pis_learned}</div><div className={`${s.small} ${s.muted}`}>{b.pis_left_out} left out</div></div>
              <div className={s.kpi}><div className={`${s.small} ${s.muted}`}>Lines learned</div><div className={s.kpiValue}>{inNum(b.lines_learned)}</div></div>
              <div className={s.kpi}><div className={`${s.small} ${s.muted}`}>Average miss when priced blind</div><div className={s.kpiValue}>{b.avg_miss === null ? '–' : `${b.avg_miss}%`}</div><div className={`${s.small} ${s.muted}`}>{inNum(b.priced_lines)} priced, {inNum(b.unpriced_lines)} not</div></div>
              <div className={s.kpi}><div className={`${s.small} ${s.muted}`}>Within ±10%</div><div className={s.kpiValue}>{b.hit_rate === null ? '–' : `${Math.round(Number(b.hit_rate))}%`}</div></div>
            </div></section>
            <section className={s.card}>
              <div className={s.cardHead}><h2>PIs in this batch</h2><span className={s.chip}>{q.data.pis.length}</span></div>
              <div className={s.tableWrap}>
                <table className={s.table}>
                  <thead><tr><th>#</th><th>File</th><th>PI date</th><th className={s.right}>Lines</th><th className={s.right}>Pieces</th><th className={s.right}>Designs</th><th className={s.right}>Value before GST</th><th>Result</th></tr></thead>
                  <tbody>{q.data.pis.map(p => (
                    <tr key={p.id} style={{ cursor: 'default' }}>
                      <td className={s.muted}>{p.seq}</td>
                      <td><div className={l.cellName}>{p.label ?? 'No file name'}</div>{p.client_type && <div className={l.cellSub}>{CLIENT_LABEL[p.client_type] ?? p.client_type}</div>}</td>
                      <td className={l.nw}>{dateIN(p.pi_date)}{p.date_source !== 'file' && <div className={l.cellSub}>{p.date_source === 'saved' ? 'file saved date' : 'typed'}</div>}</td>
                      <td className={s.right}>{p.lines}</td><td className={s.right}>{inNum(p.pieces)}</td><td className={s.right}>{p.designs}</td>
                      <td className={`${s.right} ${l.nw}`}>{formatINR(p.value_before_gst)}{p.discount ? <div className={l.cellSub}>after {formatINR(p.discount)} discount</div> : null}</td>
                      <td>{p.left_out ? <><span className={`${s.pill} ${s.st_draft}`}>Left out</span><div className={l.cellSub} style={{ maxWidth: 260 }}>{p.left_out_reason}</div></> : <span className={`${s.pill} ${s.st_confirmed}`}>Learned</span>}</td>
                    </tr>))}</tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </div>
    </QuotationsLayout>
  )
}
