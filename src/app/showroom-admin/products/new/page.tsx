'use client'

import { useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { AlertBanner } from '@/components/ui/atoms'
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

export default function NewProductPage() {
  const [productCode,    setProductCode]    = useState('')
  const [name,           setName]           = useState('')
  const [category,       setCategory]       = useState('')
  const [description,    setDescription]    = useState('')
  const [specifications, setSpecifications] = useState('')
  const [imageUrl,       setImageUrl]       = useState('')
  const [mrp,            setMrp]            = useState('')
  const [saving,         setSaving]         = useState(false)
  const [error,          setError]          = useState('')

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

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
    if (specifications.trim()) {
      try { JSON.parse(specifications) } catch {
        setError('Specifications must be valid JSON (or leave blank)')
        return
      }
    }

    setSaving(true)
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) { router.push('/login'); return }

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
        specifications: specifications.trim() || null,
        image_url: imageUrl || null,
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
          <h1 style={{
            fontFamily: font.display, fontSize: '20px', fontWeight: 700,
            color: colors.primary, margin: '0 0 24px', letterSpacing: '-0.02em',
          }}>
            New Product
          </h1>

          {error && (
            <div style={{ marginBottom: '20px' }}>
              <AlertBanner variant="red">{error}</AlertBanner>
            </div>
          )}

          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

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
                {saving ? 'Creating…' : 'Create Product'}
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
