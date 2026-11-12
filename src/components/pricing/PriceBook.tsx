'use client'

// Pricing → Price book (phase 7A). One row per product family (the same name words) with what BOE ordered and
// quoted it at, won and lost, and the suggested price worked out from those points (src/lib/pricing/suggest.ts).
// It updates itself: every new approved PI and every quotation won or lost changes the rows the next time it opens.

import { Fragment, useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Download, Search } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { formatINR } from '@/lib/currency'
import { istDateOf } from '@/lib/istDate'
import { formatDateIN } from '@/lib/quotations/math'
import { downloadCsv, toCsv } from '@/lib/quotations/report'
import { suggestPrice, type PricePoint, type Suggestion } from '@/lib/pricing/suggest'
import { HowPricesAreMade } from './HowPricesAreMade'
import s from '@/components/quotations/quotations.module.css'

type Family = { key: string; name: string; variants: number; orders: number; won: number; lost: number; open_quotes: number; last_at: string; points: PricePoint[] }

const KIND: Record<PricePoint['k'], string> = { order: 'Approved PI', won: 'Quotation won', lost: 'Quotation lost', quote: 'Quoted (open)' }
const CONF: Record<Suggestion['confidence'], string> = { high: 'high', medium: 'medium', low: 'low' }

export function PriceBook() {
  const supabase = useMemo(() => createClient(), [])
  const [typed, setTyped] = useState('')
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [view, setView] = useState<'book' | 'how'>('book')
  useEffect(() => { const t = setTimeout(() => setSearch(typed.trim()), 400); return () => clearTimeout(t) }, [typed])
  const q = useQuery({
    queryKey: ['pricing', 'book', search],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('pricing_price_book', { p_search: search || null, p_limit: 300 })
      if (error) throw new Error(/Could not find the function|does not exist/i.test(error.message) ? 'The price book is being set up: its database part has not been applied yet.' : error.message.replace(/^.*PRICING_FORBIDDEN:\s*/, ''))
      return (data ?? []) as Family[]
    },
    retry: false,
  })
  const rows = useMemo(() => (q.data ?? []).map(f => ({ f, sug: suggestPrice(f.points) })), [q.data])
  const lastOrder = (f: Family) => f.points.find(p => p.k === 'order')

  const csv = () => downloadCsv(`price-book_${istDateOf(new Date().toISOString())}.csv`, toCsv(
    ['Product', 'Suggested (Rs)', 'Low (Rs)', 'High (Rs)', 'Confidence', 'Basis', 'Last ordered (Rs)', 'Approved PIs', 'Won', 'Lost', 'Open quotes', 'Last activity'],
    rows.map(({ f, sug }) => [f.name, sug?.price ?? null, sug?.low ?? null, sug?.high ?? null, sug?.confidence ?? null, sug?.basis ?? null,
      lastOrder(f) ? Number(lastOrder(f)!.p) : null, f.orders, f.won, f.lost, f.open_quotes, istDateOf(f.last_at)])))

  return (
    <div className={s.wrap}>
      <div className={s.card}>
        <div className={s.tabs} role="tablist">
          <button className={s.tab} role="tab" aria-selected={view === 'book'} onClick={() => setView('book')}>Price book</button>
          <button className={s.tab} role="tab" aria-selected={view === 'how'} onClick={() => setView('how')}>How prices are made</button>
        </div>
        {view === 'how' ? <HowPricesAreMade supabase={supabase} /> : <>
        <div className={s.toolbar}>
          <label className={s.search} style={{ position: 'relative' }}>
            <Search size={15} style={{ position: 'absolute', left: 10, top: 10, color: 'var(--boe-text-muted)' }} aria-hidden />
            <input className={s.input} style={{ paddingLeft: 32 }} placeholder="Search a product, e.g. king bed" value={typed} onChange={e => setTyped(e.target.value)} aria-label="Search the price book" />
          </label>
          <span className={`${s.small} ${s.muted}`}>Learned from approved PIs and quotations; it updates itself as new ones arrive.</span>
          <span className={s.spacer} />
          {rows.length > 0 && <button className={`${s.btn} ${s.btnSm}`} onClick={csv}><Download size={14} aria-hidden /> CSV</button>}
        </div>
        {q.isLoading && <div className={s.empty}>Reading the price history…</div>}
        {q.isError && <div className={s.cardBody}><div className={`${s.notice} ${s.noticeBad}`}>{(q.error as Error).message}</div></div>}
        {q.isSuccess && rows.length === 0 && <div className={s.empty}>{search ? 'No product matches that search.' : 'No prices yet: approved PIs and quotations will fill this in.'}</div>}
        {rows.length > 0 && (
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead><tr><th>Product</th><th className={s.right}>Suggested</th><th className={s.desktopOnly}>Range · confidence</th><th className={s.right}>Last ordered</th><th className={s.right}>PIs</th><th className={s.right}>Won / lost</th><th className={s.desktopOnly}>Last activity</th></tr></thead>
              <tbody>
                {rows.map(({ f, sug }) => (
                  <Fragment key={f.key}>
                    <tr onClick={() => setOpen(o => (o === f.key ? null : f.key))} aria-expanded={open === f.key}>
                      <td><div className={s.name}>{f.name}</div>{f.variants > 1 && <div className={s.sub}>{f.variants} ways of writing it</div>}</td>
                      <td className={s.right}>{sug ? <b>{formatINR(sug.price)}</b> : <span className={s.muted}>–</span>}</td>
                      <td className={s.desktopOnly}>{sug ? <>{formatINR(sug.low)}–{formatINR(sug.high)} · {CONF[sug.confidence]}</> : '–'}</td>
                      <td className={s.right}>{lastOrder(f) ? formatINR(Number(lastOrder(f)!.p)) : '–'}</td>
                      <td className={s.right}>{f.orders}</td>
                      <td className={s.right}>{f.won} / {f.lost}</td>
                      <td className={s.desktopOnly}>{formatDateIN(istDateOf(f.last_at))}</td>
                    </tr>
                    {open === f.key && (
                      <tr style={{ cursor: 'default' }}><td colSpan={7} style={{ background: 'var(--boe-surface-quiet)' }}>
                        {sug && <div className={s.small} style={{ marginBottom: 6 }}>Suggested from {sug.basis}.</div>}
                        <table className={s.sum}><tbody>
                          {f.points.map((p, i) => <tr key={i}><td>{formatDateIN(istDateOf(p.at))}</td><td>{KIND[p.k]}</td><td>{p.q ? `${Number(p.q).toLocaleString('en-IN')} pcs` : ''}</td><td>{formatINR(Number(p.p))}</td></tr>)}
                        </tbody></table>
                      </td></tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
        </>}
      </div>
    </div>
  )
}
