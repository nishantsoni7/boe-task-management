'use client'

// RECORD A DISPATCH, OR ADD TO ONE (20270520000000).
//
// The papers go straight to private storage and are read on the server, one at
// a time; what is read only FILLS fields still empty, and nothing is saved until
// the person presses Save. Goods and the date are locked once a dispatch exists:
// changing them stays the administrator's, in the Payment plan.

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { Camera, CircleCheck, FileText, Image as ImageIcon, LoaderCircle, ScanText, TriangleAlert, Upload } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { displayOrderNumber } from '@/lib/orderNumbering'
import { ORDER_FILES_BUCKET } from '@/lib/orders/draftsView'
import { istToday } from '@/lib/istDate'
import {
  DISPATCH_PAPER_KINDS,
  DISPATCH_PAPER_LABEL,
  EMPTY_DISPATCH_FORM,
  amountIsValid,
  buildDispatchLedger,
  checkGoods,
  describeDispatchError,
  detailsPayload,
  formFromLot,
  invoiceAddsUp,
  plannedLot,
  type DispatchData,
  type DispatchForm,
  type DispatchLot,
  type DispatchPaperKind,
} from '@/lib/orders/dispatch'
import {
  DISPATCH_PAPER_ACCEPT,
  DISPATCH_PAPER_MAX_BYTES,
  DISPATCH_PAPER_TYPES,
  applyPaperReading,
  dispatchPaperPath,
  type PaperReadingResponse,
  type ReadSources,
} from '@/lib/orders/dispatchPaperReading'

type PaperState = 'uploading' | 'reading' | 'read' | 'unclear' | 'failed'

type Paper = {
  key: string
  kind: DispatchPaperKind
  fileName: string
  mimeType: string
  sizeBytes: number
  storagePath: string | null
  previewUrl: string
  state: PaperState
  note: string | null
}

const STATE_TEXT: Record<PaperState, string> = {
  uploading: 'Adding…', reading: 'Reading…', read: 'Read', unclear: 'Not clear', failed: 'Not added',
}

function PaperStatus({ state }: { state: PaperState }) {
  const tone = state === 'read' ? 'read' : state === 'uploading' || state === 'reading' ? 'busy' : 'problem'
  const Icon = tone === 'read' ? CircleCheck : tone === 'busy' ? LoaderCircle : TriangleAlert
  return <span className={`odr-paper-state odr-state--${tone}`}><Icon aria-hidden="true" />{STATE_TEXT[state]}</span>
}

function Field({ label, value, onChange, from, required, type = 'text', inputMode, problem, wide, maxLength, max }: {
  label: string
  value: string
  onChange: (value: string) => void
  from?: string
  required?: boolean
  type?: 'text' | 'date'
  inputMode?: 'decimal' | 'numeric' | 'tel'
  problem?: string | null
  wide?: boolean
  maxLength?: number
  max?: string
}) {
  return (
    <label className={`odr-field${wide ? ' odr-field--wide' : ''}`}>
      <span className="odr-label">{label}{required && <span className="boe-req"> *</span>}</span>
      <input
        className="boe-input" type={type} inputMode={inputMode} value={value} maxLength={maxLength} max={max}
        aria-invalid={problem ? true : undefined} onChange={e => onChange(e.target.value)}
      />
      {problem
        ? <span className="odr-field-problem">{problem}</span>
        : from && <span className="odr-from"><CircleCheck aria-hidden="true" />From {from.toLowerCase()}</span>}
    </label>
  )
}

