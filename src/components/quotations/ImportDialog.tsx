'use client'

// Read a client's requirement file into the quotation: choose one or more files (Excel, CSV, PDF, photos, PowerPoint), or
// the files attached to the quotation request, or paste rows; check every row against its page (marked cells are the ones
// the reader was unsure of); then add the kept rows. Nothing is saved until the builder's own Save (or, when starting a
// quotation from a file, until "Start quotation"). A BOE PI's prices come across from Excel; a client's file brings none:
// a price printed in it goes to the Internal note only.

import { useEffect, useMemo, useState } from 'react'
import { FileUp } from 'lucide-react'
import type { createClient } from '@/lib/supabase/client'
import { uploadPicture } from '@/lib/quotations/api'
import { addToQuote, priceOf, type ImportField, type ImportRow } from '@/lib/quotations/importBoq'
import { IMPORT_ACCEPT, readFailure, readImportFiles, readPastedText, type ImportResult } from '@/lib/quotations/importFile'
import { MAX_LINE_REFS, SUPPLY_STATES, type LineRef, type QuoteArea, type QuoteLine } from '@/lib/quotations/math'
import type { ScanProgress } from '@/lib/quotations/scanRun'
import type { Survey } from '@/lib/quotations/scanReading'
import { resolveAttachmentPath, signAttachmentUrl } from '@/lib/tasks/attachmentStorage'
import { Pic } from './Pic'
import { REF_LABEL } from './ProductLine'
import { CropDialog } from './CropDialog'
import s from './quotations.module.css'

type Supabase = ReturnType<typeof createClient>
export type StartInfo = { client_name: string; project_name: string; supply_state: string; project_type: string }

const STAGE: Record<ScanProgress['stage'], string> = {
  pages: 'Preparing the pages', survey: 'Looking over the whole file', read: 'Reading the pages', rooms: 'Finding the furniture in the room pictures', pictures: 'Cutting out the pictures',
}
type RequestFile = { id: string; name: string; path: string }

