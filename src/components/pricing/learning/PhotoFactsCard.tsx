'use client'

// Price learning: photo facts (Price Brain v2, phase 3B). Every product photo BOE One holds is read once into facts from a
// fixed list, five at a time, and any reading can be corrected. Phase 3C's engine uses the facts to tell products apart.
// Reading needs Pricing create (the server and the database both check); the facts never carry a price.

import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { createClient } from '@/lib/supabase/client'
import { FACT_KEYS, FACT_LABEL, FACT_VALUES, factText, type Facts } from '@/lib/pricing/photoFacts'
import { correctPhotoFact, fetchPhotoFacts, fetchPhotoQueue, photoKeys, publicPhoto, readPhotos, type PhotoFactRow } from '@/lib/pricing/photoFactsApi'
import s from '@/components/quotations/quotations.module.css'
import l from './learning.module.css'

type Supabase = ReturnType<typeof createClient>
const SHOWN = 24

export function PhotoFactsCard({ supabase }: { supabase: Supabase }) {
  const qc = useQueryClient()
  const queue = useQuery({ queryKey: photoKeys.queue, queryFn: () => fetchPhotoQueue(supabase, 5), retry: false })
  const list = useQuery({ queryKey: photoKeys.list, queryFn: () => fetchPhotoFacts(supabase), retry: false })
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [skipped, setSkipped] = useState<string[]>([])
  const stop = useRef(false)

  // Five at a time until none is waiting, a call fails, or the person stops. A photo that cannot be read is skipped.
  async function readAll() {
    setError(''); setRunning(true); stop.current = false
    const skip = new Set(skipped)
    try {
      for (let round = 0; round < 100 && !stop.current; round++) {
        const q = await fetchPhotoQueue(supabase, 5 + skip.size)
        const next = q.waiting.filter(w => !skip.has(w.key)).slice(0, 5)
        if (next.length === 0) break
        const results = await readPhotos(supabase, next.map(w => ({ key: w.key, label: w.label })))
        results.forEach(r => { if (!r.ok) skip.add(r.key) })
        setSkipped([...skip])
        await Promise.all([qc.invalidateQueries({ queryKey: photoKeys.queue }), qc.invalidateQueries({ queryKey: photoKeys.list })])
      }
    } catch (e) { setError((e as Error).message) } finally { setRunning(false) }
  }

  const err = (queue.error ?? list.error) as Error | null
  const q = queue.data
  return (
    <section className={s.card} aria-labelledby="photos-h">
      <div className={s.cardHead}>
        <h2 id="photos-h">Photo facts</h2>
        {q && <span className={s.chip}>{q.read} of {q.total} read</span>}
        <span className={s.spacer} />
        {q && q.read < q.total && (running
          ? <button type="button" className={`${s.btn} ${s.btnSm}`} onClick={() => { stop.current = true }}>Stop after these</button>
          : <button type="button" className={`${s.btn} ${s.btnPrimary} ${s.btnSm}`} onClick={readAll}>Read the {q.total - q.read} waiting</button>)}
      </div>
      <div className={s.cardBody} style={{ display: 'grid', gap: 10 }}>
        <p className={`${s.small} ${s.muted}`} style={{ margin: 0 }}>Each product photo (quotation lines, approved PIs, Training cases) is read once into facts: what the product is, arms, back, seat, base, top, metal, carving. The next price engine uses them to tell one chair from another. Correct any reading that is wrong; a correction is never read over.</p>
        {err && <div className={`${s.notice} ${s.noticeWarn}`}>{err.message}</div>}
        {error && <div className={`${s.notice} ${s.noticeBad}`} role="alert">{error}</div>}
        {running && <div className={s.muted} role="status">Reading photos, five at a time…</div>}
        {skipped.length > 0 && <div className={`${s.small} ${s.muted}`}>{skipped.length} photo{skipped.length === 1 ? '' : 's'} could not be read (too large, or not a picture) and {skipped.length === 1 ? 'was' : 'were'} skipped.</div>}
        {list.data && list.data.length > 0 && (
          <div className={l.photoGrid}>
            {list.data.slice(0, SHOWN).map(r => <FactRow key={r.key} r={r} supabase={supabase} onSaved={() => qc.invalidateQueries({ queryKey: photoKeys.list })} />)}
          </div>
        )}
        {list.data && list.data.length > SHOWN && <div className={`${s.small} ${s.muted}`}>The newest {SHOWN} of {list.data.length} readings are shown.</div>}
      </div>
    </section>
  )
}

function FactRow({ r, supabase, onSaved }: { r: PhotoFactRow; supabase: Supabase; onSaved: () => void }) {
  const [edit, setEdit] = useState<Facts | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const src = publicPhoto(supabase, r.key)
  const shown = FACT_KEYS.filter(k => !['unknown', 'none', 'no'].includes(r.facts[k]))
  async function save() {
    if (!edit) return
    setBusy(true); setError('')
    try { await correctPhotoFact(supabase, r.key, edit); setEdit(null); onSaved() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <div className={l.photoRow}>
      {/* eslint-disable-next-line @next/next/no-img-element -- a stored product photo, shown as it is */}
      {src ? <img className={l.ibPhoto} src={src} alt={r.label ?? 'Product photo'} loading="lazy" /> : <span className={`${l.ibPhoto} ${l.photoPi}`}>PI photo</span>}
      <div style={{ minWidth: 0, display: 'grid', gap: 4 }}>
        <div><b>{r.label ?? 'A product'}</b> {r.corrected && <span className={s.chip}>corrected</span>} <span className={`${s.small} ${s.muted}`}>{r.facts.confidence}% sure</span></div>
        {!edit && <div className={l.factChips}>{shown.map(k => <span key={k} className={s.chip}>{FACT_LABEL[k]}: {factText(k, r.facts[k])}</span>)}</div>}
        {!edit && r.facts.note && <small className={s.muted}>{r.facts.note}</small>}
        {edit && (
          <div className={l.factEdit}>
            {FACT_KEYS.map(k => (
              <label key={k} className={s.field}><span>{FACT_LABEL[k]}</span>
                <select className={s.input} value={edit[k]} onChange={e => setEdit({ ...edit, [k]: e.target.value })}>
                  {FACT_VALUES[k].map(v => <option key={v} value={v}>{factText(k, v)}</option>)}
                </select>
              </label>
            ))}
          </div>
        )}
        {error && <div className={`${s.notice} ${s.noticeBad}`}>{error}</div>}
        <div>
          {edit
            ? <><button type="button" className={`${s.btn} ${s.btnPrimary} ${s.btnSm}`} disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save the correction'}</button> <button type="button" className={`${s.btn} ${s.btnSm}`} onClick={() => setEdit(null)}>Cancel</button></>
            : <button type="button" className={s.linkBtn} onClick={() => setEdit({ ...r.facts })}>Correct</button>}
        </div>
      </div>
    </div>
  )
}