export default function OrderDispatchRecord({ data, clientName, lot, onDone }: {
  data: DispatchData
  clientName: string | null
  /** The dispatch being added to; null records a new one. */
  lot: DispatchLot | null
  onDone: () => void
}) {
  const supabase = useMemo(() => createClient(), [])
  const ledger = useMemo(() => buildDispatchLedger(data), [data])
  const planned = lot ? null : plannedLot(data)
  const [recordKey] = useState(() => lot?.details?.recordKey ?? crypto.randomUUID())
  const [form, setForm] = useState<DispatchForm>(() => (lot ? formFromLot(lot) : { ...EMPTY_DISPATCH_FORM, dispatchedOn: planned?.plannedOn ?? '' }))
  const [quantities, setQuantities] = useState<Record<string, string>>(() =>
    Object.fromEntries((planned?.lines ?? []).map(l => [l.itemSequence, String(l.quantity)])))
  const [sources, setSources] = useState<ReadSources>(() => (planned ? { goods: 'Payment plan' } : {}))
  const [papers, setPapers] = useState<Paper[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [showProblems, setShowProblems] = useState(false)

  // One drafted form across the awaits below: each reading fills from the latest.
  const draft = useRef({ form, quantities, sources })
  const previews = useRef<string[]>([])
  useEffect(() => () => { previews.current.forEach(url => URL.revokeObjectURL(url)) }, [])

  const set = (patch: Partial<DispatchForm>) => {
    setProblem(null)
    setForm(f => {
      const next = { ...f, ...patch }
      draft.current.form = next
      return next
    })
  }
  const setQuantity = (seq: string, value: string) => {
    setProblem(null)
    setQuantities(q => {
      const next = { ...q, [seq]: value }
      draft.current.quantities = next
      return next
    })
  }
  const patchPaper = (key: string, patch: Partial<Paper>) =>
    setPapers(list => list.map(p => (p.key === key ? { ...p, ...patch } : p)))

  const readPaper = async (key: string, path: string) => {
    patchPaper(key, { state: 'reading' })
    let body: PaperReadingResponse | null = null
    try {
      const res = await fetch(`/api/orders/${data.orderId}/dispatch/read-paper`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path }),
      })
      body = await res.json().catch(() => null) as PaperReadingResponse | null
    } catch { /* said in words below */ }
    if (!body?.ok) {
      patchPaper(key, { state: 'unclear', note: body?.error ?? 'Could not read the paper right now. It is kept; type the details.' })
      return
    }
    const merged = applyPaperReading(draft.current.form, draft.current.quantities, draft.current.sources, body.reading)
    draft.current = merged
    setForm(merged.form)
    setQuantities(merged.quantities)
    setSources(merged.sources)
    patchPaper(key, { state: 'read', kind: body.reading.kind, note: null })
  }

  const addFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])]
    event.target.value = ''
    setProblem(null)
    for (const file of files) {
      const ext = DISPATCH_PAPER_TYPES[file.type]
      if (!ext) { setProblem(`${file.name}: use a PDF, JPG, PNG or WebP.`); continue }
      if (file.size > DISPATCH_PAPER_MAX_BYTES) { setProblem(`${file.name} is larger than 10 MB.`); continue }
      const key = crypto.randomUUID()
      const previewUrl = URL.createObjectURL(file)
      previews.current.push(previewUrl)
      setPapers(list => [...list, {
        key, kind: 'other', fileName: file.name.slice(0, 200), mimeType: file.type, sizeBytes: file.size,
        storagePath: null, previewUrl, state: 'uploading', note: null,
      }])
      setSelected(key)
      // shortcut: a paper added and then abandoned stays in storage until the Order is deleted; sweep them if storage ever matters.
      const path = dispatchPaperPath(data.orderId, recordKey, crypto.randomUUID(), ext)
      const { error } = await supabase.storage.from(ORDER_FILES_BUCKET).upload(path, file, { contentType: file.type, upsert: false })
      if (error) { patchPaper(key, { state: 'failed', note: 'It could not be uploaded. Try adding it again.' }); continue }
      patchPaper(key, { storagePath: path })
      await readPaper(key, path)
    }
  }

  const stored = papers.filter(p => p.storagePath)
  const busy = papers.some(p => p.state === 'uploading' || p.state === 'reading')
  const goods = checkGoods(quantities, ledger)
  const adds = invoiceAddsUp(form)
  const today = istToday()
  const amountProblem = (t: string) => (amountIsValid(t) ? null : 'Type an amount, like 154237.50')
  const readCount = papers.filter(p => p.state === 'read').length
  const preview = papers.find(p => p.key === selected) ?? papers[papers.length - 1] ?? null

  const save = async () => {
    setShowProblems(true)
    setProblem(null)
    const amountsOk = [form.invoiceTaxable, form.invoiceGst, form.invoiceTotal].every(amountIsValid)
    if (!amountsOk) { setProblem('Fix the highlighted amounts first.'); return }
    if (!lot) {
      if (!form.dispatchedOn) { setProblem('Choose the dispatch date.'); return }
      if (Object.keys(goods.problems).length > 0) { setProblem('Fix the highlighted quantities first.'); return }
      if (goods.lines.length === 0) { setProblem('Enter how many pieces of at least one product left.'); return }
    }
    const files = stored.map(p => ({
      path: p.storagePath, kind: p.kind, file_name: p.fileName, mime_type: p.mimeType, size_bytes: p.sizeBytes,
    }))
    setSaving(true)
    const { error } = lot
      ? await supabase.rpc('order_dispatch_update', {
        p_lot_id: lot.id, p_record_key: recordKey, p_details: detailsPayload(form), p_files: files,
      })
      : await supabase.rpc('order_dispatch_record', {
        p_record_key: recordKey, p_order_id: data.orderId, p_dispatched_on: form.dispatchedOn,
        p_lines: goods.lines, p_details: detailsPayload(form), p_files: files,
      })
    if (error) { setProblem(describeDispatchError(error.message)); setSaving(false); return }
    onDone()
  }

  const dispatchNo = lot?.lotNo ?? planned?.lotNo ?? (data.lots.reduce((max, l) => Math.max(max, l.lotNo), 0) + 1)
  const stay = ledger.pending - goods.pieces
  const fromOf = (field: keyof DispatchForm) => sources[field]

  return (
    <div className="odr-page">
      <header className="odr-head">
        <span className="odr-eyebrow">{lot ? 'Add papers or details' : 'New dispatch'}</span>
        <h1>Dispatch {dispatchNo}</h1>
        <p>{[`Order ${displayOrderNumber(data.displayNumber)}`, clientName].filter(Boolean).join(' · ')}</p>
      </header>

      <div className="odr-split">
        <section className="odr-card" aria-label="Papers">
          <div className="odr-add">
            <label className="odr-add-btn odr-add-btn--photo">
              <input className="odr-file" type="file" accept="image/*" capture="environment" disabled={saving} onChange={e => { void addFiles(e) }} />
              <Camera aria-hidden="true" />Take photo
            </label>
            <label className="odr-add-btn">
              <input className="odr-file" type="file" accept={DISPATCH_PAPER_ACCEPT} multiple disabled={saving} onChange={e => { void addFiles(e) }} />
              <Upload aria-hidden="true" />Add invoice, e-way bill or bilty
            </label>
          </div>
          {papers.length > 0 && (
            <div className="odr-paper-list">
              {papers.map(p => {
                const Icon = p.mimeType.includes('pdf') ? FileText : ImageIcon
                return (
                  <div key={p.key} className={`odr-paper-row${preview?.key === p.key ? ' is-on' : ''}`}>
                    <button type="button" className="odr-paper-open" aria-pressed={preview?.key === p.key} onClick={() => setSelected(p.key)}>
                      <span className="od-paper-icon"><Icon aria-hidden="true" /></span>
                      <span className="od-paper-name">{p.fileName}</span>
                    </button>
                    <select
                      className="boe-input odr-paper-kind" aria-label={`What ${p.fileName} is`} value={p.kind}
                      onChange={e => patchPaper(p.key, { kind: e.target.value as DispatchPaperKind })}
                    >
                      {DISPATCH_PAPER_KINDS.map(k => <option key={k} value={k}>{DISPATCH_PAPER_LABEL[k]}</option>)}
                    </select>
                    <PaperStatus state={p.state} />
                    {p.note && <p className="odr-paper-note">{p.note}</p>}
                  </div>
                )
              })}
            </div>
          )}
          <div className="odr-preview">
            {preview
              ? preview.mimeType.includes('pdf')
                ? <iframe src={preview.previewUrl} title={preview.fileName} />
                // eslint-disable-next-line @next/next/no-img-element
                : <img src={preview.previewUrl} alt={preview.fileName} />
              : <p className="odr-preview-empty">{lot ? 'Add a paper to read it. Papers already saved stay with the dispatch.' : 'Add the papers and the details fill in for you. You can also type them.'}</p>}
          </div>
        </section>

        <div className="odr-column">
          {papers.length > 0 && (
            <p className="odr-notice" role="status">
              <ScanText aria-hidden="true" />
              <span>
                <b>{readCount} of {papers.length} {papers.length === 1 ? 'paper' : 'papers'} read.</b>{' '}
                Check each detail against the paper. Nothing is saved until you press Save.
              </span>
            </p>
          )}
          <section className="odr-card" aria-label="Details to check">
            <div className="odr-section">
              <h2 className="odr-section-title">Dispatch</h2>
              <div className="odr-fields">
                {lot ? (
                  <label className="odr-field">
                    <span className="odr-label">Dispatch date</span>
                    <input className="boe-input" type="date" value={form.dispatchedOn} disabled />
                  </label>
                ) : (
                  <Field label="Dispatch date" required type="date" max={today} value={form.dispatchedOn} from={fromOf('dispatchedOn')}
                    problem={showProblems && !form.dispatchedOn ? 'Choose the date.' : null} onChange={v => set({ dispatchedOn: v })} />
                )}
                <Field label="Vehicle number" maxLength={40} value={form.vehicleNumber} from={fromOf('vehicleNumber')} onChange={v => set({ vehicleNumber: v })} />
                <Field label="Transporter" maxLength={160} value={form.transporter} from={fromOf('transporter')} onChange={v => set({ transporter: v })} />
                <Field label="LR / bilty no." maxLength={60} value={form.lrNumber} from={fromOf('lrNumber')} onChange={v => set({ lrNumber: v })} />
                <Field label="Packages" inputMode="numeric" value={form.packages} from={fromOf('packages')}
                  problem={/^\d*$/.test(form.packages.trim()) ? null : 'Type a whole number.'} onChange={v => set({ packages: v })} />
                <Field label="Deliver to" maxLength={200} value={form.deliverTo} from={fromOf('deliverTo')} onChange={v => set({ deliverTo: v })} />
                <Field label="Driver phone" inputMode="tel" maxLength={40} value={form.driverPhone} onChange={v => set({ driverPhone: v })} />
              </div>
            </div>
            <div className="odr-section">
              <h2 className="odr-section-title">
                Invoice
                {adds === true && <span className="odr-sum odr-sum--ok"><CircleCheck aria-hidden="true" />Taxable + GST = Total</span>}
                {adds === false && <span className="odr-sum odr-sum--bad"><TriangleAlert aria-hidden="true" />Taxable + GST does not equal Total</span>}
              </h2>
              <div className="odr-fields">
                <Field label="Invoice no." maxLength={60} value={form.invoiceNumber} from={fromOf('invoiceNumber')} onChange={v => set({ invoiceNumber: v })} />
                <Field label="Invoice date" type="date" value={form.invoiceDate} from={fromOf('invoiceDate')} onChange={v => set({ invoiceDate: v })} />
                <Field label="Taxable value (₹)" inputMode="decimal" value={form.invoiceTaxable} from={fromOf('invoiceTaxable')} problem={amountProblem(form.invoiceTaxable)} onChange={v => set({ invoiceTaxable: v })} />
                <Field label="GST (₹)" inputMode="decimal" value={form.invoiceGst} from={fromOf('invoiceGst')} problem={amountProblem(form.invoiceGst)} onChange={v => set({ invoiceGst: v })} />
                <Field label="Invoice total (₹)" inputMode="decimal" value={form.invoiceTotal} from={fromOf('invoiceTotal')} problem={amountProblem(form.invoiceTotal)} onChange={v => set({ invoiceTotal: v })} />
              </div>
            </div>
            <div className="odr-section">
              <h2 className="odr-section-title">E-way bill</h2>
              <div className="odr-fields">
                <Field label="E-way bill no." maxLength={40} value={form.ewayBillNumber} from={fromOf('ewayBillNumber')} onChange={v => set({ ewayBillNumber: v })} />
                <Field label="Generated on" type="date" value={form.ewayGeneratedOn} from={fromOf('ewayGeneratedOn')} onChange={v => set({ ewayGeneratedOn: v })} />
                <Field label="Valid until" type="date" value={form.ewayValidUntil} from={fromOf('ewayValidUntil')} onChange={v => set({ ewayValidUntil: v })} />
              </div>
            </div>
            <div className="odr-section">
              <h2 className="odr-section-title">Other details</h2>
              <div className="odr-fields">
                <Field label="Note" wide maxLength={1000} value={form.note} onChange={v => set({ note: v })} />
              </div>
            </div>
          </section>
        </div>
      </div>

      {!lot && (
        <section className="odr-card" aria-label="Goods in this dispatch">
          <div className="odr-card-head">
            <span className="od-title">
              Goods in this dispatch
              {sources.goods && <span className="odr-from"><CircleCheck aria-hidden="true" />From {sources.goods.toLowerCase()}</span>}
            </span>
          </div>
          <table className="odr-goods">
            <colgroup>
              <col /><col className="odr-col-num" /><col className="odr-col-num" /><col className="odr-col-pending" /><col className="odr-col-input" /><col className="odr-col-after" />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">Product</th>
                <th scope="col" className="od-right odr-hide-small">Qty</th>
                <th scope="col" className="od-right odr-hide-small">Dispatched</th>
                <th scope="col" className="od-right odr-hide-small">Pending</th>
                <th scope="col" className="od-right">This dispatch</th>
                <th scope="col" className="od-right odr-hide-small">Pending after</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map(item => {
                const line = ledger.lines.get(item.itemSequence)
                const typed = Number((quantities[item.itemSequence] ?? '').trim() || 0)
                const after = (line?.pending ?? 0) - (Number.isFinite(typed) ? typed : 0)
                const lineProblem = goods.problems[item.itemSequence]
                return (
                  <tr key={item.itemSequence}>
                    <td>
                      <span className="od-strong">{item.productName}</span>
                      <span className="od-sub">{[item.code, line ? `${line.pending.toLocaleString('en-IN')} pending` : null].filter(Boolean).join(' · ')}</span>
                    </td>
                    <td className="od-right odr-hide-small">{item.quantity.toLocaleString('en-IN')}</td>
                    <td className="od-right odr-hide-small">{(line?.dispatched ?? 0).toLocaleString('en-IN')}</td>
                    <td className="od-right odr-hide-small">{(line?.pending ?? 0).toLocaleString('en-IN')}</td>
                    <td>
                      <input
                        className="boe-input" inputMode="decimal" aria-label={`${item.productName}, this dispatch`}
                        value={quantities[item.itemSequence] ?? ''} disabled={(line?.pending ?? 0) <= 0} aria-invalid={lineProblem ? true : undefined}
                        placeholder="0" onChange={e => setQuantity(item.itemSequence, e.target.value)}
                      />
                      {lineProblem && <span className="odr-field-problem">{lineProblem}</span>}
                    </td>
                    <td className="od-right odr-hide-small">
                      {after <= 0 && (line?.pending ?? 0) > 0 && !lineProblem
                        ? <span className="od-status od-status--all">All dispatched</span>
                        : Math.max(0, after).toLocaleString('en-IN')}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </section>
      )}

      <div className="odr-savebar">
        {problem && <p className="odr-save-problem" role="alert">{problem}</p>}
        <span className="odr-savebar-sum">
          {lot
            ? <>{stored.length > 0 ? <b>{stored.length} new {stored.length === 1 ? 'paper' : 'papers'}</b> : 'No new papers'} · goods and date stay as recorded</>
            : <><b>{goods.pieces.toLocaleString('en-IN')} {goods.pieces === 1 ? 'piece' : 'pieces'}</b> in this dispatch · <b>{Math.max(0, stay).toLocaleString('en-IN')}</b> stay pending</>}
        </span>
        <span className="odr-savebar-actions">
          <button type="button" className="boe-btn boe-btn-secondary" disabled={saving} onClick={onDone}>Cancel</button>
          <button type="button" className="boe-btn boe-btn-primary" disabled={saving || busy} onClick={() => { void save() }}>
            {saving ? 'Saving…' : busy ? 'Reading papers…' : lot ? 'Save' : 'Save dispatch'}
          </button>
        </span>
      </div>
    </div>
  )
}
