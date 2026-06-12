'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { colors, font } from '@/lib/tokens'
import { LoadingScreen } from '@/components/ui/atoms'
import { initials } from '@/lib/ui'
import {
  Plus, Package, AlertTriangle, CheckCircle2,
  Clock, Phone, MapPin,
  ThumbsUp, ThumbsDown, Send, X, ShieldCheck, Info, RotateCcw,
  LayoutList, Bell, CheckCheck, Truck, Archive, LogOut, Home, Printer,
} from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'

// ─── Types ────────────────────────────────────────────────────────────────────

type SampleStatus = 'pending_approval' | 'approved' | 'rejected' | 'dispatched' | 'returned' | 'lost'

type SampleRequest = {
  id: string
  catalog_type: string
  catalog_name: string
  client_name: string
  client_phone: string | null
  client_address: string | null
  requested_by: string
  approved_by: string | null
  approved_at: string | null
  rejected_by: string | null
  rejected_at: string | null
  rejection_reason: string | null
  dispatched_at: string | null
  dispatched_by: string | null
  courier_name: string | null
  tracking_number: string | null
  dispatch_note: string | null
  expected_return_date: string | null
  returned_date: string | null
  received_by: string | null
  received_at: string | null
  received_note: string | null
  status: SampleStatus
  notes: string | null
  last_followup_note: string | null
  last_followup_date: string | null
  created_at: string
  updated_at: string
  requested_by_name?: string
  approved_by_name?: string
  rejected_by_name?: string
  received_by_name?: string
  dispatched_by_name?: string
}

// ─── Tab config ───────────────────────────────────────────────────────────────

type TabKey = 'all' | 'pending_approval' | 'approved' | 'dispatched' | 'rejected' | 'closed' | 'notifications'

const TABS: { key: TabKey; label: string; accent: string; Icon: React.ElementType }[] = [
  { key: 'all',              label: 'All Requests',     accent: '#5B7FA6', Icon: LayoutList  },
  { key: 'pending_approval', label: 'Pending Approval', accent: '#B45309', Icon: Clock       },
  { key: 'approved',         label: 'Approved',         accent: '#2E9E6B', Icon: CheckCheck  },
  { key: 'dispatched',       label: 'Dispatched / Out', accent: '#1A2035', Icon: Truck       },
  { key: 'rejected',         label: 'Rejected',         accent: '#D94F4F', Icon: ThumbsDown  },
  { key: 'closed',           label: 'Closed',           accent: '#6B7A99', Icon: Archive     },
  { key: 'notifications',    label: 'Notifications',    accent: '#A0A9BE', Icon: Bell        },
]

// ─── Static data ──────────────────────────────────────────────────────────────

const CATALOG_TYPES = [
  { value: 'fabric_catalog',          label: 'Fabric Catalog' },
  { value: 'metal_color_catalog',     label: 'Metal Color Catalog' },
  { value: 'rope_catalog',            label: 'Rope Catalog' },
  { value: 'wooden_swatches_catalog', label: 'Wooden Swatches Catalog' },
  { value: 'other',                   label: 'Other' },
]

const STATUS_META: Record<SampleStatus, { label: string; bg: string; color: string }> = {
  pending_approval: { label: 'Pending Approval', bg: '#FEF3C714', color: '#B45309' },
  approved:         { label: 'Approved',         bg: colors.blueTint,  color: colors.blue  },
  rejected:         { label: 'Rejected',         bg: colors.redTint,   color: colors.red   },
  dispatched:       { label: 'Dispatched',       bg: '#1A203514',      color: '#1A2035'    },
  returned:         { label: 'Returned',         bg: colors.greenTint, color: colors.green },
  lost:             { label: 'Lost',             bg: colors.redTint,   color: colors.red   },
}

function catalogLabel(v: string) {
  return CATALOG_TYPES.find(c => c.value === v)?.label ?? v
}

function formatDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

function isOverdue(r: SampleRequest) {
  if (r.status !== 'dispatched' || !r.expected_return_date) return false
  return new Date(r.expected_return_date) < new Date(new Date().toDateString())
}

