'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { colors, font } from '@/lib/tokens'
import { Trash2 } from 'lucide-react'

type CartItem = {
  product_id:   string
  product_code: string
  name:         string
  mrp:          number
  quantity:     number
  image_url?:   string | null
  dim_str?:     string | null
}

type CustomerDetails = {
  customer_name: string
  customer_mobile: string
  company: string | null
  city: string | null
  project_name: string | null
}

export default function ProjectListPage() {
  const [salespersonId, setSalespersonId] = useState<string | null>(null)
  const [customer,      setCustomer]      = useState<CustomerDetails | null>(null)
  const [cart,          setCart]          = useState<CartItem[]>([])
  const [noSession,     setNoSession]     = useState(false)
  const [submitting,    setSubmitting]    = useState(false)
  const [submitError,   setSubmitError]   = useState('')
  const [ready,         setReady]         = useState(false)

  const router = useRouter()

  useEffect(() => {
    const loadFromStorage = () => {
      const sp  = localStorage.getItem('boe_sp')
      const raw = localStorage.getItem('boe_customer')

      if (!sp || !raw) { setNoSession(true); setReady(true); return }

      try {
        setCustomer(JSON.parse(raw) as CustomerDetails)
      } catch {
        setNoSession(true); setReady(true); return
      }

      setSalespersonId(sp)

      const cartRaw = localStorage.getItem('boe_cart')
      if (cartRaw) {
        try { setCart(JSON.parse(cartRaw) as CartItem[]) } catch { /* ignore bad cart */ }
      }

      setReady(true)
    }
    loadFromStorage()
  }, [])

  // Persist cart changes back to sessionStorage whenever cart state changes
  const updateCart = (next: CartItem[]) => {
    setCart(next)
    localStorage.setItem('boe_cart', JSON.stringify(next))
  }

  const handleQtyChange = (index: number, delta: number) => {
    const next = cart.map((item, i) =>
      i === index ? { ...item, quantity: Math.max(1, item.quantity + delta) } : item
    )
    updateCart(next)
  }

  const handleRemove = (index: number) => {
    updateCart(cart.filter((_, i) => i !== index))
  }

  const grandTotal = cart.reduce((sum, item) => sum + item.mrp * item.quantity, 0)

  const handleSubmit = async () => {
    if (!salespersonId || !customer || cart.length === 0) return
    setSubmitting(true)
    setSubmitError('')

    const res = await fetch('/api/showroom/inquiry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ salesperson_id: salespersonId, customer, cart }),
    })

    if (!res.ok) {
      const data = await res.json()
      setSubmitError(data.error ?? 'Something went wrong. Please try again.')
      setSubmitting(false)
      return
    }

    // Clear all session data before redirecting
    localStorage.removeItem('boe_sp')
    localStorage.removeItem('boe_customer')
    localStorage.removeItem('boe_cart')

    router.push('/showroom/done')
  }

  if (!ready) {
    return (
      <Shell>
        <div style={{ textAlign: 'center', padding: '48px 0', color: colors.muted, fontSize: '14px' }}>
          Loading…
        </div>
      </Shell>
    )
  }

  // ── No session ─────────────────────────────────────────────────────────────
  if (noSession) {
    return (
      <Shell>
        <div style={{ textAlign: 'center', padding: '32px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '14px' }}>
          <div style={{
            width: 48, height: 48, borderRadius: '12px',
            background: 'rgba(232,160,48,0.10)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '22px',
          }}>
            ⚠
          </div>
          <div style={{ fontFamily: font.display, fontSize: '18px', fontWeight: 700, color: colors.primary }}>
            Session Expired
          </div>
          <div style={{ fontSize: '13px', color: colors.tertiary, lineHeight: 1.6, maxWidth: '280px' }}>
            Please scan your salesperson&apos;s QR code to start a new session.
          </div>
          <button
            onClick={() => router.push('/showroom/join')}
            style={primaryBtn}
          >
            Scan Salesperson QR
          </button>
        </div>
      </Shell>
    )
  }

  return (
    <Shell>
      {/* Page title */}
      <div style={{ marginBottom: '20px' }}>
        <h1 style={{
          fontFamily: font.display, fontSize: '20px', fontWeight: 700,
          color: colors.primary, margin: '0 0 4px', letterSpacing: '-0.02em',
        }}>
          Project List
        </h1>
        {customer && (
          <div style={{ fontSize: '12px', color: colors.muted }}>
            {customer.customer_name}
            {customer.project_name ? ` · ${customer.project_name}` : ''}
          </div>
        )}
      </div>

      {/* Empty cart */}
      {cart.length === 0 ? (
        <div style={{
          textAlign: 'center', padding: '32px 0',
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '14px',
        }}>
          <div style={{ fontSize: '32px' }}>🛋</div>
          <div style={{ fontSize: '14px', fontWeight: 600, color: colors.secondary }}>
            No products added yet
          </div>
          <div style={{ fontSize: '12px', color: colors.tertiary, lineHeight: 1.6, maxWidth: '240px' }}>
            Point your phone camera at a product QR label in the showroom.
          </div>
          <button
            onClick={() => router.push('/showroom/scan')}
            style={{ ...primaryBtn, marginTop: '4px', padding: '12px 28px' }}
          >
            Scan Product QR
          </button>
        </div>
      ) : (
        <>
          {/* Cart items */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '20px' }}>
            {cart.map((item, index) => (
              <CartRow
                key={index}
                item={item}
                onIncrease={() => handleQtyChange(index, +1)}
                onDecrease={() => handleQtyChange(index, -1)}
                onRemove={() => handleRemove(index)}
              />
            ))}
          </div>

          {/* Grand total */}
          <div style={{
            borderTop: `1.5px solid ${colors.border}`,
            paddingTop: '14px',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            marginBottom: '20px',
          }}>
            <span style={{ fontSize: '13px', fontWeight: 600, color: colors.secondary }}>
              Estimated Total (MRP)
            </span>
            <span style={{
              fontSize: '18px', fontWeight: 700, color: colors.primary,
              fontFamily: font.mono,
            }}>
              ₹{grandTotal.toLocaleString('en-IN')}
            </span>
          </div>
        </>
      )}

      {/* Error */}
      {submitError && (
        <div style={{
          background: 'rgba(217,79,79,0.07)',
          border: '1px solid rgba(217,79,79,0.2)',
          borderRadius: '8px',
          padding: '10px 14px',
          fontSize: '13px', color: '#B91C1C',
          marginBottom: '14px',
        }}>
          {submitError}
        </div>
      )}

      {/* Add more / submit row */}
      {cart.length > 0 && (
        <button
          onClick={() => router.push('/showroom/scan')}
          style={{
            width: '100%', padding: '12px',
            background: 'none', color: colors.secondary,
            border: `1.5px solid ${colors.border}`, borderRadius: '10px',
            fontSize: '13px', fontWeight: 600,
            cursor: 'pointer', fontFamily: font.body,
            marginBottom: '10px',
          }}
        >
          + Scan Another Product
        </button>
      )}

      {/* Submit */}
      <button
        onClick={handleSubmit}
        disabled={submitting || cart.length === 0}
        style={{
          ...primaryBtn,
          width: '100%', padding: '15px',
          fontSize: '15px',
          opacity: (submitting || cart.length === 0) ? 0.5 : 1,
          cursor: (submitting || cart.length === 0) ? 'default' : 'pointer',
        }}
      >
        {submitting ? 'Submitting…' : 'Submit Inquiry'}
      </button>

      {cart.length === 0 && (
        <div style={{ fontSize: '11px', color: colors.muted, textAlign: 'center', marginTop: '8px' }}>
          Add at least one product to submit
        </div>
      )}
    </Shell>
  )
}

