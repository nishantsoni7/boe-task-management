'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppLink as Link } from '@/components/ui/AppLink'
import { useParams, useRouter } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchLibrary, fetchRework, photoUrl, trainingKeys, type ReworkAsk } from '@/lib/pricing/training/api'
import { lineWood, pickedCaseNo } from '@/lib/pricing/training/match'
import { sendFeedback, type FeedbackDoc } from '@/lib/pricing/learning/api'
import type { DiffersReport } from '@/components/pricing/training/TaughtPrice'
import { Check, ChevronRight, FileUp, Plus, Save, Trash2, X } from 'lucide-react'
import { draftDetailHref } from '@/lib/orders/draftsView'
import { saveProblem } from '@/lib/quotations/saveCheck'
import { fetchVersions, issuedAt } from '@/lib/quotations/versions'
import { askBeforeLeaving } from '@/lib/navigation/leaveGuard'
import { conversionProblems } from '@/lib/quotations/piWorkbook'
import { extrasLeftOutText, makePiDraft, type PiStage } from '@/lib/quotations/toPiDraft'
import { stateOfCity } from '@/lib/quotations/cities'
import { QuotationsLayout } from '@/components/layout/QuotationsLayout'
import { ModulePageSkeleton } from '@/components/layout/ModulePageSkeleton'
import { OPEN_FRESH_MS } from '@/lib/quotations/openQuotation'
import { useQuotations } from '@/hooks/useQuotations'
import { useDisplaySubject } from '@/hooks/queries/useDisplaySubject'
import { canAccessManagementModule } from '@/lib/permissions/moduleVisibility'
import { formatINR } from '@/lib/currency'
import { istDateOf } from '@/lib/istDate'
import {
  STATUS_LABEL, errorKind, errorText, fetchQuotation, fetchPictureMark, pictureMarkKey, pictureSrc, quotationKeys, setPictureMark, saveDoc, saveQuotation,
  setStatus as setStatusRpc, shareQuotation, fetchHints, requestPriceApproval, decidePrice, type PriceHint, uploadPicture, type Header, type Quotation, type QuotationStatus,
  fetchSuggestionSettings, suggestionsKey, fetchPaymentDetails, deleteCheckKey, fetchDeleteCheck,
} from '@/lib/quotations/api'
import { historyOnly } from '@/lib/quotations/suggestions'
import {
  DIMENSION_UNITS, SUPPLY_STATES, computeTotals, costingSums, formatDateIN, gstModeForState, validUntil,
  type QuoteArea, type QuoteLine,
} from '@/lib/quotations/math'
import { CLOSING, DEFAULT_CLIENT_NOTE, EXPECTATIONS, EXPECTATIONS_TITLE, TERMS } from '@/lib/quotations/terms'
import { needsYou, REQUEST_CARD_ID } from '@/lib/quotations/needsYou'
import { ImportDialog } from './ImportDialog'
import { WANTS } from '@/lib/quotations/importBoq'
import { lineDetails } from '@/lib/quotations/pictureStudio'
import { StatusPill } from './ListScreen'
import { StudioDialog } from './StudioDialog'
import { VersionsCard } from './VersionsCard'
import { RequestCard } from './RequestCard'
import { AskCard } from './AskCard'
import { PriceBrief } from './PriceBrief'
import { DeleteQuotationDialog } from './DeleteQuotationDialog'
import { LeadCard } from './LeadCard'
import { LineRow } from './ProductLine'
import { CostingPage } from './CostingPage'
import { effectiveLeadTime } from './LeadTime'
import { StatusCard, LOCKED } from './StatusCard'
import { ShareCard } from './ShareCard'
import { ClientCard } from './ClientCard'
import { PictureViewer, viewerItemsOf } from './PictureViewer'
import { MyDetailsReminder } from './MyDetails'
import { productType } from '@/lib/pricing/features'
import { priceLine, type Fit, type ModelSuggestion } from '@/lib/pricing/model'
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
  // THE FIRST READS DO NOT WAIT FOR ACCESS (23 Nov 2026): the database answers each one as the signed-in person and refuses what they may not
  // see, so they start with the page (or at the click that opened it, openQuotation.ts) instead of after the profile and access reads. The
  // screen below still waits for `accessLoaded` before it draws, so nothing that depends on access flickers in.
  const quoteQ = useQuery({ queryKey: quotationKeys.one(id), queryFn: () => fetchQuotation(supabase, id), staleTime: OPEN_FRESH_MS, retry: false })
  // The logo mark on pictures (owner, 18 Nov 2026): on unless somebody who may edit this quotation turned it off.
  const markQ = useQuery({ queryKey: pictureMarkKey(id), queryFn: () => fetchPictureMark(supabase, id), staleTime: OPEN_FRESH_MS, retry: false })
  const markOn = markQ.data !== false
  const picSrc = (p: string) => pictureSrc(supabase, p, { markOn, quotationId: id })
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
  const [lostReason, setLostReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [piStage, setPiStage] = useState<PiStage | null>(null)
  const [studioFor, setStudioFor] = useState<string | null>(null)
  const [viewing, setViewing] = useState<string | null>(null)
  const [advOpen, setAdvOpen] = useState(false)
  // Products, or the Fabric, finish and packing page (21 Nov 2026); both edit the same lines.
  const [tab, setTab] = useState<'products' | 'costing'>('products')
  // The price brief (20 Nov 2026): asked of the owner / pricing desk when they send a quotation back or share it; always optional.
  const [briefing, setBriefing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const isDesk = access.admin || (access.edit && access.view_all)
  // Delete (20270817000000): whether this person may now delete it is the database's answer (an unsent draft they made, or anything for an
  // administrator), asked again whenever the quotation is read again (a request to a senior, a share or a price request changes it).
  // Until 20270817000000 is applied the read fails and the button stays away.
  const delQ = useQuery({ queryKey: [...deleteCheckKey(id), quoteQ.dataUpdatedAt], queryFn: () => fetchDeleteCheck(supabase, id), enabled: accessLoaded && !notSetUp && !!quoteQ.data, retry: false })
  // The GST rate new products start with while no product sets it (the quotation has one rate; each product still stores it).
  // Price hints for the names on screen, asked for once typing pauses.
  const [hintNames, setHintNames] = useState('')
  // WHO SEES THE SUGGESTED PRICES (owner, 18 Nov 2026; Control Center › Sales › Quotation price approval): off for this person,
  // the suggestion, its model and the taught-price picker are left out and only the history (last ordered / quoted) shows. A
  // database without 20270731000000 answers with an error, which keeps them on, as before. Off until the answer is in.
  const suggQ = useQuery({ queryKey: suggestionsKey, queryFn: () => fetchSuggestionSettings(supabase), enabled: !notSetUp, staleTime: 300_000, retry: false })
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
  // Price Brain v2, phase 2: each line that picked a taught case asks the server for that case worked out for the line (its
  // size, its wood, today's rates). Asked 0.8 s after the last change, so typing a size does not send a request per key.
  const reworkAsk = useMemo(() => JSON.stringify(libraryQ.data ? lines.flatMap((l): ReworkAsk[] => {
    const no = pickedCaseNo(l.internal_note)
    return no === null ? [] : [{ key: l.key, caseNo: no, size: l.size_text || null, wood: lineWood(l, libraryQ.data!.woods) }]
  }) : []), [lines, libraryQ.data])
  const [settledAsk, setSettledAsk] = useState(reworkAsk)
  useEffect(() => { const t = setTimeout(() => setSettledAsk(reworkAsk), 800); return () => clearTimeout(t) }, [reworkAsk])
  const reworkQ = useQuery({ queryKey: ['pricing', 'rework', settledAsk], queryFn: () => fetchRework(supabase, JSON.parse(settledAsk) as ReworkAsk[]), enabled: settledAsk !== '[]', staleTime: 60_000, retry: false })
  const taught = useMemo(() => libraryQ.data && {
    library: libraryQ.data, photo: (p: string) => photoUrl(supabase, p), reworked: reworkQ.data,
    differs: (r: DiffersReport, line: FeedbackDoc['line']) => {
      void sendFeedback(supabase, { source: 'quotation', kind: 'differs_taught', comment: r.note || null, expected_price: r.quoted, line, client_type: null, quotation_id: id,
        suggestion: { taught: { case_id: r.caseId, case_no: r.caseNo, case_name: r.caseName, price: r.taught, quoted: r.quoted, reason: r.reason } } }).catch(() => {})
    },
  }, [libraryQ.data, reworkQ.data, supabase, id])
  const [importing, setImporting] = useState(false)
  const router = useRouter()
  const dirtyRef = useRef(false)
  useEffect(() => { dirtyRef.current = dirty }, [dirty])

  // The names that ask for price hints and the price pool: when typing pauses (600 ms), EXCEPT the first fill from the saved quotation, which
  // goes at once (23 Nov 2026): nobody is typing, so the wait only delayed the suggested prices by 0.6 s after the page had drawn.
  const hintsAsked = useRef(false)
  useEffect(() => {
    const names = [...new Set(lines.map(l => l.name.trim()).filter(n => n.length >= 3))].sort().slice(0, 80).join('\n')
    const t = setTimeout(() => { setHintNames(names); if (names) hintsAsked.current = true }, hintsAsked.current || dirtyRef.current ? 600 : 0)
    return () => clearTimeout(t)
  }, [lines])

  // Take the server's copy when it arrives, unless there are unsaved edits on screen.
  useEffect(() => {
    const q = quoteQ.data
    if (!q || dirtyRef.current) return
    setBase(q); setH(q.header); setAreas(q.areas); setLines(q.lines)
  }, [quoteQ.data])

  const editable = !!base?.may_edit && !!base && !LOCKED.includes(base.status)
  // Fabric and packing priced per piece on the costing page (20270819000000): once any price is typed there, their sums ARE the two amounts of
  // the totals (and what a save writes into fabric_amount and packing_amount); until then the typed boxes count, as before.
  const costSums = useMemo(() => costingSums(areas, lines), [areas, lines])
  const money = useMemo(() => (h ? (costSums.any ? { ...h, fabric_amount: costSums.fabric, packing_amount: costSums.packing } : h) : null), [h, costSums])
  const totals = useMemo(() => (money ? computeTotals(money, areas, lines) : null), [money, areas, lines])
  // One fit per product type for as long as the pool is the same: typing in a line re-prices every line, and refitting the
  // model for each of them on every keystroke made typing in Material and Remarks take ~140 ms (20 Nov 2026).
  const fits = useMemo(() => (poolQ.data ? new Map<string, Fit | null>() : null), [poolQ.data])
  const modelFor = useMemo(() => {
    const m = new Map<string, ModelSuggestion | null>()
    if (!poolQ.data || !fits || !totals) return m
    for (const l of lines) m.set(l.key, priceLine(poolQ.data, { name: l.name, size: l.size_text, material: l.material, finish: l.finish, spec: l.spec, qty: totals.lineQty[l.key], clientType: h?.client_type }, undefined, fits))
    return m
  }, [poolQ.data, fits, lines, totals, h?.client_type])
  const touch = () => { setDirty(true); setMsg(m => (m?.tone === 'ok' ? null : m)) }
  const updH = <K extends keyof Header>(k: K, v: Header[K]) => { setH(p => (p ? { ...p, [k]: v } : p)); touch() }
  const updArea = (key: string, patch: Partial<QuoteArea>) => { setAreas(p => p.map(a => (a.key === key ? { ...a, ...patch } : a))); touch() }
  const updLine = (key: string, patch: Partial<QuoteLine>) => { setLines(p => p.map(l => (l.key === key ? { ...l, ...patch } : l))); touch() }

  // Everything is billed at 18% (owner, 18 Nov 2026), so there is no GST rate to pick: the total shows one GST line.
  const startRate = 18

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
      const costed = costingSums(areas, lines)
      const header = costed.any ? { ...h, fabric_amount: costed.fabric, packing_amount: costed.packing } : h
      const r = await saveQuotation(supabase, base.id, saveDoc({ ...header, lead_time_weeks: effectiveLeadTime(h, areas) }, areas, lines, base.updated_at))
      setBase(b => (b ? { ...b, updated_at: r.updated_at } : b))
      setDirty(false); dirtyRef.current = false
      setMsg(null) // the header's "✓ Saved" says it; a message left from before is cleared
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
  const moveTo = (status: QuotationStatus, note?: string, reason?: string) => act(() => setStatusRpc(supabase, id, status, note, reason), `Marked ${STATUS_LABEL[status]}.`)

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

  const layout = (title: string, body: React.ReactNode, subtitle?: string, actions?: React.ReactNode) => (
    <QuotationsLayout profile={profile} access={access} onSignOut={signOut} title={title} subtitle={subtitle} actions={actions} contentMaxWidth={1360}>{body}</QuotationsLayout>
  )
  // While the quotation is on its way the Quotations frame stays and the body is a skeleton (the same one src/app/quotations/[id]/loading.tsx
  // draws), instead of the full-page spinner that took the sidebar away and fades in only after 0.8 s.
  const skeleton = () => layout('Quotation', <ModulePageSkeleton variant="record" label="Loading quotation" />)
  if (loading) return skeleton()
  if (notSetUp) return layout('Quotation', <div className={`${s.notice} ${s.noticeWarn}`}><b>Quotations is being set up.</b> Its database part has not been applied yet.</div>)
  if (quoteQ.isError) return layout('Quotation', <div className={`${s.notice} ${s.noticeBad}`}>{errorText(quoteQ.error)} <Link href="/quotations">Back to quotations</Link></div>)
  if (!accessLoaded || !base || !h || !totals) return skeleton()

  const issued = istDateOf(issuedAt(versionsQ.data, base.sent_at, base.created_at))
  const link = base.share_token ? `${typeof window === 'undefined' ? '' : window.location.origin}/q/${base.share_token}` : ''
  const waText = `Hello${h.contact_name ? ' ' + h.contact_name.split(' ')[0] : ''}, here is our quotation ${base.quote_no} for ${h.project_name || h.client_name}: ${formatINR(totals.grand)} including GST, valid until ${formatDateIN(validUntil(issued, h.valid_days))}.\nView it with pictures and save the PDF here: ${link}\n– ${profile?.full_name ?? ''}, Best of Exports`
  const copy = async () => {
    try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 1800) }
    catch { (document.getElementById('q-link') as HTMLInputElement | null)?.select() }
  }
  // The Excel of the saved quotation for the client (owner, 18 Nov 2026): styled, a picture beside each product, live formulas for editing; never the internal PI sheet.
  const downloadExcel = async () => {
    if (busy) return
    setBusy(true)
    try {
      const { downloadClientWorkbook } = await import('@/lib/quotations/clientWorkbookDownload')
      const { missing } = await downloadClientWorkbook({
        head: {
          quoteNo: base.quote_no, clientName: h.client_name, projectName: h.project_name, issuedOn: formatDateIN(issued), validUntilOn: formatDateIN(validUntil(issued, h.valid_days)),
          unit: h.dimension_unit, transportNote: h.transport_note, notes: h.notes,
          preparedBy: { name: base.owner_display_name ?? base.owner_name ?? '', title: base.owner_title ?? '', phone: base.owner_phone ?? '', email: base.owner_email ?? '' },
        },
        money: money ?? h, areas, lines, srcOf: picSrc,
        payment: await fetchPaymentDetails(supabase).catch(() => null), // the bank account and QR; the Excel is still made without them
      })
      if (missing > 0) setMsg({ tone: 'warn', text: `The Excel was downloaded, but ${missing} picture${missing === 1 ? '' : 's'} could not be loaded and ${missing === 1 ? 'is' : 'are'} left out.` })
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

      {briefing && <PriceBrief supabase={supabase} quotationId={id} lines={lines} onClose={n => { setBriefing(false); if (n > 0) setMsg({ tone: 'ok', text: `Saved the price brief for ${n} product${n === 1 ? '' : 's'}.` }) }} />}
      {deleting && <DeleteQuotationDialog supabase={supabase} onClose={() => setDeleting(false)}
        target={{ id, quote_no: base.quote_no, client_name: h.client_name, project_name: h.project_name || null, status: base.status }}
        onDeleted={() => { dirtyRef.current = false; router.push('/quotations') }} />}

      {/* the top row (owner-approved layout, 18 Nov 2026; tidied 23 Nov 2026): the request, where the quotation is (with the price approval), and sharing, as compact cards */}
      <div className={`${s.band} ${hasRequest ? '' : s.bandTwo}`}>
        {profile && <RequestCard id={REQUEST_CARD_ID} supabase={supabase} base={base} userId={profile.id} dirty={dirty} onDone={text => { setMsg({ tone: 'ok', text }); quoteQ.refetch() }} />}
        <StatusCard base={base} dirty={dirty} busy={busy} isAdmin={access.admin} canConfirm={canConfirm} piProblems={piProblems} priceBlocked={priceBlocked} piStage={piStage}
          lostNote={lostNote} setLostNote={setLostNote} lostReason={lostReason} setLostReason={setLostReason} onMove={moveTo} onConfirm={confirmToPi}
          canDelete={delQ.data?.may === true} onDelete={() => setDeleting(true)}
          needs={waiting} onAskPrice={() => act(() => requestPriceApproval(supabase, id), 'Sent to the pricing desk.')}
          onDecidePrice={(approve, note) => act(() => decidePrice(supabase, id, approve, note), approve ? 'Prices approved.' : 'Sent back to the salesperson.')} />
        <ShareCard id={id} base={base} dirty={dirty} busy={busy} lineCount={lines.length} phone={h.contact_phone} link={link} waText={waText} copied={copied}
          onCopy={copy} onExcel={downloadExcel} markOn={markQ.data}
          onMark={on => act(async () => { await setPictureMark(supabase, id, on); qc.setQueryData(pictureMarkKey(id), on) }, on ? 'The Best of Exports logo is on the pictures.' : 'The pictures are clean, without the logo.')} onShare={on => act(async () => { await shareQuotation(supabase, id, on); if (on && isDesk) setBriefing(true) }, on ? 'The client link is on.' : 'The client link is off.')} />
      </div>

      {/* Lead | Ask a senior: one strip of two halves; each half draws nothing when it has nothing to say, and then the strip is :empty and hidden */}
      <div className={s.strip}>
        <LeadCard supabase={supabase} base={base} dirty={dirty} onChanged={() => { quoteQ.refetch() }} />
        <AskCard supabase={supabase} base={base} dirty={dirty} onChanged={() => { quoteQ.refetch() }} onSentBack={() => { if (isDesk) setBriefing(true) }} />
      </div>

      <ClientCard h={h} areas={areas} editable={editable} advOpen={advOpen} onAdv={() => setAdvOpen(o => !o)} onField={updH}
        onPatch={patch => { setH(p => (p ? { ...p, ...patch } : p)); touch() }} onCity={setCity} onState={setState} />

      {/* Products, or the page where fabric, finish and packing are priced per piece (21 Nov 2026) */}
      <div className={s.cpTabs} role="tablist" aria-label="Products and costing">
        <button type="button" role="tab" id="q-tab-products" aria-selected={tab === 'products'} className={s.cpTab} onClick={() => setTab('products')}>Products</button>
        <button type="button" role="tab" id="q-tab-costing" aria-selected={tab === 'costing'} className={s.cpTab} onClick={() => setTab('costing')}>
          Fabric, finish and packing{costSums.waiting.length > 0 ? ` · ${costSums.waiting.length} to price` : ''}
        </button>
      </div>
      {tab === 'costing' && (
        <section className={s.card} aria-labelledby="q-costing">
          <div className={s.cardHead}><h2 id="q-costing">Fabric, finish and packing</h2><span className={s.chip}>{lines.length} {lines.length === 1 ? 'product' : 'products'}</span></div>
          <CostingPage groups={groups} areas={areas} lines={lines} editable={editable} qtyOf={k => totals.lineQty[k] ?? 0} url={picSrc}
            onChange={(key, patch) => updLine(key, patch)}
            onUploadSwatch={f => (profile ? uploadPicture(supabase, profile.id, f) : Promise.reject(new Error('Sign in again to add a picture')))} />
        </section>
      )}

      <section className={s.card} aria-labelledby="q-products" hidden={tab !== 'products'}>
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
                first={li === 0} last={li === g.lines.length - 1} url={picSrc}
                onChange={patch => updLine(l.key, patch)} onUpload={f => upload(l.key, f)} onUploadSwatch={f => (profile ? uploadPicture(supabase, profile.id, f) : Promise.reject(new Error("Sign in again to add a picture")))} onImprove={() => setStudioFor(l.key)} onView={() => setViewing(l.key)}
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
                <label className={s.field}><span>Fabric (₹)</span><input id="q-fabric" className={`${s.input} ${s.money}`} type="number" min={0} value={costSums.any ? costSums.fabric : (h.fabric_amount || '')} placeholder="0" onChange={e => updH('fabric_amount', Math.max(0, Math.round(Number(e.target.value) || 0)))} disabled={!editable || costSums.any} />{costSums.any && <span className={`${s.small} ${s.muted}`}>From the costing page</span>}</label>
                <label className={s.field}><span>Packing (₹)</span><input id="q-packing" className={`${s.input} ${s.money}`} type="number" min={0} value={costSums.any ? costSums.packing : (h.packing_amount || '')} placeholder="0" onChange={e => updH('packing_amount', Math.max(0, Math.round(Number(e.target.value) || 0)))} disabled={!editable || costSums.any} />{costSums.any && <span className={`${s.small} ${s.muted}`}>From the costing page</span>}</label>
                <label className={s.field}><span>Transport</span><input id="q-transport" className={s.input} value={h.transport_note} placeholder="As per actual" onChange={e => updH('transport_note', e.target.value)} disabled={!editable} /></label>
              </div>
              <div className={`${s.small} ${s.muted}`}>Valid until {formatDateIN(validUntil(issued, h.valid_days))}{base.sent_at ? '' : ' (counted from the day it is sent)'}</div>
            </div>
            <div className={s.sumBox}>
              <table className={s.sum}><tbody>
                <tr><td>Products</td><td>{formatINR(totals.subtotal)}</td></tr>
                {totals.discount > 0 && <tr><td>Discount {h.discount_pct}%</td><td>− {formatINR(totals.discount)}</td></tr>}
                {(money ?? h).fabric_amount > 0 && <tr><td>Fabric</td><td>{formatINR((money ?? h).fabric_amount)}</td></tr>}
                {(money ?? h).packing_amount > 0 && <tr><td>Packing</td><td>{formatINR((money ?? h).packing_amount)}</td></tr>}
                <tr className={s.hr}><td>Before GST</td><td>{formatINR(totals.taxable)}</td></tr>
                {totals.gst.map(r => <tr key={r.rate} className={s.sub}><td>GST @{r.rate}%</td><td>{formatINR(r.gst)}</td></tr>)}
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
      </div>

      {importing && profile && (
        <ImportDialog supabase={supabase} userId={profile.id} areas={areas} requestId={base?.request?.id} onClose={() => setImporting(false)}
          onAdd={(nextAreas, added) => { setAreas(nextAreas); setLines(p => [...p.filter(l => l.name.trim() || l.unit_price !== null), ...added.map(l => ({ ...l, tax_rate: startRate }))]); touch(); setImporting(false); const priced = added.filter(l => l.unit_price !== null).length; setMsg({ tone: 'ok', text: `Added ${added.length} products${priced ? `, ${priced} with their price` : ''}. Check them${priced < added.length ? ', add the missing prices' : ''}, then Save.` }) }} />
      )}
      {studioFor && profile && (() => {
        const line = lines.find(x => x.key === studioFor)
        return line?.image_path ? (
          <StudioDialog supabase={supabase} userId={profile.id} path={line.image_path} url={picSrc} onClose={() => setStudioFor(null)}
            details={lineDetails(line, unit)}
            wants={line.spec.split('\n').find(t => t.startsWith(WANTS))?.slice(WANTS.length)} swatch={line.references?.find(r => r.kind === 'swatch')?.path}
            onUse={p => { updLine(line.key, { image_path: p }); setStudioFor(null); setMsg({ tone: 'ok', text: 'Picture changed. Save to keep it.' }) }} />
        ) : null
      })()}
      {viewing && viewerAt >= 0 && (
        <PictureViewer items={viewerItems} index={viewerAt} url={picSrc} onIndex={i => setViewing(viewerItems[i]?.key ?? null)} onClose={() => setViewing(null)} />
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
