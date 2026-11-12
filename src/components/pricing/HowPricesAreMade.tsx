'use client'

// Pricing → How prices are made (model v2): for one product type, what the model has learned from every recorded
// price, effect by effect, and how well it fits. Refitted each time it is opened.

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { createClient } from '@/lib/supabase/client'
import { PRODUCT_TYPES, TYPE_LABEL } from '@/lib/pricing/features'
import { explainFit, fitType } from '@/lib/pricing/model'
import { fetchPool, poolWords } from '@/lib/pricing/pool'
import s from '@/components/quotations/quotations.module.css'

type Supabase = ReturnType<typeof createClient>

export function HowPricesAreMade({ supabase }: { supabase: Supabase }) {
  const [type, setType] = useState('bed')
  const q = useQuery({ queryKey: ['pricing', 'pool', type], queryFn: () => fetchPool(supabase, poolWords([type])), retry: false })
  const fit = useMemo(() => (q.data ? fitType(q.data, type) : null), [q.data, type])
  const effects = useMemo(() => (fit ? explainFit(fit).sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct)) : []), [fit])
  return (
    <div className={s.cardBody} style={{ display: 'grid', gap: 12 }}>
      <label className={s.field} style={{ maxWidth: 320 }}><span>Product type</span>
        <select id="how-type" className={s.input} value={type} onChange={e => setType(e.target.value)}>
          {PRODUCT_TYPES.map(t => <option key={t.type} value={t.type}>{t.label}</option>)}
        </select>
      </label>
      {q.isLoading && <div className={s.empty}>Reading every recorded price…</div>}
      {q.isError && <div className={`${s.notice} ${s.noticeBad}`}>{(q.error as Error).message}</div>}
      {q.data && !fit && <div className={`${s.notice} ${s.noticeWarn}`}>Not enough prices for {TYPE_LABEL[type]} yet: the model needs at least 8 approved-PI, won or approved prices. Until then the suggestion uses the price history of the same product name.</div>}
      {fit && (
        <>
          <div className={s.kpis}>
            <div className={s.kpi}><div className={`${s.small} ${s.muted}`}>Prices it learned from</div><div className={s.kpiValue}>{fit.n}</div></div>
            <div className={s.kpi}><div className={`${s.small} ${s.muted}`}>Typical error</div><div className={s.kpiValue}>±{Math.round((Math.exp(fit.sigma) - 1) * 100)}%</div></div>
            <div className={s.kpi}><div className={`${s.small} ${s.muted}`}>How much it explains</div><div className={s.kpiValue}>{Math.max(0, Math.round(fit.r2 * 100))}%</div></div>
          </div>
          <div className={s.small}>Compared with a typical {TYPE_LABEL[type].toLowerCase()} in {fit.ref.material === 'unknown' ? 'an unnamed material' : fit.ref.material}, finish {fit.ref.finish === 'unknown' ? 'not named' : fit.ref.finish}, 1–10 pieces:</div>
          {effects.length === 0 ? <div className={s.empty}>All prices so far look alike: no parameter moves them yet.</div> : (
            <div className={s.tableWrap}><table className={s.table}>
              <thead><tr><th>What changes</th><th className={s.right}>Effect on the price</th></tr></thead>
              <tbody>{effects.map(e => <tr key={e.label} style={{ cursor: 'default' }}><td>{e.label}</td><td className={s.right}><b>{e.pct > 0 ? '+' : ''}{e.pct}%</b></td></tr>)}</tbody>
            </table></div>
          )}
          <div className={`${s.small} ${s.muted}`}>Learned again each time from approved PIs (full weight), won quotations, prices the desk approved and open quotes (less weight). Lost quotations are not learned from.</div>
        </>
      )}
    </div>
  )
}
