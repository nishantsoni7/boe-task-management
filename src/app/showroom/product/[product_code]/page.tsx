'use client'

import { useEffect, useState } from 'react'
import { useRouter, useParams } from 'next/navigation'
import type { ShowroomProduct } from '@/lib/types'
import { colors, font } from '@/lib/tokens'
import { Package } from 'lucide-react'

type CartItem = {
  product_id: string
  product_code: string
  name: string
  mrp: number
  quantity: number
}

export default function ProductPage() {
  const params      = useParams()
  const productCode = decodeURIComponent(params.product_code as string).toUpperCase()

  const [product,   setProduct]   = useState<ShowroomProduct | null>(null)
  const [loading,   setLoading]   = useState(true)
  const [notFound,  setNotFound]  = useState(false)
  const [noSession, setNoSession] = useState(false)
  const [quantity,  setQuantity]  = useState(1)
  const [added,     setAdded]     = useState(false)

  const router = useRouter()

  useEffect(() => {
    // Check localStorage for salesperson + customer before fetching product
    const sp       = localStorage.getItem('boe_sp')
    const customer = localStorage.getItem('boe_customer')
    if (!sp || !customer) {
      setNoSession(true)
      setLoading(false)
      return
    }

    fetch(`/api/showroom/products/by-code/${encodeURIComponent(productCode)}`)
      .then(r => r.ok ? r.json() : Promise.reject())
      .then((data: { product: ShowroomProduct }) => {
        setProduct(data.product)
        setLoading(false)
      })
      .catch(() => {
        setNotFound(true)
        setLoading(false)
      })
  }, [productCode])

  const handleAdd = () => {
    if (!product) return

    const existing = localStorage.getItem('boe_cart')
    const cart: CartItem[] = existing ? JSON.parse(existing) : []

    // Same product added twice is kept as a separate row in V1
    cart.push({
      product_id:   product.id,
      product_code: product.product_code,
      name:         product.name,
      mrp:          Number(product.mrp),
      quantity,
    })

    localStorage.setItem('boe_cart', JSON.stringify(cart))
    setAdded(true)
    // Brief confirmation before redirect
    setTimeout(() => router.push('/showroom/project-list'), 600)
  }

  // ── Loading ────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <Shell>
        <div style={{ textAlign: 'center', padding: '48px 0', color: colors.muted, fontSize: '14px' }}>
          Loading…
        </div>
      </Shell>
    )
  }

  // ── No session — customer hasn't scanned salesperson QR ───────────────────
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
            Scan Salesperson QR First
          </div>
          <div style={{ fontSize: '13px', color: colors.tertiary, lineHeight: 1.6, maxWidth: '280px' }}>
            Please scan your salesperson&apos;s QR code before selecting products.
          </div>
          <button
            onClick={() => router.push('/showroom/join')}
            style={{
              marginTop: '8px',
              padding: '11px 24px',
              background: '#1A2035', color: '#fff',
              border: 'none', borderRadius: '9px',
              fontSize: '14px', fontWeight: 600,
              cursor: 'pointer', fontFamily: font.body,
            }}
          >
            Go to Salesperson QR
          </button>
        </div>
      </Shell>
    )
  }

  // ── Product not found or inactive ─────────────────────────────────────────
  if (notFound || !product) {
    return (
      <Shell>
        <div style={{ textAlign: 'center', padding: '32px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
          <div style={{
            width: 48, height: 48, borderRadius: '12px',
            background: 'rgba(217,79,79,0.08)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '22px',
          }}>
            ✕
          </div>
          <div style={{ fontFamily: font.display, fontSize: '18px', fontWeight: 700, color: colors.primary }}>
            Product Not Available
          </div>
          <div style={{ fontSize: '13px', color: colors.tertiary, lineHeight: 1.6, maxWidth: '280px' }}>
            This product is currently not available in our showroom catalog.
          </div>
          <button
            onClick={() => router.push('/showroom/project-list')}
            style={{
              marginTop: '8px',
              padding: '11px 24px',
              background: colors.float, color: colors.secondary,
              border: `1px solid ${colors.border}`, borderRadius: '9px',
              fontSize: '14px', fontWeight: 600,
              cursor: 'pointer', fontFamily: font.body,
            }}
          >
            Back to Project List
          </button>
        </div>
      </Shell>
    )
  }

  // ── Product page ──────────────────────────────────────────────────────────
  return (
    <Shell>
      {/* Product image */}
      <div style={{
        width: '100%', aspectRatio: '4/3',
        background: colors.raised,
        border: `1px solid ${colors.border}`,
        borderRadius: '12px',
        overflow: 'hidden',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        marginBottom: '20px',
      }}>
        {product.image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={product.image_url}
            alt={product.name}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <Package size={48} color={colors.muted} strokeWidth={1.2} />
        )}
      </div>

      {/* Code + category */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px', flexWrap: 'wrap' }}>
        <span style={{
          fontFamily: font.mono, fontSize: '11px', fontWeight: 600,
          color: '#1A2035', background: 'rgba(26,32,53,0.07)',
          borderRadius: '4px', padding: '2px 7px',
        }}>
          {product.product_code}
        </span>
        <span style={{ fontSize: '11px', color: colors.muted }}>
          {product.category}
        </span>
      </div>

      {/* Name */}
      <h1 style={{
        fontFamily: font.display,
        fontSize: '22px', fontWeight: 700,
        color: colors.primary,
        margin: '0 0 4px', letterSpacing: '-0.02em', lineHeight: 1.2,
      }}>
        {product.name}
      </h1>

      {/* MRP */}
      <div style={{
        fontSize: '20px', fontWeight: 700,
        color: '#1A2035',
        fontFamily: font.mono,
        marginBottom: '20px',
      }}>
        ₹{Number(product.mrp).toLocaleString('en-IN')}
        <span style={{ fontSize: '12px', fontWeight: 500, color: colors.muted, marginLeft: '5px', fontFamily: font.body }}>
          MRP
        </span>
      </div>

      {/* Description */}
      {product.description && (
        <div style={{
          fontSize: '13px', color: colors.secondary, lineHeight: 1.65,
          marginBottom: '20px',
        }}>
          {product.description}
        </div>
      )}

      {/* Specifications */}
      {product.specifications && Object.keys(product.specifications).length > 0 && (
        <div style={{
          background: colors.raised,
          border: `1px solid ${colors.border}`,
          borderRadius: '10px',
          padding: '14px 16px',
          marginBottom: '24px',
        }}>
          <div style={{
            fontSize: '10px', fontWeight: 700, letterSpacing: '0.07em',
            textTransform: 'uppercase', color: colors.muted, marginBottom: '10px',
          }}>
            Specifications
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
            {Object.entries(product.specifications).map(([key, value]) => (
              <div key={key} style={{ display: 'flex', justifyContent: 'space-between', gap: '12px' }}>
                <span style={{ fontSize: '12px', color: colors.tertiary, flexShrink: 0 }}>{key}</span>
                <span style={{ fontSize: '12px', color: colors.primary, fontWeight: 500, textAlign: 'right' }}>{value}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Quantity + Add */}
      <div style={{
        borderTop: `1px solid ${colors.border}`,
        paddingTop: '20px',
        display: 'flex', flexDirection: 'column', gap: '12px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <label style={{ fontSize: '13px', fontWeight: 600, color: colors.secondary, flexShrink: 0 }}>
            Quantity
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0' }}>
            <button
              onClick={() => setQuantity(q => Math.max(1, q - 1))}
              style={qtyBtnStyle}
              aria-label="Decrease quantity"
            >
              −
            </button>
            <div style={{
              minWidth: '44px', textAlign: 'center',
              fontSize: '16px', fontWeight: 600, color: colors.primary,
              padding: '0 4px',
            }}>
              {quantity}
            </div>
            <button
              onClick={() => setQuantity(q => q + 1)}
              style={qtyBtnStyle}
              aria-label="Increase quantity"
            >
              +
            </button>
          </div>
        </div>

        <button
          onClick={handleAdd}
          disabled={added}
          style={{
            width: '100%', padding: '15px',
            background: added ? '#45A870' : '#1A2035',
            color: '#fff',
            border: 'none', borderRadius: '10px',
            fontSize: '15px', fontWeight: 600,
            cursor: added ? 'default' : 'pointer',
            fontFamily: font.body,
            letterSpacing: '-0.01em',
            transition: 'background 0.2s',
          }}
        >
          {added ? '✓ Added — going to list…' : 'Add To Project List'}
        </button>

        <button
          onClick={() => router.push('/showroom/project-list')}
          style={{
            width: '100%', padding: '12px',
            background: 'none', color: colors.tertiary,
            border: `1px solid ${colors.border}`, borderRadius: '10px',
            fontSize: '13px', fontWeight: 500,
            cursor: 'pointer', fontFamily: font.body,
          }}
        >
          View Project List
        </button>
      </div>
    </Shell>
  )
}

// ── Page shell ────────────────────────────────────────────────────────────────

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      minHeight: '100vh',
      background: colors.void,
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
          width: 26, height: 26, borderRadius: '6px',
          background: '#1A2035',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
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

// ── Quantity button style ─────────────────────────────────────────────────────

const qtyBtnStyle: React.CSSProperties = {
  width: 36, height: 36,
  background: colors.float,
  border: `1px solid ${colors.border}`,
  borderRadius: '8px',
  fontSize: '18px', fontWeight: 400,
  color: colors.primary,
  cursor: 'pointer',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  flexShrink: 0,
  fontFamily: font.body,
}
