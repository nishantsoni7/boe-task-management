'use client'

import { useEffect, type CSSProperties, type ReactNode } from 'react'
import { formatINR } from '@/lib/currency'
import { istDateOf } from '@/lib/istDate'
import type { DimensionUnit, GstMode, QuoteArea, QuoteLine } from '@/lib/quotations/math'
import { computeTotals, formatDateIN, sizeInInches, sizeWithUnit, toDimensionUnit, validUntil } from '@/lib/quotations/math'
import { CLOSING, EXPECTATIONS, EXPECTATIONS_TITLE, TERMS } from '@/lib/quotations/terms'
import {
  ADDRESS, ADVANCE_PCT, PROOF, WEBSITE, WORKSHOP_LINE, capitalised, compactAmount, countsSeats, groupsOf, numberInWords,
  noteLinesOf, planTablePages, planTermsPages, roomsOf, rupeesInWords, summaryUnits, toProjectType,
  type TableRow,
} from '@/lib/quotations/documentPlan'
import { WORK_PULL, workSetFor } from '@/lib/quotations/documentWork'
import { cellChoices, choiceColumns, choiceRowsOf, choiceWords, choicesIntro, lineCostWords, planChoicePages, sourceText, statusText } from '@/lib/quotations/choicesDoc'
import type { PaymentDetails } from '@/lib/quotations/api'
import d from './document.module.css'
import { Pic } from './Pic'

// The quotation as the client receives it (owner-approved 14 Nov 2026): a portrait A4 document in the look of the
// Best of Exports catalogue. The print page, the client link and the saved PDF all draw THIS, page by page; the page
// plan (which rows go on which page) is decided in src/lib/quotations/documentPlan.ts so a screen and a PDF show the
// same pages. Since 18 Nov 2026 the products and their prices are ONE table (picture, product, qty, rate, amount), not
// picture pages followed by price pages, and the salesperson's details are the ones they filled in themselves. Client-safe by construction: it is given no internal notes, cost, client phone or e-mail.
// The Finish of a product is never printed (owner, 13 Nov 2026).

export type DocData = {
  quote_no: string
  version_no?: number | null
  issued_at: string
  valid_days: number
  client_name: string
  project_name: string | null
  contact_name: string | null
  /** Printed under "Prepared for" when set. A copy sent before 20270714000000 has neither, and no unit: inches. */
  company_name?: string | null
  client_gstin?: string | null
  dimension_unit?: DimensionUnit | null
  /** 20270717000000: the kind of venue, its seats and the lead time in weeks. A copy sent before has none and prints without them. */
  project_type?: string | null
  seats?: number | null
  lead_time_weeks?: number | null
  salesperson: string | null
  salesperson_phone?: string | null
  salesperson_email?: string | null
  /** What the salesperson calls their role ("Sales Manager"), from the details they filled in (20270801000000). */
  salesperson_title?: string | null
  gst_mode: GstMode
  discount_pct: number
  fabric_amount: number
  packing_amount: number
  transport_note: string | null
  notes: string | null
  areas: QuoteArea[]
  lines: QuoteLine[]
}

// The inches line is only for sizes written with their own unit in an inches quotation (6'0" × 6'6" → 72 × 78 in).
const inches = (t: string, unit: DimensionUnit) => { const v = unit === 'in' ? sizeInInches(t) : null; return v ? `${v.join(' × ')} in` : '' }
const pad2 = (n: number) => String(n).padStart(2, '0')
const firstName = (n: string | null) => (n ?? '').trim().split(/\s+/)[0] || 'us'
const singular = (w: string) => w.replace(/s$/i, '') || w
const areaTitle = (a: QuoteArea) => `${a.name}${a.style ? ` · ${a.style}` : ''}${a.multiplier > 1 ? ` × ${a.multiplier} ${a.unit_label}` : ''}`

function Star() {
  return <svg className={d.star} viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l2.9 6.2 6.6.8-4.9 4.6 1.3 6.7L12 17.5 6.1 20.8l1.3-6.7L2.5 9.5l6.6-.8z" /></svg>
}

function Proof() {
  return (
    <div className={d.proof}>
      {PROOF.map(p => <div key={p.label}><b>{p.value}{'star' in p && p.star ? <Star /> : null}</b><span>{p.label}</span></div>)}
    </div>
  )
}

