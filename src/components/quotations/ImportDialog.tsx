'use client'

// Import a client's BOQ or a BOE PI into the quotation: choose a file (Excel, CSV, PDF, photo) or paste rows, check
// every row in the review table (marked cells are the ones the reader was unsure of), then add the kept rows. Nothing
// is saved until the builder's own Save. A PI's prices come across; a client's own file and a PDF or photo bring none.

import { useEffect, useMemo, useState } from 'react'
import { FileUp } from 'lucide-react'
import type { createClient } from '@/lib/supabase/client'
import { uploadPicture } from '@/lib/quotations/api'
import { addToQuote, priceOf, type ImportField, type ImportRow } from '@/lib/quotations/importBoq'
import { IMPORT_ACCEPT, readFailure, readImportFile, readPastedText } from '@/lib/quotations/importFile'
import type { QuoteArea, QuoteLine } from '@/lib/quotations/math'
import { Pic } from './Pic'
import s from './quotations.module.css'

type Supabase = ReturnType<typeof createClient>

export function ImportDialog({ supabase, userId, areas, onClose, onAdd }: {
  supabase: Supabase; userId: string; areas: QuoteArea[]
  onClose: () => void; onAdd: (areas: QuoteArea[], lines: QuoteLine[]) => void
}) {
  const [rows, setRows] = useState<ImportRow[] | null>(null)
  const [pictures, setPictures] = useState<Blob[]>([])
  const [note, setNote] = useState('')
  const [pasted, setPasted] = useState('')
  const [busy, setBusy] = useState<'' | 'reading' | 'adding'>('')
  const [err, setErr] = useState('')
  const [reload, setReload] = useState(false)

  const urls = useMemo(() => pictures.map(p => URL.createObjectURL(p)), [pictures])
  useEffect(() => () => urls.forEach(u => URL.revokeObjectURL(u)), [urls])

  // The Price column belongs to the file (it had prices), not to what is typed later, so clearing every price keeps the column.
  const [hasPrices, setHasPrices] = useState(false)
  const take = (r: { rows: ImportRow[]; pictures: Blob[]; note: string }) => { setRows(r.rows); setPictures(r.pictures); setNote(r.note); setHasPrices(r.rows.some(x => x.price !== null)) }
  const readFile = async (file: File | undefined) => {
    if (!file) return
    setBusy('reading'); setErr(''); setReload(false)
    try { take(await readImportFile(supabase, file)) } catch (e) { const f = readFailure(e, 'Could not read the file.'); setErr(f.text); setReload(f.reload) } finally { setBusy('') }
  }
  const upd = (id: string, patch: Partial<ImportRow>) =>
    setRows(p => p && p.map(r => (r.id === id ? { ...r, ...patch, doubtful: r.doubtful.filter(f => !(f in patch)) as ImportField[] } : r)))

  const kept = rows?.filter(r => r.include && r.name.trim()) ?? []
  const add = async () => {
    setBusy('adding'); setErr('')
    try {
      const paths = new Map<string, string>()
      for (const r of kept) if (r.picture !== null && pictures[r.picture]) paths.set(r.id, await uploadPicture(supabase, userId, pictures[r.picture]))
      const out = addToQuote(kept, areas, paths)
      onAdd(out.areas, out.lines)
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not add the rows.'); setBusy('') }
  }
  const doubt = (r: ImportRow, f: ImportField) => (r.doubtful.includes(f) ? s.doubt : '')

  return (
    <div className={s.scrim} onClick={busy ? undefined : onClose}>
      <div className={s.modal} style={{ maxWidth: rows ? 1180 : 620 }} onClick={e => e.stopPropagation()} role="dialog" aria-labelledby="imp-title">
        <div className={s.cardHead}><h2 id="imp-title">Import client file</h2><span className={s.spacer} /><button type="button" className={s.iconBtn} onClick={onClose} disabled={!!busy} aria-label="Close">×</button></div>
        <div className={s.cardBody} style={{ display: 'grid', gap: 12 }}>
          {!rows && (
            <>
              <div className={s.small}>Excel or CSV is read on this device. A PDF or photo is read by the AI reader and not kept. A BOE PI&apos;s prices (Cost per piece, Original price) and customization come across from Excel, CSV or pasted rows; a PDF or photo brings no prices.</div>
              <label className={`${s.btn} ${s.btnPrimary}`} style={{ justifySelf: 'start', cursor: busy ? 'wait' : 'pointer' }}>
                <FileUp size={15} aria-hidden /> {busy === 'reading' ? 'Reading… (a PDF can take up to a minute)' : 'Choose a file (Excel, CSV, PDF, photo)'}
                <input type="file" accept={IMPORT_ACCEPT} hidden disabled={!!busy} onChange={e => { void readFile(e.target.files?.[0]); e.target.value = '' }} />
              </label>
              <label className={s.field}><span>…or paste rows copied from Excel or a message</span>
                <textarea id="imp-paste" className={s.input} style={{ height: 'auto', padding: 8 }} rows={6} value={pasted} onChange={e => setPasted(e.target.value)} placeholder={'Description\tSize\tQty\nKing bed\t6\'0" x 6\'6"\t56'} /></label>
              <button type="button" className={s.btn} style={{ justifySelf: 'start' }} disabled={!!busy || !pasted.trim()} onClick={() => take(readPastedText(pasted))}>Read pasted rows</button>
            </>
          )}
          {rows && (
            <>
              <div className={s.small}>{note} {rows.length} found. <b>Shaded cells</b> are the ones to check. Untick anything that is not furniture you supply.</div>
              {rows.length > 0 && (
                <div className={s.tableWrap} style={{ maxHeight: '58vh', overflow: 'auto' }}>
                  <table className={`${s.table} ${s.importTable}`}>
                    <thead><tr><th><input type="checkbox" aria-label="Keep all" checked={rows.every(r => r.include)} onChange={e => setRows(rows.map(r => ({ ...r, include: e.target.checked })))} /></th>
                      <th>Room type</th><th>Rooms</th><th>Product</th><th>Size</th><th>Material</th><th>Qty</th><th></th>{hasPrices && <th>Price ₹</th>}<th>Picture</th><th>From</th></tr></thead>
                    <tbody>
                      {rows.map(r => (
                        <tr key={r.id} style={{ opacity: r.include ? 1 : 0.45, cursor: 'default' }}>
                          <td><input type="checkbox" aria-label={`Keep ${r.name}`} checked={r.include} onChange={e => upd(r.id, { include: e.target.checked })} /></td>
                          <td><input className={`${s.input} ${doubt(r, 'room')}`} value={r.room} onChange={e => upd(r.id, { room: e.target.value })} aria-label="Room type" /></td>
                          <td><input className={s.input} style={{ width: 64 }} inputMode="numeric" value={r.rooms ?? ''} onChange={e => upd(r.id, { rooms: Number(e.target.value) || null })} aria-label="Rooms" /></td>
                          <td><input className={`${s.input} ${doubt(r, 'name')}`} style={{ minWidth: 200 }} value={r.name} onChange={e => upd(r.id, { name: e.target.value })} aria-label="Product" /></td>
                          <td><input className={`${s.input} ${doubt(r, 'size')}`} value={r.size} onChange={e => upd(r.id, { size: e.target.value })} aria-label="Size" /></td>
                          <td><input className={`${s.input} ${doubt(r, 'material')}`} value={r.material} onChange={e => upd(r.id, { material: e.target.value })} aria-label="Material" /></td>
                          <td><input className={`${s.input} ${doubt(r, 'qty')}`} style={{ width: 70 }} inputMode="decimal" value={r.qty ?? ''} onChange={e => upd(r.id, { qty: Number(e.target.value) || null })} aria-label="Quantity" /></td>
                          <td><select className={s.input} value={r.qtyMode} onChange={e => upd(r.id, { qtyMode: e.target.value as ImportRow['qtyMode'], doubtful: r.doubtful })} aria-label="Quantity is"><option value="per_unit">per room</option><option value="fixed">in total</option></select></td>
                          {hasPrices && <td><input className={`${s.input} ${doubt(r, 'price')}`} title={r.doubtful.includes('price') ? (r.price === null ? 'No price in the file for this product' : 'Read from a column headed only "Price" or "Rate": check it is BOE\'s price, not the client\'s') : undefined} style={{ width: 96 }} inputMode="numeric" value={r.price ?? ''} onChange={e => upd(r.id, { price: priceOf(e.target.value) })} aria-label="Price, rupees before GST" /></td>}
                          <td>{r.picture !== null && urls[r.picture] ? <Pic src={urls[r.picture]} alt="" className={s.thumb} /> : <span className={s.muted}>–</span>}</td>
                          <td className={s.muted} style={{ whiteSpace: 'nowrap' }}>{r.source}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
          {err && <div className={`${s.notice} ${s.noticeBad}`} role="alert">{err}{reload && <div style={{ marginTop: 8 }}><button type="button" className={`${s.btn} ${s.btnSm}`} onClick={() => window.location.reload()}>Reload page</button></div>}</div>}
        </div>
        <div className={s.cardHead} style={{ borderTop: '1px solid var(--boe-border)', borderBottom: 0, justifyContent: 'flex-end' }}>
          {rows && <button type="button" className={s.btn} disabled={!!busy} onClick={() => { setRows(null); setPictures([]) }}>Start over</button>}
          <button type="button" className={s.btn} onClick={onClose} disabled={!!busy}>Cancel</button>
          {rows && <button type="button" className={`${s.btn} ${s.btnPrimary}`} disabled={!!busy || kept.length === 0} onClick={add}>{busy === 'adding' ? 'Adding…' : `Add ${kept.length} product${kept.length === 1 ? '' : 's'}`}</button>}
        </div>
      </div>
    </div>
  )
}
