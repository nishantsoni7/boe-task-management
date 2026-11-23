'use client'

// Pricing > Training: one case. Its maker uploads a photo, corrects what was read from it, lists every element of
// the price in their own way and submits it. Submitting is what makes a case count; anyone who may teach can change any
// case later, and it then waits to be resubmitted.
// Nothing here sets a price anywhere (20270720000000).

import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Camera, Plus, Send, Trash2 } from 'lucide-react'
import { AppLink as Link } from '@/components/ui/AppLink'
import { LoadingScreen } from '@/components/ui/atoms'
import { createClient } from '@/lib/supabase/client'
import { formatINR } from '@/lib/currency'
import { INCLUDES, INCLUDE_LABEL, KINDS, KIND_LABEL, PRICE_LEVELS, PRICE_LEVEL_LABEL, caseTerms, emptyForm, emptyLine, newWoods, num, parseReading, problems, readingToLines, shortDate, sizeOf, statusLabel, statusText, structureRest, toLine, totals, usesQuantity, workCase, type CaseForm, type Include, type Kind, type Line, type PriceLevel } from '@/lib/pricing/training/doc'
import { CALC_LABEL, newCalc, type CalcType } from '@/lib/pricing/training/calc'
import { fetchAccess, fetchCase, fetchMetals, fetchWoods, saveWood, photoUrl, readPhoto, saveCase, sendMessage, submitCase, trainingKeys, uploadPhoto, type TrainingError } from '@/lib/pricing/training/api'
import { CalcEditor } from './CalcEditors'
import t from './training.module.css'

