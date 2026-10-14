'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, Loader2, Trash2 } from 'lucide-react'
import { InventoryLayout } from '@/components/layout/InventoryLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { useInventory } from '@/hooks/useInventory'
import {
  INVENTORY_KEY, deleteItem, fetchItem, fetchItems, itemKey, itemsKey, saveItem, type ItemInput,
} from '@/lib/inventory/api'
import { CONDITIONS, STAGES, type Condition, type InventoryItem, type Stage } from '@/lib/inventory/constants'
import { categoriesOf } from '@/lib/inventory/filters'
import { daysBetween, sortedImages } from '@/lib/inventory/format'
import { errorMessage, InventoryRequestError } from '@/lib/inventory/errors'
import { discardUploads, imageUrl, uploadImage } from '@/lib/inventory/images'
import { istToday } from '@/lib/istDate'
import { ImageUploader, type Photo } from './ImageUploader'
import { Notice, QtyStepper, Sheet, StageBadge } from './parts'
import s from './inventory.module.css'

type Draft = {
  code: string; name: string; category: string; size: string; material: string; notes: string
  price: string; condition: Condition | ''; stage: Stage | ''; days: string; qty: number
}

const EMPTY: Draft = { code: '', name: '', category: '', size: '', material: '', notes: '', price: '', condition: '', stage: '', days: '', qty: 1 }
const CODE_OK = /^[A-Z0-9][A-Z0-9._/-]{0,39}$/
const PRICE_OK = /^\d{1,10}(\.\d{1,2})?$/

function draftFrom(item: InventoryItem): Draft {
  const days = item.expected_ready_on ? Math.max(0, daysBetween(istToday(), item.expected_ready_on)) : null
  return {
    code: item.product_code, name: item.name, category: item.category ?? '', size: item.size_text, material: item.material,
    notes: item.description ?? '', price: String(Number(item.price)), condition: item.condition, stage: item.stage,
    days: days === null ? '' : String(days), qty: item.qty_total,
  }
}

export default function ProductFormScreen({ mode }: { mode: 'new' | 'edit' }) {
  const params = useParams<{ id?: string }>()
  const editId = mode === 'edit' ? params.id ?? null : null
  const inv = useInventory()
  const { supabase, profile, loading, signOut, access, pending } = inv

  const itemQ = useQuery({
    queryKey: itemKey(editId ?? 'none'), queryFn: () => fetchItem(supabase, editId as string),
    enabled: !loading && !!editId, staleTime: 0,
  })

  if (loading || (mode === 'edit' && itemQ.isLoading)) return <LoadingScreen />

  if (mode === 'edit' && itemQ.isSuccess && !itemQ.data) {
    return (
      <InventoryLayout profile={profile} access={access} pending={pending} onSignOut={signOut} title="Edit Product">
        <div className={s.wrapNarrow}>
          <Notice kind="warn">This product no longer exists. <Link href="/inventory" className={s.linkBtn}>Back to stock</Link></Notice>
        </div>
      </InventoryLayout>
    )
  }
  // Keyed by the product: another product, or a refreshed one, starts the form from its own values.
  return <ProductForm key={itemQ.data?.id ?? 'new'} mode={mode} editId={editId} item={itemQ.data ?? null} inv={inv} />
}

