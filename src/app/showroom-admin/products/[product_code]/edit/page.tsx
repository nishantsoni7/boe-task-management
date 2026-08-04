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
import { canAccessModule, type ModuleVisibilityType } from '@/lib/moduleAccess'
import { ProductImagePanel } from '../../ProductImagePanel'
import { useRefreshShowroomProductCounts } from '@/hooks/queries/useShowroomProductCounts'
import {
  PRODUCT_RETURN_MARKER_KEY, parseReturnMarker, productEditHref,
  resolveProductBack, sanitizeListSearch, type ProductReturnMarker,
} from '@/lib/showroom/productNav'

type ModVisRow = { visibility_type: string; allowed_department: string[] | null }
const teamFallback = (team?: string | null) =>
  !!team && (team.toLowerCase().includes('sales') || team.toLowerCase().includes('showroom'))

type SpecRow = { attr: string; val: string }
type DimState = { width: string; depth: string; height: string; unit: string }

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
  const [dims,        setDims]        = useState<DimState>({ width: '', depth: '', height: '', unit: 'inches' })
  const [mrp,         setMrp]         = useState('')
  const [loading,     setLoading]     = useState(true)
  const [saving,      setSaving]      = useState(false)
  const [error,       setError]       = useState('')
  const [success,     setSuccess]     = useState('')
  const [showroomMod, setShowroomMod] = useState<ModVisRow | null>(null)
  const [categories,      setCategories]      = useState<ShowroomCategory[]>([])
  const [categoriesError, setCategoriesError]  = useState('')
  const [imageIndex,      setImageIndex]      = useState(0)

  const router       = useRouter()
  const searchParams = useSearchParams()
  const supabase     = useMemo(() => createClient(), [])
  const { viewAsUserId, viewAsProfile } = useViewAs()
  const refreshNavCounts = useRefreshShowroomProductCounts()

  // The list view this product was opened from, carried in `from=` so Back can
  // rebuild it when browser history has nothing to go back to.
  const listSearch    = sanitizeListSearch(searchParams.get('from'))
  const fromCategory  = new URLSearchParams(listSearch).get('category') ?? ''

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

  useEffect(() => {
    if (!profile || !viewAsUserId || !viewAsProfile) return
    const effectiveHasAccess = viewAsProfile.role === 'admin' ||
      canAccessModule(showroomMod?.visibility_type as ModuleVisibilityType | undefined, showroomMod?.allowed_department, viewAsProfile, teamFallback(viewAsProfile.team))
    if (!effectiveHasAccess) router.replace('/modules')
  }, [profile, viewAsUserId, viewAsProfile, showroomMod, router])

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      const [{ data: p }, { data: mod }] = await Promise.all([
        supabase
          .from('users')
          .select('id, full_name, email, phone, role, team, position, is_active, created_at')
          .eq('id', session.user.id)
          .single(),
        supabase
          .from('app_modules')
          .select('visibility_type, allowed_department')
          .eq('module_key', 'showroom_qr')
          .single(),
      ])

      setShowroomMod(mod ?? null)
      const profile = p as UserProfile | null
      const hasAccess = !!profile && (profile.role === 'admin' ||
        canAccessModule(mod?.visibility_type as ModuleVisibilityType | undefined, mod?.allowed_department, profile, teamFallback(profile.team)))
      if (!hasAccess) { router.replace('/modules'); return }
      setProfile(profile)

      const [res, catRes] = await Promise.all([
        fetch(`/api/showroom/admin/products/${encodeURIComponent(productCode)}`, {
          headers: { 'Authorization': `Bearer ${session.access_token}` },
        }),
        fetch('/api/showroom/admin/categories', {
          headers: { 'Authorization': `Bearer ${session.access_token}` },
        }),
      ])
      if (!res.ok) { setError('Product not found'); setLoading(false); return }
      const data = await res.json()
      const found = data.product as ShowroomProduct | undefined
      if (!found) { setError('Product not found'); setLoading(false); return }

      if (catRes.ok) {
        const catData = await catRes.json()
        const loadedCategories: ShowroomCategory[] = Array.isArray(catData?.categories) ? catData.categories : []
        // A product may carry a category that's been renamed/deactivated since —
        // keep it selectable in the dropdown so the form doesn't silently blank it out.
        const hasCurrent = loadedCategories.some(c => c.name === found.category)
        setCategories(hasCurrent || !found.category ? loadedCategories : [
          { id: `current-${found.category}`, name: found.category, slug: found.category, is_active: true, created_at: '' },
          ...loadedCategories,
        ])
      } else {
        setCategoriesError('Failed to load categories')
      }

      setProduct(found)
      setCode(found.product_code)
      setName(found.name)
      setCategory(found.category)
      setDescription(found.description ?? '')
      setSpecs(jsonToSpecs(found.specifications))
      // Populate images: prefer new images[] array, fall back to legacy image_url
      const loadedImages = found.images?.length ? found.images : found.image_url ? [found.image_url] : ['']
      setImages(loadedImages.length ? loadedImages : [''])
      if (found.dimensions) {
        setDims({
          width:  found.dimensions.width  != null ? String(found.dimensions.width)  : '',
          depth:  found.dimensions.depth  != null ? String(found.dimensions.depth)  : '',
          height: found.dimensions.height != null ? String(found.dimensions.height) : '',
          unit:   found.dimensions.unit ?? 'inches',
        })
      }
      setMrp(String(found.mrp))
      setLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productCode])

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
      setSaving(false)
    }
  }

  if (loading) return <LoadingScreen />

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
          {categoriesError && (
            <div style={{ marginBottom: '20px' }}>
              <AlertBanner variant="red">{categoriesError}</AlertBanner>
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
                      {categories.map(c => (
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
