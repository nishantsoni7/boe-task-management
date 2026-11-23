'use client'

// Price learning: "How accurate is it" and "Teach next" (Price Brain v2, phase 3A). The model is examined on the prices it
// already has (exam.ts: five rounds, each priced blind by a model that never saw it) and compared with how much BOE's own
// prices for the same product vary. Read-only; it runs in the browser on the same price pool the suggestions use.

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { createClient } from '@/lib/supabase/client'
import { fetchWholePool } from '@/lib/pricing/pool'
import { CLOSE, examine } from '@/lib/pricing/exam'
import s from '@/components/quotations/quotations.module.css'
import l from './learning.module.css'

type Supabase = ReturnType<typeof createClient>

export function AccuracyCard({ supabase }: { supabase: Supabase }) {
  const pool = useQuery({ queryKey: ['pricing', 'learning', 'whole-pool'], queryFn: () => fetchWholePool(supabase), staleTime: 10 * 60_000, retry: false })
  const exam = useMemo(() => (pool.data ? examine(pool.data) : null), [pool.data])
  const leading = exam?.types.filter(t => t.leader === 'v3') ?? []
  const near = Math.round(CLOSE * 100)
  return (
    <section className={s.card} aria-labelledby="accuracy-h">
      <div className={s.cardHead}><h2 id="accuracy-h">How accurate is it</h2></div>
      <div className={s.cardBody} style={{ display: 'grid', gap: 12 }}>
        {pool.isLoading && <div className={s.muted}>Pricing every product blind…</div>}
        {pool.isError && <div className={`${s.notice} ${s.noticeBad}`}>The prices could not be read right now. {(pool.error as Error).message}</div>}
        {exam && (
          <>
            <div className={l.facts}>
              <div className={l.fact}><b>{exam.overall.miss === null ? '–' : `${exam.overall.miss}%`}</b><span>typical miss, priced blind</span></div>
              <div className={l.fact}><b>{exam.overall.close === null ? '–' : `${Math.round(exam.overall.close)}%`}</b><span>of prices within ±{near}%</span></div>
              <div className={l.fact}><b>{exam.floor.spread === null ? '–' : `${exam.floor.spread}%`}</b><span>your own spread on the same product</span></div>
              <div className={l.fact}><b>{pool.data!.length.toLocaleString('en-IN')}</b><span>prices it learns from</span></div>
            </div>
            <p className={s.small} style={{ margin: 0 }}>
              Each price was priced by a model that had not seen it, and compared with the real price. {exam.floor.spread === null
                ? 'No product has been priced three times yet, so how much your own prices vary is not known.'
                : `Your own prices for the same product vary by about ${exam.floor.spread}% (${exam.floor.products} product${exam.floor.products === 1 ? '' : 's'} priced three times or more), so no model can be more exact than that.`}
              {' '}Prices set with a suggestion&apos;s Use button are left out, so it never learns its own guess.{exam.untyped > 0 && ` ${exam.untyped} price${exam.untyped === 1 ? ' has' : 's have'} a name it cannot place in a product type.`}
            </p>
            <p className={s.small} style={{ margin: 0 }}>
              <b>With photos</b> is the new engine: it also learns what each product photo shows and the cases taught in Training, and is tested on the same prices.
              {' '}It prices a type only where it misses less ({leading.length ? leading.map(t => t.label).join(', ') : 'no type yet'}); everywhere else today&apos;s model stays.
            </p>
            {exam.teachNext.length > 0 && (
              <div>
                <h3 className={s.sub} style={{ margin: '4px 0 6px' }}>Teach next</h3>
                <ol className={l.teachNext}>
                  {exam.teachNext.map(t => <li key={t.type}><b>{t.label}</b> <span className={s.muted}>{t.why}{t.quoted ? `, quoted ${t.quoted} time${t.quoted === 1 ? '' : 's'}` : ''}</span></li>)}
                </ol>
                <p className={`${s.small} ${s.muted}`} style={{ margin: 0 }}>Teach these first: learn old PIs that have them, or teach a case in Pricing → Training.</p>
              </div>
            )}
            <div className={s.tableWrap}>
              <table className={s.table}>
                <thead><tr><th>Product type</th><th className={s.right}>Prices</th><th className={s.right}>From quotations</th><th className={s.right}>Typical miss</th><th className={s.right}>Within ±{near}%</th><th className={s.right}>Today&apos;s model</th><th className={s.right}>With photos</th></tr></thead>
                <tbody>{exam.types.map(t => (
                  <tr key={t.type} style={{ cursor: 'default' }}>
                    <td>{t.label}</td><td className={s.right}>{t.prices}</td><td className={s.right}>{t.quoted}</td>
                    <td className={s.right}>{t.miss === null ? <span className={s.muted}>too few</span> : <b>{t.miss}%</b>}</td>
                    <td className={s.right}>{t.close === null ? '–' : `${Math.round(t.close)}%`}</td>
                    {(['v2', 'v3'] as const).map(e => (
                      <td key={e} className={s.right}>{t[e].miss === null ? '–' : t.leader === e ? <b>{t[e].miss}% (used)</b> : `${t[e].miss}%`}</td>
                    ))}
                  </tr>))}</tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </section>
  )
}
