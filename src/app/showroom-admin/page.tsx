'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile, InquiryStatus, QuotationStatus } from '@/lib/types'
import { LoadingScreen, EmptyState } from '@/components/ui/atoms'
import { ShowroomAdminLayout } from '@/components/layout/ShowroomAdminLayout'
import { font } from '@/lib/tokens'
import { useViewAs } from '@/hooks/useViewAs'
import { resolveModuleAccess } from '@/lib/moduleAccess'
import {
  STAGE_ORDER, inquiryStage, stageLabel, type InquiryStage,
} from '@/lib/showroom/inquiryStage'

type ModVisRow = { visibility_type: string; allowed_department: string[] | null; allowed_user_ids: string[] | null }
const teamFallback = (team?: string | null) =>
  !!team && (team.toLowerCase().includes('sales') || team.toLowerCase().includes('showroom'))

type InquirySummary = {
  id: string
  customer_name: string
  customer_mobile: string
  company: string | null
  city: string | null
  project_name: string | null
  status: InquiryStatus
  quotation_status: QuotationStatus | null
  discount_percent: number
  created_at: string
  item_count: number
  mrp_total: number
  /** Resolved by the list route. Null when the profile could not be read. */
  salesperson_name: string | null
}

type StageFilter = 'all' | InquiryStage

const FILTER_TABS: { value: StageFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  ...STAGE_ORDER.map(stage => ({ value: stage as StageFilter, label: stageLabel(stage) })),
]

/**
 * Colour per stage.
 *
 * Five stages rather than four statuses, because `draft` was being shown for
 * two genuinely different situations — an inquiry the customer just submitted
 * and one whose rates a salesperson is working on. See inquiryStage: no new
 * database status is involved, the two existing columns are read together.
 */
const STAGE_STYLE: Record<InquiryStage, {
  color: string; bg: string; border: string; dot: string; strip: string
}> = {
  selecting:       { color: '#805B0D', bg: '#FAF0DA', border: '#FCD34D', dot: '#C48A1A', strip: '#C48A1A' },
  quotation_draft: { color: '#686D6C', bg: '#FBFAF8', border: '#CFC8BF', dot: '#686D6C', strip: '#686D6C' },
  quotation_sent:  { color: '#335A86', bg: '#EAF0F8', border: '#C3D3E6', dot: '#C3D3E6', strip: '#C3D3E6' },
  converted:       { color: '#276247', bg: '#E8F2EC', border: '#86EFAC', dot: '#22C55E', strip: '#22C55E' },
  lost:            { color: '#BE123C', bg: '#FBE9EC', border: '#FDA4AF', dot: '#F43F5E', strip: '#F43F5E' },
  // Ended without an outcome recorded — deliberately duller than every open
  // stage and than both outcomes, so a closed row recedes in a mixed list.
  closed:          { color: '#4C5352', bg: '#F1EEE9', border: '#CFC8BF', dot: '#686D6C', strip: '#686D6C' },
}

const inr = (n: number) => '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 0 })

