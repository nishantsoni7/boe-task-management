'use client'

// Price learning, step 1: choose up to 25 PI files. Each is read here, in the browser, and shown with what was found.

import { useRef, useState } from 'react'
import { Upload, X } from 'lucide-react'
import { formatINR } from '@/lib/currency'
import { BATCH_FILE_MAX } from '@/lib/pricing/learning/batch'
import { PI_ACCEPT, type PiFile } from '@/lib/pricing/learning/piFile'
import { orderFacts, subtotalMatches } from '@/lib/pricing/learning/readPi'
import type { SeenBefore } from '@/lib/pricing/learning/batch'
import { CLIENT_TYPES } from '@/lib/quotations/api'
import { dateIN } from './common'
import s from '@/components/quotations/quotations.module.css'
import l from './learning.module.css'

export type Progress = { done: number; total: number } | null

function result(f: PiFile, seen: SeenBefore | undefined): { cls: string; text: string; sub?: string } {
  if (seen) return { cls: s.st_draft, text: `Already ${seen.left_out ? 'seen' : 'learned'} (batch ${seen.batch_no})` }
  const v = f.verdict
  if (v.status === 'left_out') return { cls: s.st_lost, text: 'Left out', sub: v.reasons[0] }
  if (v.status === 'check') return { cls: s.st_negotiating, text: v.toCheck === 1 ? '1 thing to check' : `${v.toCheck} things to check`, sub: v.reasons.join(' · ') }
  return { cls: s.st_confirmed, text: subtotalMatches(f.reading) ? 'Read · totals match' : 'Read' }
}

