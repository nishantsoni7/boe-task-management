'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppLink as Link } from '@/components/ui/AppLink'
import { useParams, useRouter } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronDown, ChevronRight, FileUp, Copy, FileCheck2, FileSpreadsheet, Info, Link2, MessageCircle, Plus, Printer, Save, Trash2, X } from 'lucide-react'
import { draftDetailHref } from '@/lib/orders/draftsView'
import { conversionProblems, type ConversionProblem } from '@/lib/quotations/piWorkbook'
import { PI_STAGE_LABEL, makePiDraft, piWorkbookFor, type PiStage } from '@/lib/quotations/toPiDraft'
import { QuotationsLayout } from '@/components/layout/QuotationsLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { useQuotations } from '@/hooks/useQuotations'
import { formatINR } from '@/lib/currency'
import { istDateOf } from '@/lib/istDate'
import {
  CLIENT_TYPES, STATUS_LABEL, errorKind, errorText, fetchQuotation, pictureUrl, quotationKeys, saveDoc, saveQuotation,
  setStatus as setStatusRpc, shareQuotation, fetchHints, requestPriceApproval, decidePrice, type PriceHint, uploadPicture, type Header, type Quotation, type QuotationStatus,
} from '@/lib/quotations/api'
import {
  DIMENSION_UNITS, GST_RATES, SUPPLY_STATES, computeTotals, formatDateIN, gstModeForState, validUntil, whatsappLink,
  type QuoteArea, type QuoteLine,
} from '@/lib/quotations/math'
import { CLOSING, DEFAULT_CLIENT_NOTE, EXPECTATIONS, EXPECTATIONS_TITLE, TERMS } from '@/lib/quotations/terms'
import { needsYou, PRICE_CARD_ID, REQUEST_CARD_ID } from '@/lib/quotations/needsYou'
import { ImportDialog } from './ImportDialog'
import { StatusPill } from './ListScreen'
import { StudioDialog } from './StudioDialog'
import { VersionsCard } from './VersionsCard'
import { RequestCard } from './RequestCard'
import { PriceCard } from './PricingDesk'
import { LineRow } from './ProductLine'
import { PictureViewer, viewerItemsOf } from './PictureViewer'
import { productType } from '@/lib/pricing/features'
import { priceLine, type ModelSuggestion } from '@/lib/pricing/model'
import { fetchPool, poolWords } from '@/lib/pricing/pool'
import s from './quotations.module.css'

const newKey = () => `n${Math.random().toString(36).slice(2, 10)}`
const blankLine = (area_key: string | null, tax_rate: number): QuoteLine => ({
  key: newKey(), area_key, name: '', size_text: '', spec: '', material: '', finish: '', category: '',
  qty_mode: 'per_unit', qty: 1, unit_price: null, tax_rate, image_path: null, is_optional: false, client_note: '', internal_note: '',
})
const LOCKED: QuotationStatus[] = ['confirmed', 'lost', 'archived']
const EMAIL_OK = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
type Msg = { tone: 'ok' | 'bad' | 'warn'; text: string; undo?: () => void } | null

