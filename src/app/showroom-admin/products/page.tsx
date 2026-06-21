'use client'

import { useEffect, useState, useMemo, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import type { ShowroomProduct } from '@/lib/types'
import { LoadingScreen, AlertBanner, EmptyState } from '@/components/ui/atoms'
import { ShowroomAdminLayout } from '@/components/layout/ShowroomAdminLayout'
import { colors, font } from '@/lib/tokens'
import { Package, PlusCircle, Pencil, QrCode, X, Printer } from 'lucide-react'
import { useViewAs } from '@/hooks/useViewAs'
import { QRCodeSVG } from 'qrcode.react'

export default function ShowroomProductsPage() {
  const [profile,   setProfile]   = useState<UserProfile | null>(null)
  const [products,  setProducts]  = useState<ShowroomProduct[]>([])
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState('')
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [qrProduct, setQrProduct] = useState<ShowroomProduct | null>(null)

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const { viewAsUserId, viewAsProfile } = useViewAs()

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      const { data: p } = await supabase
        .from('users')
        .select('id, full_name, email, phone, role, team, position, is_active, created_at')
        .eq('id', session.user.id)
        .single()

      if (p?.role !== 'admin') { router.push('/modules'); return }
      setProfile(p as UserProfile)

      await loadProducts(session.access_token)
      setLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Redirect when viewing as a non-admin user
  useEffect(() => {
    if (!profile || !viewAsUserId || !viewAsProfile) return
    if (viewAsProfile.role !== 'admin') router.replace('/modules')
  }, [profile, viewAsUserId, viewAsProfile, router])

  const loadProducts = async (token: string) => {
    const res = await fetch('/api/showroom/admin/products', {
      headers: { 'Authorization': `Bearer ${token}` },
    })
    const data = await res.json()
    if (Array.isArray(data?.products)) setProducts(data.products as ShowroomProduct[])
  }

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  const handleToggleActive = async (product: ShowroomProduct) => {
    setTogglingId(product.id)
    setError('')

    const { data: { session } } = await supabase.auth.getSession()
    if (!session) { router.push('/login'); return }

    const res = await fetch(`/api/showroom/admin/products/${product.product_code}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ is_active: !product.is_active }),
    })

    if (!res.ok) {
      const d = await res.json()
      setError(d.error ?? 'Failed to update product')
    } else {
      await loadProducts(session.access_token)
    }
    setTogglingId(null)
  }

  if (loading) return <LoadingScreen />

  // Group by active / inactive for clarity
  const active   = products.filter(p => p.is_active)
  const inactive = products.filter(p => !p.is_active)

  return (
    <ShowroomAdminLayout
      profile={profile}
      title="Showroom Products"
      subtitle={`${active.length} active · ${inactive.length} inactive`}
      onSignOut={handleSignOut}
    >
      {qrProduct && (
        <QrPrintModal product={qrProduct} onClose={() => setQrProduct(null)} />
      )}
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px', flexWrap: 'wrap', gap: '12px' }}>
        <div style={{ fontSize: '13px', color: colors.tertiary }}>
          All products — including inactive. Use the toggle to deactivate instead of deleting.
        </div>
        <button
          onClick={() => router.push('/showroom-admin/products/new')}
          style={{
            display: 'flex', alignItems: 'center', gap: '7px',
            fontSize: '13px', fontWeight: 600,
            color: '#fff',
            background: '#1A2035',
            border: 'none', borderRadius: '8px',
            padding: '9px 16px',
            cursor: 'pointer',
          }}
        >
          <PlusCircle size={15} strokeWidth={2} />
          Create Product
        </button>
      </div>

      {error && (
        <div style={{ marginBottom: '16px' }}>
          <AlertBanner variant="red">{error}</AlertBanner>
        </div>
      )}

      {products.length === 0 ? (
        <EmptyState
          message="No products yet"
          hint="Click Create Product to add your first showroom product."
        />
      ) : (
        <>
          <ProductTable
            products={active}
            label="Active"
            togglingId={togglingId}
            onEdit={code => router.push(`/showroom-admin/products/${code}/edit`)}
            onToggle={handleToggleActive}
            onPrintQr={setQrProduct}
          />
          {inactive.length > 0 && (
            <div style={{ marginTop: '32px' }}>
              <ProductTable
                products={inactive}
                label="Inactive"
                togglingId={togglingId}
                onEdit={code => router.push(`/showroom-admin/products/${code}/edit`)}
                onToggle={handleToggleActive}
                onPrintQr={setQrProduct}
              />
            </div>
          )}
        </>
      )}
    </ShowroomAdminLayout>
  )
}

// ── Product table ─────────────────────────────────────────────────────────────

function ProductTable({
  products, label, togglingId, onEdit, onToggle, onPrintQr,
}: {
  products: ShowroomProduct[]
  label: string
  togglingId: string | null
  onEdit: (code: string) => void
  onToggle: (p: ShowroomProduct) => void
  onPrintQr: (p: ShowroomProduct) => void
}) {
  if (products.length === 0) return null

  return (
    <div>
      {/* Section label */}
      <div style={{
        fontSize: '10px', fontWeight: 700, letterSpacing: '0.07em',
        textTransform: 'uppercase', color: colors.muted, marginBottom: '10px',
      }}>
        {label} · {products.length}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {products.map(product => (
          <ProductRow
            key={product.id}
            product={product}
            toggling={togglingId === product.id}
            onEdit={() => onEdit(product.product_code)}
            onToggle={() => onToggle(product)}
            onPrintQr={() => onPrintQr(product)}
          />
        ))}
      </div>
    </div>
  )
}

function ProductRow({
  product, toggling, onEdit, onToggle, onPrintQr,
}: {
  product: ShowroomProduct
  toggling: boolean
  onEdit: () => void
  onToggle: () => void
  onPrintQr: () => void
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '14px',
      background: colors.base,
      border: `1.5px solid ${colors.border}`,
      borderRadius: '10px',
      padding: '12px 16px',
      opacity: product.is_active ? 1 : 0.6,
    }}>

      {/* Image or placeholder */}
      <div style={{
        width: 44, height: 44, borderRadius: '8px', flexShrink: 0,
        background: colors.raised,
        border: `1px solid ${colors.border}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        overflow: 'hidden',
      }}>
        {(product.images?.[0] ?? product.image_url) ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={product.images?.[0] ?? product.image_url!}
            alt={product.name}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <Package size={18} color={colors.muted} strokeWidth={1.5} />
        )}
      </div>

      {/* Code + name + category */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <span style={{
            fontFamily: font.mono, fontSize: '11px', fontWeight: 600,
            color: '#1A2035',
            background: 'rgba(26,32,53,0.07)',
            borderRadius: '4px', padding: '1px 6px',
            whiteSpace: 'nowrap',
          }}>
            {product.product_code}
          </span>
          <span style={{ fontSize: '13px', fontWeight: 600, color: colors.primary }}>
            {product.name}
          </span>
        </div>
        <div style={{ fontSize: '11px', color: colors.tertiary, marginTop: '2px' }}>
          {product.category}
        </div>
      </div>

      {/* MRP */}
      <div style={{
        fontSize: '13px', fontWeight: 600, color: colors.primary,
        whiteSpace: 'nowrap', flexShrink: 0,
        fontFamily: font.mono,
      }}>
        ₹{Number(product.mrp).toLocaleString('en-IN')}
      </div>

      {/* Print QR button */}
      <button
        onClick={onPrintQr}
        title="Print QR label"
        style={{
          display: 'flex', alignItems: 'center', gap: '5px',
          fontSize: '12px', fontWeight: 500,
          color: '#1A2035',
          background: 'rgba(26,32,53,0.06)',
          border: `1px solid rgba(26,32,53,0.15)`,
          borderRadius: '6px',
          padding: '6px 10px',
          cursor: 'pointer',
          flexShrink: 0,
        }}
      >
        <QrCode size={13} strokeWidth={1.8} />
        Print QR
      </button>

      {/* Edit button */}
      <button
        onClick={onEdit}
        title="Edit product"
        style={{
          display: 'flex', alignItems: 'center', gap: '5px',
          fontSize: '12px', fontWeight: 500,
          color: colors.secondary,
          background: colors.float,
          border: `1px solid ${colors.border}`,
          borderRadius: '6px',
          padding: '6px 10px',
          cursor: 'pointer',
          flexShrink: 0,
        }}
      >
        <Pencil size={13} strokeWidth={1.8} />
        Edit
      </button>

      {/* Active toggle */}
      <button
        onClick={onToggle}
        disabled={toggling}
        style={{
          fontSize: '11px', fontWeight: 600,
          color: product.is_active ? '#166534' : colors.muted,
          background: product.is_active ? '#F0FDF4' : colors.float,
          border: `1px solid ${product.is_active ? '#BBF7D0' : colors.border}`,
          borderRadius: '6px',
          padding: '5px 10px',
          cursor: toggling ? 'default' : 'pointer',
          opacity: toggling ? 0.6 : 1,
          flexShrink: 0,
          whiteSpace: 'nowrap',
        }}
      >
        {toggling ? '...' : product.is_active ? 'Active' : 'Inactive'}
      </button>
    </div>
  )
}

