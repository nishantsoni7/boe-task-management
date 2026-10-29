'use client'

// ── THE FABRIC & FINISH COST SHEET OF A PI (20270431000000) ──────────────────
//
// One component, drawn two ways: inside the slide-in panel over the PI Draft
// or Confirmed Order page (desktop), and as its own page (phone, or "Open as
// a page"). It is SELF-LOADING — one read (order_submission_fabric_finish_read)
// plus the product pictures — so the two record pages' counted startup reads
// do not move: nothing here runs until the sheet is opened.
//
// Two sections, as the owner asked (2026-10-29):
//   1. Fabric and packing costing per product: metres per piece, ₹ per metre,
//      packing ₹ per piece, packing type — from the workbook's "Packing cost
//      and Fabric Cost" sheet, typeable where the sheet left blanks. Totals
//      are quantity × those (fabricFinishCost.ts), compared with the PI's own
//      Fabric cost / Packing cost lines; "As applicable" when nothing is quoted.
//   2. Fabric and finish choices per product: the fabric code and the wood /
//      metal / marble finishes from the "Fabric and Finish" sheet, with a
//      reference picture that can be added here; a product with none reads
//      "No Fabric and Finish approval done".
//
// A typed value wins over the sheet's and is marked; the sheet's value stays
// visible as the field's placeholder. Every write goes through
// order_submission_fabric_finish_save_typed, which re-derives who may.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { formatInr } from '@/lib/pi/previewView'
import { ORDER_FILES_BUCKET } from '@/lib/orders/draftsView'
import {
  AS_APPLICABLE_TEXT,
  DEFAULT_FINISH_HEADINGS,
  FABRIC_FINISH_OPEN_LABEL,
  FABRIC_FINISH_TITLE,
  NO_FINISH_TEXT,
  SHEET_SOURCE_LABEL,
  TYPED_SOURCE_LABEL,
  compareWithPi,
  effective,
  effectiveFinish,
  finishIsDone,
  lineFigures,
  parseFabricFinishData,
  parseTypedFigure,
  sheetTotals,
  totalText,
  typedPayload,
  type Comparison,
  type FabricFinishData,
  type FabricFinishLine,
  type FinishEntry,
} from '@/lib/orders/fabricFinishCost'

export { FABRIC_FINISH_TITLE, FABRIC_FINISH_OPEN_LABEL }
export const FABRIC_FINISH_OPEN_PAGE_LABEL = 'Open as a page'
export const COSTING_SECTION_TITLE = 'Fabric and packing'
export const FINISH_SECTION_TITLE = 'Fabric and finish'
export const SAVE_LABEL = 'Save typed values'
export const BLANK_SOURCE_LABEL = 'Blank on sheet'
export const NOT_READ_NOTE = 'Not read from a workbook yet — type the values below.'
export const REVISION_NOTE =
  'Quantities are the PI in force. A revised quantity moves these totals at once; Edit PI then takes the Fabric cost and Packing cost lines from this sheet.'

const PICTURE_URL_TTL_SECONDS = 3600

type Draft = {
  metres: string
  price: string
  packing: string
  type: string
  finish: FinishEntry[]
}

const numText = (n: number | null | undefined) => (n === null || n === undefined ? '' : String(n))

function draftOf(line: FabricFinishLine): Draft {
  return {
    metres: numText(line.typed?.fabricMetresPerPiece),
    price: numText(line.typed?.fabricPricePerMetre),
    packing: numText(line.typed?.packingCostPerPiece),
    type: line.typed?.packingType ?? '',
    finish: (line.typed?.finish ?? []).map(f => ({ ...f })),
  }
}

const sameDraft = (a: Draft, b: Draft) => JSON.stringify(a) === JSON.stringify(b)

/** The line as the draft would save it, for live totals. A bad number counts as nothing. */
function lineWithDraft(line: FabricFinishLine, draft: Draft): FabricFinishLine {
  const safe = (text: string) => { const n = parseTypedFigure(text); return n === null || Number.isNaN(n) ? null : n }
  const finish = draft.finish.filter(f => f.heading.trim() !== '' && (f.value.trim() !== '' || f.imagePath))
  const anyTyped = draft.metres.trim() !== '' || draft.price.trim() !== '' || draft.packing.trim() !== '' || draft.type.trim() !== '' || finish.length > 0
  return {
    ...line,
    typed: anyTyped ? {
      fabricMetresPerPiece: safe(draft.metres),
      fabricPricePerMetre: safe(draft.price),
      packingCostPerPiece: safe(draft.packing),
      packingType: draft.type.trim() === '' ? null : draft.type.trim(),
      finish,
    } : null,
  }
}

