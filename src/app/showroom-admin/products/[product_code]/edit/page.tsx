'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile, ShowroomProduct } from '@/lib/types'
import { AlertBanner, LoadingScreen } from '@/components/ui/atoms'
import { ShowroomAdminLayout } from '@/components/layout/ShowroomAdminLayout'
import { colors, font } from '@/lib/tokens'
import { useViewAs } from '@/hooks/useViewAs'

type SpecRow = { attr: string; val: string }

const CATEGORIES = [
  'Dining Chairs',
  'Bar Chairs',
  'Tables',
  'Sofas',
  'Outdoor',
  'Conference',
  'Other',
]

export default function EditProductPage() {
  const params      = useParams()
  const productCode = decodeURIComponent(params.product_code as string)

  const [profile,     setProfile]     = useState<UserProfile | null>(null)
  const [product,     setProduct]     = useState<ShowroomProduct | null>(null)
  const [name,        setName]        = useState('')
  const [category,    setCategory]    = useState('')
  const [description, setDescription] = useState('')
  const [specs,       setSpecs]       = useState<SpecRow[]>([{ attr: '', val: '' }])
  const [imageUrl,    setImageUrl]    = useState('')
  const [mrp,            setMrp]            = useState('')
  const [loading,        setLoading]        = useState(true)
  const [saving,         setSaving]         = useState(false)
  const [error,          setError]          = useState('')
  const [success,        setSuccess]        = useState('')

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const { viewAsUserId, viewAsProfile } = useViewAs()

  useEffect(() => {
    if (!profile || !viewAsUserId || !viewAsProfile) return
    if (viewAsProfile.role !== 'admin') router.replace('/modules')
  }, [profile, viewAsUserId, viewAsProfile, router])

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      const { data: p } = await supabase
        .from('users')
        .select('id, full_name, email, phone, role, team, position, is_active, created_at')
        .eq('id', session.user.id)
        .single()
      if (!p || p.role !== 'admin') { router.replace('/modules'); return }
      setProfile(p as UserProfile)

      const res = await fetch('/api/showroom/admin/products', {
        headers: { 'Authorization': `Bearer ${session.access_token}` },
      })
      const data = await res.json()
      const found = (data.products as ShowroomProduct[])?.find(
        pr => pr.product_code === productCode
      )
      if (!found) { setError('Product not found'); setLoading(false); return }

      setProduct(found)
      setName(found.name)
      setCategory(found.category)
      setDescription(found.description ?? '')
      setSpecs(jsonToSpecs(found.specifications))
      setImageUrl(found.image_url ?? '')
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

    if (!name.trim() || !category.trim() || !mrp.trim()) {
      setError('Name, category and MRP are required')
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

    const res = await fetch(`/api/showroom/admin/products/${productCode}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: name.trim(),
        category: category.trim(),
        description: description.trim() || null,
        specifications: specsObj,
        image_url: imageUrl.trim() || null,
        mrp: parseFloat(mrp),
      }),
    })

    const data = await res.json()
    if (!res.ok) {
      setError(data.error ?? 'Failed to update product')
    } else {
      setSuccess('Product updated')
      setProduct(data.product)
    }
    setSaving(false)
  }

  if (loading) return <LoadingScreen />

  return (
    <ShowroomAdminLayout
      profile={profile}
      title="Edit Product"
      onSignOut={handleSignOut}
    >
      <div style={{ maxWidth: '560px' }}>

        <div style={{
          background: colors.base,
          border: `1.5px solid ${colors.border}`,
          borderRadius: '14px',
          padding: '28px 28px 32px',
        }}>
          <div style={{ marginBottom: '24px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{
                fontFamily: font.mono, fontSize: '11px', fontWeight: 600,
                color: '#1A2035', background: 'rgba(26,32,53,0.07)',
                borderRadius: '4px', padding: '2px 8px',
              }}>
                {productCode}
              </span>
              <span style={{ fontSize: '11px', color: colors.muted }}>
                Product code cannot be changed after creation
              </span>
            </div>
          </div>

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

          {product && (
            <>
            <style>{`.sp-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media(max-width:520px){.sp-grid{grid-template-columns:1fr}}`}</style>
            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

              <div className="sp-grid">
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
                    {CATEGORIES.map(c => (
                      <option key={c} value={c}>{c}</option>
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
                  rows={3}
                  style={{ ...inputStyle, resize: 'vertical' }}
                />
              </Field>

              <SpecsEditor specs={specs} onChange={setSpecs} />

              <Field label="Image URL" hint="Direct link to product image">
                <input
                  value={imageUrl}
                  onChange={e => setImageUrl(e.target.value)}
                  placeholder="https://..."
                  style={inputStyle}
                />
              </Field>

              <div style={{
                fontSize: '12px', color: colors.tertiary,
                background: colors.raised,
                border: `1px solid ${colors.border}`,
                borderRadius: '7px', padding: '10px 12px',
              }}>
                Status: <strong>{product.is_active ? 'Active' : 'Inactive'}</strong> —
                use the toggle on the products list to activate or deactivate.
              </div>

              <div style={{ paddingTop: '8px', display: 'flex', gap: '10px' }}>
                <button
                  type="submit"
                  disabled={saving}
                  style={{
                    flex: 1, padding: '11px',
                    background: '#1A2035', color: '#fff',
                    border: 'none', borderRadius: '8px',
                    fontSize: '13px', fontWeight: 600,
                    cursor: saving ? 'default' : 'pointer',
                    opacity: saving ? 0.7 : 1,
                    fontFamily: font.body,
                  }}
                >
                  {saving ? 'Saving…' : 'Save Changes'}
                </button>
                <button
                  type="button"
                  onClick={() => router.push('/showroom-admin/products')}
                  style={{
                    padding: '11px 20px',
                    background: colors.float,
                    color: colors.secondary,
                    border: `1px solid ${colors.border}`,
                    borderRadius: '8px',
                    fontSize: '13px', fontWeight: 500,
                    cursor: 'pointer',
                    fontFamily: font.body,
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
            </>
          )}
        </div>
      </div>
    </ShowroomAdminLayout>
  )
}

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

const SPEC_PLACEHOLDERS = ['Material', 'Height', 'Width', 'Depth', 'Finish', 'Fabric', 'Seat Height']

function SpecsEditor({ specs, onChange }: { specs: SpecRow[]; onChange: (rows: SpecRow[]) => void }) {
  const update = (i: number, field: 'attr' | 'val', value: string) => {
    const next = specs.map((r, idx) => idx === i ? { ...r, [field]: value } : r)
    onChange(next)
  }
  const remove = (i: number) => onChange(specs.filter((_, idx) => idx !== i))
  const add    = () => onChange([...specs, { attr: '', val: '' }])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <label style={{ fontSize: '12px', fontWeight: 600, color: colors.secondary }}>
        Specifications
      </label>
      {specs.map((row, i) => (
        <div key={i} style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          <input
            value={row.attr}
            onChange={e => update(i, 'attr', e.target.value)}
            placeholder={SPEC_PLACEHOLDERS[i % SPEC_PLACEHOLDERS.length]}
            style={{ ...inputStyle, flex: '0 0 38%' }}
          />
          <input
            value={row.val}
            onChange={e => update(i, 'val', e.target.value)}
            placeholder="Value"
            style={{ ...inputStyle, flex: 1 }}
          />
          <button
            type="button"
            onClick={() => remove(i)}
            style={{
              flexShrink: 0, width: '28px', height: '28px',
              border: '1.5px solid rgba(0,0,0,0.13)', borderRadius: '6px',
              background: '#fff', color: colors.muted,
              cursor: 'pointer', fontSize: '14px', lineHeight: 1,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={add}
        style={{
          alignSelf: 'flex-start', marginTop: '2px',
          padding: '5px 12px', fontSize: '12px', fontWeight: 500,
          background: colors.float, color: colors.secondary,
          border: `1px solid ${colors.border}`, borderRadius: '6px',
          cursor: 'pointer', fontFamily: font.body,
        }}
      >
        + Add Specification
      </button>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
      <label style={{ fontSize: '12px', fontWeight: 600, color: colors.secondary }}>
        {label}
      </label>
      {hint && <span style={{ fontSize: '11px', color: colors.muted, marginTop: '-2px' }}>{hint}</span>}
      {children}
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '9px 11px',
  fontSize: '13px',
  color: '#111318',
  background: '#fff',
  border: '1.5px solid rgba(0,0,0,0.13)',
  borderRadius: '7px',
  outline: 'none',
  boxSizing: 'border-box',
  fontFamily: 'var(--font-body, DM Sans, sans-serif)',
}