const str = (v: number | null) => (v === null || v === undefined ? '' : String(Number(v)))
/** The ways each kind of element can be worked out besides an amount or quantity × rate. */
const WAYS: Record<Kind, CalcType[]> = { structure: ['wood', 'area'], metal: ['metal'], material: ['area'], labour: ['area', 'percent'], overhead: ['percent'], margin: ['percent'], other: ['area', 'percent'] }

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

  const [form, setForm] = useState<CaseForm>(emptyForm)
  const [lines, setLines] = useState<Line[]>([])
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState<'' | 'photo' | 'reading' | 'save' | 'send' | 'decide' | 'message'>('')
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
    setForm({ name: d.name, variant: d.variant ?? '', width_in: str(d.width_in), depth_in: str(d.depth_in), height_in: str(d.height_in), sold_price: str(d.sold_price), notes: d.notes ?? '', image_path: d.image_path, ai_reading: parseReading(d.ai_reading), ...caseTerms(d) })
    setLines(d.lines.map(toLine))
    setDirty(false)
  }

  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const a = access.data
  const c = saved.data
  const editable = isNew ? !!a?.create : !!c?.may_edit
  const size = useMemo(() => sizeOf(form), [form])
  const work = useMemo(() => workCase(lines, size), [lines, size])
  const sum = useMemo(() => totals(lines, size), [lines, size])
  const sold = num(form.sold_price)

  const edit = (patch: Partial<CaseForm>) => { setForm(f => ({ ...f, ...patch })); setDirty(true) }
  const editLine = (i: number, patch: Partial<Line>) => { setLines(ls => ls.map((l, n) => (n === i ? { ...l, ...patch } : l))); setDirty(true) }
  // A kind keeps its way of working out only when that kind allows it; a metal frame starts weighed.
  const setKind = (l: Line, i: number, kind: Kind) => editLine(i, { kind, calc: l.calc && WAYS[kind].includes(l.calc.type) ? l.calc : kind === 'metal' ? newCalc('metal') : null })
  const toggleInclude = (x: Include) => edit({ includes: form.includes.includes(x) ? form.includes.filter(y => y !== x) : [...form.includes, x] })
  const addLine = () => { setLines(ls => [...ls, emptyLine()]); setDirty(true) }
  const removeLine = (i: number) => { setRemoved({ line: lines[i], at: i }); setLines(ls => ls.filter((_, n) => n !== i)); setDirty(true) }
  const undoRemove = () => { if (!removed) return; setLines(ls => [...ls.slice(0, removed.at), removed.line, ...ls.slice(removed.at)]); setRemoved(null) }
  const fail = (e: unknown) => setError((e as TrainingError)?.message || 'Something went wrong. Try again.')

  async function onPhoto(file: File | undefined) {
    if (!file || !a) return
    setError(''); setNotice(''); setBusy('photo')
    try {
      const { path, jpeg } = await uploadPhoto(supabase, a.uid, file)
      edit({ image_path: path, ai_reading: null })
      await read(jpeg)
    } catch (e) { fail(e) } finally { setBusy(''); if (fileRef.current) fileRef.current.value = '' }
  }

  // Reads the photo and adds what it sees as elements (only when none are listed yet, so nothing typed is lost).
  async function read(jpeg: Blob) {
    setBusy('reading')
    try {
      const reading = await readPhoto(supabase, jpeg)
      setForm(f => ({ ...f, ai_reading: reading, name: f.name || reading.category, variant: f.variant || reading.variant }))
      setLines(ls => (ls.length === 0 ? readingToLines(reading) : ls))
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
    const found = problems(form, lines, send)
    setIssues(found); setError(''); setNotice('')
    if (found.length) return
    setBusy(send ? 'send' : 'save')
    try {
      const id = await saveCase(supabase, isNew ? null : routeId, form, lines)
      // A wood typed on a structure row joins the wood list (without a rate), so it can be given a rate later.
      const added = woods.data ? newWoods(lines, woods.data.map(w => w.name)) : []
      if (added.length) { await Promise.all(added.map(w => saveWood(supabase, w, null).catch(() => null))); await qc.invalidateQueries({ queryKey: trainingKeys.woods }) }
      if (send) await submitCase(supabase, id)
      setDirty(false)
      await qc.invalidateQueries({ queryKey: trainingKeys.list })
      await qc.invalidateQueries({ queryKey: trainingKeys.one(id) })
      if (isNew) router.replace(`/pricing/training/${id}`)
      else setNotice(send ? 'Submitted to the price estimator.' : 'Saved. Submit it when the prices are right.')
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
    <div className={t.wrap}>
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

      {c && <div className={`boe-callout ${c.status === 'submitted' && !dirty ? 'boe-callout-success' : 'boe-callout-info'}`} role="status">{dirty ? `You have changes that are not saved yet. ${c.submit_count > 0 ? 'After saving, resubmit so the estimator uses the new prices.' : ''}` : statusText(c)}</div>}
      {error && <div className="boe-callout boe-callout-error" role="alert">{error}</div>}
      {notice && <div className="boe-callout boe-callout-info" role="status">{notice}</div>}
      {issues.length > 0 && <div className="boe-callout boe-callout-warning" role="alert"><div><span className="boe-callout-title">Fix these first</span><ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{issues.map(x => <li key={x}>{x}</li>)}</ul></div></div>}

      <div className={t.two}>
        <div className={t.card}>
          <div className={t.cardH}>Photo{editable && <>
            <input ref={fileRef} type="file" accept="image/*" hidden onChange={e => onPhoto(e.target.files?.[0])} />
            <button type="button" className="boe-btn boe-btn-secondary" disabled={busy !== ''} onClick={() => fileRef.current?.click()}><Camera size={16} aria-hidden /> {form.image_path ? 'Change photo' : 'Add a photo'}</button>
            {form.image_path && <button type="button" className="boe-btn boe-btn-secondary" disabled={busy !== ''} onClick={readAgain}>{form.ai_reading ? 'Read the photo again' : 'Read the materials from the photo'}</button>}
          </>}</div>
          <div className={t.cardB}>
            <div className={t.photo}>
              {/* eslint-disable-next-line @next/next/no-img-element -- a stored product photo, shown as it is */}
              {form.image_path ? <img src={photoUrl(supabase, form.image_path)} alt={form.name || 'Product photo'} /> : <span>{editable ? 'Add a photo of the product. I will say what I can see, and you correct it.' : 'No photo.'}</span>}
            </div>
            {busy === 'photo' && <div className={t.muted} role="status">Uploading the photo…</div>}
            {busy === 'reading' && <div className={t.muted} role="status">Reading the photo. This takes a few seconds…</div>}
            {reading && <div>
              <div className={t.row} style={{ justifyContent: 'space-between' }}><b>What I see: {reading.category || 'a product'}</b><span className={`${t.conf} ${reading.confidence >= 70 ? t.confHi : t.confLo}`}>{reading.confidence}% sure</span></div>
              {reading.materials.map((m, i) => (
                <div key={i} className={t.seen}><span><b>{m.part}:</b> {m.material}</span><span className={`${t.conf} ${m.confidence >= 70 ? t.confHi : t.confLo}`}>{m.confidence}%</span>{m.note && <small>{m.note}</small>}</div>
              ))}
              {reading.cannot_see && <p className={t.muted} style={{ margin: '8px 0 0' }}>{reading.cannot_see}</p>}
              {editable && lines.length > 0 && <button type="button" className="boe-btn boe-btn-text" onClick={() => { setLines(ls => [...ls, ...readingToLines(reading)]); setDirty(true) }}>Add these as elements again</button>}
            </div>}
          </div>
        </div>

        <div className={t.card}>
          <div className={t.cardH}>Product</div>
          <div className={t.cardB}>
            <div className={t.fields}>
              <label className={`${t.field} ${t.span3}`}><span className="boe-input-label">Name <span className="boe-req">*</span></span><input className="boe-input" value={form.name} disabled={!editable} onChange={e => edit({ name: e.target.value })} placeholder="e.g. Dining chair, teak, cane seat" maxLength={160} /></label>
              <label className={`${t.field} ${t.span3}`}><span className="boe-input-label">Variant</span><input className="boe-input" value={form.variant} disabled={!editable} onChange={e => edit({ variant: e.target.value })} placeholder="e.g. Dining chair, cane seat" maxLength={120} /></label>
              <label className={t.field}><span className="boe-input-label">Width (in)</span><input className="boe-input" inputMode="decimal" value={form.width_in} disabled={!editable} onChange={e => edit({ width_in: e.target.value })} /></label>
              <label className={t.field}><span className="boe-input-label">Depth (in)</span><input className="boe-input" inputMode="decimal" value={form.depth_in} disabled={!editable} onChange={e => edit({ depth_in: e.target.value })} /></label>
              <label className={t.field}><span className="boe-input-label">Height (in)</span><input className="boe-input" inputMode="decimal" value={form.height_in} disabled={!editable} onChange={e => edit({ height_in: e.target.value })} /></label>
              <label className={`${t.field} ${t.span3}`}><span className="boe-input-label">Price on the PI or quotation, per {num(form.per_set) ? `set of ${num(form.per_set)}` : 'piece'} (₹)</span><input className="boe-input" inputMode="decimal" value={form.sold_price} disabled={!editable} onChange={e => edit({ sold_price: e.target.value })} placeholder="If it was sold, what the client paid" /></label>
              <label className={t.field}><span className="boe-input-label">This price is</span><select className="boe-input" value={form.price_level} disabled={!editable} onChange={e => edit({ price_level: e.target.value as PriceLevel })}>{PRICE_LEVELS.map(p => <option key={p} value={p}>{PRICE_LEVEL_LABEL[p]}</option>)}</select></label>
              <label className={t.field}><span className="boe-input-label">For a set of (pieces)</span><input className="boe-input" inputMode="numeric" value={form.per_set} disabled={!editable} onChange={e => edit({ per_set: e.target.value })} placeholder="Blank: per piece" /></label>
              <fieldset className={`${t.field} ${t.span3} ${t.terms}`} disabled={!editable} style={{ border: 0, padding: 0, margin: 0 }}>
                <legend className="boe-input-label">The price already includes</legend>
                {INCLUDES.map(x => <label key={x}><input type="checkbox" checked={form.includes.includes(x)} onChange={() => toggleInclude(x)} /> {INCLUDE_LABEL[x]}</label>)}
              </fieldset>
              <label className={`${t.field} ${t.span3}`}><span className="boe-input-label">Anything else (special work, why this client paid more or less)</span><textarea className="boe-input" rows={3} value={form.notes} disabled={!editable} onChange={e => edit({ notes: e.target.value })} maxLength={2000} /></label>
            </div>
          </div>
        </div>
      </div>

      <div className={t.card}>
        <div className={t.cardH}>What the price is made of
          {editable && <button type="button" className="boe-btn boe-btn-secondary" onClick={addLine}><Plus size={16} aria-hidden /> Add an element</button>}
        </div>
        <datalist id="training-woods">{(woods.data ?? []).map(w => <option key={w.name} value={w.name} />)}</datalist>
        {lines.length === 0 && <div className={t.cardB}><p className={t.muted} style={{ margin: 0 }}>{editable ? 'List every element in your own way: the wooden structure as one price, then weaving, upholstery, finish, hardware, overhead, margin. Type a quantity and a rate, or just the amount.' : 'No elements.'}</p></div>}
        {editable ? lines.map((l, i) => (
          <div key={i} className={t.el}>
            <div className={t.elGrid}>
              <label className={t.field}><span className="boe-input-label">Element {i + 1} {l.from_ai && <span className={t.fromAi}>from the photo</span>}</span><input className="boe-input" value={l.element} onChange={e => editLine(i, { element: e.target.value })} placeholder="e.g. Wooden structure" maxLength={120} /></label>
              <label className={t.field}><span className="boe-input-label">Kind</span><select className="boe-input" value={l.kind} onChange={e => setKind(l, i, e.target.value as Kind)}>{KINDS.map(k => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select></label>
              {l.kind === 'structure'
                ? <label className={t.field}><span className="boe-input-label">Wood</span><input className="boe-input" list="training-woods" value={l.material} onChange={e => editLine(i, { material: e.target.value })} placeholder="Pick or type a wood" maxLength={40} /></label>
                : <label className={t.field}><span className="boe-input-label">Material / what it is</span><input className="boe-input" value={l.material} onChange={e => editLine(i, { material: e.target.value })} maxLength={160} /></label>}
              {l.calc
                ? <span className={`${t.muted} ${t.calcSpan}`}>Worked out below: {CALC_LABEL[l.calc.type].toLowerCase()}</span>
                : <>
                  <label className={t.field}><span className="boe-input-label">Quantity</span><input className="boe-input" inputMode="decimal" value={l.quantity} onChange={e => editLine(i, { quantity: e.target.value })} /></label>
                  <label className={t.field}><span className="boe-input-label">Unit</span><input className="boe-input" value={l.unit} onChange={e => editLine(i, { unit: e.target.value })} placeholder="cu ft" maxLength={30} /></label>
                  <label className={t.field}><span className="boe-input-label">Rate (₹)</span><input className="boe-input" inputMode="decimal" value={l.rate} onChange={e => editLine(i, { rate: e.target.value })} /></label>
                </>}
              {l.calc || usesQuantity(l)
                ? <div className={t.field}><span className="boe-input-label">Amount (₹)</span><div className={t.amount} aria-live="polite">{formatINR(work[i]?.amount ?? 0)}</div></div>
                : <label className={t.field}><span className="boe-input-label">Amount (₹)</span><input className="boe-input" inputMode="decimal" value={l.amount} onChange={e => editLine(i, { amount: e.target.value })} /></label>}
              <button type="button" className={t.iconBtn} onClick={() => removeLine(i)} aria-label={`Remove element ${i + 1}`}><Trash2 size={16} aria-hidden /></button>
            </div>
            <div className={t.split}>
              <label className={t.field}><span className="boe-input-label">Worked out as</span>
                <select className="boe-input" value={l.calc?.type ?? ''} onChange={e => editLine(i, { calc: e.target.value ? newCalc(e.target.value as CalcType) : null })}>
                  <option value="">An amount, or quantity × rate</option>
                  {WAYS[l.kind].map(w => <option key={w} value={w}>{CALC_LABEL[w]}</option>)}
                </select>
              </label>
              <label className={t.field}><span className="boe-input-label">How you worked this out</span><input className="boe-input" value={l.reasoning} onChange={e => editLine(i, { reasoning: e.target.value })} placeholder="e.g. Four legs, two rails, back posts, with cutting waste" maxLength={1000} /></label>
            </div>
            {l.calc && <CalcEditor calc={l.calc} onChange={calc => editLine(i, { calc })} worked={work[i]} size={size} woodName={l.material} woods={woods.data ?? []} metals={metals.data ?? []} idPrefix={`el${i}`} />}
            {l.kind === 'structure' && !l.calc && <div className={t.split}>
              <label className={t.field}><span className="boe-input-label">Of which wood (₹), optional</span><input className="boe-input" inputMode="decimal" value={l.wood} onChange={e => editLine(i, { wood: e.target.value })} placeholder="The wood alone" /></label>
              <p className={t.muted} aria-live="polite">{structureRest(l) === null ? 'One price for the whole wooden structure is enough. If you also give the wood alone, the rest is counted as labour and hardware, and a price can be worked out for another wood later.' : structureRest(l)! < 0 ? 'The wood share is more than the structure price.' : `Labour and hardware: ${formatINR(structureRest(l)!)}`}</p>
            </div>}
          </div>
        )) : lines.map((l, i) => (
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
        {removed && editable && <div className={t.cardB}><div className={t.row} role="status"><span className={t.muted}>Removed {removed.line.element || 'an element'}.</span><button type="button" className="boe-btn boe-btn-text" onClick={undoRemove}>Undo</button></div></div>}
        <div className={t.totals}>
          {KINDS.filter(k => sum.byKind[k] > 0).map(k => <span key={k}>{KIND_LABEL[k]} <b>{formatINR(sum.byKind[k])}</b></span>)}
          {sold !== null && sum.total > 0 && <span>Against the PI price <b>{sum.total - sold >= 0 ? '+' : '−'}{formatINR(Math.abs(sum.total - sold))}</b></span>}
          <span className={t.grand} aria-live="polite">{formatINR(sum.total)}</span>
        </div>
      </div>

      {c && (
        <div className={t.card}>
          <div className={t.cardH}>Questions and answers</div>
          <div className={t.cardB}>
            {c.messages.length === 0 && <p className={t.muted} style={{ margin: 0 }}>Nothing asked yet. Ask about a number here instead of on the phone, so the answer stays with the case.</p>}
            <div>{c.messages.map(m => <div key={m.id} className={t.msg}><span><b>{m.created_by === a?.uid ? 'You' : m.created_by_name ?? 'Someone'}</b> <span className={t.muted}>{shortDate(m.created_at)}</span></span><span>{m.body}</span></div>)}</div>
            {a?.create && <div className={t.row}>
              <input className="boe-input" style={{ flex: 1, minWidth: 180 }} value={reply} onChange={e => setReply(e.target.value)} placeholder="Write a question or an answer" aria-label="Message" maxLength={2000} onKeyDown={e => { if (e.key === 'Enter') post() }} />
              <button type="button" className="boe-btn boe-btn-secondary" disabled={busy !== '' || !reply.trim()} onClick={post}><Send size={16} aria-hidden /> Send</button>
            </div>}
          </div>
        </div>
      )}

      {c && c.events.length > 0 && (
        <div className={t.card}>
          <div className={t.cardH}>History</div>
          <div className={t.cardB}>
            <div>{c.events.map((e, i) => <div key={i} className={t.msg}><span><b>{e.what === 'submitted' ? 'Submitted' : 'Saved'}</b> by {e.created_by === a?.uid ? 'you' : e.created_by_name ?? 'someone'} <span className={t.muted}>{shortDate(e.created_at)} · total {formatINR(Number(e.total))}</span></span></div>)}</div>
          </div>
        </div>
      )}

      {editable && (
        <div className={t.foot}>
          <span className={t.muted}>{dirty ? 'Changes not saved yet.' : c ? statusText(c) : 'Nothing saved yet.'}</span>
          <span className={t.spacer} />
          <button type="button" className="boe-btn boe-btn-secondary" disabled={busy !== ''} onClick={() => save(false)}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
          <button type="button" className="boe-btn boe-btn-primary" disabled={busy !== '' || unchanged} title={unchanged ? 'Nothing has changed since it was submitted' : undefined} onClick={() => save(true)}><Send size={16} aria-hidden /> {busy === 'send' ? 'Submitting…' : c && c.submit_count > 0 ? 'Resubmit to the price estimator' : 'Submit to the price estimator'}</button>
        </div>
      )}
    </div>
  )
}