function daysOverdue(r: SampleRequest) {
  if (!r.expected_return_date) return 0
  return Math.floor((Date.now() - new Date(r.expected_return_date).getTime()) / 86400000)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapRows(rows: any[]): SampleRequest[] {
  return rows.map(r => ({
    ...r,
    requested_by_name:  r.requested_by_user?.full_name  ?? null,
    approved_by_name:   r.approved_by_user?.full_name   ?? null,
    rejected_by_name:   r.rejected_by_user?.full_name   ?? null,
    received_by_name:   r.received_by_user?.full_name   ?? null,
    dispatched_by_name: r.dispatched_by_user?.full_name ?? null,
    requested_by_user:  undefined,
    approved_by_user:   undefined,
    rejected_by_user:   undefined,
    received_by_user:   undefined,
    dispatched_by_user: undefined,
  }))
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function SamplesPage() {
  const [profile, setProfile]     = useState<UserProfile | null>(null)
  const [requests, setRequests]   = useState<SampleRequest[]>([])
  const [loading, setLoading]     = useState(true)
  const [activeTab, setActiveTab] = useState<TabKey>('all')
  const [showModal, setShowModal] = useState(false)
  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      const [{ data: profileData }, { data: rows }] = await Promise.all([
        supabase
          .from('users')
          .select('id, full_name, email, phone, role, team, is_active, created_at')
          .eq('id', session.user.id)
          .single(),
        supabase
          .from('sample_dispatches')
          .select(`
            *,
            requested_by_user:users!requested_by(full_name),
            approved_by_user:users!approved_by(full_name),
            rejected_by_user:users!rejected_by(full_name),
            received_by_user:users!received_by(full_name),
            dispatched_by_user:users!dispatched_by(full_name)
          `)
          .order('created_at', { ascending: false }),
      ])

      setProfile(profileData as UserProfile)
      if (rows) setRequests(mapRows(rows))
      setLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const refresh = async () => {
    const { data: rows } = await supabase
      .from('sample_dispatches')
      .select(`
        *,
        requested_by_user:users!requested_by(full_name),
        approved_by_user:users!approved_by(full_name),
        rejected_by_user:users!rejected_by(full_name),
        received_by_user:users!received_by(full_name)
      `)
      .order('created_at', { ascending: false })
    if (rows) setRequests(mapRows(rows))
  }

  const buckets = useMemo<Record<TabKey, SampleRequest[]>>(() => ({
    all:              requests,
    pending_approval: requests.filter(r => r.status === 'pending_approval'),
    approved:         requests.filter(r => r.status === 'approved'),
    dispatched:       [...requests.filter(r => r.status === 'dispatched')]
      .sort((a, b) => (isOverdue(b) ? 1 : 0) - (isOverdue(a) ? 1 : 0)),
    rejected:         requests.filter(r => r.status === 'rejected'),
    closed:           requests.filter(r => r.status === 'returned' || r.status === 'lost'),
    notifications:    [],
  }), [requests])

  if (loading) return <LoadingScreen />

  const isAdmin = profile?.role === 'admin'

  const counts: Record<TabKey, number> = {
    all:              buckets.all.length,
    pending_approval: buckets.pending_approval.length,
    approved:         buckets.approved.length,
    dispatched:       buckets.dispatched.length,
    rejected:         buckets.rejected.length,
    closed:           buckets.closed.length,
    notifications:    0,
  }

  const activeTabMeta = TABS.find(t => t.key === activeTab)!
  const visibleRequests = buckets[activeTab]

  return (
    <div className="boe-app-shell">

      {/* ── Sidebar ── */}
      <aside className="boe-sidebar">

        {/* Brand */}
        <div className="boe-sidebar-brand">
          <div className="boe-sidebar-brand-icon">
            <Package size={15} color="#E8A030" strokeWidth={2} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="boe-sidebar-brand-name">BOE</div>
            <div className="boe-sidebar-brand-sub">Sample Tracking</div>
          </div>
          <button
            onClick={() => router.push('/')}
            title="Home"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 28, height: 28, borderRadius: '7px',
              background: 'rgba(232,160,48,0.12)',
              border: '1px solid rgba(232,160,48,0.25)',
              color: '#E8A030', cursor: 'pointer', flexShrink: 0,
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(232,160,48,0.22)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'rgba(232,160,48,0.12)' }}
          >
            <Home size={14} strokeWidth={2} />
          </button>
        </div>

        {/* Nav items */}
        <div className="boe-sidebar-section">
          {TABS.map((tab, i) => {
            const isActive = activeTab === tab.key
            const { Icon } = tab
            const count = counts[tab.key]
            return (
              <button
                key={tab.key}
                className={`boe-nav-item${isActive ? ' active' : ''}`}
                onClick={() => setActiveTab(tab.key)}
                style={{ fontWeight: isActive ? 600 : 400, marginBottom: i < TABS.length - 1 ? '2px' : 0 }}
              >
                <span style={{ color: isActive ? '#E8A030' : '#A0A9BE', display: 'flex', alignItems: 'center' }}>
                  <Icon size={15} strokeWidth={1.8} />
                </span>
                {tab.label}
                {tab.key !== 'notifications' && count > 0 && (
                  <span style={{
                    marginLeft: 'auto',
                    fontSize: '10px', fontWeight: 600, color: '#8C94A6',
                    background: 'rgba(0,0,0,0.07)', borderRadius: '999px',
                    padding: '1px 6px', lineHeight: '15px',
                  }}>
                    {count}
                  </span>
                )}
              </button>
            )
          })}
        </div>

        {/* Profile + sign out */}
        {profile && (
          <div style={{ marginTop: 'auto', borderTop: '1px solid rgba(0,0,0,0.07)', padding: '10px 10px 6px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 10px 6px' }}>
              <div style={{
                width: 30, height: 30, borderRadius: '8px', background: '#1A2035',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '11px', fontWeight: 700, color: '#E8A030', flexShrink: 0,
              }}>
                {initials(profile.full_name)}
              </div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: '12.5px', fontWeight: 600, color: '#111318', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {profile.full_name}
                </div>
                <div style={{ fontSize: '10.5px', color: '#8C94A6', textTransform: 'capitalize' }}>
                  {profile.role} · {profile.team}
                </div>
              </div>
            </div>
            <button
              className="boe-nav-item"
              onClick={async () => { await supabase.auth.signOut(); router.replace('/login') }}
              style={{ color: '#8C94A6', fontSize: '12.5px', gap: '8px' }}
            >
              <LogOut size={14} strokeWidth={1.8} />
              Sign out
            </button>
          </div>
        )}
      </aside>

      {/* ── Main content ── */}
      <div className="boe-main-content">

        {/* Page header */}
        <div className="boe-page-header">
          <div className="boe-page-title-group">
            <div className="boe-page-title">Sample Tracking</div>
          </div>
          <div className="boe-header-actions">
            <button
              onClick={() => setShowModal(true)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '6px',
                padding: '7px 14px', borderRadius: '8px', border: 'none',
                background: '#1A2035', color: '#fff',
                fontSize: '12px', fontWeight: 600, cursor: 'pointer',
                transition: 'opacity 0.12s', whiteSpace: 'nowrap',
              }}
              onMouseEnter={e => (e.currentTarget.style.opacity = '0.88')}
              onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
            >
              <Plus size={13} strokeWidth={2.5} />
              New Request
            </button>
          </div>
        </div>

        {/* Page body */}
        <div className="boe-page-body">
          <div style={{ maxWidth: '720px', width: '100%' }}>
          {activeTab === 'notifications' ? (
            <div style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center',
              justifyContent: 'center', padding: '80px 32px', gap: '8px', color: colors.muted,
            }}>
              <Bell size={32} strokeWidth={1.4} color={colors.float} />
              <div style={{ fontSize: '14px', fontWeight: 600, color: colors.secondary, marginTop: '8px' }}>
                Sample notifications will appear here.
              </div>
              <div style={{ fontSize: '13px' }}>Notification logic coming soon.</div>
            </div>
          ) : (
            <>
              {/* Section heading */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px' }}>
                <span style={{ fontSize: '14px', fontWeight: 700, color: colors.primary, fontFamily: font.display }}>
                  {activeTabMeta.label}
                </span>
                <span style={{
                  fontSize: '11px', fontWeight: 600,
                  color: counts[activeTab] > 0 ? activeTabMeta.accent : colors.muted,
                  background: 'rgba(0,0,0,0.05)', padding: '2px 8px', borderRadius: '999px',
                }}>
                  {counts[activeTab]}
                </span>
              </div>

              {visibleRequests.length === 0 ? (
                <EmptyState />
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {visibleRequests.map(r => (
                    <RequestCard
                      key={r.id}
                      request={r}
                      isAdmin={isAdmin}
                      currentUserId={profile?.id ?? ''}
                      supabase={supabase}
                      onRefresh={refresh}
                    />
                  ))}
                </div>
              )}
            </>
          )}
          </div>
        </div>
      </div>

      {showModal && profile && (
        <NewRequestModal
          currentUserId={profile.id}
          supabase={supabase}
          onClose={() => setShowModal(false)}
          onSaved={() => { setShowModal(false); refresh() }}
        />
      )}
    </div>
  )
}

