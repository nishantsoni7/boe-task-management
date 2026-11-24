'use client'

// Pricing > Training: one case. Its maker uploads a photo, corrects what was read from it, lists every element of
// the price in their own way and submits it. Submitting is what makes a case count; anyone who may teach can change any
// case later, and it then waits to be resubmitted.
// The page is a sheet of one line per element beside a price build-up with Overhead % and Margin % (24 Nov 2026).
// Nothing here sets a price anywhere (20270720000000).

import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Camera, ChevronDown, Plus, Send, Sparkles } from 'lucide-react'
import { AppLink as Link } from '@/components/ui/AppLink'
import { LoadingScreen } from '@/components/ui/atoms'
import { createClient } from '@/lib/supabase/client'
import { formatINR } from '@/lib/currency'
import { INCLUDES, INCLUDE_LABEL, KIND_LABEL, PRICE_LEVELS, PRICE_LEVEL_LABEL, caseTerms, emptyForm, emptyLine, newWoods, num, parseReading, problems, readingToLines, shortDate, sizeOf, statusLabel, statusText, structureRest, toLine, usesQuantity, workCase, type CaseForm, type Include, type Line, type PriceLevel } from '@/lib/pricing/training/doc'
import { BOX_KINDS, boxIsSet, boxProblems, buildUp, emptyBoxes, mergeBoxes, splitBoxes, withOf, withPct, type BoxKind, type Boxes } from '@/lib/pricing/training/boxes'
import { CALC_LABEL } from '@/lib/pricing/training/calc'
import { draftFromNote, fetchAccess, fetchCase, fetchMetals, fetchWoods, saveWood, photoUrl, readPhoto, saveCase, sendMessage, submitCase, trainingKeys, uploadPhoto, type TrainingError } from '@/lib/pricing/training/api'
import { clearPrefill, prefillForm, takePrefill, type Prefill } from '@/lib/pricing/training/prefill'
import { draftForm, draftToLines } from '@/lib/pricing/training/draft'
import { setFeedbackStatus } from '@/lib/pricing/learning/api'
import { ElementRow } from './ElementRow'
import { PriceBuildUp } from './PriceBuildUp'
import t from './training.module.css'

const str = (v: number | null) => (v === null || v === undefined ? '' : String(Number(v)))

