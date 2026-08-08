'use client'

import { useEffect, useState, useMemo, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { LoadingScreen } from '@/components/ui/atoms'
import { ShowroomAdminLayout } from '@/components/layout/ShowroomAdminLayout'
import { QRCodeSVG, QRCodeCanvas } from 'qrcode.react'
import { colors, font } from '@/lib/tokens'
import { Printer, Download } from 'lucide-react'
import { useToast, Toast } from '@/components/ui/toast'
import { useViewAs } from '@/hooks/useViewAs'
import { resolveModuleAccess } from '@/lib/moduleAccess'
import {
  downloadQrCanvasAsPng,
  qrFileNameFor,
  QR_EXPORT_SIZE,
  QR_EXPORT_MARGIN_MODULES,
} from '@/lib/qrExport'

type ModVisRow = { visibility_type: string; allowed_department: string[] | null; allowed_user_ids: string[] | null }
const teamFallback = (team?: string | null) =>
  !!team && (team.toLowerCase().includes('sales') || team.toLowerCase().includes('showroom'))

export default function MyQRPage() {
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [qrUrl,   setQrUrl]   = useState('')
  const [loading, setLoading] = useState(true)
  const [showroomMod, setShowroomMod] = useState<ModVisRow | null>(null)

  const [downloading, setDownloading] = useState(false)

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const { viewAsUserId, viewAsProfile } = useViewAs()
  const { toast, show: showToast, dismiss: dismissToast } = useToast()
  const exportCanvasRef = useRef<HTMLCanvasElement>(null)

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
          .select('visibility_type, allowed_department, allowed_user_ids')
          .eq('module_key', 'showroom_qr')
          .single(),
      ])

      if (!p) { router.push('/login'); return }
      const prof = p as UserProfile
      setShowroomMod(mod ?? null)
      const hasAccess = prof.role === 'admin' ||
        resolveModuleAccess('showroom_qr', mod, prof, teamFallback(prof.team))
      if (!hasAccess) { router.replace('/modules'); return }

      setProfile(prof)
      // In view mode, generate QR for the viewed user; otherwise for self
      const spId = (prof.role === 'admin' && viewAsUserId) ? viewAsUserId : session.user.id
      setQrUrl(`${window.location.origin}/showroom/join?sp=${spId}`)
      setLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewAsUserId])

  // Redirect when view mode switches to a user without showroom access
  useEffect(() => {
    if (!profile || !viewAsUserId || !viewAsProfile) return
    const effectiveHasAccess = viewAsProfile.role === 'admin' ||
      resolveModuleAccess('showroom_qr', showroomMod, viewAsProfile, teamFallback(viewAsProfile.team))
    if (!effectiveHasAccess) router.replace('/modules')
  }, [profile, viewAsUserId, viewAsProfile, showroomMod, router])

  const effectiveProfile = viewAsProfile ?? profile

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  const handleDownloadPng = async () => {
    if (downloading) return
    setDownloading(true)
    try {
      const source = exportCanvasRef.current
      if (!source) throw new Error('QR export canvas is not mounted')
      await downloadQrCanvasAsPng(source, qrFileNameFor(effectiveProfile?.full_name))
    } catch (err) {
      console.error('[showroom-qr] PNG download failed', err)
      showToast('Unable to download the QR image. Please try again.', 'error')
    } finally {
      setDownloading(false)
    }
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
            {effectiveProfile?.full_name}
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
                title={`Showroom QR for ${effectiveProfile?.full_name}`}
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

          <div className="no-print" style={{
            display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '10px',
          }}>
            <button
              onClick={handleDownloadPng}
              disabled={downloading || !qrUrl}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '7px',
                fontSize: '13px', fontWeight: 600,
                color: '#fff',
                background: '#1A2035',
                border: 'none', borderRadius: '8px',
                padding: '10px 22px',
                cursor: downloading ? 'wait' : 'pointer',
                opacity: downloading ? 0.7 : 1,
                fontFamily: font.body,
              }}
            >
              <Download size={15} strokeWidth={2} />
              {downloading ? 'Downloading…' : 'Download PNG'}
            </button>

            <button
              onClick={() => window.print()}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '7px',
                fontSize: '13px', fontWeight: 600,
                color: colors.secondary,
                background: colors.raised,
                border: `1.5px solid ${colors.border}`, borderRadius: '8px',
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

        {/* Off-screen high-resolution source for the PNG export. Same qrUrl as the
            displayed QR above, so both always encode an identical destination. */}
        {qrUrl && (
          <div className="no-print" aria-hidden="true" style={{
            position: 'absolute', left: '-9999px', top: 0, pointerEvents: 'none',
          }}>
            <QRCodeCanvas
              ref={exportCanvasRef}
              value={qrUrl}
              size={QR_EXPORT_SIZE}
              level="M"
              marginSize={QR_EXPORT_MARGIN_MODULES}
              fgColor="#111318"
              bgColor="#ffffff"
            />
          </div>
        )}

      </div>
      <Toast toast={toast} onDismiss={dismissToast} />
    </ShowroomAdminLayout>
  )
}