export default function BuilderScreen() {
  const { id } = useParams<{ id: string }>()
  const { supabase, profile, loading, signOut, access, accessLoaded, notSetUp } = useQuotations()
  const qc = useQueryClient()
  const quoteQ = useQuery({ queryKey: quotationKeys.one(id), queryFn: () => fetchQuotation(supabase, id), enabled: accessLoaded, retry: false })

  const [base, setBase] = useState<Quotation | null>(null)
  const [h, setH] = useState<Header | null>(null)
  const [areas, setAreas] = useState<QuoteArea[]>([])
  const [lines, setLines] = useState<QuoteLine[]>([])
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<Msg>(null)
  const [lostNote, setLostNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [piStage, setPiStage] = useState<PiStage | null>(null)
  const [studioFor, setStudioFor] = useState<string | null>(null)
  const [viewing, setViewing] = useState<string | null>(null)
  const [advOpen, setAdvOpen] = useState(false)
  // The GST rate new products start with while no product sets it (the quotation has one rate; each product still stores it).
  const [newRate, setNewRate] = useState(18)
  // Price hints for the names on screen, asked for once typing pauses.
  const [hintNames, setHintNames] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setHintNames([...new Set(lines.map(l => l.name.trim()).filter(n => n.length >= 3))].sort().slice(0, 80).join('\n')), 600)
    return () => clearTimeout(t)
  }, [lines])
  const hintsQ = useQuery({ queryKey: ['quotations', 'hints', id, hintNames], queryFn: () => fetchHints(supabase, hintNames.split('\n'), id), enabled: accessLoaded && !notSetUp && hintNames !== '', staleTime: 300_000, retry: false })
  const hintFor = useMemo(() => new Map<string, PriceHint>((hintsQ.data ?? []).map(h => [h.name, h])), [hintsQ.data])
  // Pricing model v2: one pool for every product type on screen, then each line priced for its own parameters.
  const typeWords = useMemo(() => poolWords(hintNames.split('\n').map(productType).filter((t): t is string => !!t)).join(' '), [hintNames])
  const poolQ = useQuery({ queryKey: ['quotations', 'pool', id, typeWords], queryFn: () => fetchPool(supabase, typeWords.split(' '), id), enabled: accessLoaded && !notSetUp && typeWords !== '', staleTime: 300_000, retry: false })
  const [importing, setImporting] = useState(false)
  const router = useRouter()
  const dirtyRef = useRef(false)
  useEffect(() => { dirtyRef.current = dirty }, [dirty])

  // Take the server's copy when it arrives, unless there are unsaved edits on screen.
  useEffect(() => {
    const q = quoteQ.data
    if (!q || dirtyRef.current) return
    setBase(q); setH(q.header); setAreas(q.areas); setLines(q.lines)
  }, [quoteQ.data])

  const editable = !!base?.may_edit && !!base && !LOCKED.includes(base.status)
  const totals = useMemo(() => (h ? computeTotals(h, areas, lines) : null), [h, areas, lines])
  const modelFor = useMemo(() => {
    const m = new Map<string, ModelSuggestion | null>()
    if (!poolQ.data || !totals) return m
    for (const l of lines) m.set(l.key, priceLine(poolQ.data, { name: l.name, size: l.size_text, material: l.material, finish: l.finish, spec: l.spec, qty: totals.lineQty[l.key], clientType: h?.client_type }))
    return m
  }, [poolQ.data, lines, totals, h?.client_type])
  const touch = () => { setDirty(true); setMsg(m => (m?.tone === 'ok' ? null : m)) }
  const updH = <K extends keyof Header>(k: K, v: Header[K]) => { setH(p => (p ? { ...p, [k]: v } : p)); touch() }
  const updArea = (key: string, patch: Partial<QuoteArea>) => { setAreas(p => p.map(a => (a.key === key ? { ...a, ...patch } : a))); touch() }
  const updLine = (key: string, patch: Partial<QuoteLine>) => { setLines(p => p.map(l => (l.key === key ? { ...l, ...patch } : l))); touch() }

  // One GST rate for the whole quotation (owner, 13 Nov 2026). Each product still stores its rate, so a quotation that already has
  // mixed rates shows "Mixed rates" until somebody picks one.
  const rates = useMemo(() => [...new Set(lines.map(l => l.tax_rate))], [lines])
  const uniformRate = rates.length === 1 ? rates[0] : null
  const startRate = uniformRate ?? newRate
  const setAllRates = (rate: number) => { setNewRate(rate); setLines(p => p.map(l => ({ ...l, tax_rate: rate }))); touch() }

  const save = useCallback(async () => {
    if (!base || !h || saving) return
    const problem = !h.client_name.trim() ? 'Enter the client’s name.'
      : h.client_email.trim() && !EMAIL_OK.test(h.client_email.trim()) ? 'Check the email address.'
      : areas.some(a => !a.name.trim() || !(a.multiplier >= 1)) ? 'Every room type needs a name and at least 1 room.'
      : lines.some(l => !l.name.trim()) ? 'Every product needs a name.'
      : lines.some(l => !(Number(l.qty) > 0)) ? 'Every product needs a quantity above 0.'
      : null
    if (problem) { setMsg({ tone: 'bad', text: problem }); return }
    setSaving(true)
    try {
      const r = await saveQuotation(supabase, base.id, saveDoc(h, areas, lines, base.updated_at))
      setBase(b => (b ? { ...b, updated_at: r.updated_at } : b))
      setDirty(false); dirtyRef.current = false
      setMsg({ tone: 'ok', text: 'Saved.' })
      qc.invalidateQueries({ queryKey: ['quotations', 'list'] })
      quoteQ.refetch()
    } catch (e) {
      setMsg({ tone: errorKind(e) === 'stale' ? 'warn' : 'bad', text: errorText(e) })
    } finally { setSaving(false) }
  }, [base, h, areas, lines, saving, supabase, qc, quoteQ])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (dirtyRef.current) save() } }
    const onLeave = (e: BeforeUnloadEvent) => { if (dirtyRef.current) { e.preventDefault(); e.returnValue = '' } }
    window.addEventListener('keydown', onKey)
    window.addEventListener('beforeunload', onLeave)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('beforeunload', onLeave) }
  }, [save])

  const act = async (run: () => Promise<unknown>, done: string) => {
    setBusy(true)
    try { await run(); setMsg({ tone: 'ok', text: done }); await quoteQ.refetch(); qc.invalidateQueries({ queryKey: ['quotations', 'list'] }) }
    catch (e) { setMsg({ tone: 'bad', text: errorText(e) }) }
    finally { setBusy(false) }
  }
  const moveTo = (status: QuotationStatus, note?: string) => act(() => setStatusRpc(supabase, id, status, note), `Marked ${STATUS_LABEL[status]}.`)

  // Confirm → PI draft, from the SAVED quotation (the button waits for Save).
  const confirmToPi = async () => {
    if (!base || busy) return
    setBusy(true); setMsg(null)
    try {
      const r = await makePiDraft(supabase, base, setPiStage)
      if (!r.linkError) { router.push(draftDetailHref(r.submissionId)); return }
      setMsg({ tone: 'warn', text: `The PI draft was made (Orders → PI Drafts), but this quotation could not be linked to it: ${r.linkError}` })
      await quoteQ.refetch()
    } catch (e) {
      setMsg({ tone: 'bad', text: errorText(e) })
    } finally { setBusy(false); setPiStage(null) }
  }
  const downloadPi = async () => {
    if (!base || busy) return
    setBusy(true)
    try {
      const bytes = await piWorkbookFor(supabase, base)
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
      const a = document.createElement('a')
      a.href = url; a.download = `${base.quote_no} PI.xlsx`; a.click()
      setTimeout(() => URL.revokeObjectURL(url), 2000)
    } catch (e) { setMsg({ tone: 'bad', text: errorText(e) }) }
    finally { setBusy(false) }
  }

  if (loading) return <LoadingScreen />
  const layout = (title: string, body: React.ReactNode, subtitle?: string, actions?: React.ReactNode) => (
    <QuotationsLayout profile={profile} access={access} onSignOut={signOut} title={title} subtitle={subtitle} actions={actions}>{body}</QuotationsLayout>
  )
  if (notSetUp) return layout('Quotation', <div className={`${s.notice} ${s.noticeWarn}`}><b>Quotations is being set up.</b> Its database part has not been applied yet.</div>)
  if (quoteQ.isError) return layout('Quotation', <div className={`${s.notice} ${s.noticeBad}`}>{errorText(quoteQ.error)} <Link href="/quotations">Back to quotations</Link></div>)
  if (!base || !h || !totals) return <LoadingScreen />

  const issued = istDateOf(base.sent_at ?? base.created_at)
  const link = base.share_token ? `${typeof window === 'undefined' ? '' : window.location.origin}/q/${base.share_token}` : ''
  const waText = `Hello${h.contact_name ? ' ' + h.contact_name.split(' ')[0] : ''}, here is our quotation ${base.quote_no} for ${h.project_name || h.client_name}: ${formatINR(totals.grand)} including GST, valid until ${formatDateIN(validUntil(issued, h.valid_days))}.\nView it with pictures and save the PDF here: ${link}\n– ${profile?.full_name ?? ''}, Best of Exports`
  const copy = async () => {
    try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 1800) }
    catch { (document.getElementById('q-link') as HTMLInputElement | null)?.select() }
  }
  const upload = async (key: string, file: File | undefined) => {
    if (!file || !profile) return
    setMsg({ tone: 'warn', text: 'Uploading the picture…' })
    try { const path = await uploadPicture(supabase, profile.id, file); updLine(key, { image_path: path }); setMsg({ tone: 'warn', text: 'Picture added. Save to keep it.' }) }
    catch (e) { setMsg({ tone: 'bad', text: errorText(e) }) }
  }
  const removeLine = (key: string) => {
    const before = lines
    setLines(p => p.filter(l => l.key !== key)); touch()
    setMsg({ tone: 'warn', text: 'Product removed.', undo: () => { setLines(before); setMsg(null) } })
  }
  const moveLine = (key: string, dir: -1 | 1) => {
    setLines(p => {
      const i = p.findIndex(l => l.key === key)
      let j = i + dir
      while (j >= 0 && j < p.length && p[j].area_key !== p[i].area_key) j += dir
      if (j < 0 || j >= p.length) return p
      const next = [...p]; [next[i], next[j]] = [next[j], next[i]]; return next
    })
    touch()
  }
  const removeArea = (key: string) => {
    setAreas(p => p.filter(a => a.key !== key))
    setLines(p => p.map(l => (l.area_key === key ? { ...l, area_key: null } : l)))
    touch()
  }
  const groups: { area: QuoteArea | null; lines: QuoteLine[] }[] = [
    ...areas.map(a => ({ area: a, lines: lines.filter(l => l.area_key === a.key) })),
    { area: null, lines: lines.filter(l => !l.area_key || !areas.some(a => a.key === l.area_key)) },
  ]
  // The pictures in the order they are on the page: the pop-up's ← and → follow it.
  const unit = h.dimension_unit
  const viewerItems = viewerItemsOf(groups.flatMap(g => g.lines), unit)
  const viewerAt = viewing ? viewerItems.findIndex(x => x.key === viewing) : -1
  const goTo = (target: string) => document.getElementById(target)?.scrollIntoView({ block: 'center' })
  const waiting = needsYou(base)

  const actions = (
    <>
      <StatusPill status={base.status} />
      {dirty ? <span className={s.dirty}>Unsaved changes</span> : <span className={`${s.small} ${s.muted}`}><Check size={13} aria-hidden /> Saved</span>}
      <span className={`${s.hdrTotal} ${s.hideOnPhone}`}><span className={s.muted}>Total</span> <b className={s.num}>{formatINR(totals.grand)}</b> <span className={s.muted}>incl. GST</span></span>
      <Link className={s.btn} href={`/quotations/${id}/print`} target="_blank"><Printer size={15} aria-hidden /> Print / PDF</Link>
      {editable && <button className={`${s.btn} ${s.btnPrimary}`} onClick={save} disabled={!dirty || saving}><Save size={15} aria-hidden /> {saving ? 'Saving…' : 'Save'}</button>}
    </>
  )

  const body = (
    <div className={s.wrap}>
      {msg && (
        <div className={`${s.notice} ${msg.tone === 'ok' ? s.noticeOk : msg.tone === 'bad' ? s.noticeBad : s.noticeWarn}`} role={msg.tone === 'bad' ? 'alert' : 'status'}>
          <div className={s.row}><span>{msg.text}</span>{msg.undo && <button className={`${s.btn} ${s.btnSm}`} onClick={msg.undo}>Undo</button>}<span className={s.spacer} /><button className={s.iconBtn} onClick={() => setMsg(null)} aria-label="Dismiss"><X size={14} /></button></div>
        </div>
      )}
      {!base.may_edit && <div className={s.notice}>You can read this quotation. Only its owner, or someone with Edit and See all, can change it.</div>}
      {base.may_edit && LOCKED.includes(base.status) && <div className={`${s.notice} ${s.noticeWarn}`}>This quotation is {STATUS_LABEL[base.status].toLowerCase()} and cannot be changed. {base.status !== 'confirmed' || access.admin ? 'Reopen it from the Status bar to edit.' : 'Only an administrator can reopen it.'}</div>}

      {waiting.length > 0 && (
        <div className={`${s.notice} ${s.noticeWarn} ${s.needs}`} role="status">
          <Info size={16} aria-hidden />
          <ul>
            {waiting.map(w => (
              <li key={w.key}><span><b>Needs you:</b> {w.text}</span><button type="button" className={`${s.btn} ${s.btnSm}`} onClick={() => goTo(w.target)}>Go there ↓</button></li>
            ))}
          </ul>
        </div>
      )}

      <section className={s.card} aria-labelledby="q-client">
        <div className={s.statusBar}>
          <span className={s.lab}>Status</span>
          <StatusPill status={base.status} />
          <span className={s.spacer} />
          {base.may_edit && (
            <>
              {base.status === 'draft' && <button className={`${s.btn} ${s.btnSm}`} disabled={busy} onClick={() => moveTo('sent')}>Mark sent</button>}
              {(base.status === 'sent' || base.status === 'draft') && <button className={`${s.btn} ${s.btnSm}`} disabled={busy} onClick={() => moveTo('negotiating')}>Negotiating</button>}
              {!LOCKED.includes(base.status) && <button className={`${s.btn} ${s.btnSm}`} disabled={busy || dirty} onClick={() => moveTo('confirmed')} title="Confirmed without making a PI from it">Confirmed, no PI</button>}
              {!LOCKED.includes(base.status) && <button className={`${s.btn} ${s.btnSm}`} disabled={busy} onClick={() => setLostNote('')}>Lost…</button>}
              {base.status !== 'archived' && base.status !== 'confirmed' && <button className={`${s.btn} ${s.btnSm}`} disabled={busy} onClick={() => moveTo('archived')}>Archive</button>}
              {LOCKED.includes(base.status) && (base.status !== 'confirmed' || access.admin) && <button className={`${s.btn} ${s.btnSm}`} disabled={busy} onClick={() => moveTo('negotiating')}>Reopen</button>}
            </>
          )}
          {lostNote !== null && (
            <div className={s.lostBox}>
              <label className={s.field}><span>Why was it lost?</span><input id="q-lost" className={s.input} value={lostNote} onChange={e => setLostNote(e.target.value)} placeholder="Price, went elsewhere, project paused…" autoFocus /></label>
              <div className={s.row}><button className={`${s.btn} ${s.btnSm} ${s.btnDanger}`} disabled={busy || lostNote.trim().length < 3} onClick={() => { moveTo('lost', lostNote); setLostNote(null) }}>Mark lost</button><button className={`${s.btn} ${s.btnSm}`} onClick={() => setLostNote(null)}>Cancel</button></div>
            </div>
          )}
          {base.may_edit && dirty && !LOCKED.includes(base.status) && <span className={`${s.small} ${s.muted}`} style={{ flexBasis: '100%' }}>Save your changes before confirming.</span>}
        </div>
        <div className={s.cardHead}><h2 id="q-client">Client</h2><span className={`${s.small} ${s.muted}`}>Basic details. The rest is under Advanced client details.</span></div>
        <div className={s.cardBody}>
          <div className={s.clientGrid}>
            <label className={s.field}><span>Client name *</span><input id="q-client-name" className={s.input} value={h.client_name} onChange={e => updH('client_name', e.target.value)} disabled={!editable} /></label>
            <label className={s.field}><span>Contact person</span><input id="q-contact" className={s.input} value={h.contact_name} onChange={e => updH('contact_name', e.target.value)} disabled={!editable} /></label>
            <label className={s.field}><span>Contact phone</span><input id="q-phone" className={s.input} value={h.contact_phone} inputMode="tel" onChange={e => updH('contact_phone', e.target.value)} disabled={!editable} /></label>
            <label className={s.field}><span>Email ID</span><input id="q-email" className={s.input} type="email" inputMode="email" autoComplete="off" maxLength={160} placeholder="name@company.com" value={h.client_email} onChange={e => updH('client_email', e.target.value)} disabled={!editable} /></label>
            <label className={s.field}><span>Delivery state</span><input id="q-state" className={s.input} list="q-states" value={h.supply_state} disabled={!editable}
              onChange={e => { const v = e.target.value; setH(p => (p ? { ...p, supply_state: v, gst_mode: SUPPLY_STATES.some(x => x.toLowerCase() === v.trim().toLowerCase()) ? gstModeForState(v) : p.gst_mode } : p)); touch() }} />
              <datalist id="q-states">{SUPPLY_STATES.map(x => <option key={x} value={x} />)}</datalist>
              <span className={s.taxChip}>Tax: {h.gst_mode === 'igst' ? 'IGST (outside Rajasthan)' : 'CGST + SGST (within Rajasthan)'}</span></label>
          </div>
          {h.supply_state && gstModeForState(h.supply_state) !== h.gst_mode && <div className={`${s.notice} ${s.noticeWarn}`} style={{ marginTop: 12 }}>Delivery to {h.supply_state} is normally {gstModeForState(h.supply_state) === 'igst' ? 'IGST' : 'CGST + SGST'}: BOE is registered in Rajasthan. Check before sending (GST type is under Advanced client details).</div>}
          <button type="button" className={s.advBtn} aria-expanded={advOpen} aria-controls="q-advanced" onClick={() => setAdvOpen(o => !o)}>
            {advOpen ? <ChevronDown size={16} aria-hidden /> : <ChevronRight size={16} aria-hidden />} Advanced client details <span className={s.hintTxt}>Company, client type, project, their role, GST, GSTIN</span>
          </button>
          {advOpen && (
            <div id="q-advanced" className={s.advBody}>
              <label className={s.field}><span>Company name</span><input id="q-company" className={s.input} maxLength={160} value={h.company_name} onChange={e => updH('company_name', e.target.value)} disabled={!editable} /></label>
              <label className={s.field}><span>Client type</span><select id="q-type" className={s.input} value={h.client_type} onChange={e => updH('client_type', e.target.value)} disabled={!editable}><option value="">Choose…</option>{CLIENT_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
              <label className={s.field}><span>Project</span><input id="q-project" className={s.input} value={h.project_name} onChange={e => updH('project_name', e.target.value)} disabled={!editable} /></label>
              <label className={s.field}><span>Their role</span><input id="q-role" className={s.input} value={h.contact_role} onChange={e => updH('contact_role', e.target.value)} disabled={!editable} /></label>
              <label className={s.field}><span>GST type</span><select id="q-gst" className={s.input} value={h.gst_mode} onChange={e => updH('gst_mode', e.target.value as Header['gst_mode'])} disabled={!editable}><option value="igst">IGST (outside Rajasthan)</option><option value="cgst_sgst">CGST + SGST (within Rajasthan)</option></select></label>
              <label className={s.field}><span>GSTIN</span><input id="q-gstin" className={s.input} maxLength={20} autoComplete="off" value={h.client_gstin} onChange={e => updH('client_gstin', e.target.value.toUpperCase())} disabled={!editable} /></label>
            </div>
          )}
        </div>
      </section>

      <section className={s.card} aria-labelledby="q-products">
        <div className={s.cardHead}>
          <h2 id="q-products">Products</h2><span className={s.chip}>{lines.length} lines · {totals.pieces.toLocaleString('en-IN')} pieces</span>
          <span className={`${s.chip} ${s.phoneOnly}`}>Total {formatINR(totals.grand)}</span><span className={s.spacer} />
          <span className={s.segLab} id="q-unit-label">Dimensions in</span>
          <span className={s.seg} role="group" aria-labelledby="q-unit-label">
            {DIMENSION_UNITS.map(u => (
              <button key={u.value} type="button" aria-pressed={unit === u.value} disabled={!editable} onClick={() => unit !== u.value && updH('dimension_unit', u.value)}>{u.label}</button>
            ))}
          </span>
          {editable && <button className={`${s.btn} ${s.btnSm}`} onClick={() => { const k = newKey(); setAreas(p => [...p, { key: k, name: `Room type ${p.length + 1}`, style: '', multiplier: 1, unit_label: 'rooms' }]); setLines(p => [...p, blankLine(k, startRate)]); touch() }}><Plus size={14} aria-hidden /> Room type</button>}
          {editable && profile && <button className={`${s.btn} ${s.btnSm}`} onClick={() => setImporting(true)}><FileUp size={14} aria-hidden /> Import client file</button>}
        </div>
        {groups.map((g, gi) => (g.area || g.lines.length > 0 || areas.length === 0) && (
          <div key={g.area?.key ?? `none${gi}`}>
            <div className={s.areaHead}>
              {g.area ? (
                <>
                  <input aria-label="Room type name" className={s.input} style={{ maxWidth: 220, fontWeight: 700 }} value={g.area.name} onChange={e => updArea(g.area!.key, { name: e.target.value })} disabled={!editable} />
                  <input aria-label="Style" className={s.input} style={{ maxWidth: 150 }} placeholder="Style (e.g. Boho)" value={g.area.style} onChange={e => updArea(g.area!.key, { style: e.target.value })} disabled={!editable} />
                  <span className={s.small}>×</span>
                  <input aria-label={`Number of ${g.area.unit_label}`} className={`${s.input} ${s.mult}`} type="number" min={1} value={g.area.multiplier} onChange={e => updArea(g.area!.key, { multiplier: Math.max(1, Math.floor(Number(e.target.value) || 1)) })} disabled={!editable} />
                  <input aria-label="Unit" className={s.input} style={{ maxWidth: 90 }} value={g.area.unit_label} onChange={e => updArea(g.area!.key, { unit_label: e.target.value || 'rooms' })} disabled={!editable} />
                </>
              ) : <b>{areas.length ? 'Not in a room type' : 'Products'}</b>}
              <span className={s.spacer} />
              <b className={s.num}>{formatINR(totals.areaTotal[g.area?.key ?? ''] ?? 0)}</b>
              {editable && <button className={`${s.btn} ${s.btnSm}`} onClick={() => { setLines(p => [...p, blankLine(g.area?.key ?? null, startRate)]); touch() }}><Plus size={14} aria-hidden /> Product</button>}
              {editable && g.area && <button className={s.iconBtn} onClick={() => removeArea(g.area!.key)} aria-label={`Remove room type ${g.area.name}`} title="Remove the room type (its products stay, outside any room type)"><Trash2 size={15} /></button>}
            </div>
            {g.lines.map((l, li) => (
              <LineRow key={l.key} l={l} area={g.area} unit={unit} editable={editable} qty={totals.lineQty[l.key] ?? 0} total={totals.lineTotal[l.key] ?? 0}
                first={li === 0} last={li === g.lines.length - 1} url={p => pictureUrl(supabase, p)}
                onChange={patch => updLine(l.key, patch)} onUpload={f => upload(l.key, f)} onImprove={() => setStudioFor(l.key)} onView={() => setViewing(l.key)}
                hint={hintFor.get(l.name.trim())} model={modelFor.get(l.key)} onRemove={() => removeLine(l.key)}
                feedbackCtx={{ clientType: h?.client_type ?? null, quotationId: id, isDesk: access.admin || (access.edit && access.view_all) }}
                onMove={dir => moveLine(l.key, dir)} onDuplicate={() => { setLines(p => { const i = p.findIndex(x => x.key === l.key); const n = [...p]; n.splice(i + 1, 0, { ...l, key: newKey() }); return n }); touch() }} />
            ))}
          </div>
        ))}
      </section>

      <section className={s.card} aria-labelledby="q-extra">
        <div className={s.cardHead}><h2 id="q-extra">Adjustments and totals</h2></div>
        <div className={s.cardBody}>
          <div className={s.totGrid}>
            <div style={{ display: 'grid', gap: 12, alignContent: 'start' }}>
              <div className={s.grid4}>
                <label className={s.field}><span>Discount %</span><input id="q-disc" className={`${s.input} ${s.money}`} type="number" min={0} max={100} step={0.5} value={h.discount_pct} onChange={e => updH('discount_pct', Math.max(0, Math.min(100, Number(e.target.value) || 0)))} disabled={!editable} /></label>
                <label className={s.field}><span>Fabric (₹)</span><input id="q-fabric" className={`${s.input} ${s.money}`} type="number" min={0} value={h.fabric_amount || ''} placeholder="0" onChange={e => updH('fabric_amount', Math.max(0, Math.round(Number(e.target.value) || 0)))} disabled={!editable} /></label>
                <label className={s.field}><span>Packing (₹)</span><input id="q-packing" className={`${s.input} ${s.money}`} type="number" min={0} value={h.packing_amount || ''} placeholder="0" onChange={e => updH('packing_amount', Math.max(0, Math.round(Number(e.target.value) || 0)))} disabled={!editable} /></label>
                <label className={s.field}><span>Transport</span><input id="q-transport" className={s.input} value={h.transport_note} placeholder="As per actual" onChange={e => updH('transport_note', e.target.value)} disabled={!editable} /></label>
              </div>
              <div className={`${s.small} ${s.muted}`}>Valid until {formatDateIN(validUntil(issued, h.valid_days))}{base.sent_at ? '' : ' (counted from the day it is sent)'}</div>
            </div>
            <div className={s.sumBox}>
              <table className={s.sum}><tbody>
                <tr><td>Products</td><td>{formatINR(totals.subtotal)}</td></tr>
                {totals.discount > 0 && <tr><td>Discount {h.discount_pct}%</td><td>− {formatINR(totals.discount)}</td></tr>}
                {h.fabric_amount > 0 && <tr><td>Fabric</td><td>{formatINR(h.fabric_amount)}</td></tr>}
                {h.packing_amount > 0 && <tr><td>Packing</td><td>{formatINR(h.packing_amount)}</td></tr>}
                <tr className={s.hr}><td>Before GST</td><td>{formatINR(totals.taxable)}</td></tr>
                <tr className={s.gstRow}>
                  <td><label htmlFor="q-gst-rate">GST rate <span className={`${s.small} ${s.muted}`}>(all products)</span></label></td>
                  <td>
                    <select id="q-gst-rate" className={`${s.input} ${s.gstSel}`} value={uniformRate ?? (lines.length === 0 ? newRate : 'mixed')} onChange={e => setAllRates(Number(e.target.value))} disabled={!editable}>
                      {uniformRate === null && lines.length > 0 && <option value="mixed" disabled>Mixed rates</option>}
                      {GST_RATES.map(r => <option key={r} value={r}>{r}%</option>)}
                    </select>
                  </td>
                </tr>
                {totals.gst.flatMap(r => h.gst_mode === 'cgst_sgst'
                  ? [<tr key={`c${r.rate}`} className={s.sub}><td>CGST {r.rate / 2}%</td><td>{formatINR(r.cgst)}</td></tr>, <tr key={`s${r.rate}`} className={s.sub}><td>SGST {r.rate / 2}%</td><td>{formatINR(r.sgst)}</td></tr>]
                  : [<tr key={`i${r.rate}`} className={s.sub}><td>IGST {r.rate}%</td><td>{formatINR(r.igst)}</td></tr>])}
                <tr className={s.tot}><td>Grand total</td><td>{formatINR(totals.grand)}</td></tr>
              </tbody></table>
            </div>
          </div>
        </div>
      </section>

      <section className={s.card} aria-labelledby="q-terms">
        <div className={s.cardHead}><h2 id="q-terms">Terms and notes</h2></div>
        <div className={s.cardBody} style={{ display: 'grid', gap: 12 }}>
          <div className={s.grid2}>
            <label className={s.field}><span>Notes the client sees</span><textarea id="q-notes" className={s.input} rows={3} value={h.notes} placeholder={DEFAULT_CLIENT_NOTE} onChange={e => updH('notes', e.target.value)} disabled={!editable} /></label>
            <label className={s.field}><span>Internal notes (never shown to the client)</span><textarea id="q-internal" className={s.input} rows={3} value={h.internal_notes} onChange={e => updH('internal_notes', e.target.value)} disabled={!editable} /></label>
          </div>
          {editable && !h.notes && <div><button className={`${s.btn} ${s.btnSm}`} onClick={() => updH('notes', DEFAULT_CLIENT_NOTE)}>Use the standard note</button></div>}
          <details className={s.stdTerms}>
            <summary><ChevronRight size={16} className={s.chev} aria-hidden /> Standard terms printed with every quotation <span className={s.hintTxt}>{EXPECTATIONS.length} expectations and {TERMS.length} terms, word for word. Read only.</span></summary>
            <div className={s.termsBody}>
              <h3>{EXPECTATIONS_TITLE}</h3>
              <dl>{EXPECTATIONS.map(x => <div key={x.title}><dt>{x.title}</dt><dd>{x.text}</dd></div>)}</dl>
              <h3>Terms and Conditions</h3>
              <dl>{TERMS.map(x => <div key={x.title}><dt>{x.title}</dt><dd>{x.text}</dd></div>)}</dl>
              <p className={s.muted}>{CLOSING}</p>
            </div>
          </details>
        </div>
      </section>

      <div className={s.bottom}>
        <div className={s.bcol}>
          <section className={s.card}>
            <div className={s.cardHead}><h2>Share with the client</h2></div>
            <div className={s.cardBody} style={{ display: 'grid', gap: 10 }}>
              {!base.share_token && <div className={s.small}>One link shows the quotation with pictures and a Save as PDF button. No login needed. Turning it on marks a draft as Sent.</div>}
              {base.share_token && (
                <>
                  <div className={s.linkBox}><input id="q-link" className={s.input} value={link} readOnly aria-label="Client link" onFocus={e => e.currentTarget.select()} /><button className={s.iconBtn} onClick={copy} aria-label="Copy link">{copied ? <Check size={16} /> : <Copy size={16} />}</button></div>
                  <a className={`${s.btn} ${s.btnPrimary}`} href={whatsappLink(h.contact_phone, waText)} target="_blank" rel="noreferrer"><MessageCircle size={15} aria-hidden /> Open WhatsApp with the message</a>
                  <div className={`${s.small} ${s.muted}`}>WhatsApp opens with the text ready{h.contact_phone ? ` for ${h.contact_phone}` : ''}; you press send. The link always shows the latest saved version.</div>
                </>
              )}
              {base.may_edit && (dirty ? <div className={`${s.small} ${s.dirty}`}>Save first, then share.</div>
                : base.share_token
                  ? <button className={`${s.btn} ${s.btnSm}`} disabled={busy} onClick={() => act(() => shareQuotation(supabase, id, false), 'The client link is off.')}>Turn the link off</button>
                  : <button className={`${s.btn} ${s.btnPrimary}`} disabled={busy || lines.length === 0 || base.status === 'archived' || !!base.price?.blocked} title={base.price?.blocked ? 'Waiting for price approval' : undefined} onClick={() => act(() => shareQuotation(supabase, id, true), 'The client link is on.')}><Link2 size={15} aria-hidden /> Create client link</button>)}
            </div>
          </section>
          {profile && <RequestCard id={REQUEST_CARD_ID} supabase={supabase} base={base} userId={profile.id} dirty={dirty} onDone={text => { setMsg({ tone: 'ok', text }); quoteQ.refetch() }} />}
          <VersionsCard supabase={supabase} base={base} dirty={dirty} busy={busy} onSent={text => { setMsg({ tone: 'ok', text }); quoteQ.refetch() }} />
        </div>
        <div className={s.bcol}>
          <PriceCard id={PRICE_CARD_ID} price={base.price} mayEdit={base.may_edit} dirty={dirty} busy={busy}
            onAsk={() => act(() => requestPriceApproval(supabase, id), 'Sent to the pricing desk.')}
            onDecide={(approve, note) => act(() => decidePrice(supabase, id, approve, note), approve ? 'Prices approved.' : 'Sent back to the salesperson.')} />
          <PiCard base={base} dirty={dirty} busy={busy} stage={piStage} onConfirm={confirmToPi} onDownload={downloadPi} />
          <section className={s.card}>
            <div className={s.cardHead}><h2>History</h2></div>
            <div className={s.cardBody} style={{ paddingTop: 4, paddingBottom: 4 }}>
              {base.events.length === 0 && <div className={s.small}>Nothing yet.</div>}
              {base.events.slice(0, 12).map((e, i) => (
                <div key={i} className={s.event}><span className={s.muted} style={{ minWidth: 92 }}>{formatDateIN(istDateOf(e.at))}</span><span>{describe(e)}{e.actor_name ? ` · ${e.actor_name}` : ''}</span></div>
              ))}
            </div>
          </section>
        </div>
      </div>

      {importing && profile && (
        <ImportDialog supabase={supabase} userId={profile.id} areas={areas} onClose={() => setImporting(false)}
          onAdd={(nextAreas, added) => { setAreas(nextAreas); setLines(p => [...p.filter(l => l.name.trim() || l.unit_price !== null), ...added.map(l => ({ ...l, tax_rate: startRate }))]); touch(); setImporting(false); setMsg({ tone: 'ok', text: `Added ${added.length} products. Check them, add prices, then Save.` }) }} />
      )}
      {studioFor && profile && (() => {
        const line = lines.find(x => x.key === studioFor)
        return line?.image_path ? (
          <StudioDialog supabase={supabase} userId={profile.id} path={line.image_path} url={p => pictureUrl(supabase, p)} onClose={() => setStudioFor(null)}
            onUse={p => { updLine(line.key, { image_path: p }); setStudioFor(null); setMsg({ tone: 'ok', text: 'Picture changed. Save to keep it.' }) }} />
        ) : null
      })()}
      {viewing && viewerAt >= 0 && (
        <PictureViewer items={viewerItems} index={viewerAt} url={p => pictureUrl(supabase, p)} onIndex={i => setViewing(viewerItems[i]?.key ?? null)} onClose={() => setViewing(null)} />
      )}
    </div>
  )
  return layout(base.quote_no, body, `${h.project_name || h.client_name}${base.owner_name ? ` · ${base.owner_name}` : ''}`, actions)
}