// ── Cart row ──────────────────────────────────────────────────────────────────

function CartRow({
  item, onIncrease, onDecrease, onRemove,
}: {
  item: CartItem
  onIncrease: () => void
  onDecrease: () => void
  onRemove: () => void
}) {
  const lineTotal = item.mrp * item.quantity

  return (
    <div style={{
      background: colors.raised,
      border: `1px solid ${colors.border}`,
      borderRadius: '10px',
      padding: '12px 14px',
    }}>
      {/* Top row: image + info + remove */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', marginBottom: '10px' }}>

        {/* Thumbnail */}
        <div style={{
          width: 52, height: 52, flexShrink: 0,
          borderRadius: '8px',
          background: colors.float,
          border: `1px solid ${colors.border}`,
          overflow: 'hidden',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          {item.image_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={item.image_url} alt={item.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            <span style={{ fontSize: '20px' }}>🪑</span>
          )}
        </div>

        {/* Code + name + dims + price */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <span style={{
            fontFamily: font.mono, fontSize: '10px', fontWeight: 600,
            color: '#1A2035', background: 'rgba(26,32,53,0.07)',
            borderRadius: '3px', padding: '1px 5px',
          }}>
            {item.product_code}
          </span>
          <div style={{ fontSize: '13px', fontWeight: 600, color: colors.primary, marginTop: '3px', lineHeight: 1.3 }}>
            {item.name}
          </div>
          {item.dim_str && (
            <div style={{ fontSize: '11px', color: colors.muted, fontFamily: font.mono, marginTop: '2px' }}>
              {item.dim_str}
            </div>
          )}
          <div style={{ fontSize: '12px', color: colors.muted, fontFamily: font.mono, marginTop: '2px' }}>
            ₹{item.mrp.toLocaleString('en-IN')} each
          </div>
        </div>

        {/* Remove */}
        <button
          onClick={onRemove}
          title="Remove"
          style={{
            background: 'none', border: 'none',
            color: colors.muted, cursor: 'pointer',
            padding: '2px', flexShrink: 0,
            display: 'flex', alignItems: 'center',
          }}
        >
          <Trash2 size={15} strokeWidth={1.8} />
        </button>
      </div>

      {/* Bottom row: qty controls + line total */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0' }}>
          <button onClick={onDecrease} style={qtyBtn}>−</button>
          <span style={{
            minWidth: '36px', textAlign: 'center',
            fontSize: '14px', fontWeight: 600, color: colors.primary,
          }}>
            {item.quantity}
          </span>
          <button onClick={onIncrease} style={qtyBtn}>+</button>
        </div>
        <span style={{
          fontSize: '14px', fontWeight: 700, color: colors.primary,
          fontFamily: font.mono,
        }}>
          ₹{lineTotal.toLocaleString('en-IN')}
        </span>
      </div>
    </div>
  )
}

// ── Shell ─────────────────────────────────────────────────────────────────────

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      minHeight: '100vh', background: colors.void,
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      padding: '24px 16px 48px',
    }}>
      {/* BOE header */}
      <div style={{
        width: '100%', maxWidth: '480px',
        display: 'flex', alignItems: 'center', gap: '8px',
        marginBottom: '20px',
      }}>
        <div style={{
          width: 26, height: 26, borderRadius: '6px', background: '#1A2035',
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#DC1F2E" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            <polyline points="9 22 9 12 15 12 15 22" />
          </svg>
        </div>
        <span style={{ fontSize: '12px', fontWeight: 700, color: colors.secondary, letterSpacing: '0.02em' }}>
          BOE Showroom
        </span>
      </div>

      {/* Card */}
      <div style={{
        width: '100%', maxWidth: '480px',
        background: colors.base,
        border: `1.5px solid ${colors.border}`,
        borderRadius: '16px',
        padding: '20px 18px 24px',
        boxShadow: '0 2px 12px rgba(0,0,0,0.05)',
      }}>
        {children}
      </div>
    </div>
  )
}

// ── Shared styles ─────────────────────────────────────────────────────────────

const primaryBtn: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: '#1A2035', color: '#fff',
  border: 'none', borderRadius: '10px',
  fontSize: '14px', fontWeight: 600,
  cursor: 'pointer', fontFamily: font.body,
  letterSpacing: '-0.01em',
  padding: '12px 24px',
}

const qtyBtn: React.CSSProperties = {
  width: 32, height: 32,
  background: colors.float,
  border: `1px solid ${colors.border}`,
  borderRadius: '7px',
  fontSize: '16px', color: colors.primary,
  cursor: 'pointer',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  fontFamily: font.body,
}
