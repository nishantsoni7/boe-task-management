'use client'

// Price learning, step 3: the blind test. Before this batch is learned, the model priced every line using only what it knew
// (as of the PI's own date). This is the honest score. The biggest misses carry the doorway to feedback and to saying how the
// logic should work; then the batch is learned.

import { formatINR } from '@/lib/currency'
import type { BlindTest } from '@/lib/pricing/learning/blindTest'
import { LETTERS, Scatter, TARGET_MISS } from './charts'
import { SuggestionFeedback } from './SuggestionFeedback'
import { inNum } from './common'
import type { ReviewPi } from '@/lib/pricing/learning/batch'
import s from '@/components/quotations/quotations.module.css'
import l from './learning.module.css'

const cr = (n: number) => (n >= 1e7 ? `₹${(n / 1e7).toFixed(2)} Cr` : n >= 1e5 ? `₹${(n / 1e5).toFixed(1)} L` : formatINR(n))

export function StepTest({ test, pis, previous, saving, error, onBack, onLearn }: {
  test: BlindTest; pis: ReviewPi[]; previous: { avg_miss: number | null; hit_rate: number | null } | null
  saving: boolean; error: string | null; onBack: () => void; onLearn: () => void
}) {
  const learnedCount = pis.filter(p => p.learn).length
  const diff = test.avgMiss !== null && previous?.avg_miss != null ? Math.round((test.avgMiss - Number(previous.avg_miss)) * 10) / 10 : null
  const hitDiff = test.hitRate !== null && previous?.hit_rate != null ? Math.round(test.hitRate - Number(previous.hit_rate)) : null
  const total = test.lines.length
  return (
    <>
      {test.priced === 0 ? (
        <div className={s.notice}><b>The model had no prices to compare with.</b> None of the {total} lines is a product type it has enough prices for yet, so this batch has no score. Learning it sets the starting line.</div>
      ) : (
        <div className={s.notice}><b>Blind test.</b> Before learning, the model priced each line using only what it already knew, as of the PI&apos;s date. This is the honest score, because it had not seen these answers.</div>
      )}
      <div className={l.kpis4} style={{ marginTop: 16 }}>
        <div className={l.kpiBox}><div className={l.eyebrow}>Average miss</div><div className={l.kpiV}>{test.avgMiss === null ? '–' : `${test.avgMiss}%`}</div>
          <div className={l.kpiS}>{diff !== null ? <span className={`${l.delta} ${diff <= 0 ? l.deltaGood : l.deltaBad}`}>{diff <= 0 ? '▼' : '▲'} {Math.abs(diff)} points</span> : null}{diff !== null ? ` against the last batch (${previous!.avg_miss}%)` : `Target ${TARGET_MISS}%`}</div></div>
        <div className={l.kpiBox}><div className={l.eyebrow}>Lines within ±10%</div><div className={l.kpiV}>{test.hitRate === null ? '–' : `${test.hitRate}%`}</div>
          <div className={l.kpiS}>{hitDiff !== null ? <span className={`${l.delta} ${hitDiff >= 0 ? l.deltaGood : l.deltaBad}`}>{hitDiff >= 0 ? '▲' : '▼'} {Math.abs(hitDiff)} points</span> : null}{hitDiff !== null ? ` on the last batch (${Math.round(Number(previous!.hit_rate))}%)` : ' of the lines it priced'}</div></div>
        <div className={l.kpiBox}><div className={l.eyebrow}>Whole orders together</div><div className={l.kpiV}>{test.orderGapPct === null ? '–' : `${test.orderGapPct > 0 ? '+' : ''}${test.orderGapPct}%`}</div>
          <div className={l.kpiS}>{test.orderGapPct === null ? 'Nothing was priced.' : `Model ${cr(test.orderModel)} against ${cr(test.orderReal)} in the PIs. Errors on lines partly cancel out.`}</div></div>
        <div className={l.kpiBox}><div className={l.eyebrow}>Lines it could not price</div><div className={l.kpiV}>{inNum(test.unpriced)}</div>
          <div className={l.kpiS}>of {inNum(total)}: a new design, or fewer than 8 prices of its type. You enter those prices by hand today.</div></div>
      </div>

      {test.priced > 0 && (
        <div className={l.two}>
          <section className={s.card}><div className={s.cardHead}><h2>What the model said against the PI price</h2></div>
            <div className={s.cardBody}><Scatter lines={test.lines} worst={test.worst} />
              <div className={l.legend}><span><i style={{ background: '#276247' }} />Within ±10%</span><span><i style={{ background: '#C28A1C' }} />10 to 25% off</span><span><i style={{ background: '#B9472E' }} />More than 25% off</span><span><i style={{ background: '#303536' }} />Biggest misses (A to D)</span></div>
              <div className={`${s.small} ${s.muted}`} style={{ marginTop: 8 }}>One dot per line. The band is ±10%.</div></div></section>
          <section className={s.card}><div className={s.cardHead}><h2>By product type</h2></div>
            <div className={s.cardBody}><div className={l.bars}>{test.byType.map(t => (
              <div key={t.type} className={l.barRow}><span>{t.label}</span><span className={l.barTrack}><i className={t.avgMiss > 15 ? l.barBad : t.avgMiss > 10 ? l.barMid : l.barOk} style={{ width: `${Math.min(100, Math.round((t.avgMiss / 25) * 100))}%` }} /></span><span><b>{t.avgMiss}%</b> <span className={s.muted}>{t.n} lines</span></span></div>
            ))}</div>
              <div className={`${s.small} ${s.muted}`} style={{ marginTop: 10 }}>Average miss by product type in this batch.</div></div></section>
        </div>
      )}

      {test.worst.length > 0 && (
        <section className={s.card} style={{ marginTop: 16 }}>
          <div className={s.cardHead}><h2>Biggest misses</h2><span className={s.chip}>{test.worst.length}</span></div>
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead><tr><th /><th>Product</th><th className={s.right}>PI price</th><th className={s.right}>Model said</th><th className={s.right}>Off by</th><th>What the model showed</th><th /></tr></thead>
              <tbody>{test.worst.map((t, i) => {
                const m = t.model!
                return (
                  <tr key={i} style={{ cursor: 'default' }}>
                    <td>{i < 4 ? <span className={l.missN}>{LETTERS[i]}</span> : null}</td>
                    <td><div className={l.cellName}>{t.name}</div><div className={l.cellSub}>{[t.size, t.material, `${t.qty} pcs`].filter(Boolean).join(' · ')}</div></td>
                    <td className={`${s.right} ${l.nw}`}>{formatINR(t.price)}</td><td className={`${s.right} ${l.nw}`}>{formatINR(m.price)}</td>
                    <td className={s.right}><span className={`${l.pct} ${t.missPct! > 0 ? l.pctUp : l.pctDn}`}>{t.missPct! > 0 ? '+' : '−'}{Math.abs(Math.round(t.missPct!))}%</span></td>
                    <td className={s.small} style={{ minWidth: 220 }}>{m.reasons.length ? m.reasons.join(' · ') : m.basis}</td>
                    <td className={s.right} style={{ minWidth: 150 }}>
                      <SuggestionFeedback source="learning" label="Explain or correct" clientType={t.clientType} isDesk
                        line={{ name: t.name, size: t.size, material: t.material, finish: t.customization, qty: t.qty }} suggestion={{ price: m.price, low: m.low, high: m.high, confidence: m.confidence, basis: m.basis, reasons: m.reasons }} />
                    </td>
                  </tr>
                )
              })}</tbody>
            </table>
          </div>
          <div className={l.tblNote}><span>The biggest misses of {inNum(test.priced)} priced lines. Say why a miss happened and it goes to the feedback list.</span></div>
        </section>
      )}

      <div className={l.foot}>
        <span><b>{learnedCount} PI{learnedCount === 1 ? '' : 's'} · {inNum(total)} lines</b> will be learned</span>
        {error && <span className={s.small} style={{ color: '#A12438' }} role="alert">{error}</span>}
        <span className={l.footSpacer} />
        <button type="button" className={s.btn} disabled={saving} onClick={onBack}>Back to checking</button>
        <button type="button" className={`${s.btn} ${s.btnPrimary}`} style={{ minHeight: 40 }} disabled={saving} onClick={onLearn}>{saving ? 'Learning…' : 'Learn this batch'}</button>
      </div>
    </>
  )
}
