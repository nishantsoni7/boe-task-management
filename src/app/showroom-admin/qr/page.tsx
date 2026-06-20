'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { LoadingScreen } from '@/components/ui/atoms'
import { QRCodeSVG } from 'qrcode.react'
import { colors, font } from '@/lib/tokens'
import { ArrowLeft, Printer } from 'lucide-react'

export default function MyQRPage() {
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [qrUrl,   setQrUrl]   = useState('')
  const [loading, setLoading] = useState(true)

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      const { data: p } = await supabase
        .from('users')
        .select('id, full_name, email, phone, role, team, position, is_active, created_at')
        .eq('id', session.user.id)
        .single()

      if (!p) { router.push('/login'); return }
      setProfile(p as UserProfile)
      // Build QR URL from current origin so it works on localhost, staging, and production
      setQrUrl(`${window.location.origin}/showroom/join?sp=${session.user.id}`)
      setLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handlePrint = () => window.print()

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  if (loading) return <LoadingScreen />

  return (
    <>
      {/* Print styles — hides everything except the QR card */}
      <style>{`
        @media print {
          .no-print { display: none !important; }
          body { background: #fff !important; }
          .print-card {
            box-shadow: none !important;
            border: none !important;
            margin: 0 !important;
          }
        }
      `}</style>

      <div style={{ minHeight: '100vh', background: colors.void, padding: '32px 16px' }}>
        <div style={{ maxWidth: '480px', margin: '0 auto' }}>

          {/* Back + nav — hidden on print */}
          <div className="no-print" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
            <button
              onClick={() => router.push('/modules')}
              style={{
                display: 'flex', alignItems: 'center', gap: '6px',
                fontSize: '13px', color: colors.tertiary,
                background: 'none', border: 'none', cursor: 'pointer',
                padding: 0, fontFamily: font.body,
              }}
            >
              <ArrowLeft size={14} strokeWidth={2} />
              Back to Modules
            </button>

            <button
              onClick={() => router.push('/showroom-admin')}
              style={{
                fontSize: '12px', color: colors.secondary,
                background: colors.float,
                border: `1px solid ${colors.border}`,
                borderRadius: '6px',
                padding: '6px 12px',
                cursor: 'pointer',
                fontFamily: font.body,
              }}
            >
              My Inquiries
            </button>
          </div>

          {/* QR Card */}
          <div
            className="print-card"
            style={{
              background: colors.base,
              border: `1.5px solid ${colors.border}`,
              borderRadius: '16px',
              padding: '36px 32px 32px',
              textAlign: 'center',
              boxShadow: '0 2px 12px rgba(0,0,0,0.06)',
            }}
          >
            {/* Title */}
            <div style={{
              fontSize: '10px', fontWeight: 700, letterSpacing: '0.08em',
              textTransform: 'uppercase', color: colors.muted, marginBottom: '6px',
            }}>
              BOE Showroom
            </div>
            <h1 style={{
              fontFamily: font.display, fontSize: '22px', fontWeight: 700,
              color: colors.primary, margin: '0 0 4px', letterSpacing: '-0.02em',
            }}>
              My Showroom QR
            </h1>
            <div style={{ fontSize: '13px', color: colors.secondary, marginBottom: '28px' }}>
              {profile?.full_name}
            </div>

            {/* QR code */}
            <div style={{
              display: 'inline-flex',
              padding: '16px',
              background: '#fff',
              border: `1.5px solid ${colors.border}`,
              borderRadius: '12px',
              marginBottom: '20px',
            }}>
              {qrUrl && (
                <QRCodeSVG
                  value={qrUrl}
                  size={200}
                  level="M"
                  marginSize={1}
                  fgColor="#111318"
                  bgColor="#ffffff"
                  title={`Showroom QR for ${profile?.full_name}`}
                />
              )}
            </div>

            {/* Instruction */}
            <div style={{
              fontSize: '13px', fontWeight: 500,
              color: colors.secondary,
              marginBottom: '16px',
              lineHeight: 1.5,
            }}>
              Ask customer to scan this QR before entering showroom.
            </div>

            {/* QR URL — shown for reference and manual entry */}
            <div style={{
              fontSize: '11px', color: colors.muted,
              fontFamily: font.mono,
              background: colors.raised,
              border: `1px solid ${colors.border}`,
              borderRadius: '7px',
              padding: '8px 12px',
              wordBreak: 'break-all',
              marginBottom: '28px',
            }}>
              {qrUrl}
            </div>

            {/* Print button — hidden on print */}
            <button
              className="no-print"
              onClick={handlePrint}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '7px',
                fontSize: '13px', fontWeight: 600,
                color: '#fff',
                background: '#1A2035',
                border: 'none', borderRadius: '8px',
                padding: '10px 22px',
                cursor: 'pointer',
                fontFamily: font.body,
              }}
            >
              <Printer size={15} strokeWidth={2} />
              Print QR
            </button>
          </div>

          {/* Sign out — hidden on print */}
          <div className="no-print" style={{ textAlign: 'center', marginTop: '24px' }}>
            <button
              onClick={handleSignOut}
              style={{
                fontSize: '12px', color: colors.muted,
                background: 'none', border: 'none', cursor: 'pointer',
                fontFamily: font.body,
              }}
            >
              Sign out
            </button>
          </div>

        </div>
      </div>
    </>
  )
}
