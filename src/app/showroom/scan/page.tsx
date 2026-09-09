'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { colors, font } from '@/lib/tokens'
import { WorkflowSteps } from '@/components/showroom/WorkflowSteps'
import { normalizeProductCode } from '@/lib/showroom/productCode'

// ── Adding a product ──────────────────────────────────────────────────────────
//
// Scanning is the fast path and stays the headline: the phone's own camera app
// reads the sticker and opens /showroom/product/<code> directly, which is why
// there is no in-page camera here to fail.
//
// But the fast path has three ordinary ways of not working — the camera app is
// blocked or unavailable, the QR sticker is scuffed or peeling, or the person
// standing there already knows the code — and until now the page's only answer
// to all three was to repeat the instructions. Typing the code is the fallback,
// and it is on the same screen rather than behind a link, because someone
// reaching for it has already had something go wrong.
//
// Deliberately code-only. A name search would need a public, unauthenticated
// endpoint over the whole product catalogue, and these /showroom routes have no
// auth at all by design — that would publish the catalogue and its MRPs to
// anyone who found the URL. The existing by-code lookup answers about one
// product the person is standing in front of, which is the actual need.

export default function ScanPage() {
  const router = useRouter()

  const [code, setCode]       = useState('')
  const [error, setError]     = useState('')
  const [checking, setChecking] = useState(false)

  const handleLookup = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    const normalized = normalizeProductCode(code)
    if (!normalized) {
      setError('Enter the product code printed on the label.')
      return
    }

    // Confirm the code exists before navigating, so a typo is answered here —
    // where the input still is and can be corrected — rather than by a
    // "Product Not Available" page the customer has to come back from.
    setChecking(true)
    try {
      const res = await fetch(`/api/showroom/products/by-code/${encodeURIComponent(normalized)}`)
      if (!res.ok) {
        setError(`No product found with code ${normalized}. Check the label and try again.`)
        setChecking(false)
        return
      }
    } catch {
      setError('Could not check that code. Please check your connection and try again.')
      setChecking(false)
      return
    }
    router.push(`/showroom/product/${encodeURIComponent(normalized)}`)
  }

  return (
    <div style={{
      minHeight: '100vh', background: colors.void,
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      padding: '24px 16px 48px',
    }}>
      <div style={{ width: '100%', maxWidth: '480px' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '20px' }}>
          <button
            onClick={() => router.push('/showroom/project-list')}
            style={{
              background: 'none', border: 'none', padding: '4px',
              cursor: 'pointer', color: colors.tertiary, display: 'flex',
            }}
            aria-label="Back"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
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

        <WorkflowSteps current="Products" />

        {/* Card */}
        <div style={{
          width: '100%', background: colors.base,
          border: `1.5px solid ${colors.border}`, borderRadius: '16px',
          padding: '24px 20px 26px', boxShadow: '0 2px 12px rgba(0,0,0,0.05)',
          display: 'flex', flexDirection: 'column', gap: '18px',
        }}>

          {/* Scan — the primary route in */}
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '40px', lineHeight: 1, marginBottom: '10px' }}>📷</div>
            <h1 style={{
              fontFamily: font.display, fontSize: '20px', fontWeight: 700,
              color: colors.primary, margin: '0 0 8px', letterSpacing: '-0.02em',
            }}>
              Scan Product QR
            </h1>
            <p style={{
              fontSize: '14px', color: colors.secondary, lineHeight: 1.65,
              margin: '0 auto', maxWidth: '300px',
            }}>
              Open your phone&apos;s <strong>Camera app</strong> and point it at the QR label on the product.
            </p>
          </div>

          <div style={{
            background: colors.raised, border: `1px solid ${colors.border}`,
            borderRadius: '10px', padding: '13px 15px',
            fontSize: '13px', color: colors.tertiary, lineHeight: 1.75,
            textAlign: 'left',
          }}>
            <div style={{ fontWeight: 600, color: colors.secondary, marginBottom: '4px' }}>How it works</div>
            <div>1. Open your phone Camera app</div>
            <div>2. Point it at the QR label on the product</div>
            <div>3. Tap the link that appears</div>
          </div>

          {/* Fallback — always visible, never behind a disclosure */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div style={{ height: '1px', background: colors.border, flex: 1 }} />
            <span style={{
              fontSize: '10.5px', fontWeight: 700, letterSpacing: '0.08em',
              textTransform: 'uppercase', color: colors.muted,
            }}>
              Or enter the code
            </span>
            <div style={{ height: '1px', background: colors.border, flex: 1 }} />
          </div>

          <form onSubmit={handleLookup} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <label htmlFor="product-code" style={{ fontSize: '12px', fontWeight: 600, color: colors.secondary }}>
              Product code
            </label>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                id="product-code"
                type="text"
                value={code}
                onChange={e => { setCode(e.target.value); if (error) setError('') }}
                placeholder="e.g. BOE-SR-105"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                // `text`, not `search`: iOS gives search inputs a clear button
                // that overlaps short values in a narrow field.
                style={{
                  flex: 1, minWidth: 0,
                  padding: '13px 13px',
                  fontSize: '16px',   // 16px or iOS zooms the page on focus
                  fontFamily: font.mono,
                  letterSpacing: '0.04em',
                  textTransform: 'uppercase',
                  color: '#111318', background: '#fff',
                  border: `1.5px solid ${error ? 'rgba(217,79,79,0.55)' : 'rgba(0,0,0,0.13)'}`,
                  borderRadius: '9px', outline: 'none', boxSizing: 'border-box',
                  WebkitAppearance: 'none',
                }}
              />
              <button
                type="submit"
                disabled={checking}
                style={{
                  flexShrink: 0, padding: '13px 20px',
                  background: '#1A2035', color: '#fff',
                  border: 'none', borderRadius: '9px',
                  fontSize: '14px', fontWeight: 600,
                  cursor: checking ? 'default' : 'pointer',
                  opacity: checking ? 0.65 : 1,
                  fontFamily: font.body,
                }}
              >
                {checking ? '…' : 'Find'}
              </button>
            </div>

            {error && (
              <div role="alert" style={{
                background: 'rgba(217,79,79,0.07)',
                border: '1px solid rgba(217,79,79,0.22)',
                borderRadius: '8px', padding: '9px 12px',
                fontSize: '13px', color: '#B91C1C', lineHeight: 1.5,
              }}>
                {error}
              </div>
            )}

            <p style={{ fontSize: '12px', color: colors.muted, margin: 0, lineHeight: 1.6 }}>
              Use this if the camera will not open or the QR label is damaged.
            </p>
          </form>

          <button
            onClick={() => router.push('/showroom/project-list')}
            style={{
              width: '100%', padding: '13px',
              background: 'none', color: colors.secondary,
              border: `1.5px solid ${colors.border}`, borderRadius: '10px',
              fontSize: '14px', fontWeight: 600,
              cursor: 'pointer', fontFamily: font.body,
            }}
          >
            Back to My List
          </button>

        </div>
      </div>
    </div>
  )
}
