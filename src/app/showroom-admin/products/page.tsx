'use client'

import { useEffect, useState, useMemo, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import type { ShowroomProduct } from '@/lib/types'
import { AlertBanner, EmptyState } from '@/components/ui/atoms'
import { ShowroomAdminLayout } from '@/components/layout/ShowroomAdminLayout'
import { colors, font } from '@/lib/tokens'
import { Package, PlusCircle, Pencil, QrCode, X, Printer, Trash2 } from 'lucide-react'
import { useViewAs } from '@/hooks/useViewAs'
import { QRCodeSVG } from 'qrcode.react'
import { canAccessModule, type ModuleVisibilityType } from '@/lib/moduleAccess'

type ModVisRow = { visibility_type: string; allowed_department: string[] | null }
const teamFallback = (team?: string | null) =>
  !!team && (team.toLowerCase().includes('sales') || team.toLowerCase().includes('showroom'))

// Natural sort so "001" < "002" < "010" and mixed alphanumeric codes (e.g. "BOE-DC-9"
// vs "BOE-DC-101") order by numeric value within each segment, not lexicographically.
function naturalCompare(a: string, b: string): number {
  const split = (s: string) => s.match(/\d+|\D+/g) ?? []
  const ax = split(a)
  const bx = split(b)
  const len = Math.min(ax.length, bx.length)
  for (let i = 0; i < len; i++) {
    const an = ax[i], bn = bx[i]
    const bothNumeric = /^\d+$/.test(an) && /^\d+$/.test(bn)
    if (bothNumeric) {
      const diff = parseInt(an, 10) - parseInt(bn, 10)
      if (diff !== 0) return diff
    } else if (an !== bn) {
      return an < bn ? -1 : 1
    }
  }
  return ax.length - bx.length
}

const byProductCode = (a: ShowroomProduct, b: ShowroomProduct) => naturalCompare(a.product_code, b.product_code)

export default function ShowroomProductsPage() {
  const [profile,   setProfile]   = useState<UserProfile | null>(null)
  const [products,  setProducts]  = useState<ShowroomProduct[]>([])
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState('')
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [qrProduct, setQrProduct] = useState<ShowroomProduct | null>(null)
  const [showroomMod, setShowroomMod] = useState<ModVisRow | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<ShowroomProduct | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const [notice, setNotice] = useState<{ text: string; variant: 'green' | 'amber' } | null>(null)

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const { viewAsUserId, viewAsProfile } = useViewAs()

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
      if (!hasAccess) { router.push('/modules'); return }
      setProfile(profile)

      await loadProducts(session.access_token)
      setLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Redirect when viewing as a user without showroom access
  useEffect(() => {
    if (!profile || !viewAsUserId || !viewAsProfile) return
    const effectiveHasAccess = viewAsProfile.role === 'admin' ||
      canAccessModule(showroomMod?.visibility_type as ModuleVisibilityType | undefined, showroomMod?.allowed_department, viewAsProfile, teamFallback(viewAsProfile.team))
    if (!effectiveHasAccess) router.replace('/modules')
  }, [profile, viewAsUserId, viewAsProfile, showroomMod, router])

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

  const handleDelete = async () => {
    if (!deleteTarget) return
    setDeleteBusy(true)
    setDeleteError('')

    const { data: { session } } = await supabase.auth.getSession()
    if (!session) { router.push('/login'); return }

    const res = await fetch(`/api/showroom/admin/products/${deleteTarget.product_code}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${session.access_token}` },
    })
    const data = await res.json()

    if (!res.ok) {
      setDeleteError(data.error ?? 'Failed to delete product')
      setDeleteBusy(false)
      return
    }

    setDeleteTarget(null)
    setDeleteBusy(false)
    setNotice(data.deactivated
      ? { text: data.message, variant: 'amber' }
      : { text: 'Product deleted.', variant: 'green' })
    await loadProducts(session.access_token)
  }

  if (loading) {
    return (
      <ShowroomAdminLayout profile={profile} title="Showroom Products" onSignOut={handleSignOut}>
        <TableSkeleton />
      </ShowroomAdminLayout>
    )
  }

  // Group by active / inactive for clarity, sorted by product_code ascending
  const active   = products.filter(p => p.is_active).sort(byProductCode)
  const inactive = products.filter(p => !p.is_active).sort(byProductCode)

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
      {deleteTarget && (
        <DeleteConfirmModal
          product={deleteTarget}
          busy={deleteBusy}
          error={deleteError}
          onCancel={() => { setDeleteTarget(null); setDeleteError('') }}
          onConfirm={handleDelete}
        />
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

      {notice && (
        <div style={{ marginBottom: '16px' }}>
          <AlertBanner variant={notice.variant}>{notice.text}</AlertBanner>
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
            onDelete={setDeleteTarget}
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
                onDelete={setDeleteTarget}
              />
            </div>
          )}
        </>
      )}
    </ShowroomAdminLayout>
  )
}