export function TrainingCase() {
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()
  const qc = useQueryClient()
  const routeId = String(useParams<{ id: string }>()?.id ?? 'new')
  const isNew = routeId === 'new'

  const access = useQuery({ queryKey: trainingKeys.access, queryFn: () => fetchAccess(supabase), retry: false })
  const woods = useQuery({ queryKey: trainingKeys.woods, queryFn: () => fetchWoods(supabase), enabled: access.isSuccess, retry: false })
  const metals = useQuery({ queryKey: trainingKeys.metals, queryFn: () => fetchMetals(supabase), enabled: access.isSuccess, retry: false })
  const saved = useQuery({ queryKey: trainingKeys.one(routeId), queryFn: () => fetchCase(supabase, routeId), enabled: !isNew && access.isSuccess, retry: false })

  // "Teach this price": a new case may start from a feedback card or a quotation line (prefill.ts). Read once, on the
  // first render of New case; the form is only drawn after the access check, so the server and the browser agree.
  const [origin] = useState<Prefill | null>(() => (isNew ? takePrefill() : null))
  const [form, setForm] = useState<CaseForm>(() => (origin ? { ...emptyForm(), ...prefillForm(origin) } : emptyForm()))
  // The elements, and apart from them the Overhead and Margin boxes. Worked out and saved together (boxes.ts).
  const [lines, setLines] = useState<Line[]>([])
  const [boxes, setBoxes] = useState<Boxes>(emptyBoxes)
  const [openRows, setOpenRows] = useState<number[]>([])
  const [dirty, setDirty] = useState(!!origin)
  const [note, setNote] = useState(origin?.note ?? '')
  const [wordsOpen, setWordsOpen] = useState(!!origin?.note)
  const [draftMissing, setDraftMissing] = useState<string[]>([])
  const [tab, setTab] = useState<'talk' | 'history'>('talk')
  const photoCopied = useRef(false)
  const [busy, setBusy] = useState<'' | 'photo' | 'reading' | 'save' | 'send' | 'decide' | 'message' | 'draft'>('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [issues, setIssues] = useState<string[]>([])
  const [removed, setRemoved] = useState<{ line: Line; at: number } | null>(null)
  const [reply, setReply] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  // A saved case fills the form once it arrives, and again after a save or a decision changes it.
  // Set during render, keyed on the saved copy's stamp, so a plain refetch does not wipe what is being typed.
  const [loadedAt, setLoadedAt] = useState<string | null>(null)
  if (saved.data && saved.data.updated_at !== loadedAt) {
    const d = saved.data
    setLoadedAt(d.updated_at)
    const f: CaseForm = { name: d.name, variant: d.variant ?? '', width_in: str(d.width_in), depth_in: str(d.depth_in), height_in: str(d.height_in), sold_price: str(d.sold_price), notes: d.notes ?? '', image_path: d.image_path, ai_reading: parseReading(d.ai_reading), ...caseTerms(d) }
    setForm(f)
    // Overhead and margin rows move into their boxes only when that changes no figure of the case.
    const split = splitBoxes(d.lines.map(toLine), sizeOf(f))
    setLines(split.lines)
    setBoxes(split.boxes)
    setOpenRows([])
    setDirty(false)
  }

  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  useEffect(() => { if (origin) clearPrefill() }, [origin])

  const a = access.data
  // The quotation line's photo is copied into Training once the person is known (it goes into their own folder).
  // When the case came with a note, the photo is only read, not turned into rows: the note drafts the rows.
  useEffect(() => {
    if (!origin?.photoUrl || !a?.create || photoCopied.current) return
    photoCopied.current = true
    void (async () => {
      try {
        const res = await fetch(origin.photoUrl!)
        if (!res.ok) throw new Error('fetch')
        const blob = await res.blob()
        await onPhoto(new File([blob], 'line.jpg', { type: blob.type || 'image/jpeg' }), !origin.note)
      } catch { setNotice('The quotation line\'s photo could not be copied. Add it with "Add a photo".') }
    })()
  // onPhoto is a plain function of this render; the copy runs once, guarded by photoCopied.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [origin, a])

  const c = saved.data
  const editable = isNew ? !!a?.create : !!c?.may_edit
  const size = useMemo(() => sizeOf(form), [form])
  const all = useMemo(() => mergeBoxes(lines, boxes), [lines, boxes])
  const work = useMemo(() => workCase(all, size), [all, size])
  const build = useMemo(() => buildUp(lines, boxes, size), [lines, boxes, size])
  const sold = num(form.sold_price)

  const edit = (patch: Partial<CaseForm>) => { setForm(f => ({ ...f, ...patch })); setDirty(true) }
  const editLine = (i: number, patch: Partial<Line>) => { setLines(ls => ls.map((l, n) => (n === i ? { ...l, ...patch } : l))); setDirty(true) }
  const setPct = (kind: BoxKind, value: string) => { setBoxes(b => ({ ...b, [kind]: withPct(b[kind], value) })); setDirty(true) }
  const setBase = (of: 'cost' | 'above') => { setBoxes(b => ({ ...b, margin: withOf(b.margin, of) })); setDirty(true) }
  const toggleInclude = (x: Include) => edit({ includes: form.includes.includes(x) ? form.includes.filter(y => y !== x) : [...form.includes, x] })
  // A new element opens its details so the first thing typed has somewhere to go; a removed one shifts the rest.
  const addLine = () => { setOpenRows(o => [...o, lines.length]); setLines(ls => [...ls, emptyLine()]); setDirty(true) }
  const removeLine = (i: number) => { setRemoved({ line: lines[i], at: i }); setLines(ls => ls.filter((_, n) => n !== i)); setOpenRows(o => o.filter(k => k !== i).map(k => (k > i ? k - 1 : k))); setDirty(true) }
  const undoRemove = () => { if (!removed) return; setLines(ls => [...ls.slice(0, removed.at), removed.line, ...ls.slice(removed.at)]); setOpenRows(o => o.map(k => (k >= removed.at ? k + 1 : k))); setRemoved(null) }
  const toggleRow = (i: number) => setOpenRows(o => (o.includes(i) ? o.filter(k => k !== i) : [...o, i]))
  const fail = (e: unknown) => setError((e as TrainingError)?.message || 'Something went wrong. Try again.')

  async function onPhoto(file: File | undefined, addRows = true) {
    if (!file || !a) return
    setError(''); setNotice(''); setBusy('photo')
    try {
      const { path, jpeg } = await uploadPhoto(supabase, a.uid, file)
      edit({ image_path: path, ai_reading: null })
      await read(jpeg, addRows)
    } catch (e) { fail(e) } finally { setBusy(''); if (fileRef.current) fileRef.current.value = '' }
  }

  // Reads the photo and adds what it sees as elements (only when none are listed yet, so nothing typed is lost).
  async function read(jpeg: Blob, addRows = true) {
    setBusy('reading')
    try {
      const reading = await readPhoto(supabase, jpeg)
      setForm(f => ({ ...f, ai_reading: reading, name: f.name || reading.category, variant: f.variant || reading.variant }))
      if (addRows) setLines(ls => (ls.length === 0 ? readingToLines(reading) : ls))
      setDirty(true)
    } catch (e) {
      // The photo is kept; reading it is a help, not a requirement.
      setNotice(`${(e as TrainingError)?.message ?? 'The photo could not be read.'} The photo is saved with the case.`)
    }
  }

  async function readAgain() {
    if (!form.image_path) return
    setError(''); setNotice('')
    try {
      const res = await fetch(photoUrl(supabase, form.image_path))
      if (!res.ok) throw new Error('fetch')
      await read(await res.blob())
    } catch { setNotice('The saved photo could not be opened to read it again. Choose the photo once more.') } finally { setBusy('') }
  }

  async function save(send: boolean) {
    const found = [...problems(form, lines, send), ...boxProblems(boxes)]
    setIssues(found); setError(''); setNotice('')
    if (found.length) return
    setBusy(send ? 'send' : 'save')
    try {
      const id = await saveCase(supabase, isNew ? null : routeId, form, all)
      // A wood typed on a structure row joins the wood list (without a rate), so it can be given a rate later.
      const added = woods.data ? newWoods(lines, woods.data.map(w => w.name)) : []
      if (added.length) { await Promise.all(added.map(w => saveWood(supabase, w, null).catch(() => null))); await qc.invalidateQueries({ queryKey: trainingKeys.woods }) }
      if (send) await submitCase(supabase, id)
      setDirty(false)
      await qc.invalidateQueries({ queryKey: trainingKeys.list })
      await qc.invalidateQueries({ queryKey: trainingKeys.one(id) })
      // The feedback it was taught from is answered: done, with the case it became. Only the pricing desk may mark
      // feedback; for anyone else this quietly does nothing and the card stays open in Price learning.
      if (isNew && origin?.feedbackId) {
        const feedbackId = origin.feedbackId
        void fetchCase(supabase, id).then(saved => setFeedbackStatus(supabase, feedbackId, 'done', `Taught in Training as case #${saved.case_no}`)).catch(() => null)
      }
      if (isNew) router.replace(`/pricing/training/${id}`)
      else setNotice(send ? 'Submitted to the price estimator.' : 'Saved. Submit it when the prices are right.')
    } catch (e) { fail(e) } finally { setBusy('') }
  }

  // "In your words": the note becomes rows to check. They are added below what is there (or replace rows that are only
  // names read from a photo), and blanks on the case (size, set, price) are filled from the note. An overhead or margin
  // percentage in the note goes to its box when the box is empty (the person's own boxes are put last, so they stay).
  async function draft() {
    if (note.trim().length < 10) { setError('Write the note first: how the price is worked out.'); return }
    setError(''); setNotice(''); setBusy('draft')
    try {
      const d = await draftFromNote(supabase, note.trim())
      const rows = draftToLines(d)
      const base = lines.every(l => !l.amount.trim() && !l.rate.trim() && !l.calc) ? [] : lines
      const split = splitBoxes([...base, ...rows, ...mergeBoxes([], boxes)], size)
      setLines(split.lines)
      setBoxes(Object.fromEntries(BOX_KINDS.map(k => [k, boxIsSet(split.boxes[k]) ? split.boxes[k] : boxes[k]])) as Boxes)
      setForm(f => ({ ...f, ...draftForm(d, f) }))
      setDraftMissing(d.missing)
      setDirty(true)
      setNotice(rows.length ? `${rows.length} element${rows.length === 1 ? '' : 's'} drafted from your note. Check each one; nothing counts until you save and submit.` : 'No amounts or rates were found in the note.')
    } catch (e) { fail(e) } finally { setBusy('') }
  }

  async function post() {
    if (!reply.trim()) return
    setError(''); setBusy('message')
    try { await sendMessage(supabase, routeId, reply.trim()); setReply(''); await qc.invalidateQueries({ queryKey: trainingKeys.one(routeId) }) } catch (e) { fail(e) } finally { setBusy('') }
  }

  const loadErr = (access.error ?? saved.error) as TrainingError | null
  if (loadErr) return <div className={t.wrap}><Link href="/pricing/training" className="boe-btn boe-btn-secondary" style={{ justifySelf: 'start' }}><ArrowLeft size={16} aria-hidden /> Training</Link><div className={`boe-callout ${loadErr.kind === 'not_set_up' ? 'boe-callout-warning' : 'boe-callout-error'}`} role="alert">{loadErr.message}</div></div>
  if (access.isLoading || (!isNew && saved.isLoading)) return <LoadingScreen cheer={false} />
  if (isNew && a && !a.create) return <div className={t.wrap}><div className="boe-callout boe-callout-info">To teach a case, ask an admin for Create on Pricing.</div></div>

  const reading = form.ai_reading
  const badge = statusLabel(c ?? { status: 'draft', submit_count: 0 })
  const unchanged = !!c && c.status === 'submitted' && !dirty

  return (
    <div className={`${t.wrap} ${t.casePage}`}>
      <div className={t.head}>
        <div className={t.row}>
          <Link href="/pricing/training" className="boe-btn boe-btn-secondary" aria-label="Back to Training"><ArrowLeft size={16} aria-hidden /></Link>
          <div>
            <h1 className={t.h1}>{isNew ? 'New case' : form.name || 'Case'}</h1>
            <p className={t.sub}>{c ? `#${c.case_no} · taught by ${c.created_by === a?.uid ? 'you' : c.created_by_name ?? 'someone'} · ${shortDate(c.created_at)}` : 'A photo, then what the price is made of, then submit it.'}</p>
          </div>
        </div>
        <span className={`boe-badge ${badge.badge}`}>{dirty ? 'Changes not saved' : badge.label}</span>
      </div>

      {isNew && origin && <div className="boe-callout boe-callout-info" role="status">Started from {origin.feedbackId ? 'feedback' : 'a quotation line'}{origin.quoteNo ? ` on ${origin.quoteNo}` : ''}: the product, its size and the price are filled in{origin.photoUrl ? ' and its photo is being copied' : ''}. {origin.note ? 'Your note is below: draft the elements from it, then check them.' : 'Add what the price is made of, then save.'}</div>}
      {c && !dirty && <div className={`boe-callout ${c.status === 'submitted' ? 'boe-callout-success' : 'boe-callout-info'}`} role="status">{statusText(c)}</div>}
      {error && <div className="boe-callout boe-callout-error" role="alert">{error}</div>}
      {notice && <div className="boe-callout boe-callout-info" role="status">{notice}</div>}
      {issues.length > 0 && <div className="boe-callout boe-callout-warning" role="alert"><div><span className="boe-callout-title">Fix these first</span><ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{issues.map(x => <li key={x}>{x}</li>)}</ul></div></div>}

      <div className={t.two}>
        <div className={t.card}>
          <div className={t.cardH}>Photo</div>
          <div className={t.cardB}>
            <div className={t.photo}>
              {/* eslint-disable-next-line @next/next/no-img-element -- a stored product photo, shown as it is */}
              {form.image_path ? <img src={photoUrl(supabase, form.image_path)} alt={form.name || 'Product photo'} /> : <span>{editable ? 'Add a photo of the product. I will say what I can see, and you correct it.' : 'No photo.'}</span>}
            </div>
            {busy === 'photo' && <div className={t.muted} role="status">Uploading the photo…</div>}
            {busy === 'reading' && <div className={t.muted} role="status">Reading the photo. This takes a few seconds…</div>}
            {editable && <div className={t.row}>
              <input ref={fileRef} type="file" accept="image/*" hidden onChange={e => onPhoto(e.target.files?.[0])} />
              <button type="button" className="boe-btn boe-btn-secondary" disabled={busy !== ''} onClick={() => fileRef.current?.click()}><Camera size={16} aria-hidden /> {form.image_path ? 'Change photo' : 'Add a photo'}</button>
              {form.image_path && <button type="button" className="boe-btn boe-btn-secondary" disabled={busy !== ''} onClick={readAgain}>{form.ai_reading ? 'Read the photo again' : 'Read the materials from the photo'}</button>}
            </div>}
            {reading && <details className={t.seenBox}>
              <summary><b>What I see: {reading.category || 'a product'}</b><span className={`${t.conf} ${reading.confidence >= 70 ? t.confHi : t.confLo}`}>{reading.confidence}% sure</span><ChevronDown size={16} aria-hidden /></summary>
              {reading.materials.map((m, i) => (
                <div key={i} className={t.seen}><span><b>{m.part}:</b> {m.material}</span><span className={`${t.conf} ${m.confidence >= 70 ? t.confHi : t.confLo}`}>{m.confidence}%</span>{m.note && <small>{m.note}</small>}</div>
              ))}
              {reading.cannot_see && <p className={t.muted} style={{ margin: '8px 0 0' }}>{reading.cannot_see}</p>}
              {editable && lines.length > 0 && <button type="button" className="boe-btn boe-btn-text" onClick={() => { setLines(ls => [...ls, ...readingToLines(reading)]); setDirty(true) }}>Add these as elements again</button>}
            </details>}
          </div>
        </div>

        <div className={t.card}>
          <div className={t.cardH}>Product</div>
          <div className={t.cardB}>
            <div className={t.fields}>
              <label className={`${t.field} ${t.span2}`}><span className="boe-input-label">Name <span className="boe-req">*</span></span><input className="boe-input" value={form.name} disabled={!editable} onChange={e => edit({ name: e.target.value })} placeholder="e.g. Dining chair, teak, cane seat" maxLength={160} /></label>
              <label className={`${t.field} ${t.span2}`}><span className="boe-input-label">Variant</span><input className="boe-input" value={form.variant} disabled={!editable} onChange={e => edit({ variant: e.target.value })} placeholder="e.g. Dining chair, cane seat" maxLength={120} /></label>
              <label className={t.field}><span className="boe-input-label">Width (in)</span><input className="boe-input" inputMode="decimal" value={form.width_in} disabled={!editable} onChange={e => edit({ width_in: e.target.value })} /></label>
              <label className={t.field}><span className="boe-input-label">Depth (in)</span><input className="boe-input" inputMode="decimal" value={form.depth_in} disabled={!editable} onChange={e => edit({ depth_in: e.target.value })} /></label>
              <label className={t.field}><span className="boe-input-label">Height (in)</span><input className="boe-input" inputMode="decimal" value={form.height_in} disabled={!editable} onChange={e => edit({ height_in: e.target.value })} /></label>
              <label className={t.field}><span className="boe-input-label">For a set of (pieces)</span><input className="boe-input" inputMode="numeric" value={form.per_set} disabled={!editable} onChange={e => edit({ per_set: e.target.value })} placeholder="Blank: per piece" /></label>
              <label className={`${t.field} ${t.span2}`}><span className="boe-input-label">Price on the PI or quotation, per {num(form.per_set) ? `set of ${num(form.per_set)}` : 'piece'} (₹)</span><input className="boe-input" inputMode="decimal" value={form.sold_price} disabled={!editable} onChange={e => edit({ sold_price: e.target.value })} placeholder="If it was sold, what the client paid" /></label>
              <label className={`${t.field} ${t.span2}`}><span className="boe-input-label">This price is</span><select className="boe-input" value={form.price_level} disabled={!editable} onChange={e => edit({ price_level: e.target.value as PriceLevel })}>{PRICE_LEVELS.map(p => <option key={p} value={p}>{PRICE_LEVEL_LABEL[p]}</option>)}</select></label>
              <fieldset className={`${t.field} ${t.span4} ${t.terms}`} disabled={!editable} style={{ border: 0, padding: 0, margin: 0 }}>
                <legend className="boe-input-label">The price already includes</legend>
                {INCLUDES.map(x => <label key={x}><input type="checkbox" checked={form.includes.includes(x)} onChange={() => toggleInclude(x)} /> {INCLUDE_LABEL[x]}</label>)}
              </fieldset>
              <label className={`${t.field} ${t.span4}`}><span className="boe-input-label">Anything else (special work, why this client paid more or less)</span><textarea className="boe-input" rows={2} value={form.notes} disabled={!editable} onChange={e => edit({ notes: e.target.value })} maxLength={2000} /></label>
            </div>
          </div>
        </div>
      </div>

      <div className={t.layout}>
        <section className={`${t.card} ${t.sheet}`} aria-label="What the price is made of">
          <div className={t.cardH}>
            <span>What the price is made of <span className={t.muted}>· {lines.length} element{lines.length === 1 ? '' : 's'}</span></span>
            {editable && <button type="button" className="boe-btn boe-btn-secondary" aria-expanded={wordsOpen} aria-controls="training-words" onClick={() => setWordsOpen(o => !o)}><Sparkles size={16} aria-hidden /> Draft from my note</button>}
          </div>
          {editable && wordsOpen && (
            <div className={t.words} id="training-words">
              <label className={t.field}><span className="boe-input-label">How the price is worked out, as you would write it</span>
                <textarea className="boe-input" rows={4} value={note} onChange={e => setNote(e.target.value)} maxLength={4000}
                  placeholder="e.g. Top and four sides at 200 per sq ft, then 800 for finishing, then 30% margin. Total 9,620." /></label>
              <div className={t.row}>
                <button type="button" className="boe-btn boe-btn-primary" disabled={busy !== '' || note.trim().length < 10} onClick={draft}>{busy === 'draft' ? 'Drafting…' : 'Draft the elements from my note'}</button>
                <span className={t.muted}>The AI only copies the numbers out of your note into rows; this page does every sum. Check the rows below: nothing counts until you save and submit.</span>
              </div>
              {draftMissing.length > 0 && <div className="boe-callout boe-callout-warning" role="status"><div><span className="boe-callout-title">Not in the note</span><ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{draftMissing.map(m => <li key={m}>{m}</li>)}</ul></div></div>}
            </div>
          )}
          <datalist id="training-woods">{(woods.data ?? []).map(w => <option key={w.name} value={w.name} />)}</datalist>
          {lines.length === 0 && <div className={t.cardB}><p className={t.muted} style={{ margin: 0 }}>{editable ? 'List every element in your own way: the wooden structure as one price, then weaving, upholstery, finish, hardware. Type a quantity and a rate, or just the amount. Overhead and margin go in the price build-up, as percentages.' : 'No elements.'}</p></div>}
          {editable ? <>
            {lines.length > 0 && <div className={t.sheetHead} aria-hidden><span /><span>Element</span><span>Kind</span><span>Quantity</span><span className={t.right}>Rate</span><span className={t.right}>Amount</span><span /></div>}
            {lines.map((l, i) => (
              <ElementRow key={i} i={i} line={l} worked={work[i]} size={size} woods={woods.data ?? []} metals={metals.data ?? []} open={openRows.includes(i)} onToggle={() => toggleRow(i)} onChange={patch => editLine(i, patch)} onRemove={() => removeLine(i)} />
            ))}
            {removed && <div className={t.cardB}><div className={t.row} role="status"><span className={t.muted}>Removed {removed.line.element || 'an element'}.</span><button type="button" className="boe-btn boe-btn-text" onClick={undoRemove}>Undo</button></div></div>}
            <button type="button" className={t.addRow} onClick={addLine}><Plus size={16} aria-hidden /> Add an element</button>
          </> : lines.map((l, i) => (
            <div key={i} className={t.read}>
              <span><b>{l.element}</b>{l.material ? ` · ${l.material}` : ''}</span>
              <span className={t.muted}>{KIND_LABEL[l.kind]}</span>
              <span className={t.muted}>{l.calc ? CALC_LABEL[l.calc.type] : usesQuantity(l) ? `${l.quantity} ${l.unit} × ${formatINR(num(l.rate) ?? 0)}` : 'Amount given'}</span>
              <b className={t.num}>{formatINR(work[i]?.amount ?? 0)}</b>
              {l.calc && work[i]?.note && <small>{work[i].note}</small>}
              {!l.calc && structureRest(l) !== null && <small>Wood {formatINR(num(l.wood) ?? 0)} · labour and hardware {formatINR(structureRest(l)!)}</small>}
              {l.reasoning && <small>{l.reasoning}</small>}
            </div>
          ))}
        </section>

        <PriceBuildUp editable={editable} build={build} boxes={boxes} sold={sold} onPct={setPct} onBase={setBase} />
      </div>

      {c && (
        <div className={t.card}>
          <div className={t.tabs} role="tablist" aria-label="Talk and history">
            <button type="button" role="tab" id="case-tab-talk" aria-selected={tab === 'talk'} aria-controls="case-panel-talk" className={t.tab} onClick={() => setTab('talk')}>Questions and answers</button>
            {c.events.length > 0 && <button type="button" role="tab" id="case-tab-history" aria-selected={tab === 'history'} aria-controls="case-panel-history" className={t.tab} onClick={() => setTab('history')}>History <span className={t.muted}>{c.events.length}</span></button>}
          </div>
          {(tab === 'talk' || c.events.length === 0) && (
            <div className={t.cardB} role="tabpanel" id="case-panel-talk" aria-labelledby="case-tab-talk">
              {c.messages.length === 0 && <p className={t.muted} style={{ margin: 0 }}>Nothing asked yet. Ask about a number here instead of on the phone, so the answer stays with the case.</p>}
              <div>{c.messages.map(m => <div key={m.id} className={t.msg}><span><b>{m.created_by === a?.uid ? 'You' : m.created_by_name ?? 'Someone'}</b> <span className={t.muted}>{shortDate(m.created_at)}</span></span><span>{m.body}</span></div>)}</div>
              {a?.create && <div className={t.row}>
                <input className="boe-input" style={{ flex: 1, minWidth: 180 }} value={reply} onChange={e => setReply(e.target.value)} placeholder="Write a question or an answer" aria-label="Message" maxLength={2000} onKeyDown={e => { if (e.key === 'Enter') post() }} />
                <button type="button" className="boe-btn boe-btn-secondary" disabled={busy !== '' || !reply.trim()} onClick={post}><Send size={16} aria-hidden /> Send</button>
              </div>}
            </div>
          )}
          {tab === 'history' && c.events.length > 0 && (
            <div className={t.cardB} role="tabpanel" id="case-panel-history" aria-labelledby="case-tab-history">
              <div>{c.events.map((e, i) => <div key={i} className={t.msg}><span><b>{e.what === 'submitted' ? 'Submitted' : 'Saved'}</b> by {e.created_by === a?.uid ? 'you' : e.created_by_name ?? 'someone'} <span className={t.muted}>{shortDate(e.created_at)} · total {formatINR(Number(e.total))}</span></span></div>)}</div>
            </div>
          )}
        </div>
      )}

      {editable && (
        <div className={t.foot}>
          <span className={t.footTotal}><span className={t.muted}>Selling price</span><b>{formatINR(build.total)}</b></span>
          <span className={t.muted}>{dirty ? `Changes not saved yet.${c && c.submit_count > 0 ? ' After saving, resubmit so the estimator uses the new prices.' : ''}` : c ? statusText(c) : 'Nothing saved yet.'}</span>
          <span className={t.spacer} />
          <button type="button" className="boe-btn boe-btn-secondary" disabled={busy !== ''} onClick={() => save(false)}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
          <button type="button" className="boe-btn boe-btn-primary" disabled={busy !== '' || unchanged} title={unchanged ? 'Nothing has changed since it was submitted' : undefined} onClick={() => save(true)}><Send size={16} aria-hidden /> {busy === 'send' ? 'Submitting…' : c && c.submit_count > 0 ? 'Resubmit to the price estimator' : 'Submit to the price estimator'}</button>
        </div>
      )}
    </div>
  )
}