function describe(e: { kind: string; detail: Record<string, unknown> }): string {
  switch (e.kind) {
    case 'created': return e.detail.from_request ? 'Started from a quotation request' : 'Started'
    case 'saved': return `Saved: ${e.detail.lines ?? 0} lines, ${formatINR(Number(e.detail.value_before_gst ?? 0))} before GST`
    case 'status': return `${STATUS_LABEL[e.detail.from as QuotationStatus] ?? e.detail.from} → ${STATUS_LABEL[e.detail.to as QuotationStatus] ?? e.detail.to}${e.detail.note ? `: ${e.detail.note}` : ''}`
    case 'shared': return 'Client link created'
    case 'unshared': return 'Client link turned off'
    case 'opened': return 'Opened by the client'
    case 'converted': return `Confirmed into PI draft ${e.detail.draft_reference ?? ''}`.trim()
    case 'version': return `Sent as v${e.detail.version_no}${e.detail.note ? `: ${e.detail.note}` : ''}`
    case 'price': return e.detail.decision === 'requested' ? 'Price approval asked' : e.detail.decision === 'approved' ? 'Prices approved' : `Prices sent back${e.detail.note ? `: ${e.detail.note}` : ''}`
    default: return e.kind
  }
}

const PROBLEM_TEXT: Record<ConversionProblem['code'], string> = {
  NO_LINES: 'Add at least one product that is not optional.',
  NAME_MISSING: 'Name these products',
  QTY_MISSING: 'Give a quantity above 0 to',
  PRICE_MISSING: 'Give a price above ₹0 to',
  PICTURE_MISSING: 'Add a picture to (Orders needs one for every product)',
}