function Person({ name, title, phone, email, lead }: { name: string | null; title?: string | null; phone?: string | null; email?: string | null; lead: ReactNode }) {
  const contact = [phone, email].filter(Boolean).join(' · ')
  const role = title?.trim() ? `${title.trim()}, Best of Exports` : 'Best of Exports'
  return (
    <div className={d.person}>
      <div className={d.av} aria-hidden="true">{(name ?? 'B').trim().charAt(0).toUpperCase()}</div>
      <p>{lead}<br />{contact ? <>{contact}<br /></> : null}<span className={d.muted}>{role}</span></p>
    </div>
  )
}

/** One A4 page of the document body: the kicker line, an optional headline, the content, the footer with its number. */
function Page({ n, section, kicker, title, children, cls }: { n: number; section: string; kicker: string; title?: ReactNode; children: ReactNode; cls?: string }) {
  return (
    <section className={d.sheet} aria-label={section}>
      <div className={`${d.pg} ${cls ?? ''}`}>
        <div className={d.kick}><div className={d.tlabel}>{kicker}</div><div className={d.hrt} />{title ? <h2>{title}</h2> : null}</div>
        {children}
        <div className={d.foot}><span>Best of Exports</span><i /><span>{section}</span><b>——</b><span>{pad2(n)}</span></div>
      </div>
    </section>
  )
}

