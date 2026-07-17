'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { colors, font } from '@/lib/tokens'
import { Package } from 'lucide-react'

// ── Types ─────────────────────────────────────────────────────────────────────

type ShareItem = {
  id: string
  quantity: number
  mrp_at_time: number
  showroom_products: {
    product_code: string
    name: string
    category: string
  } | null
}

type ShareInquiry = {
  id: string
  customer_name: string
  company: string | null
  city: string | null
  project_name: string | null
  created_at: string
  showroom_inquiry_items: ShareItem[]
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function SharePage() {
  const { token } = useParams() as { token: string }

  const [inquiry, setInquiry] = useState<ShareInquiry | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    const loadShare = () => {
      if (!token) { setNotFound(true); setLoading(false); return }

      fetch(`/api/showroom/share/${encodeURIComponent(token)}`)
        .then(r => r.ok ? r.json() : Promise.reject(r.status))
        .then((data: { inquiry: ShareInquiry }) => {
          setInquiry(data.inquiry)
          setLoading(false)
        })
        .catch(() => {
          setNotFound(true)
          setLoading(false)
        })
    }
    loadShare()
  }, [token])

  if (loading) {
    return (
      <Shell>
        <div style={{ textAlign: 'center', padding: '48px 0', color: colors.muted, fontSize: '14px' }}>
          Loading…
        </div>
      </Shell>
    )
  }

  if (notFound || !inquiry) {
    return (
      <Shell>
        <div style={{
          textAlign: 'center', padding: '48px 24px',
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px',
        }}>
          <div style={{
            width: 48, height: 48, borderRadius: '12px',
            background: 'rgba(217,79,79,0.08)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '22px',
          }}>
            ✕
          </div>
          <div style={{ fontFamily: font.display, fontSize: '18px', fontWeight: 700, color: colors.primary }}>
            Link Not Found
          </div>
          <div style={{ fontSize: '13px', color: colors.tertiary, lineHeight: 1.6, maxWidth: '280px' }}>
            This link may have expired or is invalid. Please ask your salesperson for a new link.
          </div>
        </div>
      </Shell>
    )
  }

  const items = inquiry.showroom_inquiry_items ?? []
  const grandTotal = items.reduce((sum, i) => sum + i.mrp_at_time * i.quantity, 0)

  return (
    <Shell>
      {/* Customer / project info */}
      <div style={{ marginBottom: '24px' }}>
        <div style={{
          fontSize: '10px', fontWeight: 700, letterSpacing: '0.08em',
          textTransform: 'uppercase', color: colors.muted, marginBottom: '4px',
        }}>
          Product List
        </div>
        <h1 style={{
          fontFamily: font.display, fontSize: '20px', fontWeight: 700,
          color: colors.primary, margin: '0 0 6px', letterSpacing: '-0.02em',
        }}>
          {inquiry.customer_name}
        </h1>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
          {inquiry.project_name && <Chip>{inquiry.project_name}</Chip>}
          {inquiry.company      && <Chip>{inquiry.company}</Chip>}
          {inquiry.city         && <Chip>{inquiry.city}</Chip>}
          <Chip muted>{new Date(inquiry.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</Chip>
        </div>
      </div>

      {/* Product list */}
      {items.length === 0 ? (
        <div style={{
          textAlign: 'center', padding: '32px 0',
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px',
        }}>
          <Package size={32} color={colors.muted} strokeWidth={1.2} />
          <div style={{ fontSize: '14px', color: colors.muted }}>No products in this list.</div>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '20px' }}>
            {items.map(item => {
              const prod = item.showroom_products
              const lineTotal = item.mrp_at_time * item.quantity
              return (
                <div key={item.id} style={{
                  background: colors.raised,
                  border: `1px solid ${colors.border}`,
                  borderRadius: '10px',
                  padding: '12px 14px',
                }}>
                  {/* Code + name */}
                  <div style={{ marginBottom: '8px' }}>
                    <span style={{
                      fontFamily: font.mono, fontSize: '10px', fontWeight: 600,
                      color: '#1A2035', background: 'rgba(26,32,53,0.07)',
                      borderRadius: '3px', padding: '1px 5px',
                    }}>
                      {prod?.product_code ?? '—'}
                    </span>
                    <div style={{ fontSize: '14px', fontWeight: 600, color: colors.primary, marginTop: '3px' }}>
                      {prod?.name ?? 'Unknown product'}
                    </div>
                    {prod?.category && (
                      <div style={{ fontSize: '11px', color: colors.muted, marginTop: '1px' }}>
                        {prod.category}
                      </div>
                    )}
                  </div>

                  {/* Qty + MRP + line total */}
                  <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    borderTop: `1px solid ${colors.border}`, paddingTop: '8px',
                    fontSize: '12px', color: colors.secondary,
                  }}>
                    <span>
                      Qty <strong style={{ color: colors.primary }}>{item.quantity}</strong>
                      <span style={{ margin: '0 6px', color: colors.muted }}>×</span>
                      <span style={{ fontFamily: font.mono }}>₹{Number(item.mrp_at_time).toLocaleString('en-IN')}</span>
                      <span style={{ color: colors.muted, marginLeft: '4px' }}>MRP</span>
                    </span>
                    <span style={{ fontFamily: font.mono, fontWeight: 700, color: colors.primary, fontSize: '14px' }}>
                      ₹{lineTotal.toLocaleString('en-IN')}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>

          {/* Grand total */}
          <div style={{
            borderTop: `1.5px solid ${colors.border}`,
            paddingTop: '14px',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <span style={{ fontSize: '13px', fontWeight: 600, color: colors.secondary }}>
              Total (MRP)
            </span>
            <span style={{
              fontSize: '20px', fontWeight: 700, color: colors.primary,
              fontFamily: font.mono,
            }}>
              ₹{grandTotal.toLocaleString('en-IN')}
            </span>
          </div>
        </>
      )}
    </Shell>
  )
}

// ── Shell ─────────────────────────────────────────────────────────────────────

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
        width: '100%', maxWidth: '520px',
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
        width: '100%', maxWidth: '520px',
        background: colors.base,
        border: `1.5px solid ${colors.border}`,
        borderRadius: '16px',
        padding: '24px 20px 28px',
        boxShadow: '0 2px 12px rgba(0,0,0,0.05)',
      }}>
        {children}
      </div>
    </div>
  )
}

// ── Chip ──────────────────────────────────────────────────────────────────────

function Chip({ children, muted }: { children: React.ReactNode; muted?: boolean }) {
  return (
    <span style={{
      fontSize: '11px', fontWeight: 500,
      color: muted ? colors.muted : colors.secondary,
      background: colors.raised,
      border: `1px solid ${colors.border}`,
      borderRadius: '4px', padding: '2px 8px',
    }}>
      {children}
    </span>
  )
}