export function ImportDialog({ supabase, userId, areas, requestId, start, onClose, onAdd }: {
  supabase: Supabase; userId: string; areas: QuoteArea[]
  /** The quotation request this quotation answers: its attached files can be read in one tap. */
  requestId?: string | null
  /** Starting a new quotation from the file: ask the client's name too. */
  start?: boolean
  onClose: () => void; onAdd: (areas: QuoteArea[], lines: QuoteLine[], info: StartInfo) => void | Promise<void>
}) {
  const [res, setRes] = useState<ImportResult | null>(null)
  const rows = res?.rows ?? null
  const setRows = (f: (r: ImportRow[]) => ImportRow[]) => setRes(p => p && { ...p, rows: f(p.rows) })
  const [pasted, setPasted] = useState('')
  const [busy, setBusy] = useState<'' | 'reading' | 'adding'>('')
  const [progress, setProgress] = useState<ScanProgress | null>(null)
  const [adding, setAdding] = useState('')
  const [err, setErr] = useState('')
  const [reload, setReload] = useState(false)
  const [viewPage, setViewPage] = useState<number | null>(null)
  const [picking, setPicking] = useState<string | null>(null)
  /** The picture (index into res.pictures) being cropped; a crop replaces it for every row that uses it. */
  const [cropping, setCropping] = useState<number | null>(null)
  const [info, setInfo] = useState<StartInfo>({ client_name: '', project_name: '', supply_state: '', project_type: '' })
  const [reqFiles, setReqFiles] = useState<RequestFile[] | null>(null)

  const urls = useMemo(() => (res?.pictures ?? []).map(p => URL.createObjectURL(p)), [res?.pictures])
  useEffect(() => () => urls.forEach(u => URL.revokeObjectURL(u)), [urls])
  const pageUrls = useMemo(() => new Map((res?.pages ?? []).map(p => [p.n, URL.createObjectURL(p.jpeg)])), [res?.pages])
  useEffect(() => () => pageUrls.forEach(u => URL.revokeObjectURL(u)), [pageUrls])

  // The request's own files (the salesperson attached the client's file when asking for the quotation).
  useEffect(() => {
    if (!requestId) return
    let gone = false
    type Att = { id: string; file_name: string | null; storage_path: string | null; url: string | null }
    void supabase.from('task_attachments').select('id, file_name, storage_path, url').eq('task_id', requestId).then(({ data }: { data: Att[] | null }) => {
      if (gone) return
      setReqFiles((data ?? []).flatMap(a => {
        const path = resolveAttachmentPath(a)
        const name = a.file_name || path?.split('/').pop() || 'file'
        return path && /\.(pdf|jpe?g|png|webp|pptx|xlsx|xls|csv)$/i.test(name) ? [{ id: a.id, name, path }] : []
      }))
    })
    return () => { gone = true }
  }, [supabase, requestId])

  const take = (r: ImportResult, survey?: Survey | null) => {
    setRes(r)
    const p = survey?.project
    if (p) setInfo(i => ({
      client_name: i.client_name || p.name, project_name: i.project_name || [p.name, p.city].filter(Boolean).join(', '),
      supply_state: i.supply_state || (SUPPLY_STATES.find(x => x.toLowerCase() === p.state.toLowerCase()) ?? ''), project_type: i.project_type || p.venue,
    }))
    setViewPage(r.pages?.[0]?.n ?? null)
  }
  const readFiles = async (files: File[]) => {
    if (!files.length) return
    setBusy('reading'); setErr(''); setReload(false); setProgress(null)
    try { const r = await readImportFiles(supabase, files, setProgress); take(r, r.survey) }
    catch (e) { const f = readFailure(e, 'Could not read the file.'); setErr(f.text); setReload(f.reload) }
    finally { setBusy(''); setProgress(null) }
  }
  const readRequestFiles = async () => {
    if (!reqFiles?.length) return
    setBusy('reading'); setErr('')
    try {
      const files = await Promise.all(reqFiles.map(async f => {
        const url = await signAttachmentUrl(supabase, f.path)
        if (!url) throw new Error(`${f.name} could not be opened. Download it from the request and choose it here.`)
        const blob = await (await fetch(url)).blob()
        return new File([blob], f.name, { type: blob.type })
      }))
      await readFiles(files)
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not open the request\'s files.'); setBusy('') }
  }

  const upd = (id: string, patch: Partial<ImportRow>) =>
    setRows(p => p.map(r => (r.id === id ? { ...r, ...patch, doubtful: r.doubtful.filter(f => !(f in patch)) as ImportField[] } : r)))

  const kept = rows?.filter(r => r.include && r.name.trim()) ?? []
  // Pictures no kept row uses: the spare ones the salesperson can still put on a product.
  const used = new Set(kept.flatMap(r => [r.picture, ...(r.extras ?? []).map(e => e.picture)]).filter((i): i is number => i !== null))
  const spare = urls.map((_, i) => i).filter(i => !used.has(i))

  const add = async () => {
    if (start && !info.client_name.trim()) { setErr('Enter the client’s name.'); return }
    setBusy('adding'); setErr('')
    try {
      const pics = res?.pictures ?? []
      const jobs = [...new Set(kept.flatMap(r => [r.picture, ...(r.extras ?? []).map(e => e.picture)]).filter((i): i is number => i !== null && !!pics[i]))]
      const stored = new Map<number, string>()
      let n = 0
      const queue = [...jobs]
      await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
        for (let i = queue.shift(); i !== undefined; i = queue.shift()) { stored.set(i, await uploadPicture(supabase, userId, pics[i])); setAdding(`Saving pictures ${++n} of ${jobs.length}…`) }
      }))
      const paths = new Map<string, string>()
      const refs = new Map<string, LineRef[]>()
      for (const r of kept) {
        if (r.picture !== null && stored.has(r.picture)) paths.set(r.id, stored.get(r.picture)!)
        const x = (r.extras ?? []).flatMap(e => (stored.has(e.picture) ? [{ path: stored.get(e.picture)!, kind: e.kind, ...(e.note ? { note: e.note.slice(0, 200) } : {}) }] : [])).slice(0, MAX_LINE_REFS)
        if (x.length) refs.set(r.id, x)
      }
      const out = addToQuote(kept, areas, paths, refs)
      await onAdd(out.areas, out.lines, info)
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not add the rows.'); setBusy(''); setAdding('') }
  }
  const doubt = (r: ImportRow, f: ImportField) => (r.doubtful.includes(f) ? s.doubt : '')
  const pickFor = rows?.find(r => r.id === picking)
  const scanned = !!res?.pages?.length
  const pct = progress ? Math.round((progress.done / Math.max(1, progress.total)) * 100) : 0
  const title = start ? 'Start from a client file' : 'Import client file'

  return (
    <>
    <div className={s.scrim} onClick={busy || res ? undefined : onClose}>
      <div className={s.modal} style={{ maxWidth: rows ? 1400 : 640 }} onClick={e => e.stopPropagation()} role="dialog" aria-labelledby="imp-title">
        <div className={s.cardHead}><h2 id="imp-title">{title}</h2><span className={s.spacer} /><button type="button" className={s.iconBtn} onClick={onClose} disabled={!!busy} aria-label="Close">×</button></div>
        <div className={s.cardBody} style={{ display: 'grid', gap: 12 }}>
          {!rows && (
            <>
              <div className={s.small}>Any file the client sent: a PDF (schedule, docket, drawings, presentation), photos, a PowerPoint, or Excel. Choose several at once if they came separately. Each page is turned into a picture on this device and read by the AI reader; the file itself is not kept. A BOE PI&apos;s prices come across from Excel; a client&apos;s file brings no prices.</div>
              {!!reqFiles?.length && (
                <div className={s.scanPool}>
                  <b className={s.small}>Files attached to the quotation request</b>
                  <div className={s.small}>{reqFiles.map(f => f.name).join(' · ')}</div>
                  <button type="button" className={`${s.btn} ${s.btnPrimary}`} style={{ justifySelf: 'start' }} disabled={!!busy} onClick={readRequestFiles}>Read {reqFiles.length === 1 ? 'this file' : `these ${reqFiles.length} files`}</button>
                </div>
              )}
              <label className={`${s.btn} ${reqFiles?.length ? '' : s.btnPrimary}`} style={{ justifySelf: 'start', cursor: busy ? 'wait' : 'pointer' }}>
                <FileUp size={15} aria-hidden /> {busy === 'reading' ? 'Reading…' : 'Choose files (PDF, photos, PowerPoint, Excel)'}
                <input type="file" multiple accept={IMPORT_ACCEPT} hidden disabled={!!busy} onChange={e => { void readFiles(Array.from(e.target.files ?? [])); e.target.value = '' }} />
              </label>
              {busy === 'reading' && (
                <div role="status" aria-live="polite" style={{ display: 'grid', gap: 6 }}>
                  <div className={s.small}>{progress ? `${STAGE[progress.stage]}… ${progress.stage === 'survey' ? '' : `${progress.done} of ${progress.total}`}` : 'Opening the file…'} A file of 30 pages takes about two minutes; keep this window open.</div>
                  <div className={s.scanBar}><span style={{ width: `${progress?.stage === 'survey' ? 50 : pct}%` }} /></div>
                </div>
              )}
              <label className={s.field}><span>…or paste rows copied from Excel or a message</span>
                <textarea id="imp-paste" className={s.input} style={{ height: 'auto', padding: 8 }} rows={5} value={pasted} onChange={e => setPasted(e.target.value)} placeholder={'Description\tSize\tQty\nKing bed\t6\'0" x 6\'6"\t56'} disabled={!!busy} /></label>
              <button type="button" className={s.btn} style={{ justifySelf: 'start' }} disabled={!!busy || !pasted.trim()} onClick={() => take(readPastedText(pasted))}>Read pasted rows</button>
            </>
          )}
          {rows && (
            <>
              <div className={s.small}>{res?.note} {rows.length} found. <b>Shaded cells</b> are the ones to check. Untick anything that is not furniture you supply. Tap a page number to see the page.</div>
              {start && (
                <div className={s.grid2}>
                  <label className={s.field}><span>Client *</span><input className={s.input} value={info.client_name} onChange={e => setInfo({ ...info, client_name: e.target.value })} placeholder="Who the quotation is for" /></label>
                  <label className={s.field}><span>Project</span><input className={s.input} value={info.project_name} onChange={e => setInfo({ ...info, project_name: e.target.value })} /></label>
                  <label className={s.field}><span>Delivery state (decides CGST + SGST or IGST)</span><input className={s.input} list="imp-states" value={info.supply_state} onChange={e => setInfo({ ...info, supply_state: e.target.value })} /><datalist id="imp-states">{SUPPLY_STATES.map(x => <option key={x} value={x} />)}</datalist></label>
                </div>
              )}
              {pickFor && (
                <div className={s.scanPool}>
                  <div className={s.small}><b>Choose the picture for {pickFor.name}</b>{spare.length ? ' (pictures on no product first)' : ''}</div>
                  <div className={s.scanPics}>
                    {[...spare, ...urls.map((_, i) => i).filter(i => !spare.includes(i))].map(i => (
                      <button key={i} type="button" className={s.scanPick} onClick={() => { upd(pickFor.id, { picture: i }); setPicking(null) }} aria-label={`Use picture ${i + 1}`}><Pic src={urls[i]} alt="" className={s.thumb} /></button>
                    ))}
                  </div>
                  <span style={{ display: 'flex', gap: 8 }}>
                    <button type="button" className={`${s.btn} ${s.btnSm}`} onClick={() => { upd(pickFor.id, { picture: null }); setPicking(null) }}>No picture</button>
                    <button type="button" className={`${s.btn} ${s.btnSm}`} onClick={() => setPicking(null)}>Cancel</button>
                  </span>
                </div>
              )}
              {rows.length > 0 && (
                <div className={`${s.scanSplit} ${scanned && viewPage ? s.withPage : ''}`}>
                  <div className={s.tableWrap} style={{ maxHeight: '60vh', overflow: 'auto' }}>
                    <table className={`${s.table} ${s.importTable}`}>
                      <thead><tr><th><input type="checkbox" aria-label="Keep all" checked={rows.every(r => r.include)} onChange={e => setRows(p => p.map(r => ({ ...r, include: e.target.checked })))} /></th>
                        <th>Picture</th><th>Room / area</th><th>Rooms</th><th>Product</th><th>Size</th><th>Material</th><th>Qty</th><th></th>{rows.some(r => r.price !== null) && <th>Price ₹</th>}<th>From</th></tr></thead>
                      <tbody>
                        {rows.map(r => (
                          <tr key={r.id} style={{ opacity: r.include ? 1 : 0.45, cursor: 'default' }}>
                            <td><input type="checkbox" aria-label={`Keep ${r.name}`} checked={r.include} onChange={e => upd(r.id, { include: e.target.checked })} /></td>
                            <td>
                              <div className={s.scanPics}>
                                <span className={s.plRef}>
                                  <button type="button" className={s.scanPick} onClick={() => setPicking(r.id)} aria-label={`Change the picture of ${r.name}`} title="Change the picture">
                                    {r.picture !== null && urls[r.picture] ? <Pic src={urls[r.picture]} alt="" className={s.thumb} /> : <span className={s.thumbEmpty}>+</span>}
                                  </button>
                                  {r.picture !== null && urls[r.picture] && <button type="button" className={s.improve} onClick={() => setCropping(r.picture)} aria-label={`Crop the picture of ${r.name}`}>Crop</button>}
                                </span>
                                {(r.extras ?? []).map((x, j) => urls[x.picture] && (
                                  <span key={j} className={s.plRef} title={[REF_LABEL[x.kind], x.note].filter(Boolean).join(': ')}>
                                    <button type="button" className={s.scanPick} onClick={() => setCropping(x.picture)} aria-label={`Crop this ${REF_LABEL[x.kind].toLowerCase()}`} title="Crop">
                                      <Pic src={urls[x.picture]} alt={REF_LABEL[x.kind]} className={s.plRefImg} />
                                    </button>
                                    <span className={s.plRefKind}>{REF_LABEL[x.kind]}</span>
                                    <button type="button" className={s.plRefRm} aria-label={`Remove this ${REF_LABEL[x.kind].toLowerCase()}`} onClick={() => upd(r.id, { extras: r.extras!.filter((_, k) => k !== j) })}>×</button>
                                  </span>
                                ))}
                              </div>
                            </td>
                            <td><input className={`${s.input} ${doubt(r, 'room')}`} value={r.room} onChange={e => upd(r.id, { room: e.target.value })} aria-label="Room or area" /></td>
                            <td><input className={s.input} style={{ width: 64, minWidth: 64 }} inputMode="numeric" value={r.rooms ?? ''} onChange={e => upd(r.id, { rooms: Number(e.target.value) || null })} aria-label="Rooms" /></td>
                            <td>
                              <input className={`${s.input} ${doubt(r, 'name')}`} style={{ minWidth: 200 }} value={r.name} onChange={e => upd(r.id, { name: e.target.value })} aria-label="Product" />
                              {r.fromPicture && <div className={s.scanWants}>Seen in a room picture: confirm with the client</div>}
                              {(r.wanted || !!r.changes?.length) && <div className={s.scanWants}>Client wants: {[r.wanted, ...(r.changes ?? [])].filter(Boolean).join('; ')}</div>}
                              {r.optional && <label className={s.small} style={{ display: 'flex', gap: 4, alignItems: 'center', marginTop: 3 }}><input type="checkbox" checked onChange={() => upd(r.id, { optional: false })} /> Option (added as optional)</label>}
                            </td>
                            <td><input className={`${s.input} ${doubt(r, 'size')}`} value={r.size} onChange={e => upd(r.id, { size: e.target.value })} aria-label="Size" /></td>
                            <td><input className={`${s.input} ${doubt(r, 'material')}`} value={r.material} onChange={e => upd(r.id, { material: e.target.value })} aria-label="Material" /></td>
                            <td><input className={`${s.input} ${doubt(r, 'qty')}`} style={{ width: 70, minWidth: 70 }} inputMode="decimal" value={r.qty ?? ''} onChange={e => upd(r.id, { qty: Number(e.target.value) || null })} aria-label="Quantity" title={r.internalNote || undefined} /></td>
                            <td><select className={s.input} style={{ minWidth: 96 }} value={r.qtyMode} onChange={e => upd(r.id, { qtyMode: e.target.value as ImportRow['qtyMode'], doubtful: r.doubtful })} aria-label="Quantity is"><option value="per_unit">per room</option><option value="fixed">in total</option></select></td>
                            {rows.some(x => x.price !== null) && <td><input className={`${s.input} ${doubt(r, 'price')}`} title={r.doubtful.includes('price') ? (r.price === null ? 'No price in the file for this product' : 'Read from a column headed only "Price" or "Rate": check it is BOE\'s price, not the client\'s') : undefined} style={{ width: 96, minWidth: 96 }} inputMode="numeric" value={r.price ?? ''} onChange={e => upd(r.id, { price: priceOf(e.target.value) })} aria-label="Price, rupees before GST" /></td>}
                            <td className={s.muted} style={{ whiteSpace: 'nowrap' }}>
                              {r.page && pageUrls.has(r.page) ? <button type="button" className={s.improve} onClick={() => setViewPage(r.page!)}>{r.source}</button> : r.source}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {scanned && viewPage && pageUrls.has(viewPage) && (
                    <aside className={s.scanPage} aria-label="Page of the client's file">
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span className={s.small} style={{ flex: 1 }}>{res!.pages!.find(p => p.n === viewPage)?.label}</span>
                        <button type="button" className={`${s.btn} ${s.btnSm}`} disabled={viewPage <= 1} onClick={() => setViewPage(viewPage - 1)} aria-label="Previous page">‹</button>
                        <button type="button" className={`${s.btn} ${s.btnSm}`} disabled={!pageUrls.has(viewPage + 1)} onClick={() => setViewPage(viewPage + 1)} aria-label="Next page">›</button>
                      </span>
                      <a href={pageUrls.get(viewPage)} target="_blank" rel="noreferrer"><Pic src={pageUrls.get(viewPage)!} alt={`Page ${viewPage}`} /></a>
                    </aside>
                  )}
                </div>
              )}
              {spare.length > 0 && !pickFor && <div className={s.small}>{spare.length} picture{spare.length === 1 ? ' is' : 's are'} on no product. Tap a product&apos;s picture to choose one of them.</div>}
            </>
          )}
          {err && <div className={`${s.notice} ${s.noticeBad}`} role="alert">{err}{reload && <div style={{ marginTop: 8 }}><button type="button" className={`${s.btn} ${s.btnSm}`} onClick={() => window.location.reload()}>Reload page</button></div>}</div>}
        </div>
        <div className={s.cardHead} style={{ borderTop: '1px solid var(--boe-border)', borderBottom: 0, justifyContent: 'flex-end' }}>
          {adding && <span className={s.small} style={{ marginRight: 'auto' }} role="status">{adding}</span>}
          {rows && <button type="button" className={s.btn} disabled={!!busy} onClick={() => { setRes(null); setPicking(null) }}>Start over</button>}
          <button type="button" className={s.btn} onClick={onClose} disabled={!!busy}>Cancel</button>
          {rows && <button type="button" className={`${s.btn} ${s.btnPrimary}`} disabled={!!busy || kept.length === 0} onClick={add}>
            {busy === 'adding' ? (start ? 'Starting…' : 'Adding…') : start ? `Start quotation with ${kept.length} product${kept.length === 1 ? '' : 's'}` : `Add ${kept.length} product${kept.length === 1 ? '' : 's'}`}</button>}
        </div>
      </div>
    </div>
    {/* Beside the review, not inside its backdrop: a click there must never close the review and lose its rows. */}
    {cropping !== null && res?.pictures[cropping] && (
      <CropDialog src={urls[cropping]} onClose={() => setCropping(null)}
        onUse={b => { const at = cropping; setRes(p => p && { ...p, pictures: p.pictures.map((x, i) => (i === at ? b : x)) }); setCropping(null) }} />
    )}
    </>
  )
}
