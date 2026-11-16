'use client'

// Pricing > Price logic (owner, 16 Nov 2026): the submitted training cases side by side, element by element, so a
// disagreement between two chairs is seen and corrected. Nothing is changed here: a correction is made on the case in
// Training and resubmitted, so there is one place where a price changes and its history stays whole. No database
// change: the cases come from pricing_training_library, and one cell's reasoning from pricing_training_get.

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AppLink as Link } from '@/components/ui/AppLink'
import { createClient } from '@/lib/supabase/client'
import { formatINR } from '@/lib/currency'
import { KIND_LABEL, type Kind } from '@/lib/pricing/training/doc'
import { fetchAccess, fetchCase, fetchCases, fetchLibrary, photoUrl, trainingKeys, type TrainingError } from '@/lib/pricing/training/api'
import { logicRows } from '@/lib/pricing/training/logic'
import { sameElement } from '@/lib/pricing/training/match'
import t from './training.module.css'

export function PriceLogic() {
  const supabase = useMemo(() => createClient(), [])
  const access = useQuery({ queryKey: trainingKeys.access, queryFn: () => fetchAccess(supabase), retry: false })
  const library = useQuery({ queryKey: trainingKeys.library, queryFn: () => fetchLibrary(supabase), enabled: access.isSuccess, retry: false })
  const all = useQuery({ queryKey: trainingKeys.list, queryFn: () => fetchCases(supabase), enabled: access.isSuccess, retry: false })
  const [open, setOpen] = useState<{ id: string; element: string } | null>(null)
  const detail = useQuery({ queryKey: trainingKeys.one(open?.id ?? ''), queryFn: () => fetchCase(supabase, open!.id), enabled: !!open, retry: false })
  const err = (access.error ?? library.error) as TrainingError | null

  // Oldest first, so a chair keeps its column as more are taught.
  const cases = useMemo(() => [...(library.data?.cases ?? [])].sort((a, b) => a.case_no - b.case_no), [library.data])
  const rows = useMemo(() => logicRows(cases), [cases])
  const woods = library.data?.woods ?? []
  const drafts = (all.data ?? []).filter(c => c.status === 'draft').length
  const openCase = open && cases.find(c => c.id === open.id)
  const openLines = open && detail.data?.id === open.id ? detail.data.lines.filter(l => sameElement(l.element, open.element)) : null

  return (
    <div className={t.wrap}>
      <div className={t.head}>
        <div>
          <h1 className={t.h1}>Price logic</h1>
          <p className={t.sub}>Every submitted product side by side, element by element. Click an amount to see how it was worked out. To correct one, change the case in Training and resubmit.</p>
        </div>
      </div>
      {err && <div className={`boe-callout ${err.kind === 'not_set_up' ? 'boe-callout-warning' : 'boe-callout-error'}`} role="alert">{err.message}</div>}
      {drafts > 0 && <div className="boe-callout boe-callout-info">{drafts === 1 ? '1 case is saved but not submitted, so it is not here.' : `${drafts} cases are saved but not submitted, so they are not here.`} <Link href="/pricing/training">Open Training</Link></div>}

      {library.isSuccess && cases.length === 0 && <div className={t.card}><div className={t.cardB}><p className={t.muted} style={{ margin: 0 }}>No product has been submitted yet. Teach one in <Link href="/pricing/training">Training</Link> and submit it.</p></div></div>}

      {cases.length > 0 && (
        <div className={t.card}>
          <div className={t.cardH}>What each product is made of</div>
          <div className={t.logicScroll}>
            <table className={t.logic}>
              <thead>
                <tr>
                  <th scope="col">Element</th>
                  {cases.map(c => (
                    <th key={c.id} scope="col">
                      {/* eslint-disable-next-line @next/next/no-img-element -- a stored product photo, shown as it is */}
                      {c.image_path && <img className={t.thumb} src={photoUrl(supabase, c.image_path)} alt="" />}
                      <Link href={`/pricing/training/${c.id}`}>#{c.case_no} {c.name}</Link>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={`${r.kind}/${r.element}`}>
                    <th scope="row">{r.element} <span className={t.muted}>{KIND_LABEL[r.kind as Kind] ?? r.kind}</span>{r.varies && <span className={`boe-badge boe-badge-waiting ${t.logicVaries}`}>varies</span>}</th>
                    {r.cells.map((x, i) => (
                      <td key={cases[i].id}>
                        {x === null ? <span className={t.muted}>not on this one</span>
                          : <button type="button" className={t.logicCell} aria-expanded={open?.id === cases[i].id && open.element === r.element} onClick={() => setOpen({ id: cases[i].id, element: r.element })}>{formatINR(x)}</button>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr><th scope="row">Total</th>{cases.map(c => <td key={c.id}><b>{formatINR(Number(c.total))}</b></td>)}</tr>
              </tfoot>
            </table>
          </div>
          {open && openCase && (
            <div className={t.cardB} role="region" aria-label="How this amount was worked out">
              <b>{open.element} on #{openCase.case_no} {openCase.name}</b>
              {detail.isError && <span className={t.muted}>Could not load the case. Try again.</span>}
              {!openLines && !detail.isError && <span className={t.muted}>Loading…</span>}
              {openLines?.map((l, i) => (
                <div key={i}>
                  <div>{formatINR(Number(l.amount))}{l.quantity !== null && l.rate !== null ? ` = ${Number(l.quantity)} ${l.unit ?? ''} × ${formatINR(Number(l.rate))}` : ''}{l.material ? ` · ${l.material}` : ''}{l.wood_amount !== null ? ` · of which wood ${formatINR(Number(l.wood_amount))}` : ''}</div>
                  <div className={t.muted}>{l.reasoning || 'No reason was written for this one.'}</div>
                </div>
              ))}
              <span><Link href={`/pricing/training/${open.id}`}>Change in Training</Link></span>
            </div>
          )}
        </div>
      )}

      {cases.length > 0 && (
        <div className={t.card}>
          <div className={t.cardH}>In another wood</div>
          <div className={t.logicScroll}>
            <table className={t.logic}>
              <thead><tr><th scope="col">Product</th><th scope="col">Taught in</th><th scope="col">Of which wood</th>{woods.map(w => <th key={w} scope="col">{w}</th>)}</tr></thead>
              <tbody>
                {cases.map(c => (
                  <tr key={c.id}>
                    <th scope="row">#{c.case_no} {c.name}</th>
                    <td>{c.wood ?? <span className={t.muted}>no wood picked</span>}</td>
                    <td>{c.wood_amount === null ? <span className={t.muted}>not entered</span> : formatINR(Number(c.wood_amount))}</td>
                    {woods.map(w => {
                      const own = !!c.wood && w.trim().toLowerCase() === c.wood.trim().toLowerCase()
                      const p = own ? Number(c.total) : c.in_wood[w.trim().toLowerCase()]
                      return <td key={w}>{p === undefined ? <span className={t.muted}>—</span> : own ? <b>{formatINR(p)}</b> : formatINR(Number(p))}</td>
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className={t.cardB}><span className={t.muted}>A dash means the price cannot be worked out: the case has no wood share, or one of the two woods has no rate in <Link href="/pricing/woods">Wood rates</Link>. Only the wood share changes; the rest stays.</span></div>
        </div>
      )}
    </div>
  )
}
