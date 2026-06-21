'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile, InquiryStatus } from '@/lib/types'
import { LoadingScreen, EmptyState } from '@/components/ui/atoms'
import { ShowroomAdminLayout } from '@/components/layout/ShowroomAdminLayout'
import { colors, font } from '@/lib/tokens'
import { QrCode, Package } from 'lucide-react'

type InquirySummary = {
  id: string
  customer_name: string
  customer_mobile: string
  company: string | null
  city: string | null
  project_name: string | null
  status: InquiryStatus
  discount_percent: number
  created_at: string
  item_count: number
  mrp_total: number
}

const STATUS_STYLE: Record<InquiryStatus, { color: string; bg: string; border: string }> = {
  new:             { color: '#1E40AF', bg: '#EFF6FF', border: '#BFDBFE' },
  in_discussion:   { color: '#92400E', bg: '#FFFBEB', border: '#FDE68A' },
  quotation_sent:  { color: '#065F46', bg: '#ECFDF5', border: '#A7F3D0' },
  closed:          { color: '#374151', bg: '#F3F4F6', border: '#D1D5DB' },
}

const STATUS_LABEL: Record<InquiryStatus, string> = {
  new:            'New',
  in_discussion:  'In Discussion',
  quotation_sent: 'Quotation Sent',
  closed:         'Closed',
}

export default function ShowroomInboxPage() {
  const [profile,    setProfile]    = useState<UserProfile | null>(null)
  const [inquiries,  setInquiries]  = useState<InquirySummary[]>([])
  const [loading,    setLoading]    = useState(true)
  const [error,      setError]      = useState('')

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
      const profile = p as UserProfile
      const hasAccess = profile.role === 'admin' ||
        profile.team?.toLowerCase().includes('sales') ||
        profile.team?.toLowerCase().includes('showroom')
      if (!hasAccess) { router.replace('/modules'); return }
      setProfile(profile)

      const res = await fetch('/api/showroom/inquiry', {
        headers: { 'Authorization': `Bearer ${session.access_token}` },
      })
      if (!res.ok) {
        setError('Failed to load inquiries')
      } else {
        const data = await res.json()
        setInquiries(data.inquiries ?? [])
      }
      setLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  const isAdmin = profile?.role === 'admin'

  if (loading) return <LoadingScreen />

  return (
    <ShowroomAdminLayout
      profile={profile}
      title="Showroom Inquiries"
      subtitle={isAdmin ? 'All inquiries' : 'My inquiries'}
      onSignOut={handleSignOut}
    >
      {/* Quick links */}
      <div style={{ display: 'flex', gap: '10px', marginBottom: '24px', flexWrap: 'wrap' }}>
        <QuickLink
          label="My QR Code"
          icon={<QrCode size={14} strokeWidth={1.8} />}
          onClick={() => router.push('/showroom-admin/qr')}
        />
        {isAdmin && (
          <QuickLink
            label="Product Master"
            icon={<Package size={14} strokeWidth={1.8} />}
            onClick={() => router.push('/showroom-admin/products')}
          />
        )}
      </div>

      {error && (
        <div style={{
          background: 'rgba(217,79,79,0.07)', border: '1px solid rgba(217,79,79,0.2)',
          borderRadius: '8px', padding: '10px 14px',
          fontSize: '13px', color: '#B91C1C', marginBottom: '16px',
        }}>
          {error}
        </div>
      )}

      {inquiries.length === 0 ? (
        <EmptyState
          message="No inquiries yet"
          hint="Inquiries appear here after customers scan your QR and submit their product list."
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {inquiries.map(inq => (
            <InquiryCard
              key={inq.id}
              inquiry={inq}
              onClick={() => router.push(`/showroom-admin/inquiry/${inq.id}`)}
            />
          ))}
        </div>
      )}
    </ShowroomAdminLayout>
  )
}

// ── Inquiry card ──────────────────────────────────────────────────────────────

function InquiryCard({ inquiry, onClick }: { inquiry: InquirySummary; onClick: () => void }) {
  const [hovered, setHovered] = useState(false)
  const st = STATUS_STYLE[inquiry.status] ?? STATUS_STYLE.new

  const discountedTotal = inquiry.mrp_total * (1 - inquiry.discount_percent / 100)

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      role="button"
      tabIndex={0}
      onKeyDown={e => e.key === 'Enter' && onClick()}
      style={{
        background: colors.base,
        border: `1.5px solid ${hovered ? '#1A2035' : colors.border}`,
        borderRadius: '12px',
        padding: '14px 16px',
        cursor: 'pointer',
        transition: 'border-color 0.12s, box-shadow 0.12s',
        boxShadow: hovered ? '0 4px 12px rgba(0,0,0,0.08)' : '0 1px 3px rgba(0,0,0,0.04)',
      }}
    >
      {/* Top row */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', marginBottom: '8px' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: '14px', fontWeight: 600, color: colors.primary }}>
            {inquiry.customer_name}
          </div>
          <div style={{ fontSize: '12px', color: colors.tertiary, marginTop: '1px' }}>
            {inquiry.customer_mobile}
            {inquiry.city ? ` · ${inquiry.city}` : ''}
            {inquiry.project_name ? ` · ${inquiry.project_name}` : ''}
          </div>
        </div>
        {/* Status badge */}
        <span style={{
          fontSize: '10px', fontWeight: 700,
          color: st.color, background: st.bg,
          border: `1px solid ${st.border}`,
          borderRadius: '5px', padding: '2px 8px',
          whiteSpace: 'nowrap', flexShrink: 0,
        }}>
          {STATUS_LABEL[inquiry.status]}
        </span>
      </div>

      {/* Bottom row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{ fontSize: '11px', color: colors.muted }}>
            {inquiry.item_count} {inquiry.item_count === 1 ? 'product' : 'products'}
          </span>
          <span style={{ fontSize: '12px', fontWeight: 600, color: colors.primary, fontFamily: font.mono }}>
            ₹{discountedTotal.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
            {inquiry.discount_percent > 0 && (
              <span style={{ fontSize: '10px', color: colors.muted, fontWeight: 400, marginLeft: '4px' }}>
                ({inquiry.discount_percent}% off)
              </span>
            )}
          </span>
        </div>
        <span style={{ fontSize: '11px', color: colors.muted }}>
          {new Date(inquiry.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
        </span>
      </div>
    </div>
  )
}

// ── Quick link ────────────────────────────────────────────────────────────────

function QuickLink({ label, icon, onClick }: { label: string; icon: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: '6px',
        fontSize: '12px', fontWeight: 500,
        color: colors.secondary,
        background: colors.base,
        border: `1px solid ${colors.border}`,
        borderRadius: '7px', padding: '7px 13px',
        cursor: 'pointer', fontFamily: font.body,
      }}
    >
      {icon}{label}
    </button>
  )
}