// ─── Request Card ─────────────────────────────────────────────────────────────

function RequestCard({
  request: r,
  isAdmin,
  currentUserId,
  supabase,
  onRefresh,
}: {
  request: SampleRequest
  isAdmin: boolean
  currentUserId: string
  supabase: ReturnType<typeof createClient>
  onRefresh: () => void
}) {
  const [followupOpen,  setFollowupOpen]  = useState(false)
  const [verifyOpen,    setVerifyOpen]    = useState(false)
  const [rejectOpen,    setRejectOpen]    = useState(false)
  const [reapplyOpen,   setReapplyOpen]   = useState(false)
  const [slipOpen,      setSlipOpen]      = useState(false)
  const [dispatchOpen,  setDispatchOpen]  = useState(false)
  const [dispatchForm,  setDispatchForm]  = useState({ courier_name: '', tracking_number: '', dispatch_note: '' })
  const [followupNote,  setFollowupNote]  = useState(r.last_followup_note ?? '')
  const [followupDate,  setFollowupDate]  = useState(r.last_followup_date ?? new Date().toISOString().slice(0, 10))
  const [receivedNote,  setReceivedNote]  = useState('')
  const [rejectReason,  setRejectReason]  = useState('')
  const [reapplyNote,   setReapplyNote]   = useState('')
  const [busy, setBusy]                   = useState<string | null>(null)

  const overdue     = isOverdue(r)
  const meta        = STATUS_META[r.status]
  const isClosed    = r.status === 'returned' || r.status === 'lost'
  const isRequester = r.requested_by === currentUserId

  const act = async (action: string, patch: Record<string, unknown>) => {
    setBusy(action)
    await supabase.from('sample_dispatches').update(patch).eq('id', r.id)
    setBusy(null)
    onRefresh()
  }

  const handleApprove = () => act('approve', {
    status: 'approved', approved_by: currentUserId, approved_at: new Date().toISOString(),
  })

  const handleReject = async () => {
    if (!rejectReason.trim()) return
    setBusy('reject')
    await supabase.from('sample_dispatches').update({
      status: 'rejected', rejected_by: currentUserId,
      rejected_at: new Date().toISOString(), rejection_reason: rejectReason.trim(),
    }).eq('id', r.id)
    setBusy(null); setRejectOpen(false); setRejectReason(''); onRefresh()
  }

  const handleDispatched = () => act('dispatch', {
    status: 'dispatched', dispatched_at: new Date().toISOString(),
  })

  const handleDispatchWithDetails = async () => {
    if (!dispatchForm.courier_name.trim()) return
    setBusy('dispatch_details')
    await supabase.from('sample_dispatches').update({
      status:          'dispatched',
      dispatched_at:   new Date().toISOString(),
      dispatched_by:   currentUserId,
      courier_name:    dispatchForm.courier_name.trim(),
      tracking_number: dispatchForm.tracking_number.trim() || null,
      dispatch_note:   dispatchForm.dispatch_note.trim() || null,
    }).eq('id', r.id)
    setBusy(null)
    setDispatchOpen(false)
    setDispatchForm({ courier_name: '', tracking_number: '', dispatch_note: '' })
    onRefresh()
  }

  const handleVerifyReceived = async () => {
    setBusy('verify')
    await supabase.from('sample_dispatches').update({
      status: 'returned', returned_date: new Date().toISOString().slice(0, 10),
      received_by: currentUserId, received_at: new Date().toISOString(),
      received_note: receivedNote.trim() || null,
    }).eq('id', r.id)
    setBusy(null); setVerifyOpen(false); onRefresh()
  }

  const handleLost = () => act('lost', { status: 'lost' })

  const handleReapply = async () => {
    setBusy('reapply')
    const newNotes = [r.notes ?? '', reapplyNote.trim() ? `[Reapply] ${reapplyNote.trim()}` : '']
      .filter(Boolean).join('\n')
    await supabase.from('sample_dispatches').update({
      status: 'pending_approval', rejected_by: null, rejected_at: null,
      rejection_reason: null, notes: newNotes || null,
    }).eq('id', r.id)
    setBusy(null); setReapplyOpen(false); setReapplyNote(''); onRefresh()
  }

  const handleSaveFollowup = async () => {
    if (!followupNote.trim()) return
    setBusy('followup')
    await supabase.from('sample_dispatches').update({
      last_followup_note: followupNote.trim(), last_followup_date: followupDate,
    }).eq('id', r.id)
    setBusy(null); setFollowupOpen(false); onRefresh()
  }

  const borderColor = overdue ? colors.red + '50'
    : r.status === 'pending_approval' ? '#B45309' + '30'
    : r.status === 'rejected' ? colors.red + '28'
    : colors.border

  return (
    <div style={{
      background: '#fff', border: `1.5px solid ${borderColor}`,
      borderRadius: '10px', overflow: 'hidden', opacity: isClosed ? 0.75 : 1,
    }}>
      {overdue && (
        <div style={{ background: colors.redTint, borderBottom: `1px solid ${colors.red}22`, padding: '5px 16px', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontWeight: 600, color: colors.red }}>
          <AlertTriangle size={13} strokeWidth={2.2} />
          Overdue by {daysOverdue(r)} day{daysOverdue(r) !== 1 ? 's' : ''} — follow up needed
        </div>
      )}

      {r.status === 'pending_approval' && (
        <div style={{ background: '#FFFBEB', borderBottom: `1px solid #B4530922`, padding: '5px 16px', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontWeight: 600, color: '#B45309' }}>
          <Clock size={13} strokeWidth={2.2} />
          Awaiting admin approval
        </div>
      )}

      <div style={{ padding: '14px 16px' }}>

        {/* Top row */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px' }}>
          <div style={{ display: 'flex', gap: '11px', flex: 1, minWidth: 0 }}>
            <div style={{ width: 38, height: 38, borderRadius: '9px', flexShrink: 0, background: `${meta.color}14`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: meta.color }}>
              <Package size={17} strokeWidth={1.8} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                <span style={{ fontSize: '14.5px', fontWeight: 700, color: colors.primary, fontFamily: font.display }}>{r.catalog_name}</span>
                <span style={{ fontSize: '11px', fontWeight: 600, padding: '2px 8px', borderRadius: '999px', background: meta.bg, color: meta.color }}>{meta.label}</span>
              </div>
              <div style={{ fontSize: '12.5px', color: colors.muted, marginTop: '2px' }}>{catalogLabel(r.catalog_type)}</div>
            </div>
          </div>
          <div style={{ textAlign: 'right', flexShrink: 0, fontSize: '12px' }}>
            <div style={{ color: colors.tertiary }}>Requested <strong style={{ color: colors.secondary }}>{formatDate(r.created_at)}</strong></div>
            {r.dispatched_at && <div style={{ color: colors.tertiary, marginTop: '2px' }}>Dispatched <strong style={{ color: colors.secondary }}>{formatDate(r.dispatched_at)}</strong></div>}
            {r.status === 'dispatched' && r.expected_return_date && (
              <div style={{ color: overdue ? colors.red : colors.muted, marginTop: '2px', fontWeight: overdue ? 600 : 400 }}>
                Expected back {formatDate(r.expected_return_date)}
              </div>
            )}
            {r.status === 'returned' && r.returned_date && <div style={{ color: colors.green, marginTop: '2px', fontWeight: 600 }}>Returned {formatDate(r.returned_date)}</div>}
            {r.status === 'rejected' && r.rejected_at && <div style={{ color: colors.red, marginTop: '2px' }}>Rejected {formatDate(r.rejected_at)}</div>}
          </div>
        </div>

        {/* Client row */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '14px', marginTop: '10px', paddingTop: '10px', borderTop: `1px solid ${colors.border}` }}>
          <span style={{ fontSize: '13px', color: colors.primary, fontWeight: 600 }}>{r.client_name}</span>
          {r.client_phone && (
            <span style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12.5px', color: colors.tertiary }}>
              <Phone size={12} strokeWidth={1.8} />{r.client_phone}
            </span>
          )}
          {r.client_address && (
            <span style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12.5px', color: colors.tertiary }}>
              <MapPin size={12} strokeWidth={1.8} />{r.client_address}
            </span>
          )}
        </div>

        {/* Meta row */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', marginTop: '8px', fontSize: '12px', color: colors.muted }}>
          <span>Requested by <strong style={{ color: colors.secondary }}>{r.requested_by_name ?? 'Staff'}</strong></span>
          {r.approved_by_name && <span>Approved by <strong style={{ color: colors.secondary }}>{r.approved_by_name}</strong></span>}
          {r.received_by_name && (
            <span style={{ display: 'flex', alignItems: 'center', gap: '4px', color: colors.green }}>
              <ShieldCheck size={12} strokeWidth={2} />
              Verified by <strong style={{ color: colors.green }}>{r.received_by_name}</strong>
              {r.received_at && <span style={{ color: colors.muted }}> on {formatDate(r.received_at)}</span>}
              {r.received_note && <span style={{ color: colors.muted }}> — {r.received_note}</span>}
            </span>
          )}
          {r.last_followup_date && (
            <span>Last follow-up <strong style={{ color: colors.secondary }}>{formatDate(r.last_followup_date)}</strong>{r.last_followup_note && ` — ${r.last_followup_note}`}</span>
          )}
          {r.notes && <span>Note: {r.notes}</span>}
        </div>

        {/* Dispatch audit details */}
        {(r.status === 'dispatched' || r.status === 'returned' || r.status === 'lost') && (r.courier_name || r.dispatched_by_name) && (
          <div style={{ marginTop: '10px', padding: '10px 12px', background: '#1A20350A', borderRadius: '8px', border: '1px solid #1A203520' }}>
            <div style={{ fontSize: '11.5px', fontWeight: 700, color: '#1A2035', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'flex', alignItems: 'center', gap: '5px' }}>
              <Truck size={12} strokeWidth={2.2} />
              Dispatch Details
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', fontSize: '12.5px', color: colors.secondary }}>
              {r.dispatched_by_name && (
                <div>Dispatched by <strong>{r.dispatched_by_name}</strong>{r.dispatched_at && <span style={{ color: colors.muted }}> on {formatDate(r.dispatched_at)}</span>}</div>
              )}
              {r.courier_name && (
                <div>Courier: <strong>{r.courier_name}</strong>{r.tracking_number && <span style={{ color: colors.muted }}> · {r.tracking_number}</span>}</div>
              )}
              {r.dispatch_note && <div style={{ color: colors.muted }}>Note: {r.dispatch_note}</div>}
            </div>
          </div>
        )}

        {/* Rejection details */}
        {r.status === 'rejected' && (r.rejected_by_name || r.rejection_reason) && (
          <div style={{ marginTop: '10px', padding: '10px 12px', background: colors.redTint, borderRadius: '8px', border: `1px solid ${colors.red}28` }}>
            <div style={{ fontSize: '11.5px', fontWeight: 700, color: colors.red, marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Rejection Details
            </div>
            {r.rejected_by_name && (
              <div style={{ fontSize: '12.5px', color: colors.secondary }}>
                Rejected by <strong>{r.rejected_by_name}</strong>
                {r.rejected_at && <span style={{ color: colors.muted }}> on {formatDate(r.rejected_at)}</span>}
              </div>
            )}
            {r.rejection_reason && <div style={{ fontSize: '12.5px', color: colors.primary, marginTop: '4px' }}>Reason: {r.rejection_reason}</div>}
          </div>
        )}

        {/* Actions */}
        {!isClosed && (
          <div style={{ display: 'flex', gap: '8px', marginTop: '12px', flexWrap: 'wrap' }}>
            {isAdmin && r.status === 'pending_approval' && (
              <>
                <ActionBtn icon={<ThumbsUp size={13} strokeWidth={2.2} />} label="Approve" busy={busy === 'approve'} bg={colors.greenTint} color={colors.green} border={colors.green + '33'} onClick={handleApprove} />
                <ActionBtn icon={<ThumbsDown size={13} strokeWidth={2.2} />} label={rejectOpen ? 'Cancel' : 'Reject'} busy={busy === 'reject'} bg={colors.redTint} color={colors.red} border={colors.red + '33'} onClick={() => { setRejectOpen(v => !v); setRejectReason('') }} />
              </>
            )}
            {r.status === 'approved' && (
              <>
                {isAdmin
                  ? <ActionBtn icon={<Truck size={13} strokeWidth={2} />} label={dispatchOpen ? 'Cancel' : 'Enter Dispatch Details'} busy={busy === 'dispatch_details'} bg='#1A203514' color='#1A2035' border='#1A203530' onClick={() => { setDispatchOpen(v => !v); setDispatchForm({ courier_name: '', tracking_number: '', dispatch_note: '' }) }} />
                  : <ActionBtn icon={<Send size={13} strokeWidth={2} />} label="Mark Dispatched" busy={busy === 'dispatch'} bg='#1A203514' color='#1A2035' border='#1A203530' onClick={handleDispatched} />
                }
                <ActionBtn icon={<Printer size={13} strokeWidth={2} />} label="Print Approval Slip" busy={false} bg='#F0F4FF' color='#3B5BDB' border='#3B5BDB33' onClick={() => setSlipOpen(true)} />
              </>
            )}
            {r.status === 'dispatched' && (
              <>
                <ActionBtn icon={<Printer size={13} strokeWidth={2} />} label="Print Approval Slip" busy={false} bg='#F0F4FF' color='#3B5BDB' border='#3B5BDB33' onClick={() => setSlipOpen(true)} />
                {isRequester ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12.5px', color: colors.muted, background: colors.float, border: `1px solid ${colors.border}`, borderRadius: '7px', padding: '6px 12px' }}>
                    <Info size={13} strokeWidth={1.8} />
                    Ask Admin / HR / Dispatch to verify receipt and close this request.
                  </div>
                ) : (
                  <ActionBtn icon={<ShieldCheck size={13} strokeWidth={2.2} />} label={verifyOpen ? 'Cancel Verify' : 'Verify Received & Close'} busy={false} bg={colors.greenTint} color={colors.green} border={colors.green + '33'} onClick={() => setVerifyOpen(v => !v)} />
                )}
                <ActionBtn icon={<Clock size={13} strokeWidth={1.8} />} label={followupOpen ? 'Close Follow-up' : 'Add Follow-up'} busy={false} bg={colors.float} color={colors.secondary} border={colors.border} onClick={() => setFollowupOpen(v => !v)} />
                <ActionBtn icon={<X size={13} strokeWidth={2} />} label="Mark Lost" busy={busy === 'lost'} bg='none' color={colors.muted} border={colors.border} onClick={handleLost} />
              </>
            )}
            {r.status === 'rejected' && isRequester && (
              <ActionBtn icon={<RotateCcw size={13} strokeWidth={2} />} label={reapplyOpen ? 'Cancel' : 'Reapply'} busy={busy === 'reapply'} bg={colors.blueTint} color={colors.blue} border={colors.blue + '33'} onClick={() => { setReapplyOpen(v => !v); setReapplyNote('') }} />
            )}
          </div>
        )}

        {/* Dispatch details panel */}
        {dispatchOpen && isAdmin && r.status === 'approved' && (
          <div style={{ marginTop: '12px', padding: '12px', background: '#1A20350A', borderRadius: '8px', border: '1px solid #1A203530' }}>
            <div style={{ fontSize: '11.5px', fontWeight: 700, color: '#1A2035', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'flex', alignItems: 'center', gap: '5px' }}>
              <Truck size={13} strokeWidth={2} /> Enter Dispatch Details
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <input
                type="text"
                placeholder="Courier / Carrier Name *"
                value={dispatchForm.courier_name}
                onChange={e => setDispatchForm(f => ({ ...f, courier_name: e.target.value }))}
                style={{ padding: '8px 10px', borderRadius: '6px', fontSize: '13px', border: `1.5px solid ${dispatchForm.courier_name.trim() ? '#1A203344' : '#1A203366'}`, background: '#fff', color: colors.primary, outline: 'none', fontFamily: 'inherit', width: '100%', boxSizing: 'border-box' as const }}
              />
              <input
                type="text"
                placeholder="Tracking Number (optional)"
                value={dispatchForm.tracking_number}
                onChange={e => setDispatchForm(f => ({ ...f, tracking_number: e.target.value }))}
                style={{ padding: '8px 10px', borderRadius: '6px', fontSize: '13px', border: `1px solid ${colors.border}`, background: '#fff', color: colors.primary, outline: 'none', fontFamily: 'inherit', width: '100%', boxSizing: 'border-box' as const }}
              />
              <textarea
                placeholder="Dispatch note (optional)"
                value={dispatchForm.dispatch_note}
                onChange={e => setDispatchForm(f => ({ ...f, dispatch_note: e.target.value }))}
                rows={2}
                style={{ padding: '8px 10px', borderRadius: '6px', fontSize: '13px', border: `1px solid ${colors.border}`, background: '#fff', color: colors.primary, outline: 'none', resize: 'vertical', fontFamily: 'inherit', width: '100%', boxSizing: 'border-box' as const }}
              />
              {!dispatchForm.courier_name.trim() && (
                <div style={{ fontSize: '12px', color: colors.muted }}>Courier name is required to confirm dispatch.</div>
              )}
              <div style={{ display: 'flex', gap: '8px', marginTop: '2px' }}>
                <button
                  onClick={handleDispatchWithDetails}
                  disabled={busy === 'dispatch_details' || !dispatchForm.courier_name.trim()}
                  style={{ background: dispatchForm.courier_name.trim() ? '#1A2035' : colors.muted, color: '#fff', border: 'none', borderRadius: '7px', padding: '7px 16px', fontSize: '12.5px', fontWeight: 700, cursor: dispatchForm.courier_name.trim() && busy !== 'dispatch_details' ? 'pointer' : 'not-allowed', opacity: busy === 'dispatch_details' || !dispatchForm.courier_name.trim() ? 0.6 : 1, display: 'flex', alignItems: 'center', gap: '5px' }}
                >
                  <Truck size={13} strokeWidth={2.5} />{busy === 'dispatch_details' ? 'Saving…' : 'Confirm Dispatch'}
                </button>
                <button
                  onClick={() => { setDispatchOpen(false); setDispatchForm({ courier_name: '', tracking_number: '', dispatch_note: '' }) }}
                  style={{ background: 'none', color: colors.muted, border: `1px solid ${colors.border}`, borderRadius: '7px', padding: '7px 12px', fontSize: '12.5px', cursor: 'pointer' }}
                >Cancel</button>
              </div>
            </div>
          </div>
        )}

        {/* Rejection panel */}
        {rejectOpen && isAdmin && r.status === 'pending_approval' && (
          <div style={{ marginTop: '12px', padding: '12px', background: colors.redTint, borderRadius: '8px', border: `1px solid ${colors.red}33` }}>
            <div style={{ fontSize: '11.5px', fontWeight: 700, color: colors.red, marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'flex', alignItems: 'center', gap: '5px' }}>
              <ThumbsDown size={13} strokeWidth={2} /> Rejection Reason
            </div>
            <textarea value={rejectReason} onChange={e => setRejectReason(e.target.value)} placeholder="Required — explain why this request is being rejected…" rows={2}
              style={{ padding: '8px 10px', borderRadius: '6px', fontSize: '13px', border: `1.5px solid ${rejectReason.trim() ? colors.red + '44' : colors.red + '66'}`, background: '#fff', color: colors.primary, outline: 'none', resize: 'vertical', fontFamily: 'inherit', width: '100%', boxSizing: 'border-box' }}
            />
            {!rejectReason.trim() && <div style={{ fontSize: '12px', color: colors.red, marginTop: '4px' }}>A rejection reason is required.</div>}
            <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
              <button onClick={handleReject} disabled={busy === 'reject' || !rejectReason.trim()}
                style={{ background: rejectReason.trim() ? colors.red : colors.muted, color: '#fff', border: 'none', borderRadius: '7px', padding: '7px 16px', fontSize: '12.5px', fontWeight: 700, cursor: rejectReason.trim() && busy !== 'reject' ? 'pointer' : 'not-allowed', opacity: busy === 'reject' || !rejectReason.trim() ? 0.6 : 1, display: 'flex', alignItems: 'center', gap: '5px' }}>
                <ThumbsDown size={13} strokeWidth={2.5} />{busy === 'reject' ? 'Saving…' : 'Confirm Reject'}
              </button>
              <button onClick={() => { setRejectOpen(false); setRejectReason('') }}
                style={{ background: 'none', color: colors.muted, border: `1px solid ${colors.border}`, borderRadius: '7px', padding: '7px 12px', fontSize: '12.5px', cursor: 'pointer' }}>Cancel</button>
            </div>
          </div>
        )}

        {/* Reapply panel */}
        {reapplyOpen && r.status === 'rejected' && isRequester && (
          <div style={{ marginTop: '12px', padding: '12px', background: colors.blueTint, borderRadius: '8px', border: `1px solid ${colors.blue}33` }}>
            <div style={{ fontSize: '11.5px', fontWeight: 700, color: colors.blue, marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'flex', alignItems: 'center', gap: '5px' }}>
              <RotateCcw size={13} strokeWidth={2} /> Reapply — Additional Details
            </div>
            <textarea value={reapplyNote} onChange={e => setReapplyNote(e.target.value)} placeholder="Optional — any additional context for your reapplication…" rows={2}
              style={{ padding: '8px 10px', borderRadius: '6px', fontSize: '13px', border: `1px solid ${colors.blue}44`, background: '#fff', color: colors.primary, outline: 'none', resize: 'vertical', fontFamily: 'inherit', width: '100%', boxSizing: 'border-box' }}
            />
            <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
              <button onClick={handleReapply} disabled={busy === 'reapply'}
                style={{ background: colors.blue, color: '#fff', border: 'none', borderRadius: '7px', padding: '7px 16px', fontSize: '12.5px', fontWeight: 700, cursor: busy === 'reapply' ? 'not-allowed' : 'pointer', opacity: busy === 'reapply' ? 0.6 : 1, display: 'flex', alignItems: 'center', gap: '5px' }}>
                <RotateCcw size={13} strokeWidth={2.5} />{busy === 'reapply' ? 'Saving…' : 'Submit Reapplication'}
              </button>
              <button onClick={() => { setReapplyOpen(false); setReapplyNote('') }}
                style={{ background: 'none', color: colors.muted, border: `1px solid ${colors.border}`, borderRadius: '7px', padding: '7px 12px', fontSize: '12.5px', cursor: 'pointer' }}>Cancel</button>
            </div>
          </div>
        )}

        {/* Verify received panel */}
        {verifyOpen && r.status === 'dispatched' && !isRequester && (
          <div style={{ marginTop: '12px', padding: '12px', background: colors.greenTint, borderRadius: '8px', border: `1px solid ${colors.green}33` }}>
            <div style={{ fontSize: '11.5px', fontWeight: 700, color: colors.green, marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'flex', alignItems: 'center', gap: '5px' }}>
              <ShieldCheck size={13} strokeWidth={2} /> Verify Received & Close
            </div>
            <textarea value={receivedNote} onChange={e => setReceivedNote(e.target.value)} placeholder="Optional — condition on receipt, any remarks…" rows={2}
              style={{ padding: '8px 10px', borderRadius: '6px', fontSize: '13px', border: `1px solid ${colors.green}44`, background: '#fff', color: colors.primary, outline: 'none', resize: 'vertical', fontFamily: 'inherit', width: '100%', boxSizing: 'border-box' }}
            />
            <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
              <button onClick={handleVerifyReceived} disabled={busy === 'verify'}
                style={{ background: colors.green, color: '#fff', border: 'none', borderRadius: '7px', padding: '7px 16px', fontSize: '12.5px', fontWeight: 700, cursor: busy === 'verify' ? 'not-allowed' : 'pointer', opacity: busy === 'verify' ? 0.6 : 1, display: 'flex', alignItems: 'center', gap: '5px' }}>
                <CheckCircle2 size={13} strokeWidth={2.5} />{busy === 'verify' ? 'Saving…' : 'Confirm Received'}
              </button>
              <button onClick={() => setVerifyOpen(false)}
                style={{ background: 'none', color: colors.muted, border: `1px solid ${colors.border}`, borderRadius: '7px', padding: '7px 12px', fontSize: '12.5px', cursor: 'pointer' }}>Cancel</button>
            </div>
          </div>
        )}

        {/* Approval slip modal */}
        {slipOpen && (
          <ApprovalSlipModal request={r} onClose={() => setSlipOpen(false)} />
        )}

        {/* Follow-up panel */}
        {followupOpen && r.status === 'dispatched' && (
          <div style={{ marginTop: '12px', padding: '12px', background: colors.raised, borderRadius: '8px', border: `1px solid ${colors.border}` }}>
            <div style={{ fontSize: '11.5px', fontWeight: 700, color: colors.secondary, marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Log Follow-up
            </div>
            <input type="date" value={followupDate} onChange={e => setFollowupDate(e.target.value)}
              style={{ padding: '7px 10px', borderRadius: '6px', fontSize: '13px', border: `1px solid ${colors.border}`, background: '#fff', color: colors.primary, outline: 'none', width: 'fit-content' }}
            />
            <textarea value={followupNote} onChange={e => setFollowupNote(e.target.value)} placeholder="Called client, sent WhatsApp, client says returning by…" rows={2}
              style={{ marginTop: '8px', padding: '8px 10px', borderRadius: '6px', fontSize: '13px', border: `1px solid ${colors.border}`, background: '#fff', color: colors.primary, outline: 'none', resize: 'vertical', fontFamily: 'inherit', width: '100%', boxSizing: 'border-box' }}
            />
            <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
              <button onClick={handleSaveFollowup} disabled={busy === 'followup' || !followupNote.trim()}
                style={{ background: '#1A2035', color: '#fff', border: 'none', borderRadius: '7px', padding: '7px 16px', fontSize: '12.5px', fontWeight: 600, cursor: followupNote.trim() ? 'pointer' : 'not-allowed', opacity: busy === 'followup' || !followupNote.trim() ? 0.5 : 1 }}>
                {busy === 'followup' ? 'Saving…' : 'Save'}
              </button>
              <button onClick={() => setFollowupOpen(false)}
                style={{ background: 'none', color: colors.muted, border: `1px solid ${colors.border}`, borderRadius: '7px', padding: '7px 12px', fontSize: '12.5px', cursor: 'pointer' }}>Cancel</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Action button ────────────────────────────────────────────────────────────

function ActionBtn({ icon, label, busy, bg, color, border, onClick }: {
  icon: React.ReactNode; label: string; busy: boolean
  bg: string; color: string; border: string; onClick: () => void
}) {
  return (
    <button onClick={onClick} disabled={busy}
      style={{ display: 'flex', alignItems: 'center', gap: '5px', background: bg, color, border: `1px solid ${border}`, borderRadius: '7px', padding: '6px 12px', fontSize: '12.5px', fontWeight: 600, cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.6 : 1 }}>
      {icon}{busy ? 'Saving…' : label}
    </button>
  )
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div style={{ textAlign: 'center', padding: '60px 24px', color: colors.muted }}>
      <Package size={32} color={colors.float} strokeWidth={1.5} style={{ margin: '0 auto 12px' }} />
      <div style={{ fontSize: '14px', fontWeight: 600, color: colors.secondary, marginBottom: '4px' }}>No requests here</div>
      <div style={{ fontSize: '13px' }}>Use the sidebar to browse, or create a new request.</div>
    </div>
  )
}

// ─── Approval Slip Modal ──────────────────────────────────────────────────────

function ApprovalSlipModal({ request: r, onClose }: { request: SampleRequest; onClose: () => void }) {
  const printedAt = new Date().toLocaleString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })

  const qrPayload = `${typeof window !== 'undefined' ? window.location.origin : ''}/samples/dispatch/${r.id}`

  const handlePrint = () => {
    const printContent = document.getElementById('boe-approval-slip')
    if (!printContent) return
    const win = window.open('', '_blank', 'width=700,height=900')
    if (!win) return
    win.document.write(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Approval Slip — ${r.catalog_name}</title>
        <style>
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #fff; color: #111; padding: 32px; }
          .slip { max-width: 560px; margin: 0 auto; border: 2px solid #1A2035; border-radius: 12px; overflow: hidden; }
          .slip-header { background: #1A2035; color: #fff; padding: 16px 20px; display: flex; justify-content: space-between; align-items: center; }
          .slip-header h1 { font-size: 15px; font-weight: 700; letter-spacing: 0.02em; }
          .slip-header .sub { font-size: 11px; opacity: 0.65; margin-top: 3px; }
          .slip-body { padding: 20px; }
          .slip-row { display: flex; justify-content: space-between; padding: 7px 0; border-bottom: 1px solid #eee; font-size: 13px; }
          .slip-row:last-child { border-bottom: none; }
          .slip-label { color: #666; font-weight: 500; }
          .slip-value { color: #111; font-weight: 600; text-align: right; max-width: 60%; }
          .slip-qr { display: flex; flex-direction: column; align-items: center; padding: 20px; border-top: 1.5px dashed #ddd; gap: 8px; }
          .slip-qr p { font-size: 11px; color: #999; }
          .status-badge { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 12px; font-weight: 700; }
          .status-approved { background: #E6F7F0; color: #2E9E6B; }
          .status-dispatched { background: #1A20351A; color: #1A2035; }
          .printed { font-size: 11px; color: #aaa; text-align: center; margin-top: 12px; }
          @media print { body { padding: 12px; } }
        </style>
      </head>
      <body>
        ${printContent.innerHTML}
        <div class="printed">Printed on ${printedAt}</div>
        <script>window.onload = function() { window.print(); }<\/script>
      </body>
      </html>
    `)
    win.document.close()
  }

  const statusLabel = r.status === 'approved' ? 'Approved' : 'Dispatched'
  const statusClass = r.status === 'approved' ? 'status-approved' : 'status-dispatched'

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{ background: '#fff', borderRadius: '14px', width: '100%', maxWidth: 540, maxHeight: '92vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.25)' }}>
        {/* Modal header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: `1px solid ${colors.border}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Printer size={16} strokeWidth={2} color='#3B5BDB' />
            <span style={{ fontSize: '14px', fontWeight: 700, color: colors.primary, fontFamily: font.display }}>Approval Slip Preview</span>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.muted, display: 'flex', alignItems: 'center' }}>
            <X size={18} strokeWidth={2} />
          </button>
        </div>

        {/* Slip content (this is what gets printed) */}
        <div id="boe-approval-slip" style={{ padding: '20px' }}>
          <div className="slip" style={{ border: '2px solid #1A2035', borderRadius: '10px', overflow: 'hidden', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>
            {/* Slip header */}
            <div className="slip-header" style={{ background: '#1A2035', color: '#fff', padding: '14px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontSize: '14px', fontWeight: 700, letterSpacing: '0.02em' }}>BOE Sample Approval Slip</div>
                <div style={{ fontSize: '11px', opacity: 0.65, marginTop: '3px' }}>Request ID: {r.id.slice(0, 16).toUpperCase()}</div>
              </div>
              <span className={statusClass} style={{
                padding: '3px 10px', borderRadius: '999px', fontSize: '11px', fontWeight: 700,
                background: r.status === 'approved' ? '#E6F7F0' : '#ffffff22',
                color: r.status === 'approved' ? '#2E9E6B' : '#E8A030',
              }}>{statusLabel}</span>
            </div>

            {/* Slip body */}
            <div style={{ padding: '16px 18px' }}>
              {[
                ['Catalog Name', r.catalog_name],
                ['Catalog Type', catalogLabel(r.catalog_type)],
                ['Client', r.client_name],
                r.client_phone    ? ['Phone', r.client_phone]    : null,
                r.client_address  ? ['Address', r.client_address] : null,
                ['Requested By', r.requested_by_name ?? '—'],
                r.approved_by_name ? ['Approved By', r.approved_by_name] : null,
                r.approved_at ? ['Approved On', formatDate(r.approved_at)] : null,
                r.dispatched_at ? ['Dispatched On', formatDate(r.dispatched_at)] : null,
                r.expected_return_date ? ['Expected Return', formatDate(r.expected_return_date)] : null,
                r.notes ? ['Notes', r.notes] : null,
              ].filter(Boolean).map(row => row as string[]).map(([label, value]) => (
                <div key={label as string} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '7px 0', borderBottom: `1px solid ${colors.border}`, fontSize: '13px', gap: '12px' }}>
                  <span style={{ color: colors.muted, fontWeight: 500, flexShrink: 0 }}>{label}</span>
                  <span style={{ color: colors.primary, fontWeight: 600, textAlign: 'right', wordBreak: 'break-word' }}>{value as string}</span>
                </div>
              ))}
            </div>

            {/* QR section */}
            <div style={{ borderTop: '1.5px dashed #ddd', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '18px', gap: '10px' }}>
              <QRCodeSVG value={qrPayload} size={130} level="M" />
              <div style={{ fontSize: '11px', color: colors.muted, textAlign: 'center' }}>
                Scan to verify request · Printed {printedAt}
              </div>
            </div>
          </div>
        </div>

        {/* Print button */}
        <div style={{ padding: '14px 20px', borderTop: `1px solid ${colors.border}`, display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ background: colors.float, color: colors.secondary, border: `1.5px solid ${colors.border}`, borderRadius: '8px', padding: '8px 18px', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}>
            Close
          </button>
          <button onClick={handlePrint} style={{ display: 'flex', alignItems: 'center', gap: '6px', background: '#3B5BDB', color: '#fff', border: 'none', borderRadius: '8px', padding: '8px 20px', fontSize: '13px', fontWeight: 700, cursor: 'pointer' }}>
            <Printer size={14} strokeWidth={2} />
            Print Slip
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── New Request Modal ────────────────────────────────────────────────────────

function NewRequestModal({ currentUserId, supabase, onClose, onSaved }: {
  currentUserId: string; supabase: ReturnType<typeof createClient>
  onClose: () => void; onSaved: () => void
}) {
  const [form, setForm] = useState({
    catalog_type: 'fabric_catalog', catalog_name: '', client_name: '',
    client_phone: '', client_address: '', expected_return_date: '', notes: '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState<string | null>(null)

  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }))

  const handleSubmit = async () => {
    if (!form.catalog_name.trim()) { setError('Catalog name is required.'); return }
    if (!form.client_name.trim())  { setError('Client name is required.'); return }
    setError(null); setSaving(true)
    const { error: dbErr } = await supabase.from('sample_dispatches').insert({
      catalog_type: form.catalog_type, catalog_name: form.catalog_name.trim(),
      client_name: form.client_name.trim(), client_phone: form.client_phone.trim() || null,
      client_address: form.client_address.trim() || null,
      expected_return_date: form.expected_return_date || null,
      notes: form.notes.trim() || null, requested_by: currentUserId, status: 'pending_approval',
    })
    setSaving(false)
    if (dbErr) { setError(dbErr.message); return }
    onSaved()
  }

  const inp: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box', padding: '8px 11px', borderRadius: '7px',
    fontSize: '13.5px', border: `1.5px solid ${colors.border}`, background: '#fff',
    color: colors.primary, outline: 'none', fontFamily: 'inherit',
  }
  const lbl: React.CSSProperties = {
    fontSize: '11.5px', fontWeight: 700, color: colors.secondary,
    textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: '5px',
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{ background: '#fff', borderRadius: '16px 16px 0 0', width: '100%', maxWidth: 560, maxHeight: '90vh', overflowY: 'auto', padding: '24px 24px 40px' }}>
        <div style={{ width: 36, height: 4, borderRadius: 2, background: colors.border, margin: '0 auto 20px' }} />
        <div style={{ fontSize: '17px', fontWeight: 700, color: colors.primary, fontFamily: font.display, marginBottom: '20px', letterSpacing: '-0.01em' }}>New Sample Request</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ display: 'flex', gap: '12px' }}>
            <div style={{ flex: 1 }}>
              <label style={lbl}>Catalog Type</label>
              <select value={form.catalog_type} onChange={e => set('catalog_type', e.target.value)} style={inp}>
                {CATALOG_TYPES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label style={lbl}>Catalog Name / Details <span style={{ color: colors.red }}>*</span></label>
              <input type="text" placeholder="e.g. Summer 2026 Fabrics" value={form.catalog_name} onChange={e => set('catalog_name', e.target.value)} style={inp} />
            </div>
          </div>
          <div style={{ borderTop: `1px solid ${colors.border}` }} />
          <div>
            <label style={lbl}>Client Name <span style={{ color: colors.red }}>*</span></label>
            <input type="text" placeholder="Full name" value={form.client_name} onChange={e => set('client_name', e.target.value)} style={inp} />
          </div>
          <div style={{ display: 'flex', gap: '12px' }}>
            <div style={{ flex: 1 }}>
              <label style={lbl}>Phone</label>
              <input type="tel" placeholder="+91 ..." value={form.client_phone} onChange={e => set('client_phone', e.target.value)} style={inp} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={lbl}>Address / City</label>
              <input type="text" placeholder="City or full address" value={form.client_address} onChange={e => set('client_address', e.target.value)} style={inp} />
            </div>
          </div>
          <div style={{ borderTop: `1px solid ${colors.border}` }} />
          <div>
            <label style={lbl}>Expected Return Date <span style={{ color: colors.muted }}>(optional)</span></label>
            <input type="date" value={form.expected_return_date} onChange={e => set('expected_return_date', e.target.value)} style={{ ...inp, width: 'auto' }} />
          </div>
          <div>
            <label style={lbl}>Notes / Reason</label>
            <textarea placeholder="Why this catalog is needed, any special instructions…" value={form.notes} onChange={e => set('notes', e.target.value)} rows={2} style={{ ...inp, resize: 'vertical' }} />
          </div>
          {error && <div style={{ fontSize: '13px', color: colors.red, background: colors.redTint, padding: '8px 12px', borderRadius: '7px' }}>{error}</div>}
          <div style={{ display: 'flex', gap: '10px', marginTop: '4px' }}>
            <button onClick={handleSubmit} disabled={saving}
              style={{ flex: 1, background: '#1A2035', color: '#fff', border: 'none', borderRadius: '9px', padding: '11px', fontSize: '14px', fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.6 : 1, fontFamily: font.display }}>
              {saving ? 'Submitting…' : 'Submit Request'}
            </button>
            <button onClick={onClose}
              style={{ background: colors.float, color: colors.secondary, border: `1.5px solid ${colors.border}`, borderRadius: '9px', padding: '11px 20px', fontSize: '14px', fontWeight: 600, cursor: 'pointer' }}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