export default function ShowroomInboxPage() {
  const [profile,         setProfile]         = useState<UserProfile | null>(null)
  const [inquiries,       setInquiries]       = useState<InquirySummary[]>([])
  const [loading,         setLoading]         = useState(true)
  const [error,           setError]           = useState('')
  const [token,           setToken]           = useState('')
  const [quotationFilter, setQuotationFilter] = useState<StageFilter>('all')
  const [showroomMod, setShowroomMod] = useState<ModVisRow | null>(null)

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const { viewAsUserId, viewAsProfile } = useViewAs()

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
      const profile = p as UserProfile
      setShowroomMod(mod ?? null)
      const hasAccess = profile.role === 'admin' ||
        resolveModuleAccess('showroom_qr', mod, profile, teamFallback(profile.team))
      if (!hasAccess) { router.replace('/modules'); return }
      setProfile(profile)
      setToken(session.access_token)

      const url = new URL('/api/showroom/inquiry', window.location.origin)
      if (profile.role === 'admin' && viewAsUserId) {
        url.searchParams.set('viewAs', viewAsUserId)
      }
      const res = await fetch(url.toString(), {
        headers: { 'Authorization': `Bearer ${session.access_token}` },
      })
      if (res.status === 401) { await supabase.auth.signOut(); router.push('/login'); return }
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
  }, [viewAsUserId])

  useEffect(() => {
    if (!profile || !viewAsUserId || !viewAsProfile) return
    const effectiveHasAccess = viewAsProfile.role === 'admin' ||
      resolveModuleAccess('showroom_qr', showroomMod, viewAsProfile, teamFallback(viewAsProfile.team))
    if (!effectiveHasAccess) router.replace('/modules')
  }, [profile, viewAsUserId, viewAsProfile, showroomMod, router])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  void token

  const effectiveProfile = viewAsProfile ?? profile
  const isAdmin = effectiveProfile?.role === 'admin'
  void isAdmin

  // Stage is derived from both status columns, so it is computed once per
  // inquiry here rather than recomputed by the filter, the count and the card.
  const stageById = useMemo(() => {
    const map = new Map<string, InquiryStage>()
    for (const inq of inquiries) {
      map.set(inq.id, inquiryStage({
        status: inq.status,
        quotation_status: inq.quotation_status,
        itemCount: inq.item_count,
      }))
    }
    return map
  }, [inquiries])

  const filteredInquiries = useMemo(() => {
    if (quotationFilter === 'all') return inquiries
    return inquiries.filter(inq => stageById.get(inq.id) === quotationFilter)
  }, [inquiries, quotationFilter, stageById])

  // Pipeline stats
  const pipelineStats = useMemo(() => {
    const activeInquiries = inquiries.filter(i => {
      const qs = i.quotation_status ?? 'draft'
      return qs !== 'lost'
    })
    const convertedInquiries = inquiries.filter(i => i.quotation_status === 'converted')
    const activeValue = activeInquiries.reduce((s, i) => s + i.mrp_total * (1 - i.discount_percent / 100), 0)
    const convertedValue = convertedInquiries.reduce((s, i) => s + i.mrp_total * (1 - i.discount_percent / 100), 0)
    return { activeValue, convertedValue, total: inquiries.length, converted: convertedInquiries.length }
  }, [inquiries])

  if (loading) return <LoadingScreen />

  return (
    <ShowroomAdminLayout
      profile={profile}
      title="Showroom Inquiries"
      subtitle={isAdmin ? 'All inquiries' : (viewAsProfile ? `${viewAsProfile.full_name}'s inquiries` : 'My inquiries')}
      onSignOut={handleSignOut}
    >
      {error && (
        <div style={{
          background: '#FBE9EC', border: '1px solid #FECDD3', borderRadius: '8px',
          padding: '11px 15px', fontSize: '13px', color: '#9F1239', marginBottom: '20px',
        }}>
          {error}
        </div>
      )}

      {/* Pipeline summary, and the one action this screen is missing.
          A showroom day starts by showing a customer your QR code, and the
          landing page had no way to do it — the only route was the sidebar. */}
      <div style={{
        display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center',
        marginBottom: '16px',
      }}>
        {inquiries.length > 0 && (
          <>
            <SummaryChip label="Pipeline" value={inr(pipelineStats.activeValue)} sub={`${pipelineStats.total} inquiries`} />
            <SummaryChip label="Converted" value={inr(pipelineStats.convertedValue)} sub={`${pipelineStats.converted} won`} accent="#276247" />
          </>
        )}
        <button
          onClick={() => router.push('/showroom-admin/qr')}
          style={{
            marginLeft: 'auto',
            display: 'inline-flex', alignItems: 'center', gap: '7px',
            padding: '10px 16px', minHeight: '40px',
            background: '#B9472E', color: '#fff',
            border: 'none', borderRadius: '8px',
            fontSize: '13px', fontWeight: 600,
            cursor: 'pointer', fontFamily: font.body,
            boxShadow: '0 2px 8px rgba(48,53,54,0.22)',
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" />
            <path d="M14 14h3v3h-3zM19 19h2v2h-2z" />
          </svg>
          New Inquiry — Show My QR
        </button>
      </div>

      {/* Filter tabs */}
      {inquiries.length > 0 && (
        <div style={{
          display: 'flex', gap: '4px', marginBottom: '20px', flexWrap: 'wrap',
        }}>
          {FILTER_TABS.map(tab => {
            const active = quotationFilter === tab.value
            const count = tab.value === 'all'
              ? inquiries.length
              : inquiries.filter(i => stageById.get(i.id) === tab.value).length
            return (
              <button
                key={tab.value}
                onClick={() => setQuotationFilter(tab.value)}
                style={{
                  display: 'flex', alignItems: 'center', gap: '6px',
                  padding: '7px 14px',
                  borderRadius: '8px', border: active ? 'none' : '1.5px solid #CFC8BF',
                  background: active ? '#303536' : '#ffffff',
                  color: active ? '#FFFFFF' : '#4C5352',
                  fontSize: '12.5px', fontWeight: active ? 700 : 500,
                  cursor: 'pointer', fontFamily: font.body,
                  boxShadow: active ? '0 2px 8px rgba(48,53,54,0.22)' : '0 1px 3px rgba(0,0,0,0.05)',
                  transition: 'all 0.14s',
                  whiteSpace: 'nowrap',
                }}
              >
                {tab.label}
                <span style={{
                  fontSize: '12px', fontWeight: 700, lineHeight: 1,
                  background: active ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.06)',
                  color: active ? '#fff' : '#686D6C',
                  borderRadius: '6px', padding: '2px 6px',
                  minWidth: '18px', textAlign: 'center',
                }}>
                  {count}
                </span>
              </button>
            )
          })}
        </div>
      )}

      {/* Card grid */}
      {filteredInquiries.length === 0 ? (
        inquiries.length === 0 ? (
          <EmptyState
            message="No inquiries yet"
            hint="Inquiries appear here after customers scan your QR and submit their product list."
          />
        ) : (
          <EmptyState message={`No ${quotationFilter} quotations`} hint="Try a different filter." />
        )
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
          gap: '12px',
        }}>
          {filteredInquiries.map(inq => (
            <InquiryCard
              key={inq.id}
              inquiry={inq}
              stage={stageById.get(inq.id) ?? 'selecting'}
              onClick={() => router.push(`/showroom-admin/inquiry/${inq.id}`)}
            />
          ))}
        </div>
      )}
    </ShowroomAdminLayout>
  )
}

