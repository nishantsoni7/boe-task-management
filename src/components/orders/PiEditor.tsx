'use client'

// ── EDIT PI (20270115000000) — the full-page editor ─────────────────────────
//
// One editor for the whole PI: client, bill-to and ship-to, dates, commercial
// terms, fabric, and every product — name, code, description, quantity, price
// and photo — added, changed or removed. It is a PAGE (/orders/[id]/edit-pi and
// /orders/drafts/[submissionId]/edit-pi), not a modal: the PI is long, and a
// reader needs to see it whole, section by section, with one action bar.
//
//   mode 'propose'  the PI is approved and in force. Saving keeps unsent work
//                   (private to its author); submitting records a PENDING
//                   version. The current PI and Order do not change until an
//                   Admin approves the new version; Operations then reviews it
//                   for production.
//   mode 'apply'    the PI is not yet an Order: saving writes it.
//
// THE FIGURES SHOWN HERE ARE A PREVIEW. The server re-reads the PI, re-applies
// the edit and prices it with the same functions; what it stores is what
// counts. Every rule (validateEdit, the sequence numbers, the version diff) is
// the one the modal used; only the layout changed.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import type { SupabaseClient } from '@supabase/supabase-js'
import { ArrowLeft, FileSpreadsheet, ImagePlus, Paperclip, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { colors } from '@/lib/tokens'
import { formatInr } from '@/lib/pi/previewView'
import { FABRIC_RESPONSIBILITY_OPTIONS, fabricResponsibilityLabel } from '@/lib/orders/piTerms'
import {
  PI_EDIT_HEADER_FIELDS,
  PI_EDIT_IMAGE_COLUMNS,
  PI_EDIT_ITEM_COLUMNS,
  PI_EDIT_SUBMISSION_COLUMNS,
  PI_EDIT_TERMS_FIELDS,
  diffPi,
  editChangesSomething,
  initialEditState,
  newEditItem,
  normalizePi,
  editProductFigures,
  priceEdit,
  summarizeChanges,
  validateEdit,
  type PiContent,
  type PiContentImage,
  type PiContentItem,
  type PiEditItem,
  type PiEditState,
} from '@/lib/orders/piEdit'
import type { EditPiOutcome } from '@/lib/orders/editPiPage'

export const EDIT_PI_LABEL = 'Edit PI'
export const EDIT_PI_PROPOSE_NOTE =
  'This PI is approved and in force. Your changes become a new version: the current PI stays in force until an Admin approves the new one. Approval puts it in force and amends the Order to its values; Operations is then sent it for review.'
export const EDIT_PI_WORKBOOK_NOTE =
  "The uploaded workbook stays V1's file and is never changed. An edited version has no workbook of its own: it is these details, and its PDF is generated from them."
export const EDIT_PI_UNSAVED_PROMPT = 'You have changes that are not saved. Leave this page and lose them?'

type Mode = 'propose' | 'apply'

const DATE_KEYS = ['creation_date', 'order_confirmation_date', 'due_date', 'dispatch_commitment']

/** Reads the PI as it stands, under the viewer's own access. */
export async function loadPiContentAsViewer(supabase: SupabaseClient, submissionId: string): Promise<PiContent | null> {
  const [sub, items, images] = await Promise.all([
    supabase.from('order_submissions').select(PI_EDIT_SUBMISSION_COLUMNS).eq('id', submissionId).maybeSingle(),
    supabase.from('order_submission_items').select(PI_EDIT_ITEM_COLUMNS).eq('submission_id', submissionId),
    supabase.from('order_submission_item_images').select(PI_EDIT_IMAGE_COLUMNS).eq('submission_id', submissionId),
  ])
  if (sub.error || items.error || images.error || !sub.data) return null
  return {
    submission: sub.data as unknown as Record<string, unknown>,
    items: (items.data ?? []) as unknown as PiContentItem[],
    images: (images.data ?? []) as unknown as PiContentImage[],
  }
}

/** A date as the section summary says it: "30 Sept 2026", or null. */
const shortDay = (iso: string): string | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim())
  if (!m) return null
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
    .toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
}

