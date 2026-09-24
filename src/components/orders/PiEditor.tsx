'use client'

// ── EDIT PI (20270103000000) ──────────────────────────────────────────────────
//
// One editor for the whole PI: client, bill-to and ship-to, dates, commercial
// terms, fabric, and every product — name, code, description, quantity, price
// and photo — added, changed or removed.
//
//   mode 'propose'  the PI is approved and in force. Saving keeps unsent work
//                   (private to its author); submitting records a PENDING
//                   version. The current PI and Order do not change until the
//                   new version is authorized by an Admin and accepted by
//                   Operations.
//   mode 'apply'    the PI is not yet an Order: saving writes it.
//
// THE FIGURES SHOWN HERE ARE A PREVIEW. The server re-reads the PI, re-applies
// the edit and prices it with the same functions; what it stores is what
// counts.

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { ImagePlus, Plus, RotateCcw, Trash2, X } from 'lucide-react'
import { colors } from '@/lib/tokens'
import { useScrollLock } from '@/hooks/useScrollLock'
import { formatInr } from '@/lib/pi/previewView'
import { FABRIC_RESPONSIBILITY_OPTIONS } from '@/lib/orders/piTerms'
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
  priceEdit,
  summarizeChanges,
  validateEdit,
  type PiContent,
  type PiContentImage,
  type PiContentItem,
  type PiEditItem,
  type PiEditState,
} from '@/lib/orders/piEdit'

export const EDIT_PI_LABEL = 'Edit PI'
export const EDIT_PI_PROPOSE_NOTE =
  'This PI is approved and in force. Your changes become a new version: the current PI stays in force until an Admin approves the new one and Operations accepts it.'
export const EDIT_PI_WORKBOOK_NOTE =
  'The original uploaded workbook is kept unchanged as the source file. The revised PI is these details, and its PDF is generated from them.'

type Mode = 'propose' | 'apply'

const FIELD: React.CSSProperties = {
  padding: '7px 9px', borderRadius: '6px', border: `1px solid ${colors.border}`, background: colors.base,
  color: colors.primary, fontSize: '13px', width: '100%', boxSizing: 'border-box', fontFamily: 'inherit',
}
const LABEL: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: '3px', fontSize: '11.5px', color: colors.secondary, fontWeight: 600 }
const H: React.CSSProperties = { fontSize: '12px', fontWeight: 700, color: colors.primary, textTransform: 'uppercase', letterSpacing: '0.05em', margin: '6px 0 2px' }
const GRID: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '10px' }

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

