'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppLink as Link } from '@/components/ui/AppLink'
import { useParams, useRouter } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchLibrary, photoUrl, trainingKeys } from '@/lib/pricing/training/api'
import { sendFeedback, type FeedbackDoc } from '@/lib/pricing/learning/api'
import type { DiffersReport } from '@/components/pricing/training/TaughtPrice'
import { Check, ChevronRight, FileUp, Info, Plus, Printer, Save, Trash2, X } from 'lucide-react'
import { draftDetailHref } from '@/lib/orders/draftsView'
import { saveProblem } from '@/lib/quotations/saveCheck'
import { fetchVersions, issuedAt } from '@/lib/quotations/versions'
import { askBeforeLeaving } from '@/lib/navigation/leaveGuard'
import { conversionProblems } from '@/lib/quotations/piWorkbook'
import { extrasLeftOutText, makePiDraft, type PiStage } from '@/lib/quotations/toPiDraft'
import { stateOfCity } from '@/lib/quotations/cities'
import { QuotationsLayout } from '@/components/layout/QuotationsLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { useQuotations } from '@/hooks/useQuotations'
import { useDisplaySubject } from '@/hooks/queries/useDisplaySubject'
import { canAccessManagementModule } from '@/lib/permissions/moduleVisibility'
import { formatINR } from '@/lib/currency'
import { istDateOf } from '@/lib/istDate'
import {
  STATUS_LABEL, errorKind, errorText, fetchQuotation, pictureUrl, quotationKeys, saveDoc, saveQuotation,
  setStatus as setStatusRpc, shareQuotation, fetchHints, requestPriceApproval, decidePrice, type PriceHint, uploadPicture, type Header, type Quotation, type QuotationStatus,
  fetchSuggestionSettings,
} from '@/lib/quotations/api'
import { historyOnly } from '@/lib/quotations/suggestions'
import {
  DIMENSION_UNITS, GST_RATES, SUPPLY_STATES, computeTotals, formatDateIN, gstModeForState, validUntil,
  type QuoteArea, type QuoteLine,
} from '@/lib/quotations/math'
import { CLOSING, DEFAULT_CLIENT_NOTE, EXPECTATIONS, EXPECTATIONS_TITLE, TERMS } from '@/lib/quotations/terms'
import { needsYou, PRICE_CARD_ID, REQUEST_CARD_ID } from '@/lib/quotations/needsYou'
import { ImportDialog } from './ImportDialog'
import { WANTS } from '@/lib/quotations/importBoq'
import { StatusPill } from './ListScreen'
import { StudioDialog } from './StudioDialog'
import { VersionsCard } from './VersionsCard'
import { RequestCard } from './RequestCard'
import { PriceCard } from './PricingDesk'
import { LineRow } from './ProductLine'
import { effectiveLeadTime } from './LeadTime'
import { StatusCard, LOCKED } from './StatusCard'
import { ShareCard } from './ShareCard'
import { ClientCard } from './ClientCard'
import { PictureViewer, viewerItemsOf } from './PictureViewer'
import { MyDetailsReminder } from './MyDetails'
import { productType } from '@/lib/pricing/features'
import { priceLine, type ModelSuggestion } from '@/lib/pricing/model'
import { fetchPool, poolWords } from '@/lib/pricing/pool'
import s from './quotations.module.css'

const newKey = () => `n${Math.random().toString(36).slice(2, 10)}`
const blankLine = (area_key: string | null, tax_rate: number): QuoteLine => ({
  key: newKey(), area_key, name: '', size_text: '', spec: '', material: '', finish: '', category: '',
  qty_mode: 'per_unit', qty: 1, unit_price: null, tax_rate, image_path: null, is_optional: false, client_note: '', internal_note: '',
})
const EMAIL_OK = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const EMAIL_PROBLEM = 'Check the email address.'
type Msg = { tone: 'ok' | 'bad' | 'warn'; text: string; undo?: () => void } | null

