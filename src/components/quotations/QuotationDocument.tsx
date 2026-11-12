'use client'

import { formatINR } from '@/lib/currency'
import { istDateOf } from '@/lib/istDate'
import type { GstMode, QuoteArea, QuoteLine } from '@/lib/quotations/math'
import { computeTotals, formatDateIN, sizeInInches, validUntil } from '@/lib/quotations/math'
import { CLOSING, EXPECTATIONS, EXPECTATIONS_TITLE, TERMS } from '@/lib/quotations/terms'
import d from './document.module.css'
import { Pic } from './Pic'

// The quotation as the client receives it: the printable page (Print → Save as PDF) and the client link draw the
// same thing. Client-safe by construction: it is given no internal notes, owner phone or cost.

export type DocData = {
  quote_no: string
  version_no?: number | null
  issued_at: string
  valid_days: number
  client_name: string
  project_name: string | null
  contact_name: string | null
  salesperson: string | null
  gst_mode: GstMode
  discount_pct: number
  fabric_amount: number
  packing_amount: number
  transport_note: string | null
  notes: string | null
  areas: QuoteArea[]
  lines: QuoteLine[]
}

const inches = (t: string) => { const v = sizeInInches(t); return v ? `${v.join(' × ')} in` : '' }

export function QuotationDocument({ doc, pictureUrl }: { doc: DocData; pictureUrl: (path: string) => string }) {
  const t = computeTotals(doc, doc.areas, doc.lines)
  const issued = istDateOf(doc.issued_at)
  const groups: { area: QuoteArea | null; lines: QuoteLine[] }[] = [
    ...doc.areas.map(a => ({ area: a, lines: doc.lines.filter(l => l.area_key === a.key) })),
    { area: null, lines: doc.lines.filter(l => !l.area_key || !doc.areas.some(a => a.key === l.area_key)) },
  ].filter(g => g.lines.length > 0)
  let n = 0
  return (
    <article className={d.doc}>
      <header className={d.brand}>
        <div><div className={d.wordmark}>BEST OF EXPORTS</div><div className={d.tag}>Hospitality furniture, made in bulk to your design</div></div>
        <div className={d.meta}><div className={d.label}>Quotation</div><div className={d.no}>{doc.quote_no}{doc.version_no ? ` · v${doc.version_no}` : ''}</div></div>
      </header>

      <section className={d.facts}>
        <div><div className={d.label}>Prepared for</div><div className={d.big}>{doc.client_name}</div>{doc.project_name && <div>{doc.project_name}</div>}{doc.contact_name && <div className={d.muted}>Attn. {doc.contact_name}</div>}</div>
        <div><div className={d.label}>Date</div><div>{formatDateIN(issued)}</div><div className={d.label} style={{ marginTop: 6 }}>Valid until</div><div>{formatDateIN(validUntil(issued, doc.valid_days))}</div></div>
        <div><div className={d.label}>Sales person</div><div>{doc.salesperson ?? 'Best of Exports'}</div><div className={d.label} style={{ marginTop: 6 }}>Products</div><div className={d.num}>{doc.lines.filter(l => !l.is_optional).length} lines · {t.pieces.toLocaleString('en-IN')} pieces</div></div>
      </section>

      {groups.map((g, gi) => (
        <section key={gi} className={d.group}>
          {g.area && <h2 className={d.groupHead}><span>{g.area.name}{g.area.style ? ` · ${g.area.style}` : ''}{g.area.multiplier > 1 ? ` × ${g.area.multiplier} ${g.area.unit_label}` : ''}</span><span className={d.num}>{formatINR(t.areaTotal[g.area.key] ?? 0)}</span></h2>}
          <table className={d.table}>
            <thead><tr><th>#</th><th aria-label="Picture" /><th>Product</th><th className={d.r}>Qty</th><th className={d.r}>Rate</th><th className={d.r}>Amount</th></tr></thead>
            <tbody>
              {g.lines.map(l => {
                n += 1
                const qty = t.lineQty[l.key] ?? 0
                return (
                  <tr key={l.key} className={l.is_optional ? d.optional : undefined}>
                    <td className={d.num}>{n}</td>
                    <td>{l.image_path ? <Pic className={d.pic} src={pictureUrl(l.image_path)} alt={l.name} /> : null}</td>
                    <td>
                      <div className={d.pname}>{l.name}{l.is_optional && <span className={d.opt}> · optional, not in the total</span>}</div>
                      {l.size_text && <div className={d.num}>{l.size_text}{inches(l.size_text) && <span className={d.muted}> ({inches(l.size_text)})</span>}</div>}
                      {[l.material, l.finish].filter(Boolean).length > 0 && <div>{[l.material, l.finish].filter(Boolean).join(' · ')}</div>}
                      {l.spec && <div className={d.spec}>{l.spec}</div>}
                      {l.client_note && <div className={d.note}>Note: {l.client_note}</div>}
                    </td>
                    <td className={`${d.r} ${d.num}`}>{qty.toLocaleString('en-IN')}{l.qty_mode === 'per_unit' && g.area && g.area.multiplier > 1 && <div className={d.muted}>{l.qty} × {g.area.multiplier}</div>}</td>
                    <td className={`${d.r} ${d.num}`}>{l.unit_price === null ? '—' : formatINR(l.unit_price)}</td>
                    <td className={`${d.r} ${d.num}`}>{l.unit_price === null ? '—' : formatINR(t.lineTotal[l.key] ?? 0)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </section>
      ))}

      <section className={d.totals}>
        <div className={d.notesBox}>{doc.notes && <><div className={d.label}>Notes</div><p>{doc.notes}</p></>}{doc.transport_note && <p><b>Transport:</b> {doc.transport_note}</p>}</div>
        <table className={d.sum}><tbody>
          <tr><td>Subtotal</td><td>{formatINR(t.subtotal)}</td></tr>
          {t.discount > 0 && <tr><td>Discount {doc.discount_pct}%</td><td>− {formatINR(t.discount)}</td></tr>}
          {doc.fabric_amount > 0 && <tr><td>Fabric</td><td>{formatINR(doc.fabric_amount)}</td></tr>}
          {doc.packing_amount > 0 && <tr><td>Packing</td><td>{formatINR(doc.packing_amount)}</td></tr>}
          {(t.discount > 0 || doc.fabric_amount > 0 || doc.packing_amount > 0) && <tr><td>Taxable value</td><td>{formatINR(t.taxable)}</td></tr>}
          {t.gst.flatMap(r => doc.gst_mode === 'cgst_sgst'
            ? [<tr key={`c${r.rate}`}><td>CGST ({r.rate / 2}%)</td><td>{formatINR(r.cgst)}</td></tr>, <tr key={`s${r.rate}`}><td>SGST ({r.rate / 2}%)</td><td>{formatINR(r.sgst)}</td></tr>]
            : [<tr key={`i${r.rate}`}><td>IGST ({r.rate}%)</td><td>{formatINR(r.igst)}</td></tr>])}
          <tr className={d.grand}><td>Grand total</td><td>{formatINR(t.grand)}</td></tr>
        </tbody></table>
      </section>

      <section className={d.terms}>
        <h2>{EXPECTATIONS_TITLE}</h2>
        <dl>{EXPECTATIONS.map(x => <div key={x.title}><dt>{x.title}</dt><dd>{x.text}</dd></div>)}</dl>
        <h2>Terms and Conditions</h2>
        <dl>{TERMS.map(x => <div key={x.title}><dt>{x.title}</dt><dd>{x.text}</dd></div>)}</dl>
        <p className={d.closing}>{CLOSING}</p>
      </section>
      <footer className={d.foot}>www.bestofexports.com · Images are representative; the final product may vary.</footer>
    </article>
  )
}
