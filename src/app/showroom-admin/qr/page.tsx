'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { LoadingScreen } from '@/components/ui/atoms'
import { ShowroomAdminLayout } from '@/components/layout/ShowroomAdminLayout'
import { QRCodeSVG } from 'qrcode.react'
import { colors, font } from '@/lib/tokens'
import { Printer } from 'lucide-react'

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
      const prof = p as UserProfile
      const hasAccess = prof.role === 'admin' ||
        prof.team?.toLowerCase().includes('sales') ||
        prof.team?.toLowerCase().includes('showroom')
      if (!hasAccess) { router.replace('/modules'); return }

      setProfile(prof)
      setQrUrl(`${window.location.origin}/showroom/join?sp=${session.user.id}`)
      setLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  if (loading) return <LoadingScreen />

  return (
    <ShowroomAdminLayout
      profile={profile}
      title="My QR Code"
      onSignOut={handleSignOut}
    >
      {/* Hide sidebar/header during print */}
      <style>{`
        @media print {
          .boe-sidebar, .boe-page-header, .no-print { display: none !important; }
          .boe-main-content { margin: 0 !important; padding: 0 !important; }
          body { background: #fff !important; }
          .print-card { box-shadow: none !important; border: none !important; }
        }
      `}</style>

      <div style={{ maxWidth: '480px' }}>

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

          <div style={{
            fontSize: '13px', fontWeight: 500,
            color: colors.secondary,
            marginBottom: '16px',
            lineHeight: 1.5,
          }}>
            Ask customer to scan this QR before entering showroom.
          </div>

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

          <button
            className="no-print"
            onClick={() => window.print()}
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

      </div>
    </ShowroomAdminLayout>
  )
}