function Section({ id, title, summary, children, aside }: {
  id: string
  title: string
  summary?: string | null
  aside?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="pi-edit-card" id={id} aria-labelledby={`${id}-title`}>
      <header className="pi-edit-card-head">
        <div className="pi-edit-card-heading">
          <h2 className="pi-edit-card-title" id={`${id}-title`}>{title}</h2>
          {summary && <p className="pi-edit-card-summary">{summary}</p>}
        </div>
        {aside}
      </header>
      <div className="pi-edit-card-body">{children}</div>
    </section>
  )
}

export function PiEditor({
  supabase, mode, submissionId, orderId, backHref, context, onDone, attachments,
}: {
  supabase: SupabaseClient
  mode: Mode
  submissionId: string
  /** The Order, in propose mode. */
  orderId: string | null
  /** Where Back and Cancel return: the Order or the PI draft. */
  backHref: string
  /** "Order 0526 · Rivoli" — who and what is being edited. */
  context: string
  /** After a successful save or submission; the page navigates back. */
  onDone: (outcome: EditPiOutcome) => void
  /**
   * The Attachments section's two doors, owned by the record page: Design
   * Files / Client PO (reviewed by Admin, then accepted by Operations) and, on
   * an Order, a revised PI workbook (a proposed version). Each is reached after
   * this edit is saved, so nothing typed here is lost.
   */
  attachments: {
    /** What is on file now, in one line per category. */
    designFiles: string
    clientPo: string
    /** The record page, opened on its upload step. */
    uploadDocumentsHref: string | null
    uploadWorkbookHref: string | null
    /** Why the upload doors are closed, when they are. */
    note: string | null
  }
}) {
  const [current, setCurrent] = useState<PiContent | null>(null)
  const [state, setState] = useState<PiEditState | null>(null)
  const [reason, setReason] = useState('')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState<null | 'save' | 'submit' | 'photo'>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [resumable, setResumable] = useState<{ edit: PiEditState; reason: string; at: string } | null>(null)
  const [photoUrls, setPhotoUrls] = useState<Record<string, string>>({})
  const [reviewing, setReviewing] = useState(false)
  // What was last saved (or loaded), to tell unsaved edits from saved ones.
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void (async () => {
      const content = await loadPiContentAsViewer(supabase, submissionId)
      if (!live) return
      if (!content) { setLoadError('This PI could not be opened for editing. Reload the page and try again.'); return }
      const initial = initialEditState(content)
      setCurrent(content)
      setState(initial)
      setSavedSnapshot(JSON.stringify({ edit: initial, reason: '' }))
      if (mode === 'propose' && orderId) {
        const { data } = await supabase.from('order_pi_edit_drafts')
          .select('edit, reason, updated_at').eq('order_id', orderId).maybeSingle()
        if (live && data) setResumable({ edit: data.edit as PiEditState, reason: data.reason ?? '', at: data.updated_at })
      }
      // Signed links for the pictures already on the PI (private bucket).
      const paths = content.images.filter(i => i.role === 'representative').map(i => i.storage_path)
      if (paths.length > 0) {
        const { data: signed } = await supabase.storage.from('order-files').createSignedUrls(paths, 600)
        if (live && signed) {
          setPhotoUrls(Object.fromEntries(signed.filter(s => s.signedUrl && s.path).map(s => [s.path as string, s.signedUrl as string])))
        }
      }
    })()
    return () => { live = false }
  }, [supabase, submissionId, orderId, mode])

  const problems = useMemo(() => (state ? validateEdit(state) : []), [state])
  const priced = useMemo(() => (current && state && problems.length === 0 ? priceEdit(current, state) : null), [current, state, problems])
  const diff = useMemo(() => {
    if (!current || !state || !priced) return null
    const lines = priced.lines.map((l, i) => ({
      id: l.item.id ?? l.item.key, product_name: l.item.product_name, source_product_code: l.item.source_product_code,
      dimensions: l.item.dimensions, material: l.item.material, customization: l.item.customization,
      quantity: l.quantity, cost_per_piece: l.cost_per_piece, total_amount: l.total_amount, sort_order: i, source_row: 1,
      item_sequence: l.item.item_sequence,
    }))
    const rep = new Map(current.images.filter(m => m.role === 'representative').map(m => [m.item_id, m]))
    const images = priced.lines.flatMap(l => {
      const id = l.item.id ?? l.item.key
      if (l.item.photo.kind === 'new') return [{ item_id: id, role: 'representative' as const, position: 0, storage_path: l.item.photo.storage_path, mime_type: null, sha256: null, anchor_row: 1 }]
      if (l.item.photo.kind === 'remove') return []
      const r = l.item.id ? rep.get(l.item.id) : undefined
      return r ? [r] : []
    })
    return diffPi(normalizePi(current), normalizePi({
      submission: { ...current.submission, ...state.header, ...state.terms, ...priced.commercial,
        client_city: state.header.client_city },
      items: lines as PiContentItem[], images,
    }))
  }, [current, state, priced])

  const set = useCallback((fn: (s: PiEditState) => PiEditState) => setState(s => (s ? fn(structuredClone(s)) : s)), [])
  const setItem = (key: string, patch: Partial<PiEditItem>) =>
    set(s => ({ ...s, items: s.items.map(i => (i.key === key ? { ...i, ...patch } : i)) }))

  // ── UNSAVED WORK IS NOT LOST TO A NAVIGATION ──
  // Dirty = what is on screen differs from what was last saved or loaded. The
  // browser's own prompt guards a reload or a closed tab; Back and Cancel ask
  // first (the app's existing pattern: permissions pages, DiscardGuard).
  const dirty = !!state && savedSnapshot !== null && JSON.stringify({ edit: state, reason }) !== savedSnapshot
  const dirtyRef = useRef(false)
  useEffect(() => { dirtyRef.current = dirty && busy !== 'submit' }, [dirty, busy])
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])
  const confirmLeave = (e: React.MouseEvent) => {
    if (dirtyRef.current && !window.confirm(EDIT_PI_UNSAVED_PROMPT)) e.preventDefault()
  }

  const uploadPhoto = async (item: PiEditItem, file: File | undefined) => {
    if (!file) return
    setBusy('photo'); setFailure(null)
    const form = new FormData()
    form.set('submissionId', submissionId)
    form.set('itemId', item.id ?? item.key)
    form.set('file', file)
    try {
      const res = await fetch('/api/orders/pi-edits/photo', { method: 'POST', body: form })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) { setFailure(body.message ?? 'The photo could not be uploaded.'); return }
      setItem(item.key, { photo: { kind: 'new', storage_path: body.storage_path, sha256: body.sha256, mime_type: body.mime_type } })
      const { data } = await supabase.storage.from('order-files').createSignedUrl(body.storage_path, 600)
      if (data?.signedUrl) setPhotoUrls(u => ({ ...u, [body.storage_path]: data.signedUrl }))
    } finally { setBusy(null) }
  }

  /** Saves the unsent edit (propose mode). Resolves true when it is safe to leave. */
  const saveDraft = async (): Promise<boolean> => {
    if (!state || !orderId) return false
    setBusy('save'); setFailure(null)
    const { error } = await supabase.from('order_pi_edit_drafts').upsert(
      { order_id: orderId, submission_id: submissionId, edit: state, reason: reason.trim() || null, updated_at: new Date().toISOString() },
      { onConflict: 'order_id,author_id' })
    setBusy(null)
    if (error) { setFailure('Your changes could not be saved just now. Nothing was lost on screen — try again.'); return false }
    setSavedSnapshot(JSON.stringify({ edit: state, reason }))
    setSavedAt(new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }))
    return true
  }

  const submit = async () => {
    if (!state) return
    setBusy('submit'); setFailure(null)
    try {
      const res = await fetch('/api/orders/pi-edits', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode, submissionId, edit: state, reason }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) { setFailure(body.message ?? 'The PI could not be saved just now.'); setReviewing(false); return }
      dirtyRef.current = false
      // 20270122000000: a dates-only edit is not a new PI version.
      onDone(mode === 'propose' ? (body.dates_amended ? 'dates' : 'proposed') : 'applied')
    } finally { setBusy(null) }
  }

  /** Leaves for an upload door, saving the edit first so nothing is lost. */
  const leaveFor = async (href: string) => {
    if (dirty && mode === 'propose') {
      const ok = await saveDraft()
      if (!ok) return
    } else if (dirty && !window.confirm(EDIT_PI_UNSAVED_PROMPT)) {
      return
    }
    dirtyRef.current = false
    window.location.assign(href)
  }

  const reasonRequired = mode === 'propose'
  const changed = diff ? editChangesSomething(diff) : false
  const canSubmit = !!state && problems.length === 0 && changed && (!reasonRequired || reason.trim() !== '') && busy === null

  // ── One-line summaries, so each section says what it holds before it is read ──
  const live = state?.items.filter(i => !i.removed) ?? []
  const added = state?.items.filter(i => i.id === null).length ?? 0
  const removed = state?.items.filter(i => i.removed).length ?? 0
  const summaries = state ? {
    client: [state.header.client_name, state.header.client_city].map(s => s.trim()).filter(Boolean).join(' · ') || 'Client not named',
    dates: [
      shortDay(state.header.due_date) ? `Due ${shortDay(state.header.due_date)}` : null,
      state.terms.fabric_responsibility ? `Fabric: ${fabricResponsibilityLabel(state.terms.fabric_responsibility)}` : null,
    ].filter(Boolean).join(' · ') || null,
    products: [`${live.length} line${live.length === 1 ? '' : 's'}`, added ? `${added} new` : null, removed ? `${removed} to remove` : null]
      .filter(Boolean).join(' · '),
    commercial: priced?.commercial.grand_total != null ? `Grand total ${formatInr(priced.commercial.grand_total)}` : null,
  } : null

  const nav = [
    ['pi-edit-client', 'Client'],
    ['pi-edit-terms', 'Dates & terms'],
    ['pi-edit-products', 'Products'],
    ['pi-edit-commercial', 'Figures'],
    ['pi-edit-attachments', 'Attachments'],
    ['pi-edit-review', 'Review'],
  ] as const

  return (
    <div className="pi-edit-page">
      <div className="pi-edit-intro">
        <Link href={backHref} className="pi-edit-back" onClick={confirmLeave}>
          <ArrowLeft size={14} strokeWidth={2} aria-hidden="true" /> Back
        </Link>
        <div className="pi-edit-intro-text">
          <p className="pi-edit-context">{context}</p>
          <p className="pi-edit-note">{mode === 'propose' ? EDIT_PI_PROPOSE_NOTE : 'Changes are saved to this PI draft.'}</p>
        </div>
      </div>

      {state && (
        <nav className="pi-edit-nav" aria-label="Sections">
          {nav.map(([id, label]) => <a key={id} href={`#${id}`}>{label}</a>)}
        </nav>
      )}

      {loadError && <div role="alert" className="pi-edit-alert">{loadError}</div>}
      {!state && !loadError && <div className="pi-edit-loading" role="status">Opening the PI…</div>}

      {state && resumable && (
        <div className="pi-edit-resume" role="status">
          <span>You have unsent changes saved {new Date(resumable.at).toLocaleString('en-IN')}.</span>
          <button type="button" className="boe-btn boe-btn-primary" onClick={() => {
            setState(resumable.edit); setReason(resumable.reason); setResumable(null)
            setSavedSnapshot(JSON.stringify({ edit: resumable.edit, reason: resumable.reason }))
          }}>Continue them</button>
          <button type="button" className="boe-btn boe-btn-ghost" onClick={() => setResumable(null)}>Start from the current PI</button>
        </div>
      )}

      {state && summaries && (
        <>
          <Section id="pi-edit-client" title="Client and addresses" summary={summaries.client}>
            <div className="pi-edit-grid">
              {PI_EDIT_HEADER_FIELDS.filter(f => !DATE_KEYS.includes(f.key)).map(f => (
                <label key={f.key} className={f.kind === 'textarea' ? 'pi-edit-field pi-edit-field--wide' : 'pi-edit-field'}>
                  <span>{f.label}{'required' in f && f.required ? ' *' : ''}</span>
                  {f.kind === 'textarea'
                    ? <textarea rows={2} value={state.header[f.key]} maxLength={f.max} className="boe-input"
                        onChange={e => { const v = e.target.value; set(s => ({ ...s, header: { ...s.header, [f.key]: v } })) }} />
                    : <input value={state.header[f.key]} maxLength={'max' in f ? f.max : undefined} className="boe-input"
                        onChange={e => { const v = e.target.value; set(s => ({ ...s, header: { ...s.header, [f.key]: v } })) }} />}
                </label>
              ))}
            </div>
          </Section>

          <Section id="pi-edit-terms" title="Dates and commercial terms" summary={summaries.dates}>
            <div className="pi-edit-grid">
              {PI_EDIT_HEADER_FIELDS.filter(f => DATE_KEYS.includes(f.key)).map(f => (
                <label key={f.key} className="pi-edit-field">
                  <span>{f.label}</span>
                  <input type={f.kind === 'date' ? 'date' : 'text'} value={state.header[f.key]} className="boe-input"
                    onChange={e => { const v = e.target.value; set(s => ({ ...s, header: { ...s.header, [f.key]: v } })) }} />
                </label>
              ))}
              <label className="pi-edit-field">
                <span>Fabric *</span>
                <select value={state.terms.fabric_responsibility} className="boe-input"
                  onChange={e => { const v = e.target.value as PiEditState['terms']['fabric_responsibility']; set(s => ({ ...s, terms: { ...s.terms, fabric_responsibility: v } })) }}>
                  <option value="">Choose…</option>
                  {FABRIC_RESPONSIBILITY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </label>
              <label className="pi-edit-field">
                <span>Billing % (optional)</span>
                <input inputMode="decimal" value={state.terms.billing_percentage} className="boe-input"
                  onChange={e => { const v = e.target.value; set(s => ({ ...s, terms: { ...s.terms, billing_percentage: v } })) }} />
              </label>
              {PI_EDIT_TERMS_FIELDS.map(f => (
                <label key={f.key} className="pi-edit-field pi-edit-field--wide">
                  <span>{f.label}</span>
                  <textarea rows={2} value={state.terms[f.key]} maxLength={f.max} className="boe-input"
                    onChange={e => { const v = e.target.value; set(s => ({ ...s, terms: { ...s.terms, [f.key]: v } })) }} />
                </label>
              ))}
            </div>
          </Section>

          <Section
            id="pi-edit-products"
            title="Products and customization"
            summary={summaries.products}
            aside={
              <button type="button" className="boe-btn boe-btn-ghost pi-edit-add"
                onClick={() => set(s => ({ ...s, items: [...s.items, newEditItem(crypto.randomUUID())] }))}>
                <Plus size={14} aria-hidden="true" /> Add product
              </button>
            }
          >
            <ol className="pi-edit-products">
              {state.items.map((item, n) => {
                const repPath = item.photo.kind === 'new' ? item.photo.storage_path
                  : item.photo.kind === 'remove' ? null
                  : current?.images.find(m => m.item_id === item.id && m.role === 'representative')?.storage_path ?? null
                const line = priced?.lines.find(l => l.item.key === item.key)
                const label = item.removed ? `Product ${n + 1} — will be removed`
                  : item.id === null ? 'New product'
                  : [item.item_sequence, item.product_name].map(s => (s ?? '').trim()).filter(Boolean).join(' · ') || `Product ${n + 1}`
                return (
                  <li key={item.key} aria-label={`Product ${n + 1}`}
                      className={item.removed ? 'pi-edit-product pi-edit-product--removed' : item.id === null ? 'pi-edit-product pi-edit-product--new' : 'pi-edit-product'}>
                    <div className="pi-edit-product-head">
                      <strong className="pi-edit-product-title">{label}</strong>
                      {line && !item.removed && <span className="pi-edit-product-total">{formatInr(line.total_amount)}</span>}
                      <button type="button" className="boe-btn boe-btn-ghost pi-edit-product-toggle"
                        aria-label={item.removed ? `Keep product ${n + 1}` : `Remove product ${n + 1}`}
                        onClick={() => (item.id === null
                          ? set(s => ({ ...s, items: s.items.filter(i => i.key !== item.key) }))
                          : setItem(item.key, { removed: !item.removed }))}>
                        {item.removed ? <><RotateCcw size={13} aria-hidden="true" /> Keep</> : <><Trash2 size={13} aria-hidden="true" /> Remove</>}
                      </button>
                    </div>
                    {!item.removed && (
                      <div className="pi-edit-product-body">
                        <div className="pi-edit-photo">
                          <div className="pi-edit-photo-frame">
                            {/* eslint-disable-next-line @next/next/no-img-element -- a short-lived signed URL from a private bucket */}
                            {repPath && photoUrls[repPath] ? <img src={photoUrls[repPath]} alt="" /> : <span>No photo</span>}
                          </div>
                          <label className="boe-btn boe-btn-ghost pi-edit-photo-btn">
                            <ImagePlus size={12} aria-hidden="true" /> {repPath ? 'Replace' : 'Add'} photo
                            <input type="file" accept="image/png,image/jpeg,image/webp" hidden disabled={busy !== null}
                              aria-label={`Photo for product ${n + 1}`}
                              onChange={e => { void uploadPhoto(item, e.target.files?.[0]); e.target.value = '' }} />
                          </label>
                          {repPath && (
                            <button type="button" className="boe-btn boe-btn-ghost pi-edit-photo-btn"
                              onClick={() => setItem(item.key, { photo: { kind: 'remove' } })}>Remove photo</button>
                          )}
                        </div>
                        <div className="pi-edit-grid pi-edit-grid--product">
                          <label className="pi-edit-field pi-edit-field--wide"><span>Name *</span>
                            <input value={item.product_name} maxLength={300} className="boe-input" onChange={e => setItem(item.key, { product_name: e.target.value })} /></label>
                          <label className="pi-edit-field"><span>Code</span>
                            <input value={item.source_product_code} maxLength={100} className="boe-input" onChange={e => setItem(item.key, { source_product_code: e.target.value })} /></label>
                          <label className="pi-edit-field"><span>Quantity *</span>
                            <input inputMode="decimal" value={item.quantity} className="boe-input" onChange={e => setItem(item.key, { quantity: e.target.value })} /></label>
                          <label className="pi-edit-field"><span>Price per piece (₹) *</span>
                            <input inputMode="decimal" value={item.cost_per_piece} className="boe-input" onChange={e => setItem(item.key, { cost_per_piece: e.target.value })} /></label>
                          <label className="pi-edit-field"><span>Dimensions</span>
                            <input value={item.dimensions} maxLength={500} className="boe-input" onChange={e => setItem(item.key, { dimensions: e.target.value })} /></label>
                          <label className="pi-edit-field pi-edit-field--wide"><span>Material</span>
                            <textarea rows={2} value={item.material} maxLength={1000} className="boe-input" onChange={e => setItem(item.key, { material: e.target.value })} /></label>
                          <label className="pi-edit-field pi-edit-field--wide"><span>Customization / description</span>
                            <textarea rows={2} value={item.customization} maxLength={2000} className="boe-input" onChange={e => setItem(item.key, { customization: e.target.value })} /></label>
                        </div>
                      </div>
                    )}
                  </li>
                )
              })}
            </ol>
            <p className="pi-edit-hint">A new product gets the next free item number when the PI is saved; numbers already used on this Order are never reused.</p>
          </Section>

          <Section id="pi-edit-commercial" title="Commercial figures" summary={summaries.commercial}>
            <div className="pi-edit-grid">
              {([['discount_amount', 'Discount (₹)'], ['fabric_cost', 'Fabric cost (₹)'], ['packing_cost', 'Packing cost (₹)'],
                 ['transportation_amount', 'Transportation (₹)'], ['gst_percent', 'GST %']] as const).map(([key, label]) => (
                <label key={key} className="pi-edit-field">
                  <span>{label}</span>
                  <input inputMode="decimal" value={state.commercial[key]} className="boe-input"
                    placeholder={key !== 'gst_percent' && key !== 'discount_amount' ? 'Blank keeps what the PI states' : undefined}
                    onChange={e => { const v = e.target.value; set(s => ({ ...s, commercial: { ...s.commercial, [key]: v } })) }} />
                </label>
              ))}
            </div>
            {priced && (
              <dl className="pi-edit-figures">
                {editProductFigures(priced.commercial).map(figure => (
                  <div key={figure.key}><dt>{figure.label}</dt><dd>{figure.amount === null ? 'Not stated' : formatInr(figure.amount)}</dd></div>
                ))}
                <div><dt>Total before GST</dt><dd>{priced.commercial.total_before_gst === null ? 'Not stated' : formatInr(priced.commercial.total_before_gst)}</dd></div>
                <div><dt>GST</dt><dd>{priced.commercial.gst_amount === null ? 'Not stated' : formatInr(priced.commercial.gst_amount)}</dd></div>
                <div className="pi-edit-figures-total"><dt>Grand total</dt><dd>{priced.commercial.grand_total === null ? 'Not stated' : formatInr(priced.commercial.grand_total)}</dd></div>
              </dl>
            )}
            {priced && (
              <p className="pi-edit-hint">
                {priced.moneyChanged
                  ? 'Re-priced: line total = quantity × price; GST on the total before GST. The server prices it again when you save.'
                  : 'No quantity, price or cost changed, so every figure is exactly as the approved PI states it.'}
              </p>
            )}
          </Section>

          <Section id="pi-edit-attachments" title="Attachments" summary="Design Files, Client PO and the PI workbook">
            <div className="pi-edit-attach">
              <div className="pi-edit-attach-item">
                <Paperclip size={15} aria-hidden="true" />
                <div className="pi-edit-attach-text">
                  <p className="pi-edit-attach-title">Design Files and Client PO</p>
                  <p className="pi-edit-attach-line">Design Files: {attachments.designFiles}</p>
                  <p className="pi-edit-attach-line">Client PO: {attachments.clientPo}</p>
                  <p className="pi-edit-hint">
                    {mode === 'propose'
                      ? 'New or replacement files are reviewed by an Admin and then accepted by Operations. Product pictures stay with each product above.'
                      : 'Attached to this PI draft and sent with it for approval. Product pictures stay with each product above.'}
                  </p>
                </div>
                {attachments.uploadDocumentsHref && (
                  <button type="button" className="boe-btn boe-btn-ghost" disabled={busy !== null}
                    onClick={() => void leaveFor(attachments.uploadDocumentsHref as string)}>
                    Upload files
                  </button>
                )}
              </div>
              {attachments.uploadWorkbookHref && (
                <div className="pi-edit-attach-item">
                  <FileSpreadsheet size={15} aria-hidden="true" />
                  <div className="pi-edit-attach-text">
                    <p className="pi-edit-attach-title">Replace with a revised PI workbook</p>
                    <p className="pi-edit-hint">
                      Use this instead of editing here when Sales has a corrected .xlsx. It becomes a proposed version: the
                      current PI stays in force until an Admin approves it, and the original workbook of every version is kept.
                    </p>
                  </div>
                  <button type="button" className="boe-btn boe-btn-ghost" disabled={busy !== null}
                    onClick={() => void leaveFor(attachments.uploadWorkbookHref as string)}>
                    Upload revised workbook
                  </button>
                </div>
              )}
              {attachments.note && <p className="pi-edit-hint">{attachments.note}</p>}
              {mode === 'propose' && <p className="pi-edit-hint">{EDIT_PI_WORKBOOK_NOTE}</p>}
            </div>
          </Section>

          <Section id="pi-edit-review" title="Review changes"
            summary={diff && changed ? summarizeChanges(diff, v => formatInr(v)).join(' · ') : 'No changes yet'}>
            <label className="pi-edit-field pi-edit-field--wide">
              <span>{reasonRequired ? 'Why is the PI being revised? *' : 'Reason (needed only once the PI is under review)'}</span>
              <textarea rows={2} maxLength={500} value={reason} className="boe-input" onChange={e => setReason(e.target.value)} />
            </label>
            {problems.length > 0 && (
              <ul role="alert" className="pi-edit-problems">
                {problems.slice(0, 6).map(p => <li key={p.message}>{p.message}</li>)}
              </ul>
            )}
            {diff && changed && (
              <div className="pi-edit-diff">
                <PiDiffView diff={diff} />
              </div>
            )}
          </Section>
        </>
      )}

      {state && (
        <div className="pi-edit-bar" role="region" aria-label="Save">
          <span className="pi-edit-bar-status" role="status">
            {failure
              ? <span className="pi-edit-bar-failure">{failure}</span>
              : busy === 'photo' ? 'Uploading photo…'
              : dirty ? 'Unsaved changes'
              : savedAt ? `Saved ${savedAt}`
              : changed ? 'Changes ready to review' : 'No changes'}
          </span>
          <Link href={backHref} className="boe-btn boe-btn-ghost" onClick={confirmLeave} aria-disabled={busy === 'submit'}>Cancel</Link>
          {mode === 'propose' && (
            <button type="button" className="boe-btn boe-btn-ghost" onClick={() => void saveDraft()} disabled={busy !== null || !dirty}>
              {busy === 'save' ? 'Saving…' : 'Save and continue later'}
            </button>
          )}
          {!reviewing ? (
            <button type="button" className="boe-btn boe-btn-primary" disabled={!canSubmit}
              onClick={() => { setReviewing(true); document.getElementById('pi-edit-review')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }}>
              Review changes
            </button>
          ) : (
            <button type="button" className="boe-btn boe-btn-primary" disabled={!canSubmit} onClick={() => void submit()}>
              {busy === 'submit' ? 'Sending…' : mode === 'propose' ? 'Submit for approval' : 'Save PI'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** The comparison, as a reader takes it in: fields, then products, then money. */
const MONEY_FIELDS = new Set(['gross_product_amount', 'total_before_gst', 'gst_amount', 'grand_total', 'discount_amount'])
const MONEY_LINE_LABELS = new Set(['Price', 'Line total'])
/** A stored figure, shown as money; anything else exactly as written. */
const asMoney = (v: string) => (v !== '' && Number.isFinite(Number(v)) ? formatInr(Number(v)) : v)

export function PiDiffView({ diff }: { diff: ReturnType<typeof diffPi> }) {
  const money = (n: number | null) => (n === null ? '' : `${n > 0 ? '+' : '−'}${formatInr(Math.abs(n))}`)
  const fieldValue = (key: string, v: string) => (MONEY_FIELDS.has(key) ? asMoney(v) : v)
  const lineValue = (label: string, v: string) => (MONEY_LINE_LABELS.has(label) ? asMoney(v) : v)
  if (!editChangesSomething(diff)) return <div style={{ fontSize: '12.5px', color: colors.muted }}>No changes.</div>
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '12.5px' }}>
      {diff.fields.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr style={{ color: colors.muted, fontSize: '11px', textAlign: 'left' }}><th>Field</th><th>Current</th><th>Proposed</th></tr></thead>
          <tbody>
            {diff.fields.map(f => (
              <tr key={f.key} style={{ borderTop: `1px solid ${colors.border}` }}>
                <td style={{ padding: '4px 6px 4px 0', fontWeight: 600 }}>{f.label}</td>
                <td style={{ padding: '4px 6px', color: colors.secondary, textDecoration: 'line-through' }}>{fieldValue(f.key, f.before) || '—'}</td>
                <td style={{ padding: '4px 0 4px 6px' }}>{fieldValue(f.key, f.after) || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {diff.added.map(l => (
        <div key={l.id} style={{ color: '#166534' }}>+ Added <strong>{l.name}</strong> · {l.quantity} × {l.rate === null ? '' : formatInr(l.rate)} = {l.total === null ? '' : formatInr(l.total)}</div>
      ))}
      {diff.removed.map(l => (
        <div key={l.id} style={{ color: colors.red }}>− Removed <strong>{l.name}</strong>{l.total === null ? '' : ` (${formatInr(l.total)})`}</div>
      ))}
      {diff.changed.map(c => (
        <div key={c.id}>
          <strong>{c.name}</strong>
          {c.totalDelta !== null && <span style={{ marginLeft: '6px', fontWeight: 700 }}>{money(c.totalDelta)}</span>}
          <ul style={{ margin: '2px 0 0', paddingLeft: '18px' }}>
            {c.changes.map(x => <li key={x.label}>{x.label}: <s style={{ color: colors.secondary }}>{lineValue(x.label, x.before) || '—'}</s> → {lineValue(x.label, x.after) || '—'}</li>)}
          </ul>
        </div>
      ))}
      {diff.grandTotalDelta !== null && (
        <div style={{ fontWeight: 700 }}>Grand total {money(diff.grandTotalDelta)}</div>
      )}
    </div>
  )
}
