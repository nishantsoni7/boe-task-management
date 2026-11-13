'use client'

// Quotations → Price learning (piece 1). The pricing desk feeds the price model with the PIs BOE has already made, 25 at a
// time, and watches the blind-test score of each batch: how far the model's price was from the PI's price BEFORE it learned
// that batch. Salespeople never see this page; they see the suggested price on their quotation, with a way to give feedback.

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Upload } from 'lucide-react'
import { AppLink as Link } from '@/components/ui/AppLink'
import { QuotationsLayout } from '@/components/layout/QuotationsLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { useQuotations } from '@/hooks/useQuotations'
import { fetchHome, learningErrorKind, learningErrorText, learningKeys } from '@/lib/pricing/learning/api'
import { HitChart, MissChart, TARGET_MISS } from './charts'
import { FeedbackInbox } from './FeedbackInbox'
import { dateIN, inNum, isDesk } from './common'
import s from '@/components/quotations/quotations.module.css'
import l from './learning.module.css'

const NEW_HREF = '/quotations/learning/new'

export default function LearningHome() {
  const { supabase, profile, loading, signOut, access, accessLoaded, notSetUp } = useQuotations()
  const desk = isDesk(access)
  const q = useQuery({ queryKey: learningKeys.home, queryFn: () => fetchHome(supabase), enabled: accessLoaded && !notSetUp && desk, retry: false })
  const batches = useMemo(() => [...(q.data?.batches ?? [])].sort((a, b) => a.batch_no - b.batch_no), [q.data])
  const scored = batches.filter(b => b.avg_miss !== null)
  const latest = scored[scored.length - 1]
  const first = scored[0]

  if (loading) return <LoadingScreen />
  const upload = <Link href={NEW_HREF} className={`${s.btn} ${s.btnPrimary}`}><Upload size={15} aria-hidden /> Upload a batch</Link>
  return (
    <QuotationsLayout profile={profile} access={access} onSignOut={signOut} title="Price learning"
      subtitle="Teach the price model from your past PIs, 25 at a time" actions={accessLoaded && desk ? upload : undefined}>
      <div className={s.wrap}>
        {notSetUp && <div className={`${s.notice} ${s.noticeWarn}`}><b>Price learning is being set up.</b> Its database part has not been applied yet.</div>}
        {accessLoaded && !desk && <div className={`${s.notice} ${s.noticeWarn}`}><b>Price learning is for the pricing desk.</b> Ask an administrator for Quotations edit with see-all. You can still send feedback from any suggested price on a quotation.</div>}
        {q.isError && !notSetUp && learningErrorKind(q.error) !== 'forbidden' && <div className={`${s.notice} ${s.noticeBad}`}>{learningErrorText(q.error)}</div>}
        {q.isLoading && <div className={s.empty}>Loading…</div>}

        {q.data && batches.length === 0 && (
          <>
            <div className={`${l.drop} ${l.dropBig}`}>
              <span className={l.dropIc}><Upload size={22} aria-hidden /></span>
              <h2 className={s.sub} style={{ margin: 0, fontSize: 18 }}>Teach the price model from your past PIs</h2>
              <p style={{ margin: 0, maxWidth: 620 }}>Choose up to 25 PI files from your old orders. You check what was read, the model prices them blind to show how good it is today, then it learns. Repeat with the next 25.</p>
              {upload}
            </div>
            <div className={l.threeCards}>
              <div><span className={l.num}>1</span><b>You check the reading</b><span>Every line shows name, size, material, quantity and price as read. Doubtful cells are marked for you.</span></div>
              <div><span className={l.num}>2</span><b>It prices them blind first</b><span>Before learning a batch it prices every line using only what it knew, and compares. That is the honest score.</span></div>
              <div><span className={l.num}>3</span><b>Then it learns</b><span>Every suggestion in a quotation uses what was learned, and each has a way to send feedback or say how the logic should work.</span></div>
            </div>
            <div className={`${s.notice}`}>Today the model already learns from the approved PIs and quotations in BOE One. Its accuracy has not been measured yet: the first batch sets the starting line.</div>
          </>
        )}

        {q.data && batches.length > 0 && (
          <>
            <section className={`${s.card} ${l.hero}`}>
              <div className={l.heroMain}>
                {latest ? (
                  <>
                    <div className={l.eyebrow}>Average miss on a batch the model had not seen</div>
                    <div className={l.big}>{latest.avg_miss}%
                      {first && first.batch_no !== latest.batch_no && (
                        <span className={`${l.delta} ${Number(latest.avg_miss) <= Number(first.avg_miss) ? l.deltaGood : l.deltaBad}`}>{Number(latest.avg_miss) <= Number(first.avg_miss) ? '▼ down' : '▲ up'} from {first.avg_miss}% on batch {first.batch_no}</span>
                      )}</div>
                    <p style={{ margin: 0, maxWidth: '62ch' }}>When it priced batch {latest.batch_no} blind, its price was on average {latest.avg_miss}% away from the price in the PI. {inNum(latest.priced_lines)} lines were priced; {inNum(latest.unpriced_lines)} it could not price (a new design, or too few prices).</p>
                  </>
                ) : <div className={l.eyebrow}>No batch has a score yet: the model had no prices to compare with</div>}
                <div className={l.facts}>
                  <div className={l.fact}><b>{inNum(q.data.totals.pis)}</b><span>PIs learned</span></div>
                  <div className={l.fact}><b>{inNum(q.data.totals.lines)}</b><span>lines learned</span></div>
                  {latest && latest.hit_rate !== null && <div className={l.fact}><b>{Math.round(Number(latest.hit_rate))}%</b><span>of lines within ±10%</span></div>}
                  <div className={l.fact}><b>{batches.length}</b><span>{batches.length === 1 ? 'batch' : 'batches'}</span></div>
                </div>
              </div>
              <div className={l.heroSide}>
                {upload}
                <div className={`${s.small} ${s.muted}`}>Excel PIs (.xlsx, .xls), up to 25 at a time. Every file is checked by you before anything is learned. The target is an average miss of {TARGET_MISS}%.</div>
              </div>
            </section>

            {scored.length > 0 && (
              <div className={l.two}>
                <section className={s.card}><div className={s.cardHead}><h2>Average miss, batch by batch</h2></div>
                  <div className={s.cardBody}><MissChart points={scored.map(b => ({ batch_no: b.batch_no, value: Number(b.avg_miss) }))} />
                    <div className={l.legend}><span><i style={{ background: '#B9472E' }} />Average miss when priced blind</span><span><i style={{ background: '#276247' }} />Target</span></div></div></section>
                <section className={s.card}><div className={s.cardHead}><h2>Lines priced within ±10%</h2></div>
                  <div className={s.cardBody}><HitChart points={scored.filter(b => b.hit_rate !== null).map(b => ({ batch_no: b.batch_no, value: Math.round(Number(b.hit_rate)) }))} /></div></section>
              </div>
            )}

            <section className={s.card}>
              <div className={s.cardHead}><h2>Batches</h2></div>
              <div className={s.tableWrap}>
                <table className={s.table}>
                  <thead><tr><th>Batch</th><th className={s.right}>PIs learned</th><th className={s.right}>Left out</th><th className={s.right}>Lines</th><th className={s.right}>Average miss</th><th className={s.right}>Within ±10%</th><th /></tr></thead>
                  <tbody>{[...batches].reverse().map(b => (
                    <tr key={b.id} style={{ cursor: 'default' }}>
                      <td className={l.nw}><b>Batch {b.batch_no}</b><div className={`${s.small} ${s.muted}`}>{dateIN(b.created_at)}</div></td>
                      <td className={s.right}>{b.pis_learned}</td><td className={s.right}>{b.pis_left_out}</td><td className={s.right}>{inNum(b.lines_learned)}</td>
                      <td className={s.right}>{b.avg_miss === null ? <span className={s.muted}>not scored</span> : <b>{b.avg_miss}%</b>}</td>
                      <td className={s.right}>{b.hit_rate === null ? '–' : `${Math.round(Number(b.hit_rate))}%`}</td>
                      <td className={s.right}><Link href={`/quotations/learning/${b.id}`} className={`${s.btn} ${s.btnSm}`}>Open</Link></td>
                    </tr>))}</tbody>
                </table>
              </div>
            </section>
          </>
        )}

        {accessLoaded && desk && !notSetUp && <FeedbackInbox supabase={supabase} />}
      </div>
    </QuotationsLayout>
  )
}