export default function BuilderScreen() {
  const { id } = useParams<{ id: string }>()
  const { supabase, profile, loading, signOut, access, accessLoaded, notSetUp } = useQuotations()
  // "Why?" under a suggested price, with the way to correct the logic, is for the Pricing module's people (owner, 15 Nov 2026):
  // Admin, or switched on per person in Control Center → Access. Decided the way ModuleGuard decides entry to /pricing.
  const subject = useDisplaySubject()
  const seesWhy = subject.ready && canAccessManagementModule({ role: subject.subjectRole, moduleKey: 'pricing', isModuleActive: true, permissions: subject.subjectPermissionsByModule.get('pricing') ?? [] })
  const qc = useQueryClient()
  const quoteQ = useQuery({ queryKey: quotationKeys.one(id), queryFn: () => fetchQuotation(supabase, id), enabled: accessLoaded, retry: false })
  // The same read (and key) as the Versions card, so it costs no extra call: the newest sent version dates the quotation.
  const versionsQ = useQuery({ queryKey: ['quotations', 'versions', id, quoteQ.data?.updated_at], queryFn: () => fetchVersions(supabase, id), enabled: accessLoaded && !!quoteQ.data, retry: false })

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
  // WHO SEES THE SUGGESTED PRICES (owner, 18 Nov 2026; Control Center › Sales › Quotation price approval): off for this person,
  // the suggestion, its model and the taught-price picker are left out and only the history (last ordered / quoted) shows. A
  // database without 20270731000000 answers with an error, which keeps them on, as before. Off until the answer is in.
  const suggQ = useQuery({ queryKey: ['quotations', 'suggestions'], queryFn: () => fetchSuggestionSettings(supabase), enabled: accessLoaded && !notSetUp, staleTime: 300_000, retry: false })
  const suggestOn = suggQ.isError ? true : !!suggQ.data?.for_me
  const hintsQ = useQuery({ queryKey: ['quotations', 'hints', id, hintNames], queryFn: () => fetchHints(supabase, hintNames.split('\n'), id), enabled: accessLoaded && !notSetUp && hintNames !== '', staleTime: 300_000, retry: false })
  const hintFor = useMemo(() => new Map<string, PriceHint>((hintsQ.data ?? []).map(h => [h.name, h])), [hintsQ.data])
  // Pricing model v2: one pool for every product type on screen, then each line priced for its own parameters.
  const typeWords = useMemo(() => poolWords(hintNames.split('\n').map(productType).filter((t): t is string => !!t)).join(' '), [hintNames])
  const poolQ = useQuery({ queryKey: ['quotations', 'pool', id, typeWords], queryFn: () => fetchPool(supabase, typeWords.split(' '), id), enabled: accessLoaded && !notSetUp && suggestOn && typeWords !== '', staleTime: 300_000, retry: false })
  // Pricing > Training: the submitted cases a line can be told it is. Until 20270726000000 is applied the read fails and nothing shows.
  const libraryQ = useQuery({ queryKey: trainingKeys.library, queryFn: () => fetchLibrary(supabase), enabled: accessLoaded && !notSetUp && suggestOn, staleTime: 300_000, retry: false })
  // The reason for a price that differs from the taught one also goes to the Price learning inbox. If that send fails the reason is
  // still on the line (in its note), where Pricing > Price logic reads it.
  const taught = useMemo(() => libraryQ.data && {
    library: libraryQ.data, photo: (p: string) => photoUrl(supabase, p),
    differs: (r: DiffersReport, line: FeedbackDoc['line']) => {
      void sendFeedback(supabase, { source: 'quotation', kind: 'differs_taught', comment: r.note || null, expected_price: r.quoted, line, client_type: null, quotation_id: id,
        suggestion: { taught: { case_id: r.caseId, case_no: r.caseNo, case_name: r.caseName, price: r.taught, quoted: r.quoted, reason: r.reason } } }).catch(() => {})
    },
  }, [libraryQ.data, supabase, id])
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
      : h.client_email.trim() && !EMAIL_OK.test(h.client_email.trim()) ? EMAIL_PROBLEM
      : null
    // Says which room type or product, and brings that product into view (saveCheck.ts).
    const onLine = problem ? null : saveProblem(areas, lines)
    if (onLine) {
      setMsg({ tone: 'bad', text: onLine.text })
      if (onLine.lineKey) document.getElementById(`line-${onLine.lineKey}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      return
    }
    // The email box lives in the advanced section: open it, or the message points at a box nobody can see.
    if (problem) { if (problem === EMAIL_PROBLEM) setAdvOpen(true); setMsg({ tone: 'bad', text: problem }); return }
    setSaving(true)
    try {
      const r = await saveQuotation(supabase, base.id, saveDoc({ ...h, lead_time_weeks: effectiveLeadTime(h, areas) }, areas, lines, base.updated_at))
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
    const onLink = askBeforeLeaving(() => dirtyRef.current)
    window.addEventListener('keydown', onKey)
    window.addEventListener('beforeunload', onLeave)
    document.addEventListener('click', onLink, true)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('beforeunload', onLeave); document.removeEventListener('click', onLink, true) }
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
      // Some of the client's extra pictures did not fit: say so here (and stay) rather than lose the note on the way to the draft.
      if (!r.linkError && !r.extrasLeftOut) { router.push(draftDetailHref(r.submissionId)); return }
      setMsg({ tone: 'warn', text: r.linkError
        ? `The PI draft was made (Orders → PI Drafts), but this quotation could not be linked to it: ${r.linkError}`
        : `The PI draft was made (Orders → PI Drafts). ${extrasLeftOutText(r.extrasLeftOut)}` })
      await quoteQ.refetch()
    } catch (e) {
      setMsg({ tone: 'bad', text: errorText(e) })
    } finally { setBusy(false); setPiStage(null) }
  }

  if (loading) return <LoadingScreen />
  const layout = (title: string, body: React.ReactNode, subtitle?: string, actions?: React.ReactNode) => (
    <QuotationsLayout profile={profile} access={access} onSignOut={signOut} title={title} subtitle={subtitle} actions={actions} contentMaxWidth={1360}>{body}</QuotationsLayout>
  )
  if (notSetUp) return layout('Quotation', <div className={`${s.notice} ${s.noticeWarn}`}><b>Quotations is being set up.</b> Its database part has not been applied yet.</div>)
  if (quoteQ.isError) return layout('Quotation', <div className={`${s.notice} ${s.noticeBad}`}>{errorText(quoteQ.error)} <Link href="/quotations">Back to quotations</Link></div>)
  if (!base || !h || !totals) return <LoadingScreen />

  const issued = istDateOf(issuedAt(versionsQ.data, base.sent_at, base.created_at))
  const link = base.share_token ? `${typeof window === 'undefined' ? '' : window.location.origin}/q/${base.share_token}` : ''
  const waText = `Hello${h.contact_name ? ' ' + h.contact_name.split(' ')[0] : ''}, here is our quotation ${base.quote_no} for ${h.project_name || h.client_name}: ${formatINR(totals.grand)} including GST, valid until ${formatDateIN(validUntil(issued, h.valid_days))}.\nView it with pictures and save the PDF here: ${link}\n– ${profile?.full_name ?? ''}, Best of Exports`
  const copy = async () => {
    try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 1800) }
    catch { (document.getElementById('q-link') as HTMLInputElement | null)?.select() }
  }
  // The plain Excel of the saved quotation for the client: lines, quantity, price and totals, no pictures (never the internal PI sheet).
  const downloadExcel = async () => {
    if (busy) return
    setBusy(true)
    try {
      const [{ clientSheet, clientSheetFileName }, { downloadWorkbook }] = await Promise.all([import('@/lib/quotations/clientSheet'), import('@/lib/finance/expenseReimbursementExport')])
      await downloadWorkbook(clientSheetFileName(base.quote_no), [clientSheet({
        quoteNo: base.quote_no, clientName: h.client_name, projectName: h.project_name, issuedOn: formatDateIN(issued), validUntilOn: formatDateIN(validUntil(issued, h.valid_days)),
        unit: h.dimension_unit, transportNote: h.transport_note, notes: h.notes,
      }, h, areas, lines)])
    } catch (e) { setMsg({ tone: 'bad', text: errorText(e) }) }
    finally { setBusy(false) }
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
  // Confirm → PI draft lives in the Status bar (the PI draft card is gone, owner 18 Nov 2026). It works on the SAVED quotation.
  const piProblems = conversionProblems(base.areas, base.lines)
  const canConfirm = base.may_edit && !base.pi && (base.status === 'sent' || base.status === 'negotiating')
  const priceBlocked = !!base.price?.blocked
  // A city the list knows fills in the state, and with it the tax; any other city leaves the state as it is.
  const setCity = (v: string) => {
    const st = stateOfCity(v)
    setH(p => (p ? { ...p, delivery_city: v, ...(st ? { supply_state: st, gst_mode: gstModeForState(st) } : {}) } : p)); touch()
  }
  const setState = (v: string) => {
    setH(p => (p ? { ...p, supply_state: v, gst_mode: SUPPLY_STATES.some(x => x.toLowerCase() === v.trim().toLowerCase()) ? gstModeForState(v) : p.gst_mode } : p)); touch()
  }
  const hasRequest = !!profile && !!base.request

  const actions = (
    <>
      <span className={s.hideOnPhone}><StatusPill status={base.status} /></span>
      {dirty ? <span className={`${s.dirty} ${s.saveState}`}>Unsaved changes</span> : <span className={`${s.small} ${s.muted} ${s.saveState} ${s.hideOnPhone}`}><Check size={13} aria-hidden /> Saved</span>}
      <Link className={s.btn} href={`/quotations/${id}/print`} target="_blank" aria-label="Print / PDF"><Printer size={15} aria-hidden /> <span className={s.hideOnPhone}>Print / PDF</span></Link>
      {editable && <button className={`${s.btn} ${s.btnPrimary}`} onClick={save} disabled={!dirty || saving}><Save size={15} aria-hidden /> {saving ? 'Saving…' : 'Save'}</button>}
    </>
  )

  const body = (
    <div className={`${s.wrap} ${s.builder}`}>
      {msg && (
        <div className={`${s.notice} ${msg.tone === 'ok' ? s.noticeOk : msg.tone === 'bad' ? s.noticeBad : s.noticeWarn}`} role={msg.tone === 'bad' ? 'alert' : 'status'}>
          <div className={s.row}><span>{msg.text}</span>{msg.undo && <button className={`${s.btn} ${s.btnSm}`} onClick={msg.undo}>Undo</button>}<span className={s.spacer} /><button className={s.iconBtn} onClick={() => setMsg(null)} aria-label="Dismiss"><X size={14} /></button></div>
        </div>
      )}
      {/* until the owner has filled in the details their quotations print (20270801000000) */}
      {base.may_edit && profile?.id === base.owner_id && <MyDetailsReminder supabase={supabase} />}
      {!base.may_edit && <div className={s.notice}>You can read this quotation. Only its owner, or someone with Edit and See all, can change it.</div>}
      {base.may_edit && LOCKED.includes(base.status) && <div className={`${s.notice} ${s.noticeWarn}`}>This quotation is {STATUS_LABEL[base.status].toLowerCase()} and cannot be changed. {base.status !== 'confirmed' || access.admin ? 'Reopen it from the Status card to edit.' : 'Only an administrator can reopen it.'}</div>}

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

      {/* the top row (owner-approved layout, 18 Nov 2026): the request, where the quotation is, and sharing, as three compact cards */}
      <div className={`${s.band} ${hasRequest ? '' : s.bandTwo}`}>
        {profile && <RequestCard id={REQUEST_CARD_ID} supabase={supabase} base={base} userId={profile.id} dirty={dirty} onDone={text => { setMsg({ tone: 'ok', text }); quoteQ.refetch() }} />}
        <StatusCard base={base} dirty={dirty} busy={busy} isAdmin={access.admin} canConfirm={canConfirm} piProblems={piProblems} priceBlocked={priceBlocked} piStage={piStage}
          lostNote={lostNote} setLostNote={setLostNote} onMove={moveTo} onConfirm={confirmToPi} />
        <ShareCard id={id} base={base} dirty={dirty} busy={busy} lineCount={lines.length} phone={h.contact_phone} link={link} waText={waText} copied={copied}
          onCopy={copy} onExcel={downloadExcel} onShare={on => act(() => shareQuotation(supabase, id, on), on ? 'The client link is on.' : 'The client link is off.')} />
      </div>

      <ClientCard h={h} areas={areas} editable={editable} advOpen={advOpen} onAdv={() => setAdvOpen(o => !o)} onField={updH}
        onPatch={patch => { setH(p => (p ? { ...p, ...patch } : p)); touch() }} onCity={setCity} onState={setState} />

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
          {editable && profile && <button className={`${s.btn} ${s.btnSm} ${base?.request && !lines.some(l => l.name.trim()) ? s.btnPrimary : ''}`} onClick={() => setImporting(true)}><FileUp size={14} aria-hidden /> Import client file</button>}
        </div>
        {groups.map((g, gi) => (g.area || g.lines.length > 0 || areas.length === 0) && (
          <div key={g.area?.key ?? `none${gi}`}>
            <div className={s.areaHead}>
              {g.area ? (
                <>
                  <input aria-label="Room type name" className={s.input} style={{ maxWidth: 220, fontWeight: 700 }} value={g.area.name} onChange={e => updArea(g.area!.key, { name: e.target.value })} disabled={!editable} />
                  <input aria-label="Style" className={s.input} style={{ maxWidth: 150 }} placeholder="Style (e.g. Boho)" value={g.area.style} onChange={e => updArea(g.area!.key, { style: e.target.value })} disabled={!editable} />
                  <span className={s.small}>×</span>
                  <input aria-label={`Number of ${g.area.unit_label}`} className={`${s.input} ${s.mult}`} type="number" min={1} value={g.area.multiplier || ''} onChange={e => updArea(g.area!.key, { multiplier: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} disabled={!editable} />
                  <input aria-label="Unit" className={s.input} style={{ maxWidth: 90 }} value={g.area.unit_label} onChange={e => updArea(g.area!.key, { unit_label: e.target.value })} onBlur={e => { if (!e.target.value.trim()) updArea(g.area!.key, { unit_label: 'rooms' }) }} disabled={!editable} />
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
                hint={suggestOn ? hintFor.get(l.name.trim()) : historyOnly(hintFor.get(l.name.trim()))} model={suggestOn ? modelFor.get(l.key) : null} taught={suggestOn ? taught : undefined} onRemove={() => removeLine(l.key)}
                feedbackCtx={seesWhy ? { clientType: h?.client_type ?? null, quotationId: id, isDesk: access.admin || (access.edit && access.view_all) } : undefined}
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

      <div className={s.pair}>
      <section className={s.card} aria-labelledby="q-terms">
        <div className={s.cardHead}><h2 id="q-terms">Terms and notes</h2></div>
        <div className={s.cardBody} style={{ display: 'grid', gap: 12 }}>
            <label className={s.field}><span>Notes the client sees</span><textarea id="q-notes" className={s.input} rows={3} value={h.notes} placeholder={DEFAULT_CLIENT_NOTE} onChange={e => updH('notes', e.target.value)} disabled={!editable} /></label>
            <label className={s.field}><span>Internal notes (never shown to the client)</span><textarea id="q-internal" className={s.input} rows={3} value={h.internal_notes} onChange={e => updH('internal_notes', e.target.value)} disabled={!editable} /></label>
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

      <div className={s.bottom}>
        <VersionsCard supabase={supabase} base={base} dirty={dirty} busy={busy} onSent={text => { setMsg({ tone: 'ok', text }); quoteQ.refetch() }} />
        <PriceCard id={PRICE_CARD_ID} price={base.price} mayEdit={base.may_edit} dirty={dirty} busy={busy}
          onAsk={() => act(() => requestPriceApproval(supabase, id), 'Sent to the pricing desk.')}
          onDecide={(approve, note) => act(() => decidePrice(supabase, id, approve, note), approve ? 'Prices approved.' : 'Sent back to the salesperson.')} />
      </div>

      {importing && profile && (
        <ImportDialog supabase={supabase} userId={profile.id} areas={areas} requestId={base?.request?.id} onClose={() => setImporting(false)}
          onAdd={(nextAreas, added) => { setAreas(nextAreas); setLines(p => [...p.filter(l => l.name.trim() || l.unit_price !== null), ...added.map(l => ({ ...l, tax_rate: startRate }))]); touch(); setImporting(false); const priced = added.filter(l => l.unit_price !== null).length; setMsg({ tone: 'ok', text: `Added ${added.length} products${priced ? `, ${priced} with their price` : ''}. Check them${priced < added.length ? ', add the missing prices' : ''}, then Save.` }) }} />
      )}
      {studioFor && profile && (() => {
        const line = lines.find(x => x.key === studioFor)
        return line?.image_path ? (
          <StudioDialog supabase={supabase} userId={profile.id} path={line.image_path} url={p => pictureUrl(supabase, p)} onClose={() => setStudioFor(null)}
            wants={line.spec.split('\n').find(t => t.startsWith(WANTS))?.slice(WANTS.length)} swatch={line.references?.find(r => r.kind === 'swatch')?.path}
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
