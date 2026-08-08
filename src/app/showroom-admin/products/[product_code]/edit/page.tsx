'use client'

import { useEffect, useState, useMemo, useCallback, Suspense } from 'react'
import { useRouter, useParams, useSearchParams } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile, ShowroomProduct, ShowroomCategory } from '@/lib/types'
import { AlertBanner, LoadingScreen } from '@/components/ui/atoms'
import { ShowroomAdminLayout } from '@/components/layout/ShowroomAdminLayout'
import { colors } from '@/lib/tokens'
import { useViewAs } from '@/hooks/useViewAs'
import { resolveModuleAccess } from '@/lib/moduleAccess'
import { ProductImagePanel } from '../../ProductImagePanel'
import { ProductStepper } from '../../ProductStepper'
import { useRefreshShowroomProductCounts } from '@/hooks/queries/useShowroomProductCounts'
import { useShowroomCategories } from '@/hooks/queries/useShowroomCategories'
import { useShowroomProductSequence } from '@/hooks/queries/useShowroomProductSequence'
import {
  PRODUCT_RETURN_MARKER_KEY, parseReturnMarker, productEditHref,
  productSequenceSearch, resolveProductBack, resolveProductNeighbors,
  sanitizeListSearch, type ProductReturnMarker,
} from '@/lib/showroom/productNav'

type ModVisRow = { visibility_type: string; allowed_department: string[] | null; allowed_user_ids: string[] | null }
const teamFallback = (team?: string | null) =>
  !!team && (team.toLowerCase().includes('sales') || team.toLowerCase().includes('showroom'))

type SpecRow = { attr: string; val: string }
type DimState = { width: string; depth: string; height: string; unit: string }

const EMPTY_DIMS: DimState = { width: '', depth: '', height: '', unit: 'inches' }

type FormValues = {
  code: string
  name: string
  category: string
  description: string
  specs: SpecRow[]
  images: string[]
  dims: DimState
  mrp: string
}

/**
 * The form's contents, reduced to what a save would actually send.
 *
 * Normalised through the very same functions the submit handler uses, so
 * "unsaved changes" tracks the *record*, not the typing: adding a blank spec
 * row, padding a field with a space or lower-casing a code the form will
 * upper-case anyway all leave this string untouched. Comparing two of them is
 * the whole dirty check.
 */
function formSnapshot(v: FormValues): string {
  return JSON.stringify({
    code: v.code.trim().toUpperCase(),
    name: v.name.trim(),
    category: v.category.trim(),
    description: v.description.trim(),
    specs: specsToJson(v.specs),
    images: v.images.map(u => u.trim()).filter(Boolean),
    dims: buildDims(v.dims),
    mrp: v.mrp.trim(),
  })
}

const FORM_CSS = `
.form-card {
  background: var(--fc-base);
  border: 1.5px solid var(--fc-border);
  border-radius: 16px;
  padding: 28px;
}
.form-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.section-label {
  font-size: 13px;
  font-weight: 700;
  color: #1a1a1a;
  margin: 0;
}
.product-field-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px 24px;
  align-items: start;
}
.product-field {
  display: flex;
  flex-direction: column;
}
.field-label {
  font-size: 12px;
  font-weight: 600;
  line-height: 1.4;
  display: block;
  margin-bottom: 5px;
}
.field-helper {
  font-size: 11px;
  line-height: 1.4;
  display: block;
  margin-top: 4px;
}
.spec-row {
  display: grid;
  grid-template-columns: 32% 1fr 40px;
  gap: 8px;
  align-items: center;
}
.form-actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 10px;
  padding-top: 16px;
  border-top: 1px solid var(--fc-border);
}

/* ── Edit layout: form left, product image right ──
   Desktop uses the full page width instead of a 780px column: the form takes
   ~63% and the image panel ~37%, which is the space the old fixed column was
   throwing away. minmax(0, …) on both tracks stops a long spec value from
   pushing the grid wider than the page. */
.product-edit-layout {
  display: grid;
  grid-template-columns: minmax(0, 1.7fr) minmax(0, 1fr);
  gap: 20px;
  align-items: start;
}
/* Sticky under the module's own sticky page header, so the image stays in view
   for the whole scroll through specifications and dimensions. */
.product-image-panel {
  position: sticky;
  top: 92px;
}

/* Below the two-column threshold the image goes above the form — seeing the
   product first is the point, and a 37% column would be unreadable here. */
@media (max-width: 1023px) {
  .product-edit-layout { grid-template-columns: minmax(0, 1fr); }
  .product-image-panel { position: static; order: -1; }
}
@media (max-width: 520px) {
  .product-field-grid { grid-template-columns: 1fr; }
  .form-actions       { flex-direction: column-reverse; }
  .form-actions > *   { width: 100%; text-align: center; }
}
`

