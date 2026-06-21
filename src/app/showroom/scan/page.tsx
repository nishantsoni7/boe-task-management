'use client'

import { useRouter } from 'next/navigation'
import { colors, font } from '@/lib/tokens'

export default function ScanPage() {
  const router = useRouter()

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

        {/* Card */}
        <div style={{
          width: '100%', background: colors.base,
          border: `1.5px solid ${colors.border}`, borderRadius: '16px',
          padding: '32px 24px 36px', boxShadow: '0 2px 12px rgba(0,0,0,0.05)',
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          textAlign: 'center', gap: '16px',
        }}>

          <div style={{ fontSize: '48px', lineHeight: 1 }}>📷</div>

          <h1 style={{
            fontFamily: font.display, fontSize: '20px', fontWeight: 700,
            color: colors.primary, margin: 0, letterSpacing: '-0.02em',
          }}>
            Scan Product QR
          </h1>

          <p style={{
            fontSize: '14px', color: colors.secondary, lineHeight: 1.7,
            margin: 0, maxWidth: '300px',
          }}>
            Please open your phone <strong>Camera app</strong> and scan the product QR label on the item.
          </p>

          <div style={{
            background: colors.raised, border: `1px solid ${colors.border}`,
            borderRadius: '10px', padding: '14px 16px',
            fontSize: '13px', color: colors.tertiary, lineHeight: 1.7,
            textAlign: 'left', width: '100%',
          }}>
            <div style={{ fontWeight: 600, color: colors.secondary, marginBottom: '6px' }}>How it works</div>
            <div>1. Open your phone Camera app</div>
            <div>2. Point it at the QR label on the product</div>
            <div>3. Tap the link that appears</div>
            <div>4. Product will be added to your list</div>
          </div>

          <button
            onClick={() => router.push('/showroom/project-list')}
            style={{
              marginTop: '4px', width: '100%', padding: '14px',
              background: '#1A2035', color: '#fff',
              border: 'none', borderRadius: '10px',
              fontSize: '14px', fontWeight: 600,
              cursor: 'pointer', fontFamily: font.body,
              letterSpacing: '-0.01em',
            }}
          >
            Back to My List
          </button>

        </div>
      </div>
    </div>
  )
}
