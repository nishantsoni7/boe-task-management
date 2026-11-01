'use client'

// THE DISPATCH TAB ON THE CONFIRMED ORDER'S PRODUCT LIST (20270520000000).
//
// Code, Image, Product and Qty stay where every tab keeps them; to their right
// each product says what is dispatched and what is pending, and which dispatches
// took it. A numbered button opens that dispatch in the card below, and the
// products on the open dispatch are tinted, so the two read as one record.
//
// Nothing here does arithmetic (lib/orders/dispatch.ts does) and nothing here
// writes: recording happens on its own screen, through the database functions.

import { useMemo, useState } from 'react'
import { ChevronDown, ChevronUp, CircleCheck, Clock, FileText, Image as ImageIcon, TriangleAlert, Truck } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { formatInr } from '@/lib/pi/previewView'
import { formatDateOnly, ORDER_FILES_BUCKET } from '@/lib/orders/draftsView'
import { formatDateTime } from '@/lib/ui'
import {
  DISPATCH_PAPER_LABEL,
  DISPATCH_STATE_LABEL,
  lineShows,
  missingPapers,
  papersText,
  piecesOf,
  piecesText,
  type DispatchChip,
  type DispatchData,
  type DispatchFile,
  type DispatchFilter,
  type DispatchLedger,
  type DispatchLot,
  type DispatchState,
  type LedgerLine,
} from '@/lib/orders/dispatch'
import type { ProductViewRow } from '@/components/orders/ProductViews'

const PAPER_URL_TTL_SECONDS = 300

const shortDate = (iso: string | null): string => formatDateOnly(iso).replace(/\s\d{4}$/, '')

const STATE_ICON: Record<DispatchState, typeof Truck> = { none: Clock, part: Truck, all: CircleCheck }

function StatusBadge({ state }: { state: DispatchState }) {
  const Icon = STATE_ICON[state]
  return (
    <span className={`od-status od-status--${state}`}>
      <Icon aria-hidden="true" />
      {DISPATCH_STATE_LABEL[state]}
    </span>
  )
}

function Bar({ percent }: { percent: number }) {
  return <span className="od-bar" aria-hidden="true"><i style={{ width: `${percent}%` }} /></span>
}

const Figure = ({ value, kind }: { value: number; kind: 'sent' | 'pending' }) => (
  <span className={value > 0 ? `od-${kind}` : 'od-zero'}>{value.toLocaleString('en-IN')}</span>
)

function Chips({ chips, openLot, onOpen, row }: {
  chips: readonly DispatchChip[]
  openLot: string | null
  onOpen: (lotId: string) => void
  row: string
}) {
  return (
    <div className="od-chips">
      {chips.map(c => (
        <button
          key={c.lotId}
          type="button"
          className={`od-chip${c.lotId === openLot ? ' is-on' : ''}`}
          aria-pressed={c.lotId === openLot}
          aria-label={`Dispatch ${c.lotNo}, ${shortDate(c.date)}, ${piecesText(c.quantity)} of ${row}`}
          onClick={() => onOpen(c.lotId)}
        >
          <span className="od-key">{c.lotNo}</span>
          {shortDate(c.date)} · {piecesText(c.quantity)}
        </button>
      ))}
    </div>
  )
}

function Filters({ filter, onChange, ledger }: {
  filter: DispatchFilter
  onChange: (filter: DispatchFilter) => void
  ledger: DispatchLedger
}) {
  const options: { key: DispatchFilter; label: string; count: number }[] = [
    { key: 'all', label: 'All', count: ledger.counts.all },
    { key: 'pending', label: 'Pending', count: ledger.counts.pending },
    { key: 'done', label: 'All dispatched', count: ledger.counts.done },
  ]
  return (
    <div className="od-filters" role="group" aria-label="Show products">
      {options.map(o => (
        <button
          key={o.key}
          type="button"
          className={`od-filter${filter === o.key ? ' is-on' : ''}`}
          aria-pressed={filter === o.key}
          onClick={() => onChange(o.key)}
        >
          {o.label} <span>{o.count}</span>
        </button>
      ))}
    </div>
  )
}

