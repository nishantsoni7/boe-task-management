'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { ShowroomProduct } from '@/lib/types'
import { AlertBanner, LoadingScreen } from '@/components/ui/atoms'
import { colors, font } from '@/lib/tokens'
import { ArrowLeft } from 'lucide-react'

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

  const [product,        setProduct]        = useState<ShowroomProduct | null>(null)
  const [name,           setName]           = useState('')
  const [category,       setCategory]       = useState('')
  const [description,    setDescription]    = useState('')
  const [specifications, setSpecifications] = useState('')
  const [imageUrl,       setImageUrl]       = useState('')
  const [mrp,            setMrp]            = useState('')
  const [loading,        setLoading]        = useState(true)
  const [saving,         setSaving]         = useState(false)
  const [error,          setError]          = useState('')
  const [success,        setSuccess]        = useState('')

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      const { data: p } = await supabase
        .from('users')
        .select('role')
        .eq('id', session.user.id)
        .single()
      if (p?.role !== 'admin') { router.push('/modules'); return }

      // Fetch product via admin API (includes inactive)
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
      setSpecifications(
        found.specifications ? JSON.stringify(found.specifications, null, 2) : ''
      )
      setImageUrl(found.image_url ?? '')
      setMrp(String(found.mrp))
      setLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productCode])

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
    if (specifications.trim()) {
      try { JSON.parse(specifications) } catch {
        setError('Specifications must be valid JSON (or leave blank)')
        return
      }
    }

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
        specifications: specifications.trim() || null,
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
    <div style={{ minHeight: '100vh', background: colors.void, padding: '32px 16px' }}>
      <div style={{ maxWidth: '560px', margin: '0 auto' }}>

        {/* Back */}
        <button
          onClick={() => router.push('/showroom-admin/products')}
          style={{
            display: 'flex', alignItems: 'center', gap: '6px',
            fontSize: '13px', color: colors.tertiary,
            background: 'none', border: 'none', cursor: 'pointer',
            padding: '0 0 20px', fontFamily: font.body,
          }}
        >
          <ArrowLeft size={14} strokeWidth={2} /> Back to Products
        </button>

        <div style={{
          background: colors.base,
          border: `1.5px solid ${colors.border}`,
          borderRadius: '14px',
          padding: '28px 28px 32px',
        }}>
          <div style={{ marginBottom: '24px' }}>
            <h1 style={{
              fontFamily: font.display, fontSize: '20px', fontWeight: 700,
              color: colors.primary, margin: '0 0 6px', letterSpacing: '-0.02em',
            }}>
              Edit Product
            </h1>
            {/* Product code shown but not editable — it is the URL key and QR identifier */}
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
            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

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

              <Field label="Description">
                <textarea
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  placeholder="Short product description shown to customers"
                  rows={3}
                  style={{ ...inputStyle, resize: 'vertical' }}
                />
              </Field>

              <Field label="Specifications (JSON)" hint='e.g. {"Material":"Steel","Height":"76cm"}'>
                <textarea
                  value={specifications}
                  onChange={e => setSpecifications(e.target.value)}
                  placeholder='{"Material": "Steel", "Seat Height": "46 cm"}'
                  rows={4}
                  style={{ ...inputStyle, fontFamily: font.mono, fontSize: '12px', resize: 'vertical' }}
                />
              </Field>

              <Field label="Image URL" hint="Direct link to product image">
                <input
                  value={imageUrl}
                  onChange={e => setImageUrl(e.target.value)}
                  placeholder="https://..."
                  style={inputStyle}
                />
              </Field>

              {/* Active status note */}
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
          )}
        </div>
      </div>
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