// ── Loading skeleton ──────────────────────────────────────────────────────────

function TableSkeleton() {
  return (
    <div style={{
      background: colors.base,
      border: `1.5px solid ${colors.border}`,
      borderRadius: '10px',
      overflow: 'hidden',
    }}>
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          style={{
            display: 'flex', alignItems: 'center', gap: '16px',
            padding: '10px 16px',
            borderBottom: i < 5 ? `1px solid ${colors.border}` : 'none',
          }}
        >
          <div style={{ width: 56, height: 56, borderRadius: '8px', background: colors.raised, flexShrink: 0 }} />
          <div style={{ width: 90, height: 14, borderRadius: '4px', background: colors.raised }} />
          <div style={{ width: 160, height: 14, borderRadius: '4px', background: colors.raised }} />
          <div style={{ width: 100, height: 14, borderRadius: '4px', background: colors.raised }} />
          <div style={{ width: 70, height: 14, borderRadius: '4px', background: colors.raised, marginLeft: 'auto' }} />
        </div>
      ))}
    </div>
  )
}

// ── Product table ─────────────────────────────────────────────────────────────

function ProductTable({
  products, label, togglingId, onEdit, onToggle, onPrintQr, onDelete,
}: {
  products: ShowroomProduct[]
  label: string
  togglingId: string | null
  onEdit: (code: string) => void
  onToggle: (p: ShowroomProduct) => void
  onPrintQr: (p: ShowroomProduct) => void
  onDelete: (p: ShowroomProduct) => void
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

      <div style={{
        background: colors.base,
        border: `1.5px solid ${colors.border}`,
        borderRadius: '10px',
        overflow: 'hidden',
      }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
                {['Image', 'Product Code', 'Product Name', 'Category', 'MRP', 'Status', 'Actions'].map(h => (
                  <th key={h} style={{
                    padding: '8px 16px', textAlign: h === 'MRP' ? 'right' : 'left',
                    fontSize: '10px', fontWeight: 600, color: colors.muted,
                    textTransform: 'uppercase', letterSpacing: '0.05em',
                    whiteSpace: 'nowrap',
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {products.map(product => (
                <ProductRow
                  key={product.id}
                  product={product}
                  toggling={togglingId === product.id}
                  onEdit={() => onEdit(product.product_code)}
                  onToggle={() => onToggle(product)}
                  onPrintQr={() => onPrintQr(product)}
                  onDelete={() => onDelete(product)}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

// Thumbnail with a safe fallback: hides the broken-image icon and shows a
// neutral placeholder box if the URL is missing or fails to load.
function ProductThumb({ src, alt }: { src: string | null; alt: string }) {
  const [errored, setErrored] = useState(false)

  const showImage = !!src && !errored

  return (
    <div style={{
      width: 56, height: 56, borderRadius: '8px', flexShrink: 0,
      background: colors.raised,
      border: `1px solid ${colors.border}`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      overflow: 'hidden',
    }}>
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={alt}
          loading="lazy"
          decoding="async"
          onError={() => setErrored(true)}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      ) : (
        <Package size={20} color={colors.muted} strokeWidth={1.5} />
      )}
    </div>
  )
}

function ProductRow({
  product, toggling, onEdit, onToggle, onPrintQr, onDelete,
}: {
  product: ShowroomProduct
  toggling: boolean
  onEdit: () => void
  onToggle: () => void
  onPrintQr: () => void
  onDelete: () => void
}) {
  return (
    <tr style={{
      borderBottom: `1px solid ${colors.border}`,
      opacity: product.is_active ? 1 : 0.6,
    }}>
      {/* Image */}
      <td style={{ padding: '10px 16px', verticalAlign: 'middle' }}>
        <ProductThumb src={product.images?.[0] ?? product.image_url ?? null} alt={product.name} />
      </td>

      {/* Product Code */}
      <td style={{ padding: '10px 16px', verticalAlign: 'middle', whiteSpace: 'nowrap' }}>
        <span style={{
          fontSize: '12px', fontWeight: 600,
          color: '#1A2035',
          background: 'rgba(26,32,53,0.06)',
          borderRadius: '5px', padding: '4px 9px',
          whiteSpace: 'nowrap',
        }}>
          {product.product_code}
        </span>
      </td>

      {/* Product Name */}
      <td style={{ padding: '10px 16px', verticalAlign: 'middle', minWidth: '160px' }}>
        <span style={{ fontSize: '13.5px', fontWeight: 600, color: colors.primary }}>
          {product.name}
        </span>
      </td>

      {/* Category */}
      <td style={{ padding: '10px 16px', verticalAlign: 'middle', whiteSpace: 'nowrap' }}>
        <span style={{ fontSize: '12px', color: colors.tertiary }}>
          {product.category}
        </span>
      </td>

      {/* MRP */}
      <td style={{ padding: '10px 16px', verticalAlign: 'middle', textAlign: 'right', whiteSpace: 'nowrap' }}>
        <span style={{ fontSize: '13.5px', fontWeight: 600, color: colors.primary, fontFamily: font.body }}>
          ₹{Number(product.mrp).toLocaleString('en-IN')}
        </span>
      </td>

      {/* Status */}
      <td style={{ padding: '10px 16px', verticalAlign: 'middle', whiteSpace: 'nowrap' }}>
        <button
          onClick={onToggle}
          disabled={toggling}
          style={{
            fontSize: '11px', fontWeight: 600,
            color: product.is_active ? '#166534' : colors.muted,
            background: product.is_active ? '#F0FDF4' : colors.float,
            border: `1px solid ${product.is_active ? '#BBF7D0' : colors.border}`,
            borderRadius: '999px',
            padding: '4px 12px',
            cursor: toggling ? 'default' : 'pointer',
            opacity: toggling ? 0.6 : 1,
            whiteSpace: 'nowrap',
          }}
        >
          {toggling ? '…' : product.is_active ? 'Active' : 'Inactive'}
        </button>
      </td>

      {/* Actions */}
      <td style={{ padding: '10px 16px', verticalAlign: 'middle' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <IconButton onClick={onPrintQr} title="Print QR label" variant="neutral">
            <QrCode size={14} strokeWidth={1.8} />
          </IconButton>
          <IconButton onClick={onEdit} title="Edit product" variant="neutral">
            <Pencil size={14} strokeWidth={1.8} />
          </IconButton>
          <IconButton onClick={onDelete} title="Delete product" variant="red">
            <Trash2 size={14} strokeWidth={1.8} />
          </IconButton>
        </div>
      </td>
    </tr>
  )
}

function IconButton({
  onClick, title, variant, children,
}: {
  onClick: () => void
  title: string
  variant: 'neutral' | 'red'
  children: React.ReactNode
}) {
  const palette = variant === 'red'
    ? { color: colors.red, background: colors.redTint, border: 'rgba(217,79,79,0.2)' }
    : { color: colors.secondary, background: colors.float, border: colors.border }

  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 28, height: 28, flexShrink: 0,
        color: palette.color,
        background: palette.background,
        border: `1px solid ${palette.border}`,
        borderRadius: '6px',
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  )
}

// ── Delete Confirm Modal ──────────────────────────────────────────────────────

function DeleteConfirmModal({
  product, busy, error, onCancel, onConfirm,
}: {
  product: ShowroomProduct
  busy: boolean
  error: string
  onCancel: () => void
  onConfirm: () => void
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
      <div style={{ background: '#fff', borderRadius: '14px', width: '100%', maxWidth: 400, padding: '28px 28px 24px', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
          <div style={{ width: 36, height: 36, borderRadius: '9px', background: colors.redTint, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Trash2 size={16} strokeWidth={2.2} color={colors.red} />
          </div>
          <span style={{ fontSize: '15px', fontWeight: 700, color: colors.primary }}>Delete Product</span>
        </div>
        <p style={{ fontSize: '13.5px', color: colors.secondary, marginBottom: '20px', lineHeight: 1.55 }}>
          Are you sure you want to delete <strong style={{ color: colors.primary }}>{product.name}</strong> ({product.product_code})?
          This action cannot be undone.
        </p>
        {error && (
          <div style={{ fontSize: '13px', color: colors.red, background: colors.redTint, padding: '8px 12px', borderRadius: '7px', marginBottom: '14px' }}>{error}</div>
        )}
        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
          <button onClick={onCancel} disabled={busy}
            style={{ background: colors.float, color: colors.secondary, border: `1.5px solid ${colors.border}`, borderRadius: '8px', padding: '9px 18px', fontSize: '13.5px', fontWeight: 600, cursor: 'pointer' }}>
            Cancel
          </button>
          <button onClick={onConfirm} disabled={busy}
            style={{ background: colors.red, color: '#fff', border: 'none', borderRadius: '8px', padding: '9px 18px', fontSize: '13.5px', fontWeight: 700, cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.65 : 1, display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Trash2 size={13} strokeWidth={2.5} />
            {busy ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
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