/** The product list, as the Dispatch tab draws it. */
export function OrderDispatchLedger({ rows, ledger, isMobile, animate, openLot, onOpen, canRecord, onRecord }: {
  rows: readonly ProductViewRow[]
  ledger: DispatchLedger
  isMobile: boolean
  animate: boolean
  openLot: string | null
  onOpen: (lotId: string) => void
  canRecord: boolean
  onRecord: () => void
}) {
  const [filter, setFilter] = useState<DispatchFilter>('all')
  const lineOf = (row: ProductViewRow): LedgerLine | undefined => ledger.byItemId.get(row.id)
  const shown = rows.filter(row => lineShows(lineOf(row), filter))
  const openHas = (line: LedgerLine | undefined) => !!openLot && !!line?.chips.some(c => c.lotId === openLot)

  if (isMobile) {
    return (
      <div className={animate ? 'pv-animate' : undefined}>
        <div className="od-summary">
          <p className="od-summary-big">{ledger.dispatched.toLocaleString('en-IN')} of {ledger.ordered.toLocaleString('en-IN')} <span>pieces dispatched</span></p>
          <Bar percent={ledger.percent} />
          <div className="od-summary-split">
            <span className="od-summary-sent">{ledger.dispatched.toLocaleString('en-IN')} dispatched</span>
            <span className="od-summary-pending">{ledger.pending.toLocaleString('en-IN')} pending</span>
          </div>
          {canRecord && (
            <button type="button" className="boe-btn boe-btn-primary" onClick={onRecord}>
              <Truck aria-hidden="true" />Record dispatch
            </button>
          )}
        </div>
        <div className="od-tools"><Filters filter={filter} onChange={setFilter} ledger={ledger} /></div>
        {shown.map(row => {
          const line = lineOf(row)
          return (
            <div key={row.id} className="pv-card">
              <div className="pv-card-top">
                {row.image(true)}
                <div className="pv-card-name">
                  {row.code}
                  {row.product}
                  {line && <StatusBadge state={line.state} />}
                </div>
              </div>
              <div className="pv-swap">
                <dl className="od-nums">
                  <div><dt>Qty</dt><dd>{row.quantity}</dd></div>
                  <div><dt>Dispatched</dt><dd><Figure value={line?.dispatched ?? 0} kind="sent" /></dd></div>
                  <div><dt>Pending</dt><dd><Figure value={line?.pending ?? 0} kind="pending" /></dd></div>
                </dl>
              </div>
              {line && line.chips.length > 0 && <Chips chips={line.chips} openLot={openLot} onOpen={onOpen} row={row.label} />}
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <>
      <div className="od-tools">
        <Filters filter={filter} onChange={setFilter} ledger={ledger} />
        {ledger.dispatches.length > 0 && <span className="od-hint">Press a dispatch number to open it below.</span>}
      </div>
      <div className={`pv-scroll${animate ? ' pv-animate' : ''}`}>
        <table className="pv-table pv-table--order">
          <colgroup>
            <col className="pv-col-code" /><col className="pv-col-image" /><col className="pv-col-product" /><col className="pv-col-qty" />
            <col style={{ width: '104px' }} /><col style={{ width: '84px' }} /><col style={{ width: '156px' }} /><col />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">Code</th><th scope="col">Image</th><th scope="col">Product</th>
              <th scope="col" className="pv-num">Qty</th>
              <th scope="col" className="pv-swap pv-num">Dispatched</th>
              <th scope="col" className="pv-swap pv-num">Pending</th>
              <th scope="col" className="pv-swap">Status</th>
              <th scope="col" className="pv-swap">Dispatches</th>
            </tr>
          </thead>
          <tbody>
            {shown.map(row => {
              const line = lineOf(row)
              return (
                <tr key={row.id} className={openHas(line) ? 'od-in-open' : undefined}>
                  <td>{row.code}</td>
                  <td>{row.image(false)}</td>
                  <td>{row.product}</td>
                  <td className="pv-num od-qty">{row.quantity}</td>
                  <td className="pv-swap pv-num"><Figure value={line?.dispatched ?? 0} kind="sent" /></td>
                  <td className="pv-swap pv-num"><Figure value={line?.pending ?? 0} kind="pending" /></td>
                  <td className="pv-swap">
                    {line && <><StatusBadge state={line.state} /><Bar percent={line.percent} /></>}
                  </td>
                  <td className="pv-swap">
                    {line && line.chips.length > 0
                      ? <Chips chips={line.chips} openLot={openLot} onOpen={onOpen} row={row.label} />
                      : <span className="od-none">Nothing sent yet</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
          <tfoot>
            <tr className="pv-total">
              <td colSpan={3}>Total pieces</td>
              <td className="pv-num od-qty">{ledger.ordered.toLocaleString('en-IN')}</td>
              <td className="pv-swap pv-num"><Figure value={ledger.dispatched} kind="sent" /></td>
              <td className="pv-swap pv-num"><Figure value={ledger.pending} kind="pending" /></td>
              <td className="pv-swap">{ledger.percent}% dispatched</td>
              <td className="pv-swap">{ledger.dispatches.length} {ledger.dispatches.length === 1 ? 'dispatch' : 'dispatches'}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  )
}

function PaperRow({ file, onView }: { file: DispatchFile; onView: (file: DispatchFile) => void }) {
  const isPdf = (file.mimeType ?? '').includes('pdf')
  const Icon = isPdf ? FileText : ImageIcon
  const label = DISPATCH_PAPER_LABEL[file.kind]
  const size = file.sizeBytes === null ? null
    : file.sizeBytes >= 1048576 ? `${(file.sizeBytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(file.sizeBytes / 1024))} KB`
  return (
    <div className="od-paper">
      <span className="od-paper-icon"><Icon aria-hidden="true" /></span>
      <span className="od-paper-name">{label}<span className="od-sub">{[isPdf ? 'PDF' : 'Photo', size].filter(Boolean).join(' · ')}</span></span>
      <button type="button" className="boe-btn boe-btn-secondary od-small-btn" aria-label={`View ${label}`} onClick={() => onView(file)}>View</button>
    </div>
  )
}

const money = (n: number | null | undefined) => (n === null || n === undefined ? '—' : formatInr(n))
const orDash = (t: string | number | null | undefined) => (t === null || t === undefined || t === '' ? '—' : t)

function DispatchDetail({ lot, data, canRecord, onEdit, canChangeGoods, onChangeGoods, onView }: {
  lot: DispatchLot
  data: DispatchData
  canRecord: boolean
  onEdit: (lotId: string) => void
  canChangeGoods: boolean
  onChangeGoods: () => void
  onView: (file: DispatchFile) => void
}) {
  const d = lot.details
  const nameOf = (seq: string) => data.items.find(i => i.itemSequence === seq)?.productName ?? 'No longer on the PI'
  return (
    <div className="od-detail">
      <div>
        <h3 className="od-detail-title">Goods in this dispatch</h3>
        <div className="od-goods">
          {lot.lines.map(l => (
            <div key={l.itemSequence} className="od-good">
              <span className="od-good-name">{nameOf(l.itemSequence)}</span>
              <span className="od-good-qty">{l.quantity.toLocaleString('en-IN')}</span>
            </div>
          ))}
        </div>
      </div>
      <div>
        <h3 className="od-detail-title">Transport</h3>
        <dl className="od-kv">
          <dt>LR / bilty no.</dt><dd>{orDash(d?.lrNumber)}</dd>
          <dt>Packages</dt><dd>{orDash(d?.packages)}</dd>
          <dt>Deliver to</dt><dd>{orDash(d?.deliverTo)}</dd>
          <dt>Driver</dt><dd>{orDash(d?.driverPhone)}</dd>
        </dl>
      </div>
      <div>
        <h3 className="od-detail-title">Invoice</h3>
        <dl className="od-kv">
          <dt>Date</dt><dd>{formatDateOnly(d?.invoiceDate)}</dd>
          <dt>Taxable value</dt><dd>{money(d?.invoiceTaxable)}</dd>
          <dt>GST</dt><dd>{money(d?.invoiceGst)}</dd>
          <dt>Total</dt><dd>{money(d?.invoiceTotal)}</dd>
        </dl>
      </div>
      <div>
        <h3 className="od-detail-title">Papers</h3>
        <div className="od-papers">
          {lot.files.map(f => <PaperRow key={f.id} file={f} onView={onView} />)}
          {missingPapers(lot).map(kind => (
            <div key={kind} className="od-paper od-paper--missing">
              <span className="od-paper-icon"><TriangleAlert aria-hidden="true" /></span>
              <span className="od-paper-name">{DISPATCH_PAPER_LABEL[kind]} not added</span>
              {canRecord && <button type="button" className="boe-btn boe-btn-secondary od-small-btn" onClick={() => onEdit(lot.id)}>Add</button>}
            </div>
          ))}
        </div>
      </div>
      <div className="od-detail-foot">
        <span className="od-hint">
          {d?.note ? `${d.note} · ` : ''}
          {d?.recordedAt ? `Recorded by ${lot.recordedByName ?? 'a former colleague'} on ${formatDateTime(d.recordedAt)}` : 'Marked dispatched in the Payment plan'}
        </span>
        <div className="od-detail-actions">
          {canChangeGoods && (
            <button type="button" className="boe-btn boe-btn-ghost od-small-btn" onClick={onChangeGoods}>Change goods or date</button>
          )}
          {canRecord && (
            <button type="button" className="boe-btn boe-btn-secondary od-small-btn" onClick={() => onEdit(lot.id)}>Add papers or details</button>
          )}
        </div>
      </div>
    </div>
  )
}

function PapersBadge({ lot }: { lot: DispatchLot }) {
  const { text, complete } = papersText(lot)
  const Icon = complete ? CircleCheck : TriangleAlert
  return <span className={`od-status od-status--${complete ? 'all' : 'missing'}`}><Icon aria-hidden="true" />{text}</span>
}

/** The dispatches themselves, under the product list while the Dispatch tab is open. */
export function OrderDispatchRecords({ data, ledger, isMobile, openLot, onToggle, onRecord, onEdit, canChangeGoods, onChangeGoods }: {
  data: DispatchData
  ledger: DispatchLedger
  isMobile: boolean
  openLot: string | null
  onToggle: (lotId: string) => void
  onRecord: () => void
  onEdit: (lotId: string) => void
  canChangeGoods: boolean
  onChangeGoods: () => void
}) {
  const [problem, setProblem] = useState<string | null>(null)
  const newestFirst = useMemo(() => [...ledger.dispatches].sort((a, b) => b.lotNo - a.lotNo), [ledger.dispatches])

  const view = async (file: DispatchFile) => {
    setProblem(null)
    const { data: signed, error } = await createClient().storage.from(ORDER_FILES_BUCKET).createSignedUrl(file.storagePath, PAPER_URL_TTL_SECONDS)
    if (error || !signed?.signedUrl) { setProblem(`${file.fileName} could not be opened.`); return }
    window.open(signed.signedUrl, '_blank', 'noopener,noreferrer')
  }

  const detail = (lot: DispatchLot) => (
    <DispatchDetail
      lot={lot} data={data} canRecord={data.canRecord} onEdit={onEdit}
      canChangeGoods={canChangeGoods} onChangeGoods={onChangeGoods} onView={f => { void view(f) }}
    />
  )

  const head = (
    <div className="odr-card-head">
      <span className="od-title">
        Dispatches
        {ledger.needPapers > 0 && <span className="od-count">{ledger.needPapers} {ledger.needPapers === 1 ? 'needs a paper' : 'need papers'}</span>}
      </span>
    </div>
  )

  if (ledger.dispatches.length === 0) {
    return (
      <section className="odr-card od-card" aria-label="Dispatches">
        <div className="od-empty">
          <span className="od-empty-icon"><Truck aria-hidden="true" /></span>
          <h3>No dispatch recorded yet</h3>
          <p>
            All {ledger.ordered.toLocaleString('en-IN')} pieces are pending.
            {data.canRecord ? ' When goods leave, add the invoice and e-way bill and the details fill in for you.' : ''}
          </p>
          {data.canRecord && <button type="button" className="boe-btn boe-btn-primary" onClick={onRecord}>Record dispatch</button>}
        </div>
      </section>
    )
  }

  return (
    <section className="odr-card od-card" aria-label="Dispatches">
      {head}
      {problem && <p className="od-problem" role="alert">{problem}</p>}
      {isMobile ? (
        newestFirst.map(lot => (
          <article key={lot.id} id={`dispatch-${lot.id}`} className="od-dcard">
            <div className="od-dcard-top">
              <span className={`od-key${lot.id === openLot ? ' is-on' : ''}`}>{lot.lotNo}</span>
              {formatDateOnly(lot.dispatchedOn)}
              <b>{piecesText(piecesOf(lot))}</b>
            </div>
            <dl className="od-kv">
              <dt>Vehicle</dt><dd>{orDash(lot.details?.vehicleNumber)}</dd>
              <dt>Invoice</dt><dd>{orDash(lot.details?.invoiceNumber)}</dd>
              <dt>Invoice total</dt><dd>{money(lot.details?.invoiceTotal)}</dd>
            </dl>
            {missingPapers(lot).length > 0 && <div><PapersBadge lot={lot} /></div>}
            <button type="button" className="boe-btn boe-btn-secondary" aria-expanded={lot.id === openLot} onClick={() => onToggle(lot.id)}>
              {lot.id === openLot ? 'Close' : 'Open'} dispatch {lot.lotNo}
            </button>
            {lot.id === openLot && detail(lot)}
          </article>
        ))
      ) : (
        <div className="pv-scroll">
          <table className="od-records">
            <colgroup>
              <col style={{ width: '168px' }} /><col /><col /><col style={{ width: '152px' }} />
              <col style={{ width: '76px' }} /><col style={{ width: '200px' }} /><col style={{ width: '52px' }} />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">Dispatch</th><th scope="col">Vehicle</th><th scope="col">Invoice</th><th scope="col">E-way bill</th>
                <th scope="col" className="od-right">Goods</th><th scope="col">Papers</th><th scope="col"><span className="order-sr-only">Open</span></th>
              </tr>
            </thead>
            <tbody>
              {newestFirst.flatMap(lot => {
                const open = lot.id === openLot
                const d = lot.details
                const row = (
                  <tr key={lot.id} id={`dispatch-${lot.id}`} className={open ? 'is-open' : undefined}>
                    <td><span className="od-record-date"><span className={`od-key${open ? ' is-on' : ''}`}>{lot.lotNo}</span>{formatDateOnly(lot.dispatchedOn)}</span></td>
                    <td><span className="od-strong">{orDash(d?.vehicleNumber)}</span>{d?.transporter && <span className="od-sub">{d.transporter}</span>}</td>
                    <td><span className="od-strong">{orDash(d?.invoiceNumber)}</span>{d?.invoiceTotal !== null && d?.invoiceTotal !== undefined && <span className="od-sub">{money(d.invoiceTotal)}</span>}</td>
                    <td>
                      {d?.ewayBillNumber ? <span className="od-strong">{d.ewayBillNumber}</span> : <span className="od-none">Not added</span>}
                      {d?.ewayValidUntil && <span className="od-sub">Valid until {shortDate(d.ewayValidUntil)}</span>}
                    </td>
                    <td className="od-right"><span className="od-strong">{piecesText(piecesOf(lot))}</span></td>
                    <td><PapersBadge lot={lot} /></td>
                    <td>
                      <button type="button" className="od-chev" aria-expanded={open} aria-label={`${open ? 'Close' : 'Open'} dispatch ${lot.lotNo}`} onClick={() => onToggle(lot.id)}>
                        {open ? <ChevronUp aria-hidden="true" size={16} /> : <ChevronDown aria-hidden="true" size={16} />}
                      </button>
                    </td>
                  </tr>
                )
                return open
                  ? [row, <tr key={`${lot.id}-detail`} className="od-detail-row"><td colSpan={7}>{detail(lot)}</td></tr>]
                  : [row]
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
