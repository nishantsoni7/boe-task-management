'use client'

// On a quotation line: tell the line which submitted training case it is by picking its photo, and see that case's
// price (in the line's wood when the wood rates allow). Owner, 16 Nov 2026: the taught price leads, it never fills
// itself, and only people with Pricing see what the price is made of (the database sends `lines` to them alone).

import { useState } from 'react'
import { formatINR } from '@/lib/currency'
import { useDialogFocus } from '@/components/salesLeads/useDialogFocus'
import { KIND_LABEL, type Kind } from '@/lib/pricing/training/doc'
import { adjustment, borrowable, byLikeness, readPick, sameElement, taughtPrice, withPick, writePick, type Library, type LineWords, type LinePick, type TaughtCase } from '@/lib/pricing/training/match'
import t from './training.module.css'

export function TaughtPrice({ library, photo, line, note, price, editable, onNote, onUse }: {
  library: Library; photo: (path: string) => string; line: LineWords; note: string | null | undefined
  price: number | null; editable: boolean; onNote: (note: string) => void; onUse: (p: number) => void
}) {
  const [picking, setPicking] = useState(false)
  const [adjusting, setAdjusting] = useState(false)
  const pick = readPick(note)
  const no = pick?.caseNo ?? null
  const c = no === null ? null : library.cases.find(x => x.case_no === no) ?? null
  if (no === null && (!editable || library.cases.length === 0)) return null
  const base = c ? taughtPrice(c, line, library.woods) : null
  // Owner, 16 Nov 2026: "this one is different". Leaving out or adding an element moves the price by that element's
  // amount; the structure, overhead and margin stay as taught.
  const adj = c && pick ? adjustment(c, pick, library.cases) : null
  const p = base && adj ? { ...base, price: base.price + adj.delta } : null
  const differs = !!adj && (adj.without.length > 0 || adj.with.length > 0)

  return (
    <div className={t.taught}>
      {no === null && <button type="button" className={t.taughtLink} onClick={() => setPicking(true)} aria-haspopup="dialog">Pick a taught product</button>}
      {no !== null && !c && <span>Taught product #{no} has no submitted price right now (it is being changed in Pricing → Training).</span>}
      {c && p && (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element -- a stored product photo, shown as it is */}
          {c.image_path && <img className={t.thumb} src={photo(c.image_path)} alt="" />}
          <span className={t.taughtText}>
            <span>{differs ? 'Taught price, adjusted' : 'Taught price'} <b>{formatINR(p.price)}</b>{p.wood ? ` in ${p.wood}` : ''}</span>
            <span className={t.muted}>
              #{c.case_no} {c.name}
              {adj && adj.without.length > 0 && <> · without {adj.without.map(x => x.element).join(', ')}</>}
              {adj && adj.with.length > 0 && <> · with {adj.with.map(x => `${x.part.element} (#${x.from.case_no})`).join(', ')}</>}
              {adj && adj.lost.length > 0 && <> · no longer taught, so not counted: {adj.lost.join(', ')}</>}
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
          {c?.parts && <button type="button" className={t.taughtLink} onClick={() => setAdjusting(true)} aria-haspopup="dialog">This one is different</button>}
          <button type="button" className={t.taughtLink} onClick={() => setPicking(true)} aria-haspopup="dialog">Change</button>
          <button type="button" className={t.taughtLink} onClick={() => onNote(withPick(note, null))}>Remove</button>
        </span>
      )}
      {picking && <Picker cases={byLikeness(library.cases, line, library.woods)} photo={photo} picked={no}
        onPick={x => { onNote(withPick(note, x.case_no)); setPicking(false) }} onClose={() => setPicking(false)} />}
      {adjusting && c && pick && <Differences c={c} pick={pick} cases={library.cases} onPick={x => onNote(writePick(note, x))} onClose={() => setAdjusting(false)} />}
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

/** The tick list behind "This one is different". Amounts are shown only to people the database sent the elements to. */
function Differences({ c, pick, cases, onPick, onClose }: { c: TaughtCase; pick: LinePick; cases: TaughtCase[]; onPick: (p: LinePick) => void; onClose: () => void }) {
  const sheet = useDialogFocus<HTMLDivElement>(onClose)
  const amounts = !!c.lines
  const others = borrowable(c, cases)
  const out = (e: string) => pick.without.some(x => sameElement(x, e))
  const added = (no: number, e: string) => pick.with.some(x => x.caseNo === no && sameElement(x.element, e))
  return (
    <div className="boe-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="taught-diff-title" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="boe-modal-sheet" ref={sheet} tabIndex={-1}>
        <div className="boe-modal-header">
          <h2 id="taught-diff-title" className={t.pickTitle}>How is this one different?</h2>
          <p className={t.muted} style={{ margin: '2px 0 0' }}>From #{c.case_no} {c.name}. The wooden structure, overhead and margin stay as taught.</p>
        </div>
        <div className="boe-modal-body">
          <fieldset className={t.diffSet}>
            <legend>It has (untick to leave out)</legend>
            {(c.parts ?? []).length === 0 && <span className={t.muted}>This case has no element that can be left out.</span>}
            {(c.parts ?? []).map((p, i) => (
              <label key={i} className={t.diffRow}>
                <input type="checkbox" checked={!out(p.element)} onChange={() => onPick({ ...pick, without: out(p.element) ? pick.without.filter(x => !sameElement(x, p.element)) : [...pick.without, p.element] })} />
                <span>{p.element}</span>{amounts && <span className={t.muted}>{formatINR(Number(p.amount))}</span>}
              </label>
            ))}
          </fieldset>
          <fieldset className={t.diffSet}>
            <legend>Add from another taught product</legend>
            {others.length === 0 && <span className={t.muted}>Nothing to add yet. Elements appear here as more products are submitted in Pricing → Training.</span>}
            {others.map(({ from, part }, i) => (
              <label key={i} className={t.diffRow}>
                <input type="checkbox" checked={added(from.case_no, part.element)} onChange={() => onPick({ ...pick, with: added(from.case_no, part.element) ? pick.with.filter(x => !(x.caseNo === from.case_no && sameElement(x.element, part.element))) : [...pick.with, { caseNo: from.case_no, element: part.element }] })} />
                <span>{part.element} <span className={t.muted}>from #{from.case_no} {from.name}</span></span>{amounts && <span className={t.muted}>{formatINR(Number(part.amount))}</span>}
              </label>
            ))}
          </fieldset>
          <button type="button" className="boe-btn boe-btn-primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}