function describeError(message: string): string {
  if (/FABRIC_FINISH_FORBIDDEN/.test(message)) return 'You do not have access to change this sheet.'
  if (/FABRIC_FINISH_LINE_NOT_ON_PI/.test(message)) return 'This product is no longer on the PI. Reload the page.'
  if (/FABRIC_FINISH_VALUE_INVALID/.test(message)) return 'Figures must be numbers of at least 0, with at most three decimals for metres and two for rupees.'
  if (/FABRIC_FINISH_IMAGE_INVALID/.test(message)) return 'A picture could not be attached. Add it again.'
  if (/FABRIC_FINISH_FINISH_INVALID/.test(message)) return 'A finish entry is too long or malformed.'
  return 'That could not be saved. Please try again.'
}

const showDate = (iso: string | null) => {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })
}

const money = (n: number | null) => (n === null ? '—' : formatInr(n))
const metresText = (n: number | null) => (n === null ? '—' : `${Math.round(n * 100) / 100} m`)

function ComparisonBox({ label, pi, c }: { label: string; pi: string; c: Comparison }) {
  return (
    <div className={'ff-match-box'}>
      {label} on the PI: <b>{pi}</b> · from this sheet: <b>{c.sheetAmount === null ? AS_APPLICABLE_TEXT : formatInr(c.sheetAmount)}</b>{' '}
      {c.state === 'matches' && <span className={'ff-ok'}>matches</span>}
      {c.state === 'differs' && c.difference !== null && (
        <span className={'ff-diff'}>differs by {formatInr(Math.abs(c.difference))}{c.difference > 0 ? ' more' : ' less'}</span>
      )}
      {c.state === 'unknown' && <span className={'ff-unknown'}>not yet known</span>}
    </div>
  )
}

function SourceChip({ line }: { line: FabricFinishLine }) {
  const typed = line.typed && (line.typed.fabricMetresPerPiece !== null || line.typed.fabricPricePerMetre !== null
    || line.typed.packingCostPerPiece !== null || line.typed.packingType !== null)
  if (typed) return <span className={`${'ff-chip'} ${'ff-chip-typed'}`}>{TYPED_SOURCE_LABEL}{line.typedByName ? ` · ${line.typedByName}` : ''}</span>
  if (line.sheet && (line.sheet.fabricMetresPerPiece !== null || line.sheet.fabricPricePerMetre !== null || line.sheet.packingCostPerPiece !== null)) {
    return <span className={`${'ff-chip'} ${'ff-chip-sheet'}`}>{SHEET_SOURCE_LABEL}</span>
  }
  return <span className={`${'ff-chip'} ${'ff-chip-blank'}`}>{BLANK_SOURCE_LABEL}</span>
}