// `useSearchParams` (the `from=` breadcrumb) opts the tree into client-side
// rendering, so the form lives below a Suspense boundary — same pattern as the
// list page.
export default function EditProductPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <EditProductContent />
    </Suspense>
  )
}

function EditProductContent() {
  const params      = useParams()
  const productCode = decodeURIComponent(params.product_code as string)

  const [profile,     setProfile]     = useState<UserProfile | null>(null)
  const [product,     setProduct]     = useState<ShowroomProduct | null>(null)
  const [code,        setCode]        = useState('')
  const [name,        setName]        = useState('')
  const [category,    setCategory]    = useState('')
  const [description, setDescription] = useState('')
  const [specs,       setSpecs]       = useState<SpecRow[]>([{ attr: '', val: '' }])
  const [images,      setImages]      = useState<string[]>([''])
  const [dims,        setDims]        = useState<DimState>(EMPTY_DIMS)
  const [mrp,         setMrp]         = useState('')
  // Which product the form currently holds. `loading` is derived from it rather
  // than stored, so it cannot fall out of step with the code in the URL.
  const [loadedCode,  setLoadedCode]  = useState<string | null>(null)
  const [saving,      setSaving]      = useState(false)
  const [error,       setError]       = useState('')
  const [success,     setSuccess]     = useState('')
  const [showroomMod, setShowroomMod] = useState<ModVisRow | null>(null)
  const [imageIndex,      setImageIndex]      = useState(0)
  // The form as it was when it loaded (or was last saved). Anything different is
  // an unsaved edit — see `dirty` below.
  const [baseline,        setBaseline]        = useState<string | null>(null)
  const [pendingStep,     setPendingStep]     = useState<string | null>(null)

  const router       = useRouter()
  const searchParams = useSearchParams()
  const supabase     = useMemo(() => createClient(), [])
  const { viewAsUserId, viewAsProfile } = useViewAs()
  const refreshNavCounts = useRefreshShowroomProductCounts()

  // Cached across the whole run of products — stepping to the next product no
  // longer re-fetches the category list it already has.
  const categoryQuery = useShowroomCategories(!!profile)

  // The list view this product was opened from, carried in `from=` so Back can
  // rebuild it when browser history has nothing to go back to.
  const listSearch    = sanitizeListSearch(searchParams.get('from'))
  const fromCategory  = new URLSearchParams(listSearch).get('category') ?? ''

  // Previous/Next changes `product_code` without remounting this component, so
  // everything tied to the *old* product has to be dropped the moment the URL
  // moves on. Otherwise the previous product's form stays on screen while the
  // next one loads and — worse — its baseline stays with it, so the incoming
  // product would look edited before anyone touched it.
  //
  // Adjusted during render rather than in an effect: the stale form must never
  // be painted, not even for one frame.
  if (loadedCode !== null && loadedCode !== productCode) {
    setLoadedCode(null)
    setBaseline(null)
    setError('')
    setSuccess('')
    setImageIndex(0)
  }

  /** The form does not yet hold the product the URL asks for. */
  const loading = loadedCode !== productCode

  // Read once, at mount: the marker records that the LIST navigated here, and
  // that is true only for this arrival.
  const [returnMarker] = useState<ProductReturnMarker | null>(() => {
    if (typeof window === 'undefined') return null
    try {
      return parseReturnMarker(window.sessionStorage.getItem(PRODUCT_RETURN_MARKER_KEY))
    } catch {
      return null
    }
  })

  // Cleared separately so the read above stays pure: a later reload, bookmark or
  // shared link of the same URL must not inherit this arrival's marker.
  useEffect(() => {
    try {
      window.sessionStorage.removeItem(PRODUCT_RETURN_MARKER_KEY)
    } catch {
      // Storage unavailable — nothing was read either, so nothing to clear.
    }
  }, [])

  // The control says "Back to products", so it must land on Product Master —
  // never wherever history happens to point. `history.back()` is used only when
  // the list itself opened this product, because there it restores filters,
  // page and scroll natively. Every other entry path — a bookmark, a new tab, a
  // link from elsewhere in BOE — becomes a plain internal navigation. Ordinary
  // browser Back is untouched.
  const goBack = useCallback(() => {
    const target = resolveProductBack({
      marker: returnMarker,
      from: listSearch,
      productCategory: product?.category ?? null,
    })
    if (target.action === 'back') router.back()
    else router.push(target.href)
  }, [router, listSearch, product, returnMarker])

  // ── Previous / next ─────────────────────────────────────────────────────────
  // The run the user is stepping through: the list view this product was opened
  // from, or — for a bookmark or a sidebar lookup, which carry no breadcrumb —
  // the product's own category at Product Master's defaults.
  const sequenceSearch = productSequenceSearch({
    from: listSearch,
    productCategory: product?.category ?? null,
  })
  const sequence  = useShowroomProductSequence(sequenceSearch, !!profile)
  const neighbors = useMemo(
    () => resolveProductNeighbors(sequence.codes, productCode),
    [sequence.codes, productCode],
  )

  // Warm both neighbours' routes so a click renders immediately instead of
  // waiting on the route bundle. Only the two adjacent products — never the run
  // — so this stays two prefetches regardless of how large the category is.
  useEffect(() => {
    for (const code of [neighbors.previous, neighbors.next]) {
      if (code) router.prefetch(productEditHref(code, listSearch))
    }
  }, [neighbors.previous, neighbors.next, listSearch, router])

  const dirty = baseline !== null && baseline !== formSnapshot({
    code, name, category, description, specs, images, dims, mrp,
  })

  // `targetCode`, not `productCode`: the outer `productCode` is the product
  // being edited, and shadowing it here would make the two easy to confuse.
  const stepTo = useCallback((targetCode: string) => {
    router.push(productEditHref(targetCode, listSearch))
  }, [router, listSearch])

  // Stepping away with edits in the form would destroy them silently, and
  // Previous/Next is designed to be clicked quickly. Ask once, and only when
  // there is genuinely something to lose.
  const requestStep = useCallback((targetCode: string) => {
    if (dirty) { setPendingStep(targetCode); return }
    stepTo(targetCode)
  }, [dirty, stepTo])

  useEffect(() => {
    if (!profile || !viewAsUserId || !viewAsProfile) return
    const effectiveHasAccess = viewAsProfile.role === 'admin' ||
      resolveModuleAccess('showroom_qr', showroomMod, viewAsProfile, teamFallback(viewAsProfile.team))
    if (!effectiveHasAccess) router.replace('/modules')
  }, [profile, viewAsUserId, viewAsProfile, showroomMod, router])

  useEffect(() => {
    // Guards against a superseded response: two quick steps must not let the
    // slower one win and land the user on a product they navigated past.
    let current = true

    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      // The product is requested alongside the access check, not after it. It
      // does not depend on the answer — only on having a session — and its own
      // API re-checks access anyway, so nothing is exposed by asking early. What
      // it saves is a whole round trip on the critical path, which is the cost
      // paid on every single step through Previous/Next.
      const [{ data: p }, { data: mod }, res] = await Promise.all([
        supabase
          .from('users')
          .select('id, full_name, email, phone, role, team, position, is_active, created_at')
          .eq('id', session.user.id)
          .single(),
        supabase
          .from('app_modules')
          .select('visibility_type, allowed_department, allowed_user_ids')
          .eq('module_key', 'showroom_qr')
          .single(),
        fetch(`/api/showroom/admin/products/${encodeURIComponent(productCode)}`, {
          headers: { 'Authorization': `Bearer ${session.access_token}` },
        }),
      ])

      // Superseded — the user stepped on again before this settled. Two rapid
      // clicks must not let the slower response win and land the user on a
      // product they already navigated past.
      if (!current) return

      setShowroomMod(mod ?? null)
      const profile = p as UserProfile | null
      const hasAccess = !!profile && (profile.role === 'admin' ||
        resolveModuleAccess('showroom_qr', mod, profile, teamFallback(profile.team)))
      // Leaving — the product response is simply dropped unread.
      if (!hasAccess) { router.replace('/modules'); return }
      setProfile(profile)

      // Settled, even though it failed: the skeleton gives way to the error.
      if (!res.ok) { setError('Product not found'); setLoadedCode(productCode); return }
      const data = await res.json()
      if (!current) return
      const found = data.product as ShowroomProduct | undefined
      if (!found) { setError('Product not found'); setLoadedCode(productCode); return }

      setProduct(found)

      // Populate images: prefer new images[] array, fall back to legacy image_url
      const loadedImages = found.images?.length ? found.images : found.image_url ? [found.image_url] : ['']
      const loadedSpecs  = jsonToSpecs(found.specifications)
      const loadedDims: DimState = found.dimensions ? {
        width:  found.dimensions.width  != null ? String(found.dimensions.width)  : '',
        depth:  found.dimensions.depth  != null ? String(found.dimensions.depth)  : '',
        height: found.dimensions.height != null ? String(found.dimensions.height) : '',
        unit:   found.dimensions.unit ?? 'inches',
      } : EMPTY_DIMS

      setCode(found.product_code)
      setName(found.name)
      setCategory(found.category)
      setDescription(found.description ?? '')
      setSpecs(loadedSpecs)
      setImages(loadedImages.length ? loadedImages : [''])
      setDims(loadedDims)
      setMrp(String(found.mrp))

      // Recorded from the same values the form was just given, so "unsaved
      // changes" means the user typed something — not that loading normalised a
      // field on the way in.
      setBaseline(formSnapshot({
        code: found.product_code,
        name: found.name,
        category: found.category,
        description: found.description ?? '',
        specs: loadedSpecs,
        images: loadedImages.length ? loadedImages : [''],
        dims: loadedDims,
        mrp: String(found.mrp),
      }))
      // Last, so the form is fully populated before it is shown.
      setLoadedCode(productCode)
    }
    init()
    return () => { current = false }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productCode])

  // A product may carry a category that's been renamed/deactivated since — keep
  // it selectable in the dropdown so the form doesn't silently blank it out.
  const categoryOptions = useMemo<ShowroomCategory[]>(() => {
    const loaded = categoryQuery.categories
    const current = product?.category
    if (!current || loaded.some(c => c.name === current)) return loaded
    return [
      { id: `current-${current}`, name: current, slug: current, is_active: true, created_at: '' },
      ...loaded,
    ]
  }, [categoryQuery.categories, product?.category])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setSuccess('')

    if (!code.trim() || !name.trim() || !category.trim() || !mrp.trim()) {
      setError('Product code, name, category and MRP are required')
      return
    }
    if (isNaN(parseFloat(mrp)) || parseFloat(mrp) <= 0) {
      setError('MRP must be a positive number')
      return
    }

    const specsObj = specsToJson(specs)
    const newCode = code.trim().toUpperCase()

    setSaving(true)
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) { router.push('/login'); return }

    const res = await fetch(`/api/showroom/admin/products/${productCode}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        product_code: newCode,
        name: name.trim(),
        category: category.trim(),
        description: description.trim() || null,
        specifications: specsObj,
        images: images.map(u => u.trim()).filter(Boolean),
        dimensions: buildDims(dims),
        mrp: parseFloat(mrp),
      }),
    })

    const data = await res.json()
    if (!res.ok) {
      setError(data.error ?? 'Failed to update product')
      setSaving(false)
    } else if (data.product.product_code !== productCode) {
      // Code changed — move to the new URL so further edits/refreshes target the
      // right record. `from=` rides along so Back still knows where to return.
      refreshNavCounts()
      router.replace(productEditHref(data.product.product_code, listSearch))
    } else {
      // A category change moves two sidebar badges.
      refreshNavCounts()
      setSuccess('Product updated')
      setProduct(data.product)
      // Saved — what is on screen is now what is stored, so Previous/Next stops
      // asking about it.
      setBaseline(formSnapshot({ code, name, category, description, specs, images, dims, mrp }))
      setSaving(false)
    }
  }

  // Back and Previous/Next, identical in both states. Kept mounted while the
  // next product loads so a run of edits is a run of clicks on a control that
  // stays put — a stepper that disappears for every load cannot be clicked
  // twice in a row.
  const navHeader = (
    <>
      <button
        type="button"
        onClick={goBack}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          fontSize: 13, color: colors.tertiary,
          background: 'transparent', border: 'none', padding: 0,
          cursor: 'pointer', marginBottom: 14,
        }}
        onMouseEnter={e => { e.currentTarget.style.color = colors.primary }}
        onMouseLeave={e => { e.currentTarget.style.color = colors.tertiary }}
      >
        <ArrowLeft size={14} strokeWidth={2.5} />
        Back to products
      </button>

      {/* Step to the neighbouring product without going through the list. Sits
          under Back — same row of "where am I" controls, above the form it
          navigates between. */}
      <ProductStepper neighbors={neighbors} onNavigate={requestStep} />
    </>
  )

  // A skeleton *inside* the module shell, not a full-screen loader: stepping
  // through products would otherwise tear down the sidebar and header on every
  // click and rebuild them a moment later, which reads as a flash rather than as
  // progress.
  if (loading) {
    return (
      <ShowroomAdminLayout
        profile={profile}
        title="Edit Product"
        subtitle={productCode}
        activeProductCategory={fromCategory}
        onSignOut={handleSignOut}
      >
        <style>{FORM_CSS}</style>
        {navHeader}
        <FormSkeleton />
      </ShowroomAdminLayout>
    )
  }

  return (
    <ShowroomAdminLayout
      profile={profile}
      title="Edit Product"
      subtitle={product ? `${product.product_code} · ${product.category}` : undefined}
      activeProductCategory={fromCategory || product?.category || ''}
      onSignOut={handleSignOut}
    >
      <style>{FORM_CSS}</style>
      <div style={{
        '--fc-base': colors.base,
        '--fc-border': colors.border,
      } as React.CSSProperties & Record<'--fc-base' | '--fc-border', string>}>

        {navHeader}

        {pendingStep && (
          <DiscardChangesModal
            targetCode={pendingStep}
            onCancel={() => setPendingStep(null)}
            onDiscard={() => { const code = pendingStep; setPendingStep(null); stepTo(code) }}
          />
        )}

        {/* Two columns on desktop: the form card, then the image panel below.
            The card keeps its original indentation so this stays a wrapper
            rather than a rewrite of the whole form. */}
        <div className="product-edit-layout">

        <div className="form-card">

          {error && (
            <div style={{ marginBottom: '20px' }}>
              <AlertBanner variant="red">{error}</AlertBanner>
            </div>
          )}
          {success && (
            <div style={{ marginBottom: '20px' }}>
              <AlertBanner variant="green">{success}</AlertBanner>
            </div>
          )}
          {categoryQuery.failed && (
            <div style={{ marginBottom: '20px' }}>
              <AlertBanner variant="red">Failed to load categories</AlertBanner>
            </div>
          )}

          {product && (
            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '22px' }}>

              {/* ── Basic Information ───────────────────────── */}
              <div className="form-section">
                <p className="section-label">Basic information</p>

                <div className="product-field-grid">
                  <Field label="Product Code *" hint="Used in the product's QR URL — changing it will invalidate previously printed QR codes for this product.">
                    <input
                      value={code}
                      onChange={e => setCode(e.target.value.toUpperCase())}
                      placeholder="BOE-DC-101"
                      style={inputStyle}
                    />
                  </Field>

                  <Field label="Name *">
                    <input
                      value={name}
                      onChange={e => setName(e.target.value)}
                      placeholder="Dining Chair"
                      style={inputStyle}
                    />
                  </Field>

                  <Field label="Category *">
                    <select
                      value={category}
                      onChange={e => setCategory(e.target.value)}
                      style={inputStyle}
                    >
                      <option value="">Select category</option>
                      {categoryOptions.map(c => (
                        <option key={c.id} value={c.name}>{c.name}</option>
                      ))}
                    </select>
                  </Field>

                  <Field label="MRP (₹) *">
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={mrp}
                      onChange={e => setMrp(e.target.value)}
                      placeholder="12500"
                      style={inputStyle}
                    />
                  </Field>
                </div>

                <Field label="Description">
                  <textarea
                    value={description}
                    onChange={e => setDescription(e.target.value)}
                    placeholder="Short product description shown to customers"
                    style={{ ...inputStyle, height: '90px', resize: 'vertical' }}
                  />
                </Field>
              </div>

              {/* ── Specifications ──────────────────────────── */}
              <div className="form-section">
                <p className="section-label">Specifications</p>
                <SpecsEditor specs={specs} onChange={setSpecs} />
              </div>

              {/* ── Dimensions ──────────────────────────────── */}
              <div className="form-section">
                <p className="section-label">Dimensions</p>
                <DimsEditor dims={dims} onChange={setDims} />
              </div>

              {/* ── Product Images ───────────────────────────── */}
              <div className="form-section">
                <p className="section-label">Product images</p>
                <ImagesEditor images={images} onChange={setImages} />
              </div>

              {/* Status note */}
              <div style={{
                fontSize: '12px', color: colors.tertiary,
                background: colors.raised,
                border: `1px solid ${colors.border}`,
                borderRadius: '7px', padding: '10px 12px',
                marginTop: '-8px',
              }}>
                Status: <strong>{product.is_active ? 'Active' : 'Inactive'}</strong> —
                use the toggle on the products list to activate or deactivate.
              </div>

              {/* ── Actions ─────────────────────────────────── */}
              <div className="form-actions">
                <button
                  type="button"
                  onClick={goBack}
                  style={cancelBtnStyle}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  style={{ ...primaryBtnStyle, opacity: saving ? 0.7 : 1, cursor: saving ? 'default' : 'pointer' }}
                >
                  {saving ? 'Saving…' : 'Save Changes'}
                </button>
              </div>

            </form>
          )}
        </div>

        {/* Image column — reads the same `images` state the form edits, so a
            pasted URL previews immediately. */}
        <aside className="product-image-panel">
          <ProductImagePanel
            images={images}
            selectedIndex={imageIndex}
            onSelect={setImageIndex}
            alt={name || product?.name || code}
          />
        </aside>
        </div>
      </div>
    </ShowroomAdminLayout>
  )
}

// ── Loading + confirmation ─────────────────────────────────────────────────

/** Placeholder in the shape of the edit layout, so nothing jumps on arrival. */
function FormSkeleton() {
  const bar = (width: string | number, height = 14) => (
    <div style={{ width, height, borderRadius: '4px', background: colors.raised }} />
  )
  return (
    <div className="product-edit-layout">
      <div style={{
        background: colors.base,
        border: `1.5px solid ${colors.border}`,
        borderRadius: '16px', padding: '28px',
        display: 'flex', flexDirection: 'column', gap: '18px',
      }}>
        {bar(120, 13)}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px 24px' }}>
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {bar(80, 11)}
              {bar('100%', 36)}
            </div>
          ))}
        </div>
        {bar('100%', 90)}
        {bar(120, 13)}
        {bar('100%', 36)}
      </div>
      <div className="product-image-panel">
        <div style={{
          background: colors.base,
          border: `1.5px solid ${colors.border}`,
          borderRadius: '16px', padding: '16px',
          display: 'flex', flexDirection: 'column', gap: '12px',
        }}>
          {bar(90, 13)}
          <div style={{ width: '100%', aspectRatio: '1 / 1', borderRadius: '12px', background: colors.raised }} />
        </div>
      </div>
    </div>
  )
}

/**
 * The one gate on Previous/Next, and only when the form actually differs from
 * what is stored. Naming the destination matters: the user clicked a product
 * code, so the question is about *that* step, not about some abstract navigation.
 */
function DiscardChangesModal({
  targetCode, onCancel, onDiscard,
}: {
  targetCode: string
  onCancel: () => void
  onDiscard: () => void
}) {
  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onCancel() }}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '20px',
      }}
    >
      <div style={{
        background: '#fff', borderRadius: '14px', width: '100%', maxWidth: 400,
        padding: '28px 28px 24px', boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
      }}>
        <div style={{ fontSize: '15px', fontWeight: 700, color: colors.primary, marginBottom: '10px' }}>
          Unsaved changes
        </div>
        <p style={{ fontSize: '13.5px', color: colors.secondary, marginBottom: '20px', lineHeight: 1.55 }}>
          This product has edits you haven&apos;t saved. Opening{' '}
          <strong style={{ color: colors.primary }}>{targetCode}</strong> will discard them.
        </p>
        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
          <button onClick={onCancel} style={cancelBtnStyle}>Stay and keep editing</button>
          <button
            onClick={onDiscard}
            style={{ ...primaryBtnStyle, cursor: 'pointer' }}
          >
            Discard and open
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Helpers ────────────────────────────────────────────────────────────────

function jsonToSpecs(raw: unknown): SpecRow[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [{ attr: '', val: '' }]
  const entries = Object.entries(raw as Record<string, unknown>)
  if (entries.length === 0) return [{ attr: '', val: '' }]
  return entries.map(([attr, val]) => ({ attr, val: String(val) }))
}

function specsToJson(rows: SpecRow[]): Record<string, string> | null {
  const obj: Record<string, string> = {}
  for (const { attr, val } of rows) {
    if (attr.trim() && val.trim()) obj[attr.trim()] = val.trim()
  }
  return Object.keys(obj).length > 0 ? obj : null
}

function buildDims(d: DimState) {
  const w = parseFloat(d.width)
  const dep = parseFloat(d.depth)
  const h = parseFloat(d.height)
  if (isNaN(w) && isNaN(dep) && isNaN(h)) return null
  return {
    width:  isNaN(w)   ? null : w,
    depth:  isNaN(dep) ? null : dep,
    height: isNaN(h)   ? null : h,
    unit:   d.unit || 'inches',
  }
}

const SPEC_ATTR_PLACEHOLDERS = ['Material', 'Height', 'Width', 'Depth', 'Finish', 'Fabric', 'Seat Height']


function SpecsEditor({ specs, onChange }: { specs: SpecRow[]; onChange: (rows: SpecRow[]) => void }) {
  const update = (i: number, field: 'attr' | 'val', value: string) => {
    onChange(specs.map((r, idx) => idx === i ? { ...r, [field]: value } : r))
  }
  const remove = (i: number) => onChange(specs.filter((_, idx) => idx !== i))
  const add    = () => onChange([...specs, { attr: '', val: '' }])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {specs.map((row, i) => (
        <div key={i} className="spec-row">
          <input
            value={row.attr}
            onChange={e => update(i, 'attr', e.target.value)}
            placeholder={`e.g. ${SPEC_ATTR_PLACEHOLDERS[i % SPEC_ATTR_PLACEHOLDERS.length]}`}
            style={inputStyle}
          />
          <input
            value={row.val}
            onChange={e => update(i, 'val', e.target.value)}
            placeholder="e.g. Steel"
            style={inputStyle}
          />
          <button
            type="button"
            onClick={() => remove(i)}
            style={removeBtnStyle}
          >
            ×
          </button>
        </div>
      ))}
      <div>
        <button
          type="button"
          onClick={add}
          style={addSpecBtnStyle}
        >
          + Add Specification
        </button>
      </div>
    </div>
  )
}

function ImagesEditor({ images, onChange }: { images: string[]; onChange: (imgs: string[]) => void }) {
  const update = (i: number, val: string) => onChange(images.map((u, idx) => idx === i ? val : u))
  const remove = (i: number) => onChange(images.filter((_, idx) => idx !== i))
  const add    = () => onChange([...images, ''])
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {images.map((url, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 40px', gap: '8px', alignItems: 'center' }}>
          <input
            value={url}
            onChange={e => update(i, e.target.value)}
            placeholder={i === 0 ? 'https://… (primary image)' : 'https://… (additional image)'}
            style={inputStyle}
          />
          {images.length > 1 && (
            <button type="button" onClick={() => remove(i)} style={removeBtnStyle}>×</button>
          )}
        </div>
      ))}
      <div>
        <button type="button" onClick={add} style={addSpecBtnStyle}>+ Add Image URL</button>
      </div>
      <span style={{ fontSize: '11px', color: '#888' }}>First URL is the primary display image</span>
    </div>
  )
}

const DIM_UNITS = ['inches', 'cm', 'mm', 'ft']

function DimsEditor({ dims, onChange }: { dims: DimState; onChange: (d: DimState) => void }) {
  const set = (field: keyof DimState, val: string) => onChange({ ...dims, [field]: val })
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 120px', gap: '12px', alignItems: 'end' }}>
        <div className="product-field">
          <span className="field-label" style={{ color: '#555' }}>Width</span>
          <input value={dims.width} onChange={e => set('width', e.target.value)} placeholder="e.g. 24" type="number" min="0" step="0.1" style={inputStyle} />
        </div>
        <div className="product-field">
          <span className="field-label" style={{ color: '#555' }}>Depth</span>
          <input value={dims.depth} onChange={e => set('depth', e.target.value)} placeholder="e.g. 24" type="number" min="0" step="0.1" style={inputStyle} />
        </div>
        <div className="product-field">
          <span className="field-label" style={{ color: '#555' }}>Height</span>
          <input value={dims.height} onChange={e => set('height', e.target.value)} placeholder="e.g. 32" type="number" min="0" step="0.1" style={inputStyle} />
        </div>
        <div className="product-field">
          <span className="field-label" style={{ color: '#555' }}>Unit</span>
          <select value={dims.unit} onChange={e => set('unit', e.target.value)} style={inputStyle}>
            {DIM_UNITS.map(u => <option key={u} value={u}>{u}</option>)}
          </select>
        </div>
      </div>
      <span style={{ fontSize: '11px', color: '#888' }}>Leave blank for any dimension you don&apos;t want to display</span>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="product-field">
      <span className="field-label" style={{ color: colors.secondary }}>{label}</span>
      {children}
      {hint && <span className="field-helper" style={{ color: colors.muted }}>{hint}</span>}
    </div>
  )
}

// ── Styles ─────────────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '9px 11px',
  height: '36px',
  fontSize: '13px',
  color: '#111318',
  background: '#fff',
  border: '1.5px solid rgba(0,0,0,0.13)',
  borderRadius: '7px',
  outline: 'none',
  boxSizing: 'border-box',
  fontFamily: 'var(--font-body, DM Sans, sans-serif)',
}

const removeBtnStyle: React.CSSProperties = {
  width: '36px',
  height: '36px',
  flexShrink: 0,
  border: '1.5px solid rgba(0,0,0,0.13)',
  borderRadius: '7px',
  background: '#fff',
  color: '#888',
  cursor: 'pointer',
  fontSize: '16px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontFamily: 'var(--font-body, DM Sans, sans-serif)',
}

const addSpecBtnStyle: React.CSSProperties = {
  padding: '6px 14px',
  fontSize: '12px',
  fontWeight: 500,
  background: 'transparent',
  color: '#555',
  border: '1px solid rgba(0,0,0,0.13)',
  borderRadius: '6px',
  cursor: 'pointer',
  fontFamily: 'var(--font-body, DM Sans, sans-serif)',
}

const primaryBtnStyle: React.CSSProperties = {
  padding: '10px 24px',
  background: '#1A2035',
  color: '#fff',
  border: 'none',
  borderRadius: '8px',
  fontSize: '13px',
  fontWeight: 600,
  fontFamily: 'var(--font-body, DM Sans, sans-serif)',
  whiteSpace: 'nowrap',
}

const cancelBtnStyle: React.CSSProperties = {
  padding: '10px 20px',
  background: 'transparent',
  color: '#555',
  border: '1px solid rgba(0,0,0,0.13)',
  borderRadius: '8px',
  fontSize: '13px',
  fontWeight: 500,
  cursor: 'pointer',
  fontFamily: 'var(--font-body, DM Sans, sans-serif)',
  whiteSpace: 'nowrap',
}
