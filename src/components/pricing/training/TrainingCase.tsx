'use client'

// Pricing > Training: one case. Its maker uploads a photo, corrects what was read from it, lists every element of
// the price in their own way and sends it for checking; a person holding Approve (the owner or Nitish) approves it, sends it back or rejects it.
// Nothing here sets a price anywhere (20270720000000).

import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Camera, Plus, Send, Trash2 } from 'lucide-react'
import { AppLink as Link } from '@/components/ui/AppLink'
import { LoadingScreen } from '@/components/ui/atoms'
import { createClient } from '@/lib/supabase/client'
import { formatINR } from '@/lib/currency'
import { KINDS, KIND_LABEL, emptyForm, emptyLine, lineAmount, num, parseReading, problems, readingToLines, toLine, totals, usesQuantity, type CaseForm, type Kind, type Line } from '@/lib/pricing/training/doc'
import { decideCase, fetchAccess, fetchCase, photoUrl, readPhoto, saveCase, sendMessage, submitCase, trainingKeys, uploadPhoto, type TrainingError } from '@/lib/pricing/training/api'
import { STATUS, shortDate } from './TrainingList'
import t from './training.module.css'

const str = (v: number | null) => (v === null || v === undefined ? '' : String(Number(v)))

export function TrainingCase() {
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()
  const qc = useQueryClient()
  const routeId = String(useParams<{ id: string }>()?.id ?? 'new')
  const isNew = routeId === 'new'

  const access = useQuery({ queryKey: trainingKeys.access, queryFn: () => fetchAccess(supabase), retry: false })
  const saved = useQuery({ queryKey: trainingKeys.one(routeId), queryFn: () => fetchCase(supabase, routeId), enabled: !isNew && access.isSuccess, retry: false })

  const [form, setForm] = useState<CaseForm>(emptyForm)
  const [lines, setLines] = useState<Line[]>([])
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState<'' | 'photo' | 'reading' | 'save' | 'send' | 'decide' | 'message'>('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [issues, setIssues] = useState<string[]>([])
  const [removed, setRemoved] = useState<{ line: Line; at: number } | null>(null)
  const [note, setNote] = useState('')
  const [reply, setReply] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  // A saved case fills the form once it arrives, and again after a save or a decision changes it.
  // Set during render, keyed on the saved copy's stamp, so a plain refetch does not wipe what is being typed.
  const [loadedAt, setLoadedAt] = useState<string | null>(null)
  if (saved.data && saved.data.updated_at !== loadedAt) {
    const d = saved.data
    setLoadedAt(d.updated_at)
    setForm({ name: d.name, variant: d.variant ?? '', width_in: str(d.width_in), depth_in: str(d.depth_in), height_in: str(d.height_in), sold_price: str(d.sold_price), notes: d.notes ?? '', image_path: d.image_path, ai_reading: parseReading(d.ai_reading) })
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
  const sum = useMemo(() => totals(lines), [lines])
  const sold = num(form.sold_price)

  const edit = (patch: Partial<CaseForm>) => { setForm(f => ({ ...f, ...patch })); setDirty(true) }
  const editLine = (i: number, patch: Partial<Line>) => { setLines(ls => ls.map((l, n) => (n === i ? { ...l, ...patch } : l))); setDirty(true) }
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
    } catch (e) { fail(e) } finally { setBusy(''); if (fileRef.current) fileRef.current.value = '' }
  }

  async function save(send: boolean) {
    const found = problems(form, lines, send)
    setIssues(found); setError(''); setNotice('')
    if (found.length) return
    setBusy(send ? 'send' : 'save')
    try {
      const id = await saveCase(supabase, isNew ? null : routeId, form, lines)
      if (send) await submitCase(supabase, id)
      setDirty(false)
      await qc.invalidateQueries({ queryKey: trainingKeys.list })
      await qc.invalidateQueries({ queryKey: trainingKeys.one(id) })
      if (send) router.push('/pricing/training')
      else if (isNew) router.replace(`/pricing/training/${id}`)
      else setNotice('Saved.')
    } catch (e) { fail(e) } finally { setBusy('') }
  }

  async function decide(decision: 'approved' | 'sent_back' | 'rejected') {
    setError('')
    if (decision !== 'approved' && !note.trim()) { setError('Write a note saying what should change.'); return }
    setBusy('decide')
    try {
      await decideCase(supabase, routeId, decision, note.trim())
      await qc.invalidateQueries({ queryKey: trainingKeys.list })
      router.push('/pricing/training')
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
  const status = c?.status ?? 'draft'

  return (
    <div className={t.wrap}>
      <div className={t.head}>
        <div className={t.row}>
          <Link href="/pricing/training" className="boe-btn boe-btn-secondary" aria-label="Back to Training"><ArrowLeft size={16} aria-hidden /></Link>
          <div>
            <h1 className={t.h1}>{isNew ? 'New case' : form.name || 'Case'}</h1>
            <p className={t.sub}>{c ? `#${c.case_no} · taught by ${c.created_by === a?.uid ? 'you' : c.created_by_name ?? 'someone'} · ${shortDate(c.created_at)}` : 'A photo, then what the price is made of, then send it for checking.'}</p>
          </div>
        </div>
        <span className={`boe-badge ${STATUS[status].badge}`}>{c?.may_decide ? 'Waiting for you' : STATUS[status].label}</span>
      </div>

      {c?.status === 'sent_back' && c.decision_note && <div className="boe-callout boe-callout-warning" role="status"><div><span className="boe-callout-title">Sent back by {c.decided_by_name ?? 'the checker'}</span>{c.decision_note}</div></div>}
      {c?.status === 'rejected' && <div className="boe-callout boe-callout-error" role="status"><div><span className="boe-callout-title">Rejected by {c.decided_by_name ?? 'the checker'}</span>{c.decision_note}</div></div>}
      {c?.status === 'approved' && <div className="boe-callout boe-callout-success" role="status">Approved by {c.decided_by_name ?? 'the checker'}{c.decided_at ? ` on ${shortDate(c.decided_at)}` : ''}. It is now part of the record the price logic will be built from.</div>}
      {c?.status === 'submitted' && c.created_by === a?.uid && !c.may_decide && <div className="boe-callout boe-callout-info" role="status">Sent for checking. It waits for someone who may approve cases.</div>}
      {error && <div className="boe-callout boe-callout-error" role="alert">{error}</div>}
      {notice && <div className="boe-callout boe-callout-info" role="status">{notice}</div>}
      {issues.length > 0 && <div className="boe-callout boe-callout-warning" role="alert"><div><span className="boe-callout-title">Fix these first</span><ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{issues.map(x => <li key={x}>{x}</li>)}</ul></div></div>}

      <div className={t.two}>
        <div className={t.card}>
          <div className={t.cardH}>Photo{editable && <>
            <input ref={fileRef} type="file" accept="image/*" hidden onChange={e => onPhoto(e.target.files?.[0])} />
            <button type="button" className="boe-btn boe-btn-secondary" disabled={busy !== ''} onClick={() => fileRef.current?.click()}><Camera size={16} aria-hidden /> {form.image_path ? 'Change photo' : 'Add a photo'}</button>
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
              <label className={`${t.field} ${t.span3}`}><span className="boe-input-label">Price on the PI or quotation, per piece (₹)</span><input className="boe-input" inputMode="decimal" value={form.sold_price} disabled={!editable} onChange={e => edit({ sold_price: e.target.value })} placeholder="If it was sold, what the client paid" /></label>
              <label className={`${t.field} ${t.span3}`}><span className="boe-input-label">Anything else (special work, why this client paid more or less)</span><textarea className="boe-input" rows={3} value={form.notes} disabled={!editable} onChange={e => edit({ notes: e.target.value })} maxLength={2000} /></label>
            </div>
          </div>
        </div>
      </div>

      <div className={t.card}>
        <div className={t.cardH}>What the price is made of
          {editable && <button type="button" className="boe-btn boe-btn-secondary" onClick={addLine}><Plus size={16} aria-hidden /> Add an element</button>}
        </div>
        {lines.length === 0 && <div className={t.cardB}><p className={t.muted} style={{ margin: 0 }}>{editable ? 'List every element in your own way: wood, weaving, upholstery, finish, hardware, labour, overhead, margin. Type a quantity and a rate, or just the amount.' : 'No elements.'}</p></div>}
        {editable ? lines.map((l, i) => (
          <div key={i} className={t.el}>
            <div className={t.elGrid}>
              <label className={t.field}><span className="boe-input-label">Element {i + 1} {l.from_ai && <span className={t.fromAi}>from the photo</span>}</span><input className="boe-input" value={l.element} onChange={e => editLine(i, { element: e.target.value })} placeholder="e.g. Frame wood" maxLength={120} /></label>
              <label className={t.field}><span className="boe-input-label">Kind</span><select className="boe-input" value={l.kind} onChange={e => editLine(i, { kind: e.target.value as Kind })}>{KINDS.map(k => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select></label>
              <label className={t.field}><span className="boe-input-label">Material / what it is</span><input className="boe-input" value={l.material} onChange={e => editLine(i, { material: e.target.value })} maxLength={160} /></label>
              <label className={t.field}><span className="boe-input-label">Quantity</span><input className="boe-input" inputMode="decimal" value={l.quantity} onChange={e => editLine(i, { quantity: e.target.value })} /></label>
              <label className={t.field}><span className="boe-input-label">Unit</span><input className="boe-input" value={l.unit} onChange={e => editLine(i, { unit: e.target.value })} placeholder="cu ft" maxLength={30} /></label>
              <label className={t.field}><span className="boe-input-label">Rate (₹)</span><input className="boe-input" inputMode="decimal" value={l.rate} onChange={e => editLine(i, { rate: e.target.value })} /></label>
              {usesQuantity(l)
                ? <div className={t.field}><span className="boe-input-label">Amount (₹)</span><div className={t.amount} aria-live="polite">{formatINR(lineAmount(l))}</div></div>
                : <label className={t.field}><span className="boe-input-label">Amount (₹)</span><input className="boe-input" inputMode="decimal" value={l.amount} onChange={e => editLine(i, { amount: e.target.value })} /></label>}
              <button type="button" className={t.iconBtn} onClick={() => removeLine(i)} aria-label={`Remove element ${i + 1}`}><Trash2 size={16} aria-hidden /></button>
            </div>
            <label className={t.field}><span className="boe-input-label">How you worked this out</span><input className="boe-input" value={l.reasoning} onChange={e => editLine(i, { reasoning: e.target.value })} placeholder="e.g. Four legs, two rails, back posts, with cutting waste" maxLength={1000} /></label>
          </div>
        )) : lines.map((l, i) => (
          <div key={i} className={t.read}>
            <span><b>{l.element}</b>{l.material ? ` · ${l.material}` : ''}</span>
            <span className={t.muted}>{KIND_LABEL[l.kind]}</span>
            <span className={t.muted}>{usesQuantity(l) ? `${l.quantity} ${l.unit} × ${formatINR(num(l.rate) ?? 0)}` : 'Amount given'}</span>
            <b className={t.num}>{formatINR(lineAmount(l))}</b>
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

      {c?.may_decide && (
        <div className={t.card}>
          <div className={t.cardH}>Your decision</div>
          <div className={t.cardB}>
            <label className={t.field}><span className="boe-input-label">Note (needed if you send it back or reject it)</span><textarea className="boe-input" rows={2} value={note} onChange={e => setNote(e.target.value)} placeholder="What should change?" maxLength={2000} /></label>
            <div className={t.row}>
              <button type="button" className="boe-btn boe-btn-primary" disabled={busy !== ''} onClick={() => decide('approved')}>Approve</button>
              <button type="button" className="boe-btn boe-btn-secondary" disabled={busy !== ''} onClick={() => decide('sent_back')}>Send back with a note</button>
              <button type="button" className="boe-btn boe-btn-danger" disabled={busy !== ''} onClick={() => decide('rejected')}>Reject</button>
            </div>
          </div>
        </div>
      )}

      {c && (
        <div className={t.card}>
          <div className={t.cardH}>Questions and answers</div>
          <div className={t.cardB}>
            {c.messages.length === 0 && <p className={t.muted} style={{ margin: 0 }}>Nothing asked yet. Ask about a number here instead of on the phone, so the answer stays with the case.</p>}
            <div>{c.messages.map(m => <div key={m.id} className={t.msg}><span><b>{m.created_by === a?.uid ? 'You' : m.created_by_name ?? 'Someone'}</b> <span className={t.muted}>{shortDate(m.created_at)}</span></span><span>{m.body}</span></div>)}</div>
            {(a?.create || a?.approve) && <div className={t.row}>
              <input className="boe-input" style={{ flex: 1, minWidth: 180 }} value={reply} onChange={e => setReply(e.target.value)} placeholder="Write a question or an answer" aria-label="Message" maxLength={2000} onKeyDown={e => { if (e.key === 'Enter') post() }} />
              <button type="button" className="boe-btn boe-btn-secondary" disabled={busy !== '' || !reply.trim()} onClick={post}><Send size={16} aria-hidden /> Send</button>
            </div>}
          </div>
        </div>
      )}

      {editable && (
        <div className={t.foot}>
          <span className={t.muted}>{dirty ? 'Changes not saved yet.' : isNew ? 'Nothing saved yet.' : 'All changes saved.'}</span>
          <span className={t.spacer} />
          <button type="button" className="boe-btn boe-btn-secondary" disabled={busy !== ''} onClick={() => save(false)}>{busy === 'save' ? 'Saving…' : 'Save draft'}</button>
          <button type="button" className="boe-btn boe-btn-primary" disabled={busy !== ''} onClick={() => save(true)}><Send size={16} aria-hidden /> {busy === 'send' ? 'Sending…' : 'Send for checking'}</button>
        </div>
      )}
    </div>
  )
}