export function StepFiles({ files, seen, progress, error, clientType, onClientType, onAdd, onRemove, onNext }: {
  files: PiFile[]; seen: SeenBefore[]; progress: Progress; error: string | null
  clientType: string; onClientType: (v: string) => void
  onAdd: (list: File[]) => void; onRemove: (i: number) => void; onNext: () => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const [all, setAll] = useState(false)
  const busy = progress !== null
  const seenOf = (f: PiFile) => seen.find(x => x.file_hash === f.fileHash || (f.reading.lines.length > 0 && x.content_print === f.contentPrint))
  const ready = files.filter(f => f.verdict.status !== 'left_out' && !seenOf(f)).length
  const checks = files.filter(f => f.verdict.status === 'check' && !seenOf(f)).length
  const out = files.length - ready
  const shown = all ? files : files.slice(0, 10)
  const pick = (list: FileList | null) => { if (list && list.length) onAdd([...list]) }
  return (
    <div className={l.two}>
      <div style={{ display: 'grid', gap: 16, minWidth: 0 }}>
        <div className={`${l.drop} ${over ? l.dropOn : ''}`} onDragOver={e => { e.preventDefault(); setOver(true) }} onDragLeave={() => setOver(false)}
          onDrop={e => { e.preventDefault(); setOver(false); if (!busy) pick(e.dataTransfer.files) }}>
          <span className={l.dropIc}><Upload size={22} aria-hidden /></span>
          <div style={{ flex: 1, minWidth: 220 }}>
            <b style={{ fontSize: 15 }}>{files.length === 0 ? `Drop up to ${BATCH_FILE_MAX} PI files here` : `${files.length} of ${BATCH_FILE_MAX} files added`}</b>
            <div className={`${s.small} ${s.muted}`}>Excel files (.xlsx or .xls). A batch holds {BATCH_FILE_MAX} at most so every file stays easy to check. The files are read on this computer.</div>
          </div>
          <button type="button" className={`${s.btn} ${files.length === 0 ? s.btnPrimary : ''}`} disabled={busy || files.length >= BATCH_FILE_MAX} onClick={() => input.current?.click()}>Choose files</button>
          <input ref={input} type="file" accept={PI_ACCEPT} multiple hidden onChange={e => { pick(e.target.files); e.target.value = '' }} />
        </div>
        {progress && <div className={s.notice} role="status">Reading file {Math.min(progress.done + 1, progress.total)} of {progress.total}…</div>}
        {error && <div className={`${s.notice} ${s.noticeBad}`} role="alert">{error}</div>}

        {files.length > 0 && (
          <>
            <section className={s.card}>
              <div className={s.cardHead}><h2>Settings for this batch</h2></div>
              <div className={s.cardBody}>
                <label className={s.field} style={{ maxWidth: 360 }}><span>Client type</span>
                  <select className={s.input} value={clientType} onChange={e => onClientType(e.target.value)}>
                    <option value="">Not specified</option>
                    {CLIENT_TYPES.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                  </select>
                  <span className={`${s.small} ${s.muted}`} style={{ fontWeight: 400 }}>The files do not say. Leave it unspecified unless this whole batch is one kind of client; you can change it for each PI.</span>
                </label>
              </div>
            </section>
            <section className={s.card}>
              <div className={s.cardHead}><h2>Files</h2><span className={s.chip}>{files.length}</span></div>
              <div className={s.tableWrap}>
                <table className={s.table}>
                  <thead><tr><th>#</th><th>File</th><th>PI date</th><th className={s.right}>Lines</th><th className={s.right}>Pieces</th><th className={s.right}>Value before GST</th><th>Result</th><th /></tr></thead>
                  <tbody>{shown.map((f, i) => {
                    const r = result(f, seenOf(f))
                    const facts = orderFacts(f.reading.lines.filter(x => !x.sample), f.reading.footer.discount)
                    return (
                      <tr key={`${f.fileHash}${i}`} style={{ cursor: 'default' }}>
                        <td className={s.muted}>{i + 1}</td>
                        <td><div className={l.cellName}>{f.label}</div></td>
                        <td className={l.nw}>{f.reading.piDate ? dateIN(f.reading.piDate) : <span className={s.muted}>not found</span>}</td>
                        <td className={s.right}>{f.reading.lines.length}</td><td className={s.right}>{facts.pieces.toLocaleString('en-IN')}</td>
                        <td className={`${s.right} ${l.nw}`}>{f.reading.lines.length ? formatINR(facts.valueBeforeGst) : '–'}</td>
                        <td><span className={`${s.pill} ${r.cls}`}>{r.text}</span>{r.sub && <div className={l.cellSub} style={{ maxWidth: 300, whiteSpace: 'normal' }}>{r.sub}</div>}</td>
                        <td className={s.right}><button type="button" className={s.iconBtn} aria-label={`Remove ${f.label}`} disabled={busy} onClick={() => onRemove(files.indexOf(f))}><X size={15} aria-hidden /></button></td>
                      </tr>
                    )
                  })}</tbody>
                </table>
              </div>
              {files.length > 10 && <div className={l.tblNote}><span>{all ? `Showing all ${files.length} files` : `Showing 10 of ${files.length} files`}</span><button type="button" className={`${s.btn} ${s.btnSm}`} onClick={() => setAll(v => !v)}>{all ? 'Show first 10' : `Show all ${files.length}`}</button></div>}
            </section>
          </>
        )}
      </div>

      <div style={{ display: 'grid', gap: 12, minWidth: 0, position: 'sticky', top: 84 }}>
        <section className={s.card}>
          <div className={s.cardHead}><h2>What was read</h2></div>
          <div className={s.cardBody}>
            <div className={l.swrow}><div><b>{ready - checks} read cleanly</b><small>Ready to check and learn</small></div><span className={`${l.dot} ${l.dotOk}`} /></div>
            <div className={l.swrow}><div><b>{checks} need a look</b><small>A date, a Sub Total or an odd price</small></div><span className={`${l.dot} ${l.dotWarn}`} /></div>
            <div className={l.swrow}><div><b>{out} will not be learned</b><small>Already seen, in dollars, or no prices</small></div><span className={`${l.dot} ${l.dotIdle}`} /></div>
            <button type="button" className={`${s.btn} ${s.btnPrimary}`} style={{ width: '100%', marginTop: 14, minHeight: 44 }} disabled={busy || ready === 0} onClick={onNext}>Check what was read →</button>
            {files.length > 0 && ready === 0 && !busy && <div className={`${s.small} ${s.muted}`} style={{ marginTop: 8 }}>No file is ready to learn. Add other files, or see the reason beside each.</div>}
          </div>
        </section>
        <div className={s.notice}><b>Private.</b> The files are read on this computer and are not stored. BOE keeps each PI&apos;s file name (visible to the pricing desk only), its date, its products and its prices.</div>
      </div>
    </div>
  )
}