export function PiEditor({
  supabase, mode, submissionId, orderId, onClose, onDone,
}: {
  supabase: SupabaseClient
  mode: Mode
  submissionId: string
  /** The Order, in propose mode. */
  orderId: string | null
  onClose: () => void
  /** After a successful save or submission. */
  onDone: (message: string) => void
}) {
  useScrollLock(true)
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

  useEffect(() => {
    let live = true
    void (async () => {
      const content = await loadPiContentAsViewer(supabase, submissionId)
      if (!live) return
      if (!content) { setLoadError('This PI could not be opened for editing. Reload the page and try again.'); return }
      setCurrent(content)
      setState(initialEditState(content))
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

  const saveDraft = async () => {
    if (!state || !orderId) return
    setBusy('save'); setFailure(null)
    const { error } = await supabase.from('order_pi_edit_drafts').upsert(
      { order_id: orderId, submission_id: submissionId, edit: state, reason: reason.trim() || null, updated_at: new Date().toISOString() },
      { onConflict: 'order_id,author_id' })
    setBusy(null)
    if (error) { setFailure('Your changes could not be saved just now. Nothing was lost on screen — try again.'); return }
    setSavedAt(new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }))
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
      onDone(mode === 'propose'
        ? `PI V${body.version_number ?? ''} sent for approval. The current PI stays in force until it is approved.`
        : 'The PI was saved.')
    } finally { setBusy(null) }
  }

  const reasonRequired = mode === 'propose'
  const changed = diff ? editChangesSomething(diff) : false
  const canSubmit = !!state && problems.length === 0 && changed && (!reasonRequired || reason.trim() !== '') && busy === null

  return (
    <div className="boe-modal-overlay" role="dialog" aria-modal="true" aria-label={EDIT_PI_LABEL}>
      <div className="boe-modal-sheet" style={{ maxWidth: '980px', maxHeight: '94vh' }}>
        <div className="boe-modal-header" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '15px', fontWeight: 700, color: colors.primary }}>{EDIT_PI_LABEL}</div>
            <div style={{ fontSize: '11.5px', color: colors.muted }}>
              {mode === 'propose' ? EDIT_PI_PROPOSE_NOTE : 'Changes are saved to this draft PI.'}
            </div>
          </div>
          <button type="button" className="boe-btn boe-btn-ghost" aria-label="Close" onClick={onClose} disabled={busy === 'submit'}>
            <X size={16} />
          </button>
        </div>

        <div className="boe-modal-body">
          {loadError && <div role="alert" style={{ color: colors.red, fontSize: '12.5px' }}>{loadError}</div>}
          {!state && !loadError && <div style={{ fontSize: '12.5px', color: colors.muted }}>Opening the PI…</div>}

          {state && resumable && (
            <div style={{ border: `1px solid ${colors.blue}`, background: colors.blueTint, borderRadius: '7px', padding: '9px 11px', fontSize: '12.5px', display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{ flex: 1 }}>You have unsent changes saved {new Date(resumable.at).toLocaleString('en-IN')}.</span>
              <button type="button" className="boe-btn boe-btn-primary" onClick={() => { setState(resumable.edit); setReason(resumable.reason); setResumable(null) }}>Continue them</button>
              <button type="button" className="boe-btn boe-btn-ghost" onClick={() => setResumable(null)}>Start from the current PI</button>
            </div>
          )}

          {state && (
            <>
              <div style={H}>Client and addresses</div>
              <div style={GRID}>
                {PI_EDIT_HEADER_FIELDS.filter(f => !['creation_date', 'order_confirmation_date', 'due_date', 'dispatch_commitment'].includes(f.key)).map(f => (
                  <label key={f.key} style={{ ...LABEL, gridColumn: f.kind === 'textarea' ? '1 / -1' : undefined }}>
                    {f.label}{'required' in f && f.required ? ' *' : ''}
                    {f.kind === 'textarea'
                      ? <textarea rows={2} value={state.header[f.key]} maxLength={f.max} style={FIELD}
                          onChange={e => { const v = e.target.value; set(s => ({ ...s, header: { ...s.header, [f.key]: v } })) }} />
                      : <input value={state.header[f.key]} maxLength={'max' in f ? f.max : undefined} style={FIELD}
                          onChange={e => { const v = e.target.value; set(s => ({ ...s, header: { ...s.header, [f.key]: v } })) }} />}
                  </label>
                ))}
              </div>

              <div style={H}>Dates and commercial terms</div>
              <div style={GRID}>
                {PI_EDIT_HEADER_FIELDS.filter(f => ['creation_date', 'order_confirmation_date', 'due_date', 'dispatch_commitment'].includes(f.key)).map(f => (
                  <label key={f.key} style={LABEL}>
                    {f.label}
                    <input type={f.kind === 'date' ? 'date' : 'text'} value={state.header[f.key]} style={FIELD}
                      onChange={e => { const v = e.target.value; set(s => ({ ...s, header: { ...s.header, [f.key]: v } })) }} />
                  </label>
                ))}
                <label style={LABEL}>
                  Fabric *
                  <select value={state.terms.fabric_responsibility} style={FIELD}
                    onChange={e => { const v = e.target.value as PiEditState['terms']['fabric_responsibility']; set(s => ({ ...s, terms: { ...s.terms, fabric_responsibility: v } })) }}>
                    <option value="">Choose…</option>
                    {FABRIC_RESPONSIBILITY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </label>
                <label style={LABEL}>
                  Billing % (optional)
                  <input inputMode="decimal" value={state.terms.billing_percentage} style={FIELD}
                    onChange={e => { const v = e.target.value; set(s => ({ ...s, terms: { ...s.terms, billing_percentage: v } })) }} />
                </label>
                {PI_EDIT_TERMS_FIELDS.map(f => (
                  <label key={f.key} style={{ ...LABEL, gridColumn: '1 / -1' }}>
                    {f.label}
                    <textarea rows={2} value={state.terms[f.key]} maxLength={f.max} style={FIELD}
                      onChange={e => { const v = e.target.value; set(s => ({ ...s, terms: { ...s.terms, [f.key]: v } })) }} />
                  </label>
                ))}
              </div>

              <div style={H}>Products</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {state.items.map((item, n) => {
                  const repPath = item.photo.kind === 'new' ? item.photo.storage_path
                    : item.photo.kind === 'remove' ? null
                    : current?.images.find(m => m.item_id === item.id && m.role === 'representative')?.storage_path ?? null
                  const line = priced?.lines.find(l => l.item.key === item.key)
                  return (
                    <div key={item.key} role="group" aria-label={`Product ${n + 1}`} style={{
                      border: `1px solid ${colors.border}`, borderRadius: '8px', padding: '10px', opacity: item.removed ? 0.55 : 1,
                      background: item.id === null ? colors.greenTint : colors.base,
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                        <strong style={{ fontSize: '12.5px', flex: 1 }}>
                          {item.removed ? `Product ${n + 1} — will be removed` : item.id === null ? `New product` : `Product ${n + 1}`}
                        </strong>
                        {line && !item.removed && <span style={{ fontSize: '12.5px', fontWeight: 700 }}>{formatInr(line.total_amount)}</span>}
                        <button type="button" className="boe-btn boe-btn-ghost" style={{ padding: '3px 8px' }}
                          aria-label={item.removed ? `Keep product ${n + 1}` : `Remove product ${n + 1}`}
                          onClick={() => (item.id === null
                            ? set(s => ({ ...s, items: s.items.filter(i => i.key !== item.key) }))
                            : setItem(item.key, { removed: !item.removed }))}>
                          {item.removed ? <><RotateCcw size={13} /> Keep</> : <><Trash2 size={13} /> Remove</>}
                        </button>
                      </div>
                      {!item.removed && (
                        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(84px, 110px) 1fr', gap: '10px' }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', alignItems: 'stretch' }}>
                            <div style={{ width: '100%', aspectRatio: '1', borderRadius: '6px', border: `1px solid ${colors.border}`, background: colors.raised, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', color: colors.muted }}>
                              {/* eslint-disable-next-line @next/next/no-img-element -- a short-lived signed URL from a private bucket */}
                              {repPath && photoUrls[repPath] ? <img src={photoUrls[repPath]} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : 'No photo'}
                            </div>
                            <label className="boe-btn boe-btn-ghost" style={{ padding: '3px 6px', fontSize: '11.5px', justifyContent: 'center', cursor: 'pointer' }}>
                              <ImagePlus size={12} /> {repPath ? 'Replace' : 'Add'} photo
                              <input type="file" accept="image/png,image/jpeg,image/webp" style={{ display: 'none' }} disabled={busy !== null}
                                aria-label={`Photo for product ${n + 1}`}
                                onChange={e => { void uploadPhoto(item, e.target.files?.[0]); e.target.value = '' }} />
                            </label>
                            {repPath && (
                              <button type="button" className="boe-btn boe-btn-ghost" style={{ padding: '3px 6px', fontSize: '11.5px' }}
                                onClick={() => setItem(item.key, { photo: { kind: 'remove' } })}>Remove photo</button>
                            )}
                          </div>
                          <div style={{ ...GRID, gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
                            <label style={{ ...LABEL, gridColumn: '1 / -1' }}>Name *
                              <input value={item.product_name} maxLength={300} style={FIELD} onChange={e => setItem(item.key, { product_name: e.target.value })} /></label>
                            <label style={LABEL}>Code
                              <input value={item.source_product_code} maxLength={100} style={FIELD} onChange={e => setItem(item.key, { source_product_code: e.target.value })} /></label>
                            <label style={LABEL}>Quantity *
                              <input inputMode="decimal" value={item.quantity} style={FIELD} onChange={e => setItem(item.key, { quantity: e.target.value })} /></label>
                            <label style={LABEL}>Price per piece (₹) *
                              <input inputMode="decimal" value={item.cost_per_piece} style={FIELD} onChange={e => setItem(item.key, { cost_per_piece: e.target.value })} /></label>
                            <label style={LABEL}>Dimensions
                              <input value={item.dimensions} maxLength={500} style={FIELD} onChange={e => setItem(item.key, { dimensions: e.target.value })} /></label>
                            <label style={{ ...LABEL, gridColumn: '1 / -1' }}>Material
                              <textarea rows={2} value={item.material} maxLength={1000} style={FIELD} onChange={e => setItem(item.key, { material: e.target.value })} /></label>
                            <label style={{ ...LABEL, gridColumn: '1 / -1' }}>Customization / description
                              <textarea rows={2} value={item.customization} maxLength={2000} style={FIELD} onChange={e => setItem(item.key, { customization: e.target.value })} /></label>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
                <button type="button" className="boe-btn boe-btn-ghost" style={{ alignSelf: 'flex-start' }}
                  onClick={() => set(s => ({ ...s, items: [...s.items, newEditItem(crypto.randomUUID())] }))}>
                  <Plus size={14} /> Add product
                </button>
              </div>

              <div style={H}>Commercial figures</div>
              <div style={GRID}>
                {([['discount_amount', 'Discount (₹)'], ['fabric_cost', 'Fabric cost (₹)'], ['packing_cost', 'Packing cost (₹)'],
                   ['transportation_amount', 'Transportation (₹)'], ['gst_percent', 'GST %']] as const).map(([key, label]) => (
                  <label key={key} style={LABEL}>{label}
                    <input inputMode="decimal" value={state.commercial[key]} style={FIELD}
                      placeholder={key !== 'gst_percent' && key !== 'discount_amount' ? 'Blank keeps what the PI states' : undefined}
                      onChange={e => { const v = e.target.value; set(s => ({ ...s, commercial: { ...s.commercial, [key]: v } })) }} />
                  </label>
                ))}
              </div>
              {priced && (
                <div style={{ border: `1px solid ${colors.border}`, borderRadius: '8px', padding: '10px 12px', background: colors.raised, fontSize: '12.5px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '6px' }}>
                  <span>Product value <strong>{formatInr(priced.commercial.gross_product_amount)}</strong></span>
                  <span>Total before GST <strong>{priced.commercial.total_before_gst === null ? 'Not stated' : formatInr(priced.commercial.total_before_gst)}</strong></span>
                  <span>GST <strong>{priced.commercial.gst_amount === null ? 'Not stated' : formatInr(priced.commercial.gst_amount)}</strong></span>
                  <span>Grand total <strong>{priced.commercial.grand_total === null ? 'Not stated' : formatInr(priced.commercial.grand_total)}</strong></span>
                  <span style={{ gridColumn: '1 / -1', color: colors.muted, fontSize: '11.5px' }}>
                    {priced.moneyChanged
                      ? 'Re-priced: line total = quantity × price; GST on the total before GST. The server prices it again when you save.'
                      : 'No quantity, price or cost changed, so every figure is exactly as the approved PI states it.'}
                  </span>
                </div>
              )}

              <div style={H}>Client PO and Design Files</div>
              <div style={{ fontSize: '12px', color: colors.secondary }}>
                {mode === 'propose'
                  ? 'Managed under Documents on this Order (Update documents), where each change is reviewed by an Admin and accepted by Operations.'
                  : 'Attach them in the Client PO and Design Files section of this PI; they are sent with it for approval.'}
              </div>
              <div style={{ fontSize: '11.5px', color: colors.muted }}>{EDIT_PI_WORKBOOK_NOTE}</div>

              <label style={LABEL}>
                {reasonRequired ? 'Why is the PI being revised? *' : 'Reason (needed only once the PI is under review)'}
                <textarea rows={2} maxLength={500} value={reason} style={FIELD} onChange={e => setReason(e.target.value)} />
              </label>

              {problems.length > 0 && (
                <ul role="alert" style={{ margin: 0, paddingLeft: '18px', color: colors.red, fontSize: '12px' }}>
                  {problems.slice(0, 6).map(p => <li key={p.message}>{p.message}</li>)}
                </ul>
              )}

              {reviewing && diff && (
                <div style={{ border: `1px solid ${colors.border}`, borderRadius: '8px', padding: '10px 12px' }}>
                  <div style={{ fontWeight: 700, fontSize: '12.5px', marginBottom: '6px' }}>What will change</div>
                  <PiDiffView diff={diff} />
                </div>
              )}
              {failure && <div role="alert" style={{ color: colors.red, fontSize: '12.5px' }}>{failure}</div>}
            </>
          )}
        </div>

        {state && (
          <div style={{ position: 'sticky', bottom: 0, background: colors.base, borderTop: `1px solid ${colors.border}`, padding: '10px 16px', display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ flex: 1, fontSize: '11.5px', color: colors.muted }}>
              {diff ? summarizeChanges(diff, n => formatInr(n)).join(' · ') : ''}
              {savedAt ? ` · Saved ${savedAt}` : ''}
            </span>
            <button type="button" className="boe-btn boe-btn-ghost" onClick={onClose} disabled={busy === 'submit'}>Cancel</button>
            {mode === 'propose' && (
              <button type="button" className="boe-btn boe-btn-ghost" onClick={() => void saveDraft()} disabled={busy !== null}>
                {busy === 'save' ? 'Saving…' : 'Save and continue later'}
              </button>
            )}
            {!reviewing ? (
              <button type="button" className="boe-btn boe-btn-primary" disabled={!canSubmit} onClick={() => setReviewing(true)}>
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