// ── QR Print Modal ────────────────────────────────────────────────────────────

function QrPrintModal({ product, onClose }: { product: ShowroomProduct; onClose: () => void }) {
  const printRef = useRef<HTMLDivElement>(null)
  const qrUrl = `${typeof window !== 'undefined' ? window.location.origin : ''}/showroom/product/${product.product_code}`

  const handlePrint = () => {
    const content = printRef.current
    if (!content) return
    const win = window.open('', '_blank', 'width=400,height=520')
    if (!win) return
    win.document.write(`
      <html><head><title>QR Label – ${product.name}</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; background: #fff; }
        .label { text-align: center; padding: 28px 32px; border: 1.5px solid #e5e7eb; border-radius: 12px; display: inline-block; }
        .brand { font-size: 11px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #6b7280; margin-bottom: 4px; }
        .name { font-size: 17px; font-weight: 700; color: #111827; margin: 10px 0 2px; }
        .code { font-size: 11px; font-family: monospace; color: #6b7280; margin-bottom: 2px; }
        .mrp { font-size: 20px; font-weight: 700; color: #111827; margin: 6px 0 16px; }
        svg { display: block; margin: 0 auto; }
      </style></head><body>${content.innerHTML}</body></html>
    `)
    win.document.close()
    win.focus()
    win.print()
    win.close()
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '24px',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#fff',
          borderRadius: '14px',
          padding: '28px 32px',
          width: '100%', maxWidth: '360px',
          boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
          position: 'relative',
        }}
      >
        {/* Close */}
        <button
          onClick={onClose}
          style={{
            position: 'absolute', top: '14px', right: '14px',
            background: 'transparent', border: 'none', cursor: 'pointer',
            color: '#9ca3af', padding: '4px',
          }}
        >
          <X size={18} />
        </button>

        {/* Label preview */}
        <div ref={printRef} className="label" style={{ textAlign: 'center' }}>
          <div className="brand" style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#6b7280', marginBottom: '4px' }}>
            BOE · Showroom
          </div>
          <QRCodeSVG value={qrUrl} size={160} style={{ display: 'block', margin: '0 auto' }} />
          <div className="name" style={{ fontSize: '17px', fontWeight: 700, color: '#111827', margin: '12px 0 2px' }}>
            {product.name}
          </div>
          <div className="code" style={{ fontSize: '11px', fontFamily: 'monospace', color: '#6b7280', marginBottom: '2px' }}>
            {product.product_code}
          </div>
          <div className="mrp" style={{ fontSize: '20px', fontWeight: 700, color: '#111827', marginTop: '4px' }}>
            ₹{Number(product.mrp).toLocaleString('en-IN')}
          </div>
        </div>

        {/* Print button */}
        <button
          onClick={handlePrint}
          style={{
            marginTop: '20px',
            width: '100%',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
            fontSize: '14px', fontWeight: 600,
            color: '#fff',
            background: '#1A2035',
            border: 'none', borderRadius: '8px',
            padding: '11px 0',
            cursor: 'pointer',
          }}
        >
          <Printer size={15} strokeWidth={2} />
          Print QR Label
        </button>
      </div>
    </div>
  )
}