/** The bank account and the UPI QR, in a compact block on the terms page. Nothing prints until an administrator has filled in an account number or a UPI id. */
export const hasPayment = (p: PaymentDetails | null | undefined): p is PaymentDetails => !!p && !!(p.account_no || p.upi_id)
function PayBlock({ p }: { p: PaymentDetails }) {
  const rows: [string, string][] = ([['Account name', p.account_holder], ['Bank', p.bank], ['Account no.', p.account_no], ['IFSC', p.ifsc], ['Branch', p.branch], ['UPI ID', p.upi_id]] as [string, string][]).filter(([, v]) => v)
  return (
    <div className={d.pay}>
      <div className={d.payMain}>
        <h3>Pay by bank transfer or UPI</h3>
        <dl>{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
      </div>
      {p.qr_image ? (
        <div className={d.payQr}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={p.qr_image} alt="UPI QR code" />
          <span>Scan to pay</span>
        </div>
      ) : null}
    </div>
  )
}

export function QuotationDocument({ doc, pictureUrl, payment }: { doc: DocData; pictureUrl: (path: string) => string; payment?: PaymentDetails | null }) {
  // Pictures below the first screen load as the reader scrolls to them (a quotation can hold 60 pictures of a few hundred KB each).
  // Printing needs every one of them, so the moment a print starts they all load.
  useEffect(() => {
    const all = () => document.querySelectorAll<HTMLImageElement>('img[loading="lazy"]').forEach(i => { i.loading = 'eager' })
    window.addEventListener('beforeprint', all)
    return () => window.removeEventListener('beforeprint', all)
  }, [])
  const t = computeTotals(doc, doc.areas, doc.lines)
  const unit = toDimensionUnit(doc.dimension_unit)
  const issued = istDateOf(doc.issued_at)
  const until = formatDateIN(validUntil(issued, doc.valid_days))
  const type = toProjectType(doc.project_type)
  const rooms = roomsOf(doc.areas)
  const groups = groupsOf(doc.areas, doc.lines)
  const sumRows = 1 + (t.discount > 0 ? 1 : 0) + (doc.fabric_amount > 0 ? 1 : 0) + (doc.packing_amount > 0 ? 1 : 0) + (t.discount > 0 || doc.fabric_amount > 0 || doc.packing_amount > 0 ? 1 : 0) + t.gst.length * (doc.gst_mode === 'cgst_sgst' ? 2 : 1)
  // the notes (what is included and what is not) print right under the total, where the client reads the price
  const hasNotes = !!(doc.notes || doc.transport_note)
  const tablePages = planTablePages(groups, summaryUnits(sumRows, hasNotes ? noteLinesOf(doc.notes, doc.transport_note) : 0))
  // the client's choices: one table, a row per product that has any, a column per choice the document uses; none, no page (20270809000000, 20270828000000)
  const choiceRows = choiceRowsOf(doc.areas, doc.lines)
  const choiceCols = choiceColumns(doc.lines)
  const choicePages = choiceRows.length ? planChoicePages(choiceRows, choiceCols) : []
  const termPages = planTermsPages([{ heading: EXPECTATIONS_TITLE, items: EXPECTATIONS }, { heading: 'Terms and Conditions', items: TERMS }])
  const work = workSetFor(type)
  const title = doc.project_name || doc.client_name
  const who = firstName(doc.salesperson)
  const productCount = doc.lines.filter(l => !l.is_optional).length
  const unitWord = doc.areas.length && doc.areas.every(a => a.unit_label === doc.areas[0].unit_label) ? doc.areas[0].unit_label : 'rooms'

  let n = 1
  const nGlance = ++n, nWork = ++n
  const firstTable = n + 1
  n += tablePages.length
  const firstChoice = n + 1
  n += choicePages.length
  const nTerms = ++n
  const firstAnnex = n + 1

  // ── page 2: the numbers, what is included, the next step ──
  const stats: { value: ReactNode; label: string }[] = []
  if (countsSeats(type) && doc.seats) stats.push({ value: doc.seats.toLocaleString('en-IN'), label: 'Seats' })
  else if (rooms > 1) stats.push({ value: rooms.toLocaleString('en-IN'), label: capitalised(unitWord) })
  stats.push({ value: t.pieces.toLocaleString('en-IN'), label: 'Pieces' }, { value: String(productCount), label: productCount === 1 ? 'Product' : 'Products' })
  const total = compactAmount(t.grand)
  stats.push({ value: total.unit === 'Rupees' ? formatINR(t.grand) : `₹${total.value}`, label: total.unit === 'Rupees' ? 'Including GST' : `${total.unit}, including GST` })
  const headline = countsSeats(type) && doc.seats ? `Seating for ${doc.seats.toLocaleString('en-IN')} guests, made in our own Jodhpur workshop.`
    : rooms > 1 ? `${capitalised(numberInWords(rooms))} ${unitWord}, made in our own Jodhpur workshop.`
    : `${t.pieces.toLocaleString('en-IN')} ${t.pieces === 1 ? 'piece' : 'pieces'}, made in our own Jodhpur workshop.`
  const included: string[] = []
  for (const g of groups.slice(0, 4)) {
    const k = g.lines.filter(l => !l.is_optional).length
    if (k) included.push(g.area ? `${g.area.name}: ${k} ${k === 1 ? 'product' : 'products'}${g.area.multiplier > 1 ? `, for ${g.area.multiplier} ${g.area.unit_label}` : ''}` : `${k} other ${k === 1 ? 'product' : 'products'}`)
  }
  if (groups.length > 4) included.push(`and ${groups.length - 4} more room types`)
  if (doc.packing_amount > 0) included.push('Packing, in the total')
  if (doc.fabric_amount > 0) included.push('Fabric, in the total')
  if (doc.transport_note) included.push(`Transport: ${doc.transport_note}`)
  included.push('GST shown separately')
  const weeks = doc.lead_time_weeks && doc.lead_time_weeks > 0 ? doc.lead_time_weeks : null

  const tableRow = (r: TableRow) => {
    if (r.kind === 'group') {
      return (
        <tr key={`g${r.area.key}${r.continued ? 'c' : ''}`} className={d.grp}>
          <td colSpan={4}>{areaTitle(r.area)}{r.continued ? <span className={d.cont}> · continued</span> : null}</td>
          <td className={d.r}>{r.continued ? '' : formatINR(t.areaTotal[r.area.key] ?? 0)}</td>
        </tr>
      )
    }
    const l = r.line, q = t.lineQty[l.key] ?? 0
    const per = l.qty_mode === 'per_unit' && r.area && r.area.multiplier > 1 ? `${l.qty} per ${singular(r.area.unit_label)} × ${r.area.multiplier} ${r.area.unit_label}` : ''
    const size = l.size_text ? sizeWithUnit(l.size_text, unit) : ''
    const inch = l.size_text ? inches(l.size_text, unit) : ''
    const amount = l.unit_price === null ? '—' : formatINR(t.lineTotal[l.key] ?? 0)
    return (
      <tr key={l.key} className={l.is_optional ? d.optRow : undefined}>
        {/* a product with no picture leaves the cell empty: no empty frame */}
        <td className={d.thumb}>{l.image_path ? <div className={d.tb}><Pic src={pictureUrl(l.image_path)} alt={l.name} lazy /></div> : null}</td>
        <td>
          <b className={d.pname}>{l.name}</b>
          <span className={d.pspec}>
            {size ? <span className={d.num}>{size}{inch ? ` (${inch})` : ''}</span> : null}
            {l.material ? <span>{l.material}</span> : null}
            {l.spec ? <span className={d.remarks}>{l.spec}</span> : null}
            {l.client_note ? <span className={d.remarks}>Note: {l.client_note}</span> : null}
            {per ? <span>{per}</span> : null}
            {l.is_optional ? <span className={d.opt}>Optional, not in the total</span> : null}
          </span>
        </td>
        <td className={d.r}>{q.toLocaleString('en-IN')}</td>
        <td className={d.r}>{l.unit_price === null ? '—' : formatINR(l.unit_price)}</td>
        <td className={d.r}>{l.is_optional && l.unit_price !== null ? `(${amount})` : amount}</td>
      </tr>
    )
  }

  const notesBox = (
    <div className={d.notesBox}>
      {doc.notes ? <><h3>Notes</h3><p>{doc.notes}</p></> : null}
      {doc.transport_note ? <p><b>Transport:</b> {doc.transport_note}</p> : null}
    </div>
  )

  return (
    <article className={d.doc}>
      {/* ── 1 · cover (A, sand, like the catalogue's front page) ── */}
      <section className={`${d.sheet} ${d.cover}`} aria-label="Cover">
        <svg className={d.diamond} viewBox="0 0 100 100" fill="none" aria-hidden="true"><path d="M50 2 L96 48 Q99 50 96 52 L50 98 Q48 100 46 98 L4 52 Q1 50 4 48 L46 2 Q48 0 50 2Z" /><path d="M50 14 L84 48 Q86 50 84 52 L50 86 Q48 88 46 86 L16 52 Q14 50 16 48 L46 14 Q48 12 50 14Z" /></svg>
        <div className={d.labels}><div className={d.vrt} /><ul><li className={d.tlabel}>Hotels</li><li className={d.tlabel}>Restaurants</li><li className={d.tlabel}>Cafés</li><li className={d.tlabel}>Resorts</li><li className={d.tlabel}>Breweries</li></ul></div>
        <Pic className={d.logo} src="/quotation/boe-logo.png" alt="Best of Exports" />
        <div className={`${d.tlabel} ${d.tagline}`}>Furniture for<br />hospitality spaces</div>
        <div className={d.mid}>
          <div className={d.hrt} />
          <div className={d.tlabel}>Quotation</div>
          <h1 className={d.disp}>{title}</h1>
          {doc.project_name ? <div className={`${d.tlabel} ${d.muted}`}>{doc.client_name}</div> : null}
        </div>
        <div className={d.meta}>
          <dl>
            <div><dt>Prepared for</dt><dd>{doc.company_name || doc.client_name}{doc.contact_name ? <span className={d.sub}>{doc.contact_name}</span> : null}{doc.client_gstin ? <span className={d.sub}>GSTIN {doc.client_gstin}</span> : null}</dd></div>
            <div><dt>Quotation</dt><dd>{doc.quote_no}{doc.version_no ? ` · v${doc.version_no}` : ''} · {formatDateIN(issued)}</dd></div>
          </dl>
          <div className={d.tag}><div className={d.vrt} /><ul><li>Valid until</li><li className={d.terra}>{until}</li></ul></div>
        </div>
      </section>

      {/* ── 2 · at a glance ── */}
      <Page n={nGlance} section="At a glance" kicker="At a glance" title={headline}>
        <div className={d.stats} style={{ '--n': stats.length } as CSSProperties}>{stats.map(s => <div key={s.label} className={d.stat}><b>{s.value}</b><span>{s.label}</span></div>)}</div>
        <div className={d.two}>
          <div className={d.blk}>
            <h3>What is included</h3>
            <ul>{included.map(x => <li key={x}>{x}</li>)}</ul>
            {weeks ? <><h3 className={d.gap}>Lead time</h3><p>{weeks} weeks from the day we receive your advance.</p></> : null}
          </div>
          <div className={d.blk}>
            <h3>Your next step</h3>
            <div className={d.steps}>
              <div className={d.step}><b>1</b><p><strong>Review</strong>Check the pieces, sizes and prices on the next pages.</p></div>
              <div className={d.step}><b>2</b><p><strong>Approve</strong>Reply “Approved” to {who}{doc.salesperson_phone ? ' on WhatsApp' : ''}.</p></div>
              <div className={d.step}><b>3</b><p><strong>Advance {ADVANCE_PCT}%</strong>Production starts after the advance is received.</p></div>
            </div>
          </div>
        </div>
        <div className={d.cta}>
          <div><div className={d.tlabel}>This quotation is valid until {until}</div><strong>Reply “Approved” to begin</strong></div>
          <div className={d.reply}>{doc.salesperson_phone ? `WhatsApp ${doc.salesperson_phone}` : `Reply to ${who}`}</div>
        </div>
        <Person name={doc.salesperson} title={doc.salesperson_title} phone={doc.salesperson_phone} email={doc.salesperson_email} lead={<b>{doc.salesperson ?? 'Best of Exports'}</b>} />
        <Proof />
        <p className={d.proofLine}>{WORKSHOP_LINE}</p>
      </Page>

      {/* ── 3 · our work ── */}
      <Page n={nWork} section="Our work" kicker={work.kicker} title="Spaces people remember.">
        <div className={`${d.gal} ${work.layout === 'wide-first' ? d.galWide : d.galGrid}`}>
          {work.photos.map((p, i) => (
            <figure key={p.src} className={work.layout === 'wide-first' && i === 0 ? d.span2 : undefined}>
              <div className={d.im}><Pic src={p.src} alt={p.alt} lazy /></div>
              {p.caption ? <figcaption>{p.caption}</figcaption> : null}
            </figure>
          ))}
          {work.layout === 'wide-first' ? <div className={d.pull}><p>{WORK_PULL}</p><span>Best of Exports</span></div> : null}
        </div>
        <Proof />
      </Page>

      {/* ── 4 · the products and their prices, one table ── */}
      {tablePages.map((pg, pi) => (
        <Page key={`i${pi}`} n={firstTable + pi} section="Products and prices" kicker="Products and prices" title={pi === 0 ? 'Every piece, line by line.' : undefined}>
          {pg.rows.length ? (
            <table className={`${d.tbl} ${d.ptbl}`}>
              <thead><tr><th className={d.thumb} aria-label="Picture" /><th>Product</th><th className={d.r}>Qty</th><th className={d.r}>Rate</th><th className={d.r}>Amount</th></tr></thead>
              <tbody>{pg.rows.map(tableRow)}</tbody>
            </table>
          ) : null}
          {pg.summary ? (
            <>
              <table className={`${d.tbl} ${d.sum}`}><tbody>
                <tr className={d.subr}><td colSpan={3}>Subtotal</td><td className={d.r}>{formatINR(t.subtotal)}</td></tr>
                {t.discount > 0 && <tr className={d.subr}><td colSpan={3}>Discount {doc.discount_pct}%</td><td className={d.r}>− {formatINR(t.discount)}</td></tr>}
                {doc.fabric_amount > 0 && <tr className={d.subr}><td colSpan={3}>Fabric</td><td className={d.r}>{formatINR(doc.fabric_amount)}</td></tr>}
                {doc.packing_amount > 0 && <tr className={d.subr}><td colSpan={3}>Packing</td><td className={d.r}>{formatINR(doc.packing_amount)}</td></tr>}
                {(t.discount > 0 || doc.fabric_amount > 0 || doc.packing_amount > 0) && <tr className={d.subr}><td colSpan={3}>Taxable value</td><td className={d.r}>{formatINR(t.taxable)}</td></tr>}
                {t.gst.map(r => <tr key={r.rate} className={d.subr}><td colSpan={3}>GST @{r.rate}%</td><td className={d.r}>{formatINR(r.gst)}</td></tr>)}
                <tr className={d.tot}><td colSpan={3}>Grand total</td><td className={d.r}>{formatINR(t.grand)}</td></tr>
              </tbody></table>
              <p className={d.words}>{rupeesInWords(t.grand)}</p>
              {hasNotes ? notesBox : null}
              <div className={d.sched}><div className={d.a}><b>{ADVANCE_PCT}%</b>Advance, on confirmation of the order</div><div className={d.b}><b>{100 - ADVANCE_PCT}%</b>Before dispatch</div></div>
              <div className={d.tline}>
                <div><b>Approval</b>Advance received</div>
                <div><b>Production</b>{weeks ? `${weeks} weeks` : 'Made to order'}</div>
                <div><b>Dispatch</b>Packed and shipped</div>
                <div><b>On site</b>Delivered to you</div>
              </div>
            </>
          ) : null}
        </Page>
      ))}

      {/* ── the client's choices, one table (only when a product has any) ── */}
      {choicePages.map((rows, ci) => (
        <Page key={`c${ci}`} n={firstChoice + ci} section="Client choices" kicker="Client choices" title={ci === 0 ? 'What you chose, and what is still open.' : undefined}>
          {ci === 0 ? <p className={d.chIntro}>{choicesIntro(doc.lines)}</p> : null}
          <table className={`${d.tbl} ${d.chtbl}`}>
            <thead><tr><th>Product</th>{choiceCols.map(col => <th key={col.id}>{col.label}</th>)}</tr></thead>
            <tbody>{rows.map(r => (
              <tr key={r.line.key}>
                <td className={d.chProd} data-label="Product"><b className={d.pname}>{r.line.name}</b><small>{[r.area?.name, r.line.is_optional ? 'Optional' : ''].filter(Boolean).join(' · ')}</small>{lineCostWords(r.line).packing ? <small>{lineCostWords(r.line).packing}</small> : null}</td>
                {choiceCols.map(col => {
                  const items = cellChoices(r.line, col, choiceCols)
                  const fabric = col.id === 'fabric' ? lineCostWords(r.line).fabric : ''
                  if (!items.length) return <td key={col.id} data-label={col.label} className={d.chNone}>{fabric ? <span>{fabric}</span> : <span>Not used</span>}</td>
                  return (
                    <td key={col.id} data-label={col.label}>
                      {items.map(({ label, c }, n) => (
                        <div key={n} className={n ? d.chMore : undefined}>
                          {col.other ? <span className={d.chSrc}>{label}</span> : null}
                          {c.photo ? <div className={d.chSw}><Pic src={pictureUrl(c.photo)} alt={`${label} swatch for ${r.line.name}`} lazy /></div> : null}
                          {choiceWords(c).map((w, i) => i === 0 ? <b key={i} className={d.chName}>{w}</b> : <span key={i} className={d.chWord}>{w}</span>)}
                          {n === 0 && fabric ? <span className={d.chWord}>{fabric}</span> : null}
                          <span className={d.chSrc}>{sourceText(c)}</span>
                          <span className={`${d.chChip} ${c.status === 'confirmed' ? d.chOk : d.chWait}`}>{statusText(c)}</span>
                        </div>
                      ))}
                    </td>
                  )
                })}
              </tr>
            ))}</tbody>
          </table>
          {ci === choicePages.length - 1 ? (
            <div className={d.chSign}>
              <div><span>For the client: name, date and signature</span></div>
              <div><span>For Best of Exports: name and date</span></div>
            </div>
          ) : null}
        </Page>
      ))}

      {/* ── 6 · terms in plain words, and the acceptance ── */}
      <Page n={nTerms} section="Terms and acceptance" kicker="Terms and acceptance" title="What we ask, and how we start.">
        <div className={d.two}>
          <div className={d.blk}><h3>Payment and production</h3><ul>
            <li>{ADVANCE_PCT}% at the confirmation of the order, {100 - ADVANCE_PCT}% before the material is dispatched</li>
            <li>Production starts after the advance is received</li>
            <li>This quotation is valid until {until}</li></ul></div>
          <div className={d.blk}><h3>What we ask of you</h3><ul>
            <li>Fabric and wood finishes confirmed within 5 to 7 days of the project being finalised</li>
            <li>Design, size and finish unchanged once finalised</li>
            <li>One single point of contact for the project</li></ul></div>
        </div>
        {hasPayment(payment) ? <PayBlock p={payment} /> : null}
        <p className={d.fine}>The full terms and conditions (7 expectations, 23 terms) follow on the next {termPages.length === 1 ? 'page' : 'pages'} and are part of this quotation.</p>
        <Person name={doc.salesperson} title={doc.salesperson_title} phone={doc.salesperson_phone} email={doc.salesperson_email} lead={<b>Questions? Talk to {who}.</b>} />
        <div className={d.addr}><div className={d.vrt} /><div>{WEBSITE}<br />{ADDRESS.map(x => <span key={x}>{x}<br /></span>)}</div></div>
      </Page>

      {/* ── the full standard terms ── */}
      {termPages.map((segs, ti) => (
        <Page key={`t${ti}`} n={firstAnnex + ti} section="Terms and conditions" kicker="Terms and conditions" cls={d.annex}>
          {segs.map((s, si) => (
            <div key={si} className={d.terms}>
              {s.heading ? <h2>{s.heading}</h2> : null}
              <dl>{s.items.map(x => <div key={x.title}><dt>{x.title}</dt><dd>{x.text}</dd></div>)}</dl>
            </div>
          ))}
          {ti === termPages.length - 1 ? <p className={d.closing}>{CLOSING}</p> : null}
        </Page>
      ))}
    </article>
  )
}
