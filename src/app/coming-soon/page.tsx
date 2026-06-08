'use client'

import { useRouter } from 'next/navigation'
import { Briefcase, Clock } from 'lucide-react'
import { colors, font } from '@/lib/tokens'

export default function ComingSoonPage() {
  const router = useRouter()

  return (
    <div style={{
      minHeight: '100vh',
      background: colors.void,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '24px',
    }}>
      <div style={{
        background: colors.base,
        border: `1.5px solid ${colors.border}`,
        borderRadius: '16px',
        padding: '48px 40px',
        maxWidth: '420px',
        width: '100%',
        textAlign: 'center',
        boxShadow: '0 4px 24px rgba(0,0,0,0.06)',
      }}>

        {/* Icon */}
        <div style={{
          width: 56, height: 56, borderRadius: '14px',
          background: 'rgba(232,160,48,0.1)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          margin: '0 auto 24px',
        }}>
          <Clock size={26} color="#E8A030" strokeWidth={1.8} />
        </div>

        {/* Brand */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', marginBottom: '24px' }}>
          <div style={{
            width: 24, height: 24, borderRadius: '6px',
            background: '#1A2035',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Briefcase size={12} color="#E8A030" strokeWidth={2} />
          </div>
          <span style={{ fontSize: '12px', fontWeight: 700, color: colors.muted, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            BOE Internal Platform
          </span>
        </div>

        {/* Heading */}
        <h1 style={{
          fontFamily: font.display,
          fontSize: '24px',
          fontWeight: 700,
          color: colors.primary,
          letterSpacing: '-0.02em',
          margin: '0 0 8px',
          lineHeight: 1.2,
        }}>
          Attendance Module
        </h1>

        <div style={{
          display: 'inline-block',
          fontSize: '11px', fontWeight: 700,
          color: '#E8A030',
          background: 'rgba(232,160,48,0.1)',
          border: '1px solid rgba(232,160,48,0.25)',
          borderRadius: '999px',
          padding: '3px 12px',
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          marginBottom: '20px',
        }}>
          Coming Soon
        </div>

        <p style={{
          fontSize: '14px',
          color: colors.tertiary,
          lineHeight: 1.65,
          margin: '0 0 32px',
        }}>
          This module is currently under development.
          <br />
          You will receive access once it is released.
        </p>

        {/* Back button */}
        <button
          onClick={() => router.push('/')}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: '6px',
            fontSize: '13px', fontWeight: 600,
            color: colors.secondary,
            background: colors.float,
            border: `1px solid ${colors.border}`,
            borderRadius: '8px',
            padding: '9px 18px',
            cursor: 'pointer',
            transition: 'background 0.12s, color 0.12s',
          }}
          onMouseEnter={e => {
            e.currentTarget.style.background = colors.hover
            e.currentTarget.style.color = colors.primary
          }}
          onMouseLeave={e => {
            e.currentTarget.style.background = colors.float
            e.currentTarget.style.color = colors.secondary
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" />
          </svg>
          Back to Home
        </button>

      </div>
    </div>
  )
}
