'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile, ShowroomCategory } from '@/lib/types'
import { AlertBanner, LoadingScreen } from '@/components/ui/atoms'
import { ShowroomAdminLayout } from '@/components/layout/ShowroomAdminLayout'
import { colors, font } from '@/lib/tokens'
import { useViewAs } from '@/hooks/useViewAs'
import { canAccessModule, type ModuleVisibilityType } from '@/lib/moduleAccess'

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
@media (max-width: 520px) {
  .product-field-grid { grid-template-columns: 1fr; }
  .form-actions       { flex-direction: column-reverse; }
  .form-actions > *   { width: 100%; text-align: center; }
}
`

export default function NewProductPage() {
  const [profile,     setProfile]     = useState<UserProfile | null>(null)
  const [loadingAuth, setLoadingAuth] = useState(true)
  const [productCode, setProductCode] = useState('')
  const [name,        setName]        = useState('')
  const [category,    setCategory]    = useState('')
  const [description, setDescription] = useState('')
  const [specs,       setSpecs]       = useState<SpecRow[]>([{ attr: '', val: '' }])
  const [images,      setImages]      = useState<string[]>([''])
  const [dims,        setDims]        = useState<DimState>({ width: '', depth: '', height: '', unit: 'inches' })
  const [mrp,         setMrp]         = useState('')
  const [saving,      setSaving]      = useState(false)
  const [error,       setError]       = useState('')
  const [showroomMod, setShowroomMod] = useState<ModVisRow | null>(null)
  const [categories,     setCategories]     = useState<ShowroomCategory[]>([])
  const [categoriesError, setCategoriesError] = useState('')

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const { viewAsUserId, viewAsProfile } = useViewAs()

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

      const catRes = await fetch('/api/showroom/admin/categories', {
        headers: { 'Authorization': `Bearer ${session.access_token}` },
      })
      if (catRes.ok) {
        const catData = await catRes.json()
        setCategories(Array.isArray(catData?.categories) ? catData.categories : [])
      } else {
        setCategoriesError('Failed to load categories')
      }

      setLoadingAuth(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (!productCode.trim() || !name.trim() || !category.trim() || !mrp.trim()) {
      setError('Product code, name, category and MRP are required')
      return
    }
    if (isNaN(parseFloat(mrp)) || parseFloat(mrp) <= 0) {
      setError('MRP must be a positive number')
      return
    }

    const specsObj = specsToJson(specs)

    setSaving(true)
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) { router.push('/login'); return }

    const imagesArr = images.map(u => u.trim()).filter(Boolean)
    const dimsObj = buildDims(dims)

    const res = await fetch('/api/showroom/admin/products', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        product_code: productCode,
        name,
        category,
        description: description || null,
        specifications: specsObj,
        images: imagesArr,
        dimensions: dimsObj,
        mrp,
      }),
    })

    const data = await res.json()
    if (!res.ok) {
      setError(data.error ?? 'Failed to create product')
      setSaving(false)
      return
    }

    router.push('/showroom-admin/products')
  }

  if (loadingAuth) return <LoadingScreen />

  return (
    <ShowroomAdminLayout
      profile={profile}
      title="New Product"
      onSignOut={handleSignOut}
    >
      {/* CSS variables bridge for classes that can't use JS token values directly */}
      <style>{FORM_CSS}</style>
      <div style={{
        maxWidth: '780px',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ['--fc-base' as any]: colors.base,
        ['--fc-border' as any]: colors.border,
      }}>

        <div className="form-card">

          {error && (
            <div style={{ marginBottom: '24px' }}>
              <AlertBanner variant="red">{error}</AlertBanner>
            </div>
          )}
          {categoriesError && (
            <div style={{ marginBottom: '24px' }}>
              <AlertBanner variant="red">{categoriesError}</AlertBanner>
            </div>
          )}

          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '22px' }}>

            {/* ── Basic Information ─────────────────────────── */}
            <div className="form-section">
              <p className="section-label">Basic information</p>

              <div className="product-field-grid">
                <Field label="Product Code *" hint="e.g. BOE-DC-101 — used in QR URL, must be unique">
                  <input
                    value={productCode}
                    onChange={e => setProductCode(e.target.value.toUpperCase())}
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

            {/* ── Specifications ────────────────────────────── */}
            <div className="form-section">
              <p className="section-label">Specifications</p>
              <SpecsEditor specs={specs} onChange={setSpecs} />
            </div>

            {/* ── Dimensions ────────────────────────────────── */}
            <div className="form-section">
              <p className="section-label">Dimensions</p>
              <DimsEditor dims={dims} onChange={setDims} />
            </div>

            {/* ── Product Images ────────────────────────────── */}
            <div className="form-section">
              <p className="section-label">Product images</p>
              <ImagesEditor images={images} onChange={setImages} />
            </div>

            {/* ── Actions ───────────────────────────────────── */}
            <div className="form-actions">
              <button
                type="button"
                onClick={() => router.push('/showroom-admin/products')}
                style={cancelBtnStyle}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                style={{ ...primaryBtnStyle, opacity: saving ? 0.7 : 1, cursor: saving ? 'default' : 'pointer' }}
              >
                {saving ? 'Creating…' : 'Create Product'}
              </button>
            </div>

          </form>
        </div>
      </div>
    </ShowroomAdminLayout>
  )
}

// ── Helpers ────────────────────────────────────────────────────────────────

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