export function FabricFinishSheet({ submissionId, variant, context, onClose, openAsPageHref }: {
  submissionId: string
  variant: 'page' | 'drawer'
  /** "Order 539 · Client" — whose sheet this is. */
  context: string
  onClose?: () => void
  openAsPageHref?: string
}) {
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const [data, setData] = useState<FabricFinishData | null | undefined>(undefined)
  const [unreadable, setUnreadable] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [urls, setUrls] = useState<Record<string, string>>({})
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({})

  const load = useCallback(async () => {
    const { data: raw, error } = await supabase.rpc('order_submission_fabric_finish_read', { p_submission_id: submissionId })
    if (error) { setUnreadable(true); return }
    const parsed = parseFabricFinishData(raw)
    setUnreadable(false)
    setData(parsed)
    if (parsed) setDrafts(Object.fromEntries(parsed.lines.map(l => [l.itemSequence, draftOf(l)])))
  }, [supabase, submissionId])

  useEffect(() => { void load() }, [load])

  // Product pictures and finish reference pictures: signed per object, under
  // the reader's own access. A picture the reader may not open simply has none.
  useEffect(() => {
    if (!data) return
    let live = true
    void (async () => {
      const { data: images } = await supabase.from('order_submission_item_images')
        .select('item_id, storage_path').eq('submission_id', submissionId).eq('role', 'representative')
        .order('position', { ascending: true })
      if (!live) return
      const pathByItem = new Map<string, string>()
      for (const m of (images ?? []) as { item_id: string; storage_path: string }[]) {
        if (!pathByItem.has(m.item_id)) pathByItem.set(m.item_id, m.storage_path)
      }
      const productPaths = data.lines.flatMap(l => (l.itemId && pathByItem.get(l.itemId) ? [[l.itemSequence, pathByItem.get(l.itemId) as string] as const] : []))
      const finishPaths = data.lines.flatMap(l => effectiveFinish(l).flatMap(f => (f.entry.imagePath ? [f.entry.imagePath] : [])))
      const all = [...new Set([...productPaths.map(p => p[1]), ...finishPaths])]
      if (all.length === 0) return
      const signed = await supabase.storage.from(ORDER_FILES_BUCKET).createSignedUrls(all, PICTURE_URL_TTL_SECONDS)
      if (!live || signed.error) return
      const byPath: Record<string, string> = {}
      for (const s of signed.data ?? []) if (s.path && s.signedUrl) byPath[s.path] = s.signedUrl
      const out: Record<string, string> = { ...byPath }
      for (const [seq, path] of productPaths) if (byPath[path]) out[`product:${seq}`] = byPath[path]
      setUrls(u => ({ ...u, ...out }))
    })()
    return () => { live = false }
  }, [supabase, submissionId, data])

  // ── Live figures from what is typed ──
  const live = useMemo(() => {
    if (!data) return null
    const lines = data.lines.map(l => lineWithDraft(l, drafts[l.itemSequence] ?? draftOf(l)))
    const totals = sheetTotals(lines)
    return {
      lines,
      totals,
      fabric: compareWithPi(data.piFabricCost, totals.fabric),
      packing: compareWithPi(data.piPackingCost, totals.packing),
    }
  }, [data, drafts])

  const dirtyKeys = useMemo(() => (data ? data.lines.filter(l => drafts[l.itemSequence] && !sameDraft(drafts[l.itemSequence], draftOf(l))).map(l => l.itemSequence) : []), [data, drafts])

  const headings = useMemo(() => {
    if (!data) return [] as string[]
    const seen: string[] = []
    const key = (h: string) => h.replace(/\s+/g, ' ').trim().toLowerCase()
    for (const l of data.lines) {
      for (const f of [...(l.sheet?.finish ?? []), ...(drafts[l.itemSequence]?.finish ?? l.typed?.finish ?? [])]) {
        if (!seen.some(s => key(s) === key(f.heading))) seen.push(f.heading.replace(/\s+/g, ' ').trim())
      }
    }
    return seen.length > 0 ? seen : [...DEFAULT_FINISH_HEADINGS]
  }, [data, drafts])

  const setDraft = (seq: string, patch: Partial<Draft>) => {
    setProblem(null)
    setDrafts(d => ({ ...d, [seq]: { ...(d[seq] ?? { metres: '', price: '', packing: '', type: '', finish: [] }), ...patch } }))
  }
  const setFinishValue = (seq: string, heading: string, value: string) => {
    const draft = drafts[seq] ?? { metres: '', price: '', packing: '', type: '', finish: [] }
    const key = (h: string) => h.replace(/\s+/g, ' ').trim().toLowerCase()
    const existing = draft.finish.find(f => key(f.heading) === key(heading))
    const finish = existing
      ? draft.finish.map(f => (f === existing ? { ...f, value } : f))
      : [...draft.finish, { heading, value, imagePath: null, imageSha256: null }]
    setDraft(seq, { finish })
  }
  const setFinishImage = (seq: string, heading: string, imagePath: string | null, imageSha256: string | null) => {
    const draft = drafts[seq] ?? { metres: '', price: '', packing: '', type: '', finish: [] }
    const key = (h: string) => h.replace(/\s+/g, ' ').trim().toLowerCase()
    const existing = draft.finish.find(f => key(f.heading) === key(heading))
    const line = data?.lines.find(l => l.itemSequence === seq)
    const sheetValue = line?.sheet?.finish.find(f => key(f.heading) === key(heading))?.value ?? ''
    const finish = existing
      ? draft.finish.map(f => (f === existing ? { ...f, imagePath, imageSha256 } : f))
      : [...draft.finish, { heading, value: sheetValue, imagePath, imageSha256 }]
    setDraft(seq, { finish })
  }

  const uploadImage = async (seq: string, heading: string, file: File) => {
    setBusy(true); setProblem(null)
    try {
      const form = new FormData()
      form.set('submissionId', submissionId)
      form.set('itemSequence', seq)
      form.set('file', file)
      const res = await fetch('/api/orders/fabric-finish/image', { method: 'POST', body: form })
      const body = (await res.json().catch(() => null)) as { storage_path?: string; sha256?: string; message?: string } | null
      if (!res.ok || !body?.storage_path || !body.sha256) {
        setProblem(body?.message ?? 'The picture could not be stored. Please try again.')
        return
      }
      setFinishImage(seq, heading, body.storage_path, body.sha256)
      const signed = await supabase.storage.from(ORDER_FILES_BUCKET).createSignedUrls([body.storage_path], PICTURE_URL_TTL_SECONDS)
      const url = signed.data?.[0]?.signedUrl
      if (url) setUrls(u => ({ ...u, [body.storage_path as string]: url }))
    } catch {
      setProblem('Could not reach the server. The picture was not added.')
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    if (!data || dirtyKeys.length === 0) return
    setBusy(true); setProblem(null)
    try {
      for (const seq of dirtyKeys) {
        const d = drafts[seq]
        const payload = typedPayload({
          fabricMetresPerPiece: d.metres, fabricPricePerMetre: d.price, packingCostPerPiece: d.packing, packingType: d.type, finish: d.finish,
        })
        if (!payload.ok) { setProblem(payload.problem); return }
        const { error } = await supabase.rpc('order_submission_fabric_finish_save_typed', {
          p_submission_id: submissionId, p_item_sequence: seq, p_values: payload.values,
        })
        if (error) { setProblem(describeError(error.message)); return }
      }
      setSavedAt(new Date().toISOString())
      await load()
    } finally {
      setBusy(false)
    }
  }

  // ── Header ──
  const header = (
    <header className={'ff-head'}>
      <div style={{ minWidth: 0 }}>
        <h2 className={'ff-title'}>{FABRIC_FINISH_TITLE}</h2>
        <p className={'ff-sub'}>
          {context}
          {data?.sheetReadAt ? ` · read from the PI workbook ${showDate(data.sheetReadAt) ?? ''}` : data ? ` · ${NOT_READ_NOTE}` : ''}
        </p>
      </div>
      {variant === 'drawer' && (
        <div className={'ff-acts'}>
          {openAsPageHref && (
            <button type="button" className="boe-btn boe-btn-ghost" onClick={() => router.push(openAsPageHref)}>{FABRIC_FINISH_OPEN_PAGE_LABEL} ↗</button>
          )}
          <button type="button" className={'ff-close'} aria-label="Close" onClick={onClose}>×</button>
        </div>
      )}
    </header>
  )

  if (unreadable) {
    return <>{header}<p className={'ff-alert'} role="alert">The sheet could not be opened. You may not have access, or the page needs a reload.</p></>
  }
  if (data === undefined || !live) {
    return <>{header}<p className={'ff-note'} role="status">Opening the sheet…</p></>
  }
  if (data === null) {
    return <>{header}<p className={'ff-note'} role="status">This PI could not be found.</p></>
  }

  const canEdit = data.canEdit
  const { totals } = live
  const figuresOf = (seq: string) => lineFigures(live.lines.find(l => l.itemSequence === seq) as FabricFinishLine)
  const sheetText = (line: FabricFinishLine, key: 'fabricMetresPerPiece' | 'fabricPricePerMetre' | 'packingCostPerPiece') => {
    const v = line.sheet?.[key]
    return v === null || v === undefined ? 'type' : String(v)
  }
  const input = (line: FabricFinishLine, key: keyof Pick<Draft, 'metres' | 'price' | 'packing'>, sheetKey: 'fabricMetresPerPiece' | 'fabricPricePerMetre' | 'packingCostPerPiece', label: string) => {
    const d = drafts[line.itemSequence] ?? draftOf(line)
    const bad = Number.isNaN(parseTypedFigure(d[key]) as number)
    if (!canEdit) return <>{effective(line, sheetKey).value ?? '—'}</>
    return (
      <input
        className={`${'ff-inp'}${d[key].trim() === '' ? ` ${'ff-inp-empty'}` : ''}${bad ? ` ${'ff-inp-bad'}` : ''}`}
        inputMode="decimal"
        aria-label={`${label}, ${line.productName ?? line.itemSequence}`}
        value={d[key]}
        placeholder={sheetText(line, sheetKey)}
        disabled={busy}
        onChange={e => setDraft(line.itemSequence, { [key]: e.target.value } as Partial<Draft>)}
      />
    )
  }
  const typeInput = (line: FabricFinishLine) => {
    const d = drafts[line.itemSequence] ?? draftOf(line)
    if (!canEdit) return <>{effective(line, 'packingType').value ?? '—'}</>
    return (
      <input
        className={`${'ff-inp'} ${'ff-inp-text'}${d.type.trim() === '' ? ` ${'ff-inp-empty'}` : ''}`}
        aria-label={`Packing type, ${line.productName ?? line.itemSequence}`}
        value={d.type}
        placeholder={line.sheet?.packingType ?? 'type'}
        disabled={busy}
        onChange={e => setDraft(line.itemSequence, { type: e.target.value })}
      />
    )
  }
  const finishCell = (line: FabricFinishLine, heading: string) => {
    const liveLine = live.lines.find(l => l.itemSequence === line.itemSequence) as FabricFinishLine
    const key = (h: string) => h.replace(/\s+/g, ' ').trim().toLowerCase()
    const current = effectiveFinish(liveLine).find(f => key(f.entry.heading) === key(heading))
    const value = current?.entry.value ?? ''
    const imagePath = current?.entry.imagePath ?? null
    const pending = value !== '' && !finishIsDone(value)
    const inputId = `ff-img-${line.itemSequence}-${key(heading).replace(/[^a-z0-9]/g, '')}`
    return (
      <div className={'ff-finish-row'}>
        {imagePath && urls[imagePath] && (
          // eslint-disable-next-line @next/next/no-img-element -- a short-lived signed link
          <a href={urls[imagePath]} target="_blank" rel="noreferrer"><img src={urls[imagePath]} alt={`${heading} reference`} className={'ff-finish-img'} /></a>
        )}
        {canEdit ? (
          <input
            className={`${'ff-inp'} ${'ff-inp-text'}${value === '' ? ` ${'ff-inp-empty'}` : ''}`}
            aria-label={`${heading}, ${line.productName ?? line.itemSequence}`}
            value={(drafts[line.itemSequence]?.finish ?? []).find(f => key(f.heading) === key(heading))?.value ?? (current?.source === 'sheet' ? '' : value)}
            placeholder={current?.source === 'sheet' && current.entry.value ? current.entry.value : 'type'}
            disabled={busy}
            onChange={e => setFinishValue(line.itemSequence, heading, e.target.value)}
          />
        ) : (
          <span className={pending ? 'ff-pend' : undefined}>{value === '' ? '—' : value}</span>
        )}
        {canEdit && (
          <>
            <input
              id={inputId}
              ref={el => { fileInputs.current[inputId] = el }}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              style={{ display: 'none' }}
              onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void uploadImage(line.itemSequence, heading, f) }}
            />
            <button type="button" className={'ff-img-btn'} disabled={busy} onClick={() => fileInputs.current[inputId]?.click()}>
              {imagePath ? 'Change picture' : 'Add picture'}
            </button>
          </>
        )}
        {current?.source === 'typed' && !canEdit && <span className={`${'ff-chip'} ${'ff-chip-typed'}`}>{TYPED_SOURCE_LABEL}</span>}
      </div>
    )
  }
  const finishStatus = (line: FabricFinishLine) => {
    const f = figuresOf(line.itemSequence)
    return f.finishMissing
      ? <span className={`${'ff-chip'} ${'ff-chip-none'}`}>{NO_FINISH_TEXT}</span>
      : <span className={`${'ff-chip'} ${'ff-chip-sheet'}`}>Recorded</span>
  }
  const piFabricText = live.fabric.piWords ?? money(live.fabric.piAmount)
  const piPackingText = live.packing.piWords ?? money(live.packing.piAmount)

  const body = (
    <>
      {data.lines.length === 0 && <p className={'ff-empty'}>This PI has no product lines yet.</p>}

      {/* ══ 1. Fabric and packing costing ══ */}
      {data.lines.length > 0 && (
        <section className={'ff-section'} aria-label={COSTING_SECTION_TITLE}>
          <div className={'ff-section-head'}>
            <h3 className={'ff-section-title'}>{COSTING_SECTION_TITLE}</h3>
            <span className={'ff-section-note'}>per product · metres and ₹ per metre from the sheet or typed here; totals are always quantity × those</span>
          </div>
          <div className={'ff-table-wrap'}>
            <table className={'ff-table'}>
              <thead>
                <tr>
                  <th>Product</th><th className={'ff-num'}>Qty</th><th className={'ff-num'}>Fabric m / pc</th><th className={'ff-num'}>Total m</th>
                  <th className={'ff-num'}>₹ / m</th><th className={'ff-num'}>Fabric ₹</th><th className={'ff-num'}>Packing ₹ / pc</th>
                  <th className={'ff-num'}>Packing ₹</th><th>Packing type</th><th>Source</th>
                </tr>
              </thead>
              <tbody>
                {data.lines.map(line => {
                  const f = figuresOf(line.itemSequence)
                  const liveLine = live.lines.find(l => l.itemSequence === line.itemSequence) as FabricFinishLine
                  return (
                    <tr key={line.itemSequence}>
                      <td>
                        <div className={'ff-prod'}>
                          {urls[`product:${line.itemSequence}`]
                            ? (
                            // eslint-disable-next-line @next/next/no-img-element -- a short-lived signed link
                            <img src={urls[`product:${line.itemSequence}`]} alt="" className={'ff-thumb'} />
                          )
                            : <div className={'ff-thumb-none'} aria-hidden="true">No image</div>}
                          <div>{line.productName ?? 'Product'}<span className={'ff-code'}>{line.productCode ?? line.itemSequence}</span></div>
                        </div>
                      </td>
                      <td className={'ff-num'}>{line.quantity}</td>
                      <td className={'ff-num'}>{input(line, 'metres', 'fabricMetresPerPiece', 'Fabric metres per piece')}</td>
                      <td className={`${'ff-num'} ${'ff-calc'}`}>{metresText(f.metres)}</td>
                      <td className={'ff-num'}>{input(line, 'price', 'fabricPricePerMetre', 'Fabric price per metre')}</td>
                      <td className={`${'ff-num'} ${'ff-calc'}`}>{money(f.fabricAmount)}</td>
                      <td className={'ff-num'}>{input(line, 'packing', 'packingCostPerPiece', 'Packing cost per piece')}</td>
                      <td className={`${'ff-num'} ${'ff-calc'}`}>{money(f.packingAmount)}</td>
                      <td>{typeInput(line)}</td>
                      <td><SourceChip line={liveLine} /></td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td>Total</td>
                  <td className={'ff-num'}>{data.lines.reduce((a, l) => a + l.quantity, 0)}</td>
                  <td></td>
                  <td className={'ff-num'}>{metresText(totals.metres)}</td>
                  <td></td>
                  <td className={'ff-num'}>{totals.fabric.counted === 0 ? '—' : formatInr(totals.fabric.sum)}</td>
                  <td></td>
                  <td className={'ff-num'}>{totals.packing.counted === 0 ? '—' : formatInr(totals.packing.sum)}</td>
                  <td colSpan={2}>{totals.linesFilled} of {totals.lines} lines filled</td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Phone: one card per product */}
          <div className={'ff-cards'}>
            {data.lines.map(line => {
              const f = figuresOf(line.itemSequence)
              const liveLine = live.lines.find(l => l.itemSequence === line.itemSequence) as FabricFinishLine
              return (
                <div key={line.itemSequence} className={'ff-card'}>
                  <div className={'ff-card-top'}>
                    {urls[`product:${line.itemSequence}`]
                      ? (
                            // eslint-disable-next-line @next/next/no-img-element -- a short-lived signed link
                            <img src={urls[`product:${line.itemSequence}`]} alt="" className={'ff-thumb'} />
                          )
                      : <div className={'ff-thumb-none'} aria-hidden="true">No image</div>}
                    <div><b>{line.productName ?? 'Product'}</b><small>{line.productCode ?? line.itemSequence} · Qty {line.quantity}</small></div>
                    <span style={{ marginLeft: 'auto' }}><SourceChip line={liveLine} /></span>
                  </div>
                  <div className={'ff-kv'}>
                    <div><span>Fabric m / pc</span>{input(line, 'metres', 'fabricMetresPerPiece', 'Fabric metres per piece')}</div>
                    <div><span>Total metres</span><b>{metresText(f.metres)}</b></div>
                    <div><span>₹ per metre</span>{input(line, 'price', 'fabricPricePerMetre', 'Fabric price per metre')}</div>
                    <div><span>Fabric ₹</span><b>{money(f.fabricAmount)}</b></div>
                    <div><span>Packing ₹ / pc</span>{input(line, 'packing', 'packingCostPerPiece', 'Packing cost per piece')}</div>
                    <div><span>Packing ₹</span><b>{money(f.packingAmount)}</b></div>
                    <div className={'ff-kv-wide'}><span>Packing type</span>{typeInput(line)}</div>
                  </div>
                </div>
              )
            })}
          </div>

          <div className={'ff-match'}>
            <ComparisonBox label="Fabric cost" pi={piFabricText} c={live.fabric} />
            <ComparisonBox label="Packing cost" pi={piPackingText} c={live.packing} />
          </div>
          <p className={'ff-legend'}>
            Sheet totals are rounded to ₹10 like the workbook: fabric {totalText(totals.fabric, formatInr)}, packing {totalText(totals.packing, formatInr)}. {REVISION_NOTE}
          </p>
        </section>
      )}

      {/* ══ 2. Fabric and finish choices ══ */}
      {data.lines.length > 0 && (
        <section className={'ff-section'} aria-label={FINISH_SECTION_TITLE}>
          <div className={'ff-section-head'}>
            <h3 className={'ff-section-title'}>{FINISH_SECTION_TITLE}</h3>
            <span className={'ff-section-note'}>the code of the fabric or finish and a reference picture, from the sheet or added here</span>
          </div>
          <div className={'ff-table-wrap'}>
            <table className={'ff-table'}>
              <thead>
                <tr>
                  <th>Product</th><th className={'ff-num'}>Qty</th>
                  {headings.map(h => <th key={h}>{h}</th>)}
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.lines.map(line => (
                  <tr key={line.itemSequence}>
                    <td>
                      <div className={'ff-prod'}>
                        {urls[`product:${line.itemSequence}`]
                          ? (
                            // eslint-disable-next-line @next/next/no-img-element -- a short-lived signed link
                            <img src={urls[`product:${line.itemSequence}`]} alt="" className={'ff-thumb'} />
                          )
                          : <div className={'ff-thumb-none'} aria-hidden="true">No image</div>}
                        <div>{line.productName ?? 'Product'}<span className={'ff-code'}>{line.productCode ?? line.itemSequence}</span></div>
                      </div>
                    </td>
                    <td className={'ff-num'}>{line.quantity}</td>
                    {headings.map(h => <td key={h} className={'ff-finish-cell'}>{finishCell(line, h)}</td>)}
                    <td>{finishStatus(line)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className={'ff-cards'}>
            {data.lines.map(line => (
              <div key={line.itemSequence} className={'ff-card'}>
                <div className={'ff-card-top'}>
                  <div><b>{line.productName ?? 'Product'}</b><small>{line.productCode ?? line.itemSequence} · Qty {line.quantity}</small></div>
                  <span style={{ marginLeft: 'auto' }}>{finishStatus(line)}</span>
                </div>
                <div className={'ff-kv'}>
                  {headings.map(h => <div key={h} className={'ff-kv-wide'}><span>{h}</span>{finishCell(line, h)}</div>)}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {canEdit && data.lines.length > 0 && (
        <div className={variant === 'page' ? 'ff-save-bar' : 'ff-bar'}>
          <button type="button" className="boe-btn boe-btn-primary" disabled={busy || dirtyKeys.length === 0} onClick={() => void save()}>
            {busy ? 'Saving…' : SAVE_LABEL}
          </button>
          {dirtyKeys.length > 0 && <span className={'ff-note'} style={{ margin: 0 }}>{dirtyKeys.length} product{dirtyKeys.length === 1 ? '' : 's'} changed</span>}
          {savedAt && dirtyKeys.length === 0 && <span className={'ff-saved'}>Saved</span>}
        </div>
      )}
      {problem && <p className={'ff-alert'} role="alert">{problem}</p>}
      {!canEdit && data.lines.length > 0 && (
        <p className={'ff-note'}>Values can be typed by the PI&apos;s salesperson, admins and managers.</p>
      )}
    </>
  )

  return variant === 'drawer'
    ? <>{header}<div className={'ff-drawer-body'}>{body}</div></>
    : <>{header}<div>{body}</div></>
}
