'use client'

// On a quotation line: tell the line which submitted training case it is by picking its photo, and see that case's
// price (in the line's wood when the wood rates allow). Owner, 16 Nov 2026: the taught price leads, it never fills
// itself, and only people with Pricing see what the price is made of (the database sends `lines` to them alone).

import { useState } from 'react'
import { formatINR } from '@/lib/currency'
import { useDialogFocus } from '@/components/salesLeads/useDialogFocus'
import { KIND_LABEL, type Kind } from '@/lib/pricing/training/doc'
import { byLikeness, pickedCaseNo, taughtPrice, withPick, type Library, type LineWords, type TaughtCase } from '@/lib/pricing/training/match'
import t from './training.module.css'

export function TaughtPrice({ library, photo, line, note, price, editable, onNote, onUse }: {
  library: Library; photo: (path: string) => string; line: LineWords; note: string | null | undefined
  price: number | null; editable: boolean; onNote: (note: string) => void; onUse: (p: number) => void
}) {
  const [picking, setPicking] = useState(false)
  const no = pickedCaseNo(note)
  const c = no === null ? null : library.cases.find(x => x.case_no === no) ?? null
  if (no === null && (!editable || library.cases.length === 0)) return null
  const p = c ? taughtPrice(c, line, library.woods) : null

  return (
    <div className={t.taught}>
      {no === null && <button type="button" className={t.taughtLink} onClick={() => setPicking(true)} aria-haspopup="dialog">Pick a taught product</button>}
      {no !== null && !c && <span>Taught product #{no} has no submitted price right now (it is being changed in Pricing → Training).</span>}
      {c && p && (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element -- a stored product photo, shown as it is */}
          {c.image_path && <img className={t.thumb} src={photo(c.image_path)} alt="" />}
          <span className={t.taughtText}>
            <span>Taught price <b>{formatINR(p.price)}</b>{p.wood ? ` in ${p.wood}` : ''}</span>
            <span className={t.muted}>
              #{c.case_no} {c.name}
              {p.swapped && <> · taught at {formatINR(Number(c.total))} in {c.wood}</>}
              {p.noRate && <> · {c.wood_amount === null ? `the case has no wood share yet, so no ${p.noRate} price` : `no rate for ${p.noRate} or ${c.wood} yet, so no ${p.noRate} price`}</>}
            </span>
          </span>
          {editable && price !== p.price && <button type="button" className={t.taughtUse} onClick={() => onUse(p.price)}>Use</button>}
          {c.lines && (
            <details className={t.taughtWhy}>
              <summary>What it is made of</summary>
              {c.lines.map((l, i) => (
                <div key={i} className={t.taughtRow}><span>{l.element}{l.material ? ` (${l.material})` : ''} <span className={t.muted}>{KIND_LABEL[l.kind as Kind] ?? l.kind}</span></span><span>{formatINR(Number(l.amount))}</span></div>
              ))}
            </details>
          )}
        </>
      )}
      {no !== null && editable && (
        <span className={t.taughtActs}>
          <button type="button" className={t.taughtLink} onClick={() => setPicking(true)} aria-haspopup="dialog">Change</button>
          <button type="button" className={t.taughtLink} onClick={() => onNote(withPick(note, null))}>Remove</button>
        </span>
      )}
      {picking && <Picker cases={byLikeness(library.cases, line, library.woods)} photo={photo} picked={no}
        onPick={x => { onNote(withPick(note, x.case_no)); setPicking(false) }} onClose={() => setPicking(false)} />}
    </div>
  )
}

function Picker({ cases, photo, picked, onPick, onClose }: { cases: TaughtCase[]; photo: (path: string) => string; picked: number | null; onPick: (c: TaughtCase) => void; onClose: () => void }) {
  const sheet = useDialogFocus<HTMLDivElement>(onClose)
  return (
    <div className="boe-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="taught-pick-title" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="boe-modal-sheet" style={{ maxWidth: 720 }} ref={sheet} tabIndex={-1}>
        <div className="boe-modal-header">
          <h2 id="taught-pick-title" className={t.pickTitle}>Which taught product is this?</h2>
          <p className={t.muted} style={{ margin: '2px 0 0' }}>Only submitted cases from Pricing → Training are here.</p>
        </div>
        <div className="boe-modal-body">
          <div className={t.pickGrid}>
            {cases.map(c => (
              <button key={c.id} type="button" className={t.pickCard} aria-pressed={c.case_no === picked} onClick={() => onPick(c)}>
                {/* eslint-disable-next-line @next/next/no-img-element -- a stored product photo, shown as it is */}
                {c.image_path ? <img src={photo(c.image_path)} alt="" loading="lazy" /> : <span className={t.pickNoPhoto}>No photo</span>}
                <b>{c.name}</b>
                <span className={t.muted}>#{c.case_no} · {formatINR(Number(c.total))}{c.wood ? ` in ${c.wood}` : ''}</span>
              </button>
            ))}
          </div>
          <button type="button" className="boe-btn boe-btn-secondary" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  )
}