function ProductForm({
  mode, editId, item, inv,
}: { mode: 'new' | 'edit'; editId: string | null; item: InventoryItem | null; inv: ReturnType<typeof useInventory> }) {
  const router = useRouter()
  const qc = useQueryClient()
  const { supabase, profile, signOut, access, accessLoaded, pending } = inv

  const listQ = useQuery({ queryKey: itemsKey, queryFn: () => fetchItems(supabase), staleTime: 60_000 })

  const [draft, setDraft] = useState<Draft>(() => (item ? draftFrom(item) : EMPTY))
  const [photos, setPhotos] = useState<Photo[]>(() =>
    item ? sortedImages(item).map<Photo>(i => ({ key: i.path, path: i.path, url: imageUrl(supabase, i.path), status: 'ok' })) : [])
  const [daysTouched, setDaysTouched] = useState(false)
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const [submitted, setSubmitted] = useState(false)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [codeTaken, setCodeTaken] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const userId = profile?.id ?? null
  const uploadedHere = useRef<Set<string>>(new Set())
  const savedRef = useRef(false)

  // Leaving without saving: pictures uploaded on this screen and not on a product are tidied away.
  useEffect(() => () => {
    if (!savedRef.current && uploadedHere.current.size) void discardUploads(supabase, [...uploadedHere.current])
  }, [supabase])

  // Rights: the database refuses anyway; this just stops showing a form that cannot be saved.
  useEffect(() => {
    if (!accessLoaded) return
    if (mode === 'new' && !access.create) router.replace('/inventory')
    if (mode === 'edit' && !access.edit) router.replace(editId ? `/inventory/${editId}` : '/inventory')
  }, [accessLoaded, access, mode, router, editId])

  const categories = useMemo(() => categoriesOf(listQ.data ?? []), [listQ.data])
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft(d => ({ ...d, [k]: v }))
  const touch = (k: string) => setTouched(t => ({ ...t, [k]: true }))

  // Photos ---------------------------------------------------------------
  const startUpload = useCallback(async (key: string, blob: Blob) => {
    if (!userId) return
    try {
      const path = await uploadImage(supabase, userId, blob)
      uploadedHere.current.add(path)
      setPhotos(ps => ps.map(p => p.key === key ? { ...p, path, status: 'ok', url: p.url, blob: undefined } : p))
    } catch {
      setPhotos(ps => ps.map(p => p.key === key ? { ...p, status: 'failed' } : p))
    }
  }, [supabase, userId])

  const addFiles = (files: File[]) => {
    const fresh = files.map<Photo>(f => ({ key: crypto.randomUUID(), path: null, url: URL.createObjectURL(f), status: 'uploading', blob: f }))
    setPhotos(ps => [...ps, ...fresh])
    fresh.forEach(p => { void startUpload(p.key, p.blob as Blob) })
  }
  const retry = (key: string) => {
    const p = photos.find(x => x.key === key)
    if (!p?.blob) return
    setPhotos(ps => ps.map(x => x.key === key ? { ...x, status: 'uploading' } : x))
    void startUpload(key, p.blob)
  }
  const removePhoto = (key: string) => {
    const p = photos.find(x => x.key === key)
    setPhotos(ps => ps.filter(x => x.key !== key))
    if (p?.path && uploadedHere.current.has(p.path)) {
      uploadedHere.current.delete(p.path)
      void discardUploads(supabase, [p.path])
    }
    if (p && p.url.startsWith('blob:')) URL.revokeObjectURL(p.url)
  }
  const makeCover = (key: string) => setPhotos(ps => {
    const p = ps.find(x => x.key === key)
    return p ? [p, ...ps.filter(x => x.key !== key)] : ps
  })
  useEffect(() => () => { photos.forEach(p => { if (p.url.startsWith('blob:')) URL.revokeObjectURL(p.url) }) }, [photos])

  // Validation -------------------------------------------------------------
  const codeUp = draft.code.trim().toUpperCase()
  const duplicate = useMemo(
    () => !!codeUp && (listQ.data ?? []).some(i => i.product_code === codeUp && i.id !== editId),
    [codeUp, listQ.data, editId],
  )
  const errors: Record<string, string> = {}
  if (!codeUp) errors.code = 'Enter a product code'
  else if (!CODE_OK.test(codeUp)) errors.code = 'Use letters, digits and . _ / - only'
  else if (duplicate || codeTaken === codeUp) errors.code = `${codeUp} is already used by another product`
  if (!draft.name.trim()) errors.name = 'Enter the product name'
  if (!draft.size.trim()) errors.size = 'Enter the size'
  if (!draft.material.trim()) errors.material = 'Enter the material'
  if (!PRICE_OK.test(draft.price.replace(/[,\s₹]/g, ''))) errors.price = 'Enter the price, like 4500 or 4500.50'
  if (!draft.condition) errors.condition = 'Choose the condition'
  if (!draft.stage) errors.stage = 'Choose the stage'
  if (draft.stage && draft.stage !== 'ready' && draft.days.trim() !== '' && !/^\d{1,4}$/.test(draft.days.trim())) errors.days = 'Days must be a whole number'
  const minQty = item ? item.qty_sold + item.qty_reserved : 0
  if (draft.qty < Math.max(minQty, 0)) errors.qty = `Cannot be below ${minQty} (already sold or reserved)`
  const live = photos.filter(p => p.status !== 'failed')
  if (live.length === 0) errors.photos = 'Add at least one picture'
  const busyUploading = photos.some(p => p.status === 'uploading')
  const failedUploads = photos.some(p => p.status === 'failed')
  const show = (k: string) => (submitted || touched[k]) && errors[k]

  const pickStage = (v: Stage) => {
    setDraft(d => ({ ...d, stage: v, days: !daysTouched && v !== 'ready' ? String(STAGES.find(x => x.value === v)?.days ?? '') : d.days }))
  }

  const save = async () => {
    setSubmitted(true)
    setFormError(null)
    if (Object.keys(errors).length > 0) {
      const first = document.querySelector<HTMLElement>('[data-invalid="true"]')
      first?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      return
    }
    if (busyUploading) { setFormError('Wait for the pictures to finish uploading.'); return }
    if (failedUploads) { setFormError('A picture did not upload. Retry or remove it.'); return }
    setSaving(true)
    try {
      const base: ItemInput = {
        product_code: codeUp, name: draft.name.trim(), category: draft.category.trim(), size_text: draft.size.trim(),
        material: draft.material.trim(), description: draft.notes.trim(), price: Number(draft.price.replace(/[,\s₹]/g, '')),
        condition: draft.condition as Condition, stage: draft.stage as Stage, qty_total: draft.qty,
      }
      const stageChanged = !!item && item.stage !== draft.stage
      if (draft.stage !== 'ready' && (mode === 'new' || daysTouched || stageChanged)) {
        base.ready_in_days = draft.days.trim() === '' ? null : Number(draft.days.trim())
      }
      const out = await saveItem(supabase, editId, base, photos.map(p => p.path as string))
      savedRef.current = true
      await qc.invalidateQueries({ queryKey: INVENTORY_KEY })
      router.replace(`/inventory/${out.id}?saved=${mode === 'new' ? 'created' : 'updated'}`)
    } catch (e) {
      if (e instanceof InventoryRequestError && e.kind === 'duplicate_code') setCodeTaken(codeUp)
      setFormError(errorMessage(e))
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!editId) return
    setDeleting(true)
    setDeleteError(null)
    try {
      await deleteItem(supabase, editId)
      savedRef.current = true
      await qc.invalidateQueries({ queryKey: INVENTORY_KEY })
      router.replace('/inventory?deleted=1')
    } catch (e) {
      setDeleteError(errorMessage(e))
      setDeleting(false)
    }
  }

  const title = mode === 'new' ? 'Add Product' : 'Edit Product'
  const back = mode === 'edit' && editId ? `/inventory/${editId}` : '/inventory'

  const stage = STAGES.find(x => x.value === draft.stage)
  const showDays = !!draft.stage && draft.stage !== 'ready'

  return (
    <InventoryLayout profile={profile} access={access} pending={pending} onSignOut={signOut} title={title}
      subtitle={mode === 'edit' ? draft.code : 'Everything a salesperson needs to sell it'}>
      <form className={s.wrapNarrow} onSubmit={e => { e.preventDefault(); void save() }} noValidate>
        <Link href={back} className={s.back}><ChevronLeft size={18} /> {mode === 'edit' ? 'Back to product' : 'Back to stock'}</Link>

        <section className={s.formCard} aria-labelledby="f-photos">
          <h2 className={s.formTitle} id="f-photos"><span className={s.stepNo}>1</span> Pictures <span className={s.req}>*</span></h2>
          <div data-invalid={!!show('photos')}>
            <ImageUploader photos={photos} onAdd={addFiles} onRemove={removePhoto} onMakeCover={makeCover} onRetry={retry} invalid={!!show('photos')} />
            {show('photos') && <div className={s.err} role="alert" style={{ marginTop: 8 }}>{errors.photos}</div>}
          </div>
        </section>

        <section className={s.formCard} aria-labelledby="f-basics">
          <h2 className={s.formTitle} id="f-basics"><span className={s.stepNo}>2</span> Details</h2>
          <div className={s.grid2}>
            <div className={s.field}>
              <label className={s.label} htmlFor="f-code">Product code <span className={s.req}>*</span></label>
              <input id="f-code" className={`${s.input} ${s.mono}${show('code') ? ` ${s.invalid}` : ''}`} value={draft.code}
                onChange={e => { set('code', e.target.value); setCodeTaken(null) }} onBlur={() => touch('code')}
                autoCapitalize="characters" autoComplete="off" spellCheck={false} maxLength={40} placeholder="CH-0142"
                aria-invalid={!!show('code')} aria-describedby="f-code-h" data-invalid={!!show('code')} />
              {show('code') ? <div className={s.err} id="f-code-h" role="alert">{errors.code}</div> : <div className={s.hint} id="f-code-h">Unique for every product. It is printed on the share message.</div>}
            </div>
            <div className={s.field}>
              <label className={s.label} htmlFor="f-name">Product name <span className={s.req}>*</span></label>
              <input id="f-name" className={`${s.input}${show('name') ? ` ${s.invalid}` : ''}`} value={draft.name} onChange={e => set('name', e.target.value)}
                onBlur={() => touch('name')} maxLength={120} placeholder="e.g. Teak dining chair" autoComplete="off" aria-invalid={!!show('name')} data-invalid={!!show('name')} />
              {show('name') && <div className={s.err} role="alert">{errors.name}</div>}
            </div>
            <div className={s.field}>
              <label className={s.label} htmlFor="f-size">Size <span className={s.req}>*</span></label>
              <input id="f-size" className={`${s.input}${show('size') ? ` ${s.invalid}` : ''}`} value={draft.size} onChange={e => set('size', e.target.value)}
                onBlur={() => touch('size')} maxLength={120} placeholder="L × W × H, e.g. 45 × 50 × 90 cm" autoComplete="off" aria-invalid={!!show('size')} data-invalid={!!show('size')} />
              {show('size') && <div className={s.err} role="alert">{errors.size}</div>}
            </div>
            <div className={s.field}>
              <label className={s.label} htmlFor="f-mat">Material <span className={s.req}>*</span></label>
              <input id="f-mat" className={`${s.input}${show('material') ? ` ${s.invalid}` : ''}`} value={draft.material} onChange={e => set('material', e.target.value)}
                onBlur={() => touch('material')} maxLength={120} placeholder="e.g. Teak wood, velvet seat" autoComplete="off" aria-invalid={!!show('material')} data-invalid={!!show('material')} />
              {show('material') && <div className={s.err} role="alert">{errors.material}</div>}
            </div>
            <div className={s.field}>
              <label className={s.label} htmlFor="f-cat">Category</label>
              <input id="f-cat" className={s.input} value={draft.category} onChange={e => set('category', e.target.value)} maxLength={60}
                list="f-cat-list" placeholder="e.g. Chairs, Tables, Sofas" autoComplete="off" />
              <datalist id="f-cat-list">{categories.map(c => <option key={c} value={c} />)}</datalist>
            </div>
          </div>
          <div className={s.field}>
            <label className={s.label} htmlFor="f-notes">Notes for the sales team</label>
            <textarea id="f-notes" className={s.textarea} value={draft.notes} onChange={e => set('notes', e.target.value)} maxLength={1000}
              placeholder="Finish, colour options, damage to mention, anything a customer will ask" />
            <div className={s.hint}>{draft.notes.length}/1000. Shared with the customer on WhatsApp.</div>
          </div>
        </section>

        <section className={s.formCard} aria-labelledby="f-status">
          <h2 className={s.formTitle} id="f-status"><span className={s.stepNo}>3</span> Condition and stage</h2>
          <div className={s.field} data-invalid={!!show('condition')}>
            <span className={s.label} id="f-cond-l">Condition <span className={s.req}>*</span></span>
            <div className={s.optionGrid} role="radiogroup" aria-labelledby="f-cond-l">
              {CONDITIONS.map(c => (
                <button key={c.value} type="button" role="radio" aria-checked={draft.condition === c.value}
                  className={`${s.option}${draft.condition === c.value ? ` ${s.optionOn}` : ''}`} onClick={() => { set('condition', c.value); touch('condition') }}>
                  <span className={s.optionName}>{c.label}</span><span className={s.optionHint}>{c.hint}</span>
                </button>
              ))}
            </div>
            {show('condition') && <div className={s.err} role="alert">{errors.condition}</div>}
          </div>
          <div className={s.field} data-invalid={!!show('stage')}>
            <span className={s.label} id="f-stage-l">Stage <span className={s.req}>*</span></span>
            <div className={`${s.optionGrid} ${s.optionGrid3} ${s.optionGridStage}`} role="radiogroup" aria-labelledby="f-stage-l">
              {STAGES.map(st => (
                <button key={st.value} type="button" role="radio" aria-checked={draft.stage === st.value}
                  className={`${s.option} ${s.optionStage}${draft.stage === st.value ? ` ${s.optionOn}` : ''}`} onClick={() => { pickStage(st.value); touch('stage') }}>
                  <span className={s.optionName}><StageBadge stage={st.value} /></span><span className={s.optionHint}>{st.hint}</span>
                </button>
              ))}
            </div>
            {show('stage') && <div className={s.err} role="alert">{errors.stage}</div>}
          </div>
          {showDays && (
            <div className={s.field}>
              <label className={s.label} htmlFor="f-days">Ready in how many days?</label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <input id="f-days" className={`${s.input}${show('days') ? ` ${s.invalid}` : ''}`} style={{ maxWidth: 140 }} value={draft.days}
                  inputMode="numeric" pattern="[0-9]*" maxLength={4} placeholder="days"
                  onChange={e => { setDaysTouched(true); set('days', e.target.value.replace(/\D/g, '')) }} onBlur={() => touch('days')}
                  aria-invalid={!!show('days')} data-invalid={!!show('days')} />
                {[7, 14, 30].map(n => (
                  <button key={n} type="button" className={`${s.chip}${draft.days === String(n) ? ` ${s.chipOn}` : ''}`} onClick={() => { setDaysTouched(true); set('days', String(n)) }}>{n}d</button>
                ))}
              </div>
              {show('days') ? <div className={s.err} role="alert">{errors.days}</div>
                : <div className={s.hint}>Counted from today. Salespeople see this as “ready in about N days”.{stage && ` Usual for ${stage.label.toLowerCase()}: ${stage.days} days.`}</div>}
            </div>
          )}
        </section>

        <section className={s.formCard} aria-labelledby="f-stock">
          <h2 className={s.formTitle} id="f-stock"><span className={s.stepNo}>4</span> Price and quantity</h2>
          <div className={s.grid2}>
            <div className={s.field}>
              <label className={s.label} htmlFor="f-price">Price per piece <span className={s.req}>*</span></label>
              <div className={s.adorn}>
                <span className={s.adornLead} aria-hidden="true">₹</span>
                <input id="f-price" className={`${s.input}${show('price') ? ` ${s.invalid}` : ''}`} value={draft.price} onChange={e => set('price', e.target.value)}
                  onBlur={() => touch('price')} inputMode="decimal" placeholder="0" autoComplete="off" aria-invalid={!!show('price')} data-invalid={!!show('price')} />
              </div>
              {show('price') && <div className={s.err} role="alert">{errors.price}</div>}
            </div>
            <div className={s.field} data-invalid={!!show('qty')}>
              <span className={s.label} id="f-qty-l">Total quantity</span>
              <QtyStepper value={draft.qty} onChange={n => set('qty', n)} min={Math.max(minQty, 0)} label="Total quantity" />
              {show('qty') ? <div className={s.err} role="alert">{errors.qty}</div>
                : <div className={s.hint}>{item ? `Sold ${item.qty_sold}, reserved ${item.qty_reserved}. Available is worked out for you.` : 'Every unit you have. Available and sold are tracked as bookings are confirmed.'}</div>}
            </div>
          </div>
        </section>

        {formError && <Notice kind="err">{formError}</Notice>}

        <div className={s.saveBar}>
          <Link href={back} className={s.btn} style={{ minHeight: 52 }}>Cancel</Link>
          <button type="submit" className={`${s.btn} ${s.btnPrimary}`} disabled={saving || busyUploading}>
            {saving ? <><Loader2 size={18} className={s.spin} /> Saving…</> : busyUploading ? 'Uploading pictures…' : mode === 'new' ? 'Save product' : 'Save changes'}
          </button>
        </div>

        {mode === 'edit' && access.delete && (
          <div className={s.danger}>
            <div className={s.label}>Delete this product</div>
            <div className={s.hint}>Removes it from the stock list for everyone. Past bookings stay on record. Not possible while booking requests are waiting.</div>
            <button type="button" className={`${s.btn} ${s.btnDanger}`} style={{ alignSelf: 'flex-start' }} onClick={() => { setDeleteError(null); setConfirmDelete(true) }}>
              <Trash2 size={17} /> Delete product
            </button>
          </div>
        )}
      </form>

      {confirmDelete && (
        <Sheet title="Delete this product?" subtitle={`${draft.code} · ${draft.name}`} busy={deleting} onClose={() => setConfirmDelete(false)}
          footer={<>
            <button type="button" className={s.btn} onClick={() => setConfirmDelete(false)} disabled={deleting}>Keep it</button>
            <button type="button" className={`${s.btn} ${s.btnDanger}`} onClick={() => void remove()} disabled={deleting}>
              {deleting ? <Loader2 size={17} className={s.spin} /> : <Trash2 size={17} />} Delete
            </button>
          </>}>
          <p style={{ margin: 0, fontSize: 15, lineHeight: 1.5, color: '#303536' }}>The product disappears from the stock list and cannot be booked. This cannot be undone from the app.</p>
          {deleteError && <Notice kind="err">{deleteError}</Notice>}
        </Sheet>
      )}
    </InventoryLayout>
  )
}