/** The PI this quotation became, or Confirm → PI draft; and the PI-format download. Works on the SAVED quotation. */
function PiCard({ base, dirty, busy, stage, onConfirm, onDownload }: {
  base: Quotation; dirty: boolean; busy: boolean; stage: PiStage | null; onConfirm: () => void; onDownload: () => void
}) {
  const problems = conversionProblems(base.areas, base.lines)
  const canConfirm = base.may_edit && !base.pi && (base.status === 'sent' || base.status === 'negotiating')
  const priceBlocked = !!base.price?.blocked
  if (!base.pi && !canConfirm && base.lines.length === 0) return null
  return (
    <section className={s.card}>
      <div className={s.cardHead}><h2>PI draft</h2></div>
      <div className={s.cardBody} style={{ display: 'grid', gap: 8 }}>
        {base.pi && (
          <>
            <div className={s.small}>Confirmed into PI draft <b>{base.pi.draft_reference ?? ''}</b> ({base.pi.status.replace(/_/g, ' ')}).</div>
            <Link className={`${s.btn} ${s.btnPrimary}`} href={draftDetailHref(base.pi.id)}><FileCheck2 size={15} aria-hidden /> Open the PI draft</Link>
          </>
        )}
        {canConfirm && (
          <>
            {problems.length > 0
              ? <div className={`${s.notice} ${s.noticeWarn}`}><b>Before it can become a PI:</b>{problems.map(p => <div key={p.code}>{PROBLEM_TEXT[p.code]}{p.lines.length ? `: ${p.lines.slice(0, 6).join(', ')}${p.lines.length > 6 ? ` and ${p.lines.length - 6} more` : ''}` : ''}</div>)}</div>
              : <div className={s.small}>Makes a PI draft in Orders from the saved quotation, through the same checks as an uploaded PI, then opens it. Optional products are left out.</div>}
            <button className={`${s.btn} ${s.btnPrimary}`} disabled={busy || dirty || problems.length > 0 || priceBlocked} onClick={onConfirm}>
              <FileCheck2 size={15} aria-hidden /> {stage ? PI_STAGE_LABEL[stage] : 'Confirm → make PI draft'}
            </button>
            {dirty && <div className={`${s.small} ${s.dirty}`}>Save first, then confirm.</div>}
            {priceBlocked && <div className={`${s.small} ${s.muted}`}>Waiting for price approval (see Price approval).</div>}
          </>
        )}
        {!base.pi && !canConfirm && base.may_edit && base.status === 'draft' && <div className={`${s.small} ${s.muted}`}>Send it (or mark it Negotiating) before confirming it into a PI.</div>}
        {base.lines.length > 0 && (
          <button className={`${s.btn} ${s.btnSm}`} disabled={busy || dirty} onClick={onDownload}><FileSpreadsheet size={15} aria-hidden /> Download in PI format (.xlsx)</button>
        )}
      </div>
    </section>
  )
}