// ── Pipeline summary chip ─────────────────────────────────────────────────────

function SummaryChip({ label, value, sub, accent = '#303536' }: {
  label: string; value: string; sub: string; accent?: string
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '10px',
      background: '#ffffff',
      border: '1px solid #E4DED7',
      borderRadius: '8px',
      padding: '8px 14px',
      boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
      borderLeft: `3px solid ${accent}`,
    }}>
      <div>
        <div style={{
          fontSize: '12px', fontWeight: 700, letterSpacing: '0.07em',
          textTransform: 'uppercase', color: '#686D6C', marginBottom: '2px',
        }}>
          {label}
        </div>
        <div style={{
          fontSize: '16px', fontWeight: 700, color: '#303536',
          fontFamily: 'var(--font-body)',
          letterSpacing: '-0.02em', fontFeatureSettings: '"tnum" 1',
          lineHeight: 1.1,
        }}>
          {value}
        </div>
      </div>
      <div style={{ fontSize: '12px', color: '#686D6C', fontWeight: 400, paddingLeft: '10px', borderLeft: '1px solid #E4DED7' }}>
        {sub}
      </div>
    </div>
  )
}

// ── Inquiry card ──────────────────────────────────────────────────────────────

function InquiryCard({ inquiry, stage, onClick }: {
  inquiry: InquirySummary; stage: InquiryStage; onClick: () => void
}) {
  const [hovered, setHovered] = useState(false)
  const qs = STAGE_STYLE[stage]
  const discountedTotal = inquiry.mrp_total * (1 - inquiry.discount_percent / 100)
  const hasDiscount = inquiry.discount_percent > 0

  const dateStr = new Date(inquiry.created_at).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: '2-digit',
  })
  const timeStr = new Date(inquiry.created_at).toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', hour12: true,
  })

  const contextLine = [inquiry.city, inquiry.project_name].filter(Boolean).join(' · ')

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      role="button"
      tabIndex={0}
      onKeyDown={e => e.key === 'Enter' && onClick()}
      style={{
        background: '#FFFFFF',
        border: `1px solid ${hovered ? '#303536' : '#E4DED7'}`,
        borderRadius: '12px',
        cursor: 'pointer',
        transition: 'border-color 0.15s, box-shadow 0.15s, transform 0.15s',
        boxShadow: hovered
          ? '0 10px 32px rgba(48,53,54,0.12)'
          : '0 2px 8px rgba(0,0,0,0.06)',
        transform: hovered ? 'translateY(-2px)' : 'translateY(0)',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
      }}
    >
      {/* Left status strip */}
      <div style={{
        position: 'absolute', left: 0, top: 0, bottom: 0,
        width: '4px', background: qs.strip,
      }} />

      <div style={{ padding: '14px 16px 14px 20px', flex: 1, display: 'flex', flexDirection: 'column', gap: '10px' }}>

        {/* Row 1: Name + status badge */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '10px' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{
              fontSize: '17px', fontWeight: 700,
              color: '#303536',
              fontFamily: 'var(--font-body)',
              letterSpacing: '-0.015em',
              lineHeight: 1.2,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {inquiry.customer_name}
            </div>
            <div style={{
              fontSize: '12px',
              color: '#686D6C',
              fontWeight: 400,
              marginTop: '3px',
              fontFeatureSettings: '"tnum" 1',
              letterSpacing: '0.01em',
            }}>
              {inquiry.customer_mobile}
            </div>
          </div>

          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: '5px',
            fontSize: '12px', fontWeight: 700,
            color: qs.color, background: qs.bg,
            border: `1.5px solid ${qs.border}`,
            borderRadius: '8px', padding: '4px 10px',
            letterSpacing: '0.06em',
            textTransform: 'uppercase' as const,
            whiteSpace: 'nowrap', flexShrink: 0,
          }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: qs.dot }} />
            {stageLabel(stage)}
          </span>
        </div>

        {/* Owner. An admin sees every salesperson's inquiries in one list, and
            until now the list did not say whose customer any of them was. */}
        <div style={{
          fontSize: '12px', color: '#4C5352', fontWeight: 500,
          display: 'flex', alignItems: 'center', gap: '5px',
        }}>
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="8" cy="5" r="2.75" stroke="currentColor" strokeWidth="1.5"/>
            <path d="M2.5 14c0-2.5 2.5-4 5.5-4s5.5 1.5 5.5 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {inquiry.salesperson_name ?? 'Unassigned'}
          </span>
        </div>

        {/* Context line (city / project) */}
        {contextLine && (
          <div style={{
            fontSize: '12px', color: '#686D6C', fontWeight: 500,
            display: 'flex', alignItems: 'center', gap: '5px',
          }}>
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M8 1.5C5.51 1.5 3.5 3.51 3.5 6c0 3.75 4.5 8.5 4.5 8.5S12.5 9.75 12.5 6c0-2.49-2.01-4.5-4.5-4.5zm0 6a1.5 1.5 0 110-3 1.5 1.5 0 010 3z" fill="currentColor"/>
            </svg>
            {contextLine}
          </div>
        )}

        {/* Divider */}
        <div style={{ height: '1px', background: 'rgba(0,0,0,0.06)' }} />

        {/* Value + items row */}
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
          <div>
            <div style={{
              fontSize: '18px', fontWeight: 700,
              color: '#303536',
              fontFamily: 'var(--font-body)',
              letterSpacing: '-0.02em',
              lineHeight: 1,
              fontFeatureSettings: '"tnum" 1',
            }}>
              {inr(discountedTotal)}
            </div>
            {hasDiscount ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '5px' }}>
                <span style={{
                  fontSize: '12px', color: '#686D6C',
                  textDecoration: 'line-through',
                  fontFeatureSettings: '"tnum" 1',
                }}>
                  {inr(inquiry.mrp_total)}
                </span>
                <span style={{
                  fontSize: '12px', fontWeight: 700,
                  color: '#276247', background: '#E8F2EC',
                  border: '1px solid #BCD8C8',
                  borderRadius: '6px', padding: '1px 5px',
                  letterSpacing: '0.02em',
                }}>
                  -{inquiry.discount_percent}%
                </span>
              </div>
            ) : (
              <div style={{ fontSize: '12px', color: '#686D6C', marginTop: '5px', fontWeight: 500 }}>
                at MRP
              </div>
            )}
          </div>

          <div style={{ textAlign: 'right' }}>
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: '5px',
              fontSize: '12px', fontWeight: 600, color: '#4C5352',
              background: '#F1EEE9', border: '1px solid #E4DED7',
              borderRadius: '8px', padding: '4px 10px',
            }}>
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <rect x="1" y="2" width="14" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
                <path d="M1 6h14" stroke="currentColor" strokeWidth="1.5"/>
              </svg>
              {inquiry.item_count} {inquiry.item_count === 1 ? 'item' : 'items'}
            </div>
            <div style={{
              fontSize: '12px', color: '#686D6C', marginTop: '4px',
              fontVariantNumeric: 'tabular-nums',
            }}>
              {dateStr} · {timeStr}
            </div>
          </div>
        </div>

      </div>
    </div>
  )
}
