'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { LoadingScreen } from '@/components/ui/atoms'
import { colors } from '@/lib/tokens'
import { OrdersLayout } from '@/components/layout/OrdersLayout'
import type { UserProfile } from '@/lib/types'
import { X } from 'lucide-react'

// ── Types ─────────────────────────────────────────────────────────────────────

type Order = {
  id: string
  display_number: string
  client_name: string
  requested_by: string | null
  requested_by_name?: string
  assigned_to: string | null
  assigned_to_name?: string
  confirm_date: string | null
  due_date: string | null
  total_value: number | null
  status: string
}

type UserOption = { id: string; full_name: string }

type StatusFilter = 'all' | 'requested' | 'running' | 'on_hold' | 'ready_for_dispatch' | 'dispatched' | 'cancelled'

// ── Constants ─────────────────────────────────────────────────────────────────

const STATUS_META: Record<string, { label: string; bg: string; color: string; border: string }> = {
  requested:          { label: 'Requested',          bg: '#FFFBEB', color: '#92400E', border: '#FDE68A' },
  running:            { label: 'Running',             bg: '#EFF6FF', color: '#1E40AF', border: '#BFDBFE' },
  on_hold:            { label: 'On Hold',             bg: '#FFF7ED', color: '#9A3412', border: '#FED7AA' },
  ready_for_dispatch: { label: 'Ready for Dispatch',  bg: '#F5F3FF', color: '#5B21B6', border: '#DDD6FE' },
  dispatched:         { label: 'Dispatched',          bg: '#F0FDF4', color: '#166534', border: '#BBF7D0' },
  cancelled:          { label: 'Cancelled',           bg: '#FEF2F2', color: '#991B1B', border: '#FECACA' },
}

const STATUS_TABS: { key: StatusFilter; label: string }[] = [
  { key: 'all',               label: 'All' },
  { key: 'requested',         label: 'Requested' },
  { key: 'running',           label: 'Running' },
  { key: 'on_hold',           label: 'On Hold' },
  { key: 'ready_for_dispatch',label: 'Ready to Dispatch' },
  { key: 'dispatched',        label: 'Dispatched' },
  { key: 'cancelled',         label: 'Cancelled' },
]

const LEAD_SOURCE_OPTIONS = [
  { value: 'reference',       label: 'Reference' },
  { value: 'repeat_customer', label: 'Repeat Customer' },
  { value: 'whatsapp',        label: 'WhatsApp' },
  { value: 'instagram',       label: 'Instagram' },
  { value: 'website',         label: 'Website' },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtAmount(n: number | null) {
  if (n == null) return '—'
  return '₹' + n.toLocaleString('en-IN')
}

function fmtDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

function isOverdue(due_date: string | null, status: string): boolean {
  if (!due_date) return false
  if (['dispatched', 'cancelled'].includes(status)) return false
  return new Date(due_date) < new Date()
}

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const meta = STATUS_META[status] ?? { label: status, bg: '#F3F4F6', color: '#4B5563', border: '#E5E7EB' }
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: '5px',
      background: meta.bg, color: meta.color,
      border: `1px solid ${meta.border}`,
      fontSize: '11px', fontWeight: 600, whiteSpace: 'nowrap',
    }}>
      {meta.label}
    </span>
  )
}

// ── New Order Modal ───────────────────────────────────────────────────────────

type NewOrderForm = {
  client_name: string
  requested_by: string
  assigned_to: string
  confirm_date: string
  due_date: string
  total_value: string
  lead_source: string
  notes: string
}

const EMPTY_FORM: NewOrderForm = {
  client_name: '',
  requested_by: '',
  assigned_to: '',
  confirm_date: '',
  due_date: '',
  total_value: '',
  lead_source: '',
  notes: '',
}

function NewOrderModal({
  users,
  onClose,
  onCreated,
}: {
  users: UserOption[]
  onClose: () => void
  onCreated: (id: string) => void
}) {
  const [form,    setForm]    = useState<NewOrderForm>(EMPTY_FORM)
  const [saving,  setSaving]  = useState(false)
  const [error,   setError]   = useState<string | null>(null)
  const supabase = useMemo(() => createClient(), [])

  const set = (k: keyof NewOrderForm) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm(f => ({ ...f, [k]: e.target.value }))

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.client_name.trim()) { setError('Client name is required.'); return }
    setSaving(true)
    setError(null)

    const { data: { session } } = await supabase.auth.getSession()
    if (!session) { setError('Not authenticated.'); setSaving(false); return }

    // Allocate the order number from the monotonic DB sequence only now,
    // at the moment of actual creation — never on mount/preview/cancel.
    const { data: nextNumber, error: numberErr } = await supabase.rpc('next_order_display_number')
    if (numberErr || !nextNumber) {
      setError('Failed to reserve order number. Please try again.')
      setSaving(false)
      return
    }

    const payload = {
      display_number: nextNumber,
      client_name:    form.client_name.trim(),
      requested_by:   form.requested_by || null,
      assigned_to:    form.assigned_to  || null,
      confirm_date:   form.confirm_date || null,
      due_date:       form.due_date     || null,
      total_value:    form.total_value  ? parseFloat(form.total_value) : null,
      lead_source:    form.lead_source  || null,
      notes:          form.notes.trim() || null,
      status:         'requested',
      created_by:     session.user.id,
    }

    const { data: newOrder, error: insertErr } = await supabase
      .from('orders')
      .insert(payload)
      .select('id')
      .single()

    if (insertErr || !newOrder) {
      setError(insertErr?.message ?? 'Failed to create order.')
      setSaving(false)
      return
    }

    await supabase.from('order_activity_log').insert({
      order_id:   newOrder.id,
      actor_id:   session.user.id,
      event_type: 'created',
      payload:    {},
    })

    onCreated(newOrder.id)
  }

  const labelStyle: React.CSSProperties = {
    display: 'flex', flexDirection: 'column', gap: '4px',
    fontSize: '11px', fontWeight: 600, color: colors.muted,
    textTransform: 'uppercase', letterSpacing: '0.05em',
  }
  const inputStyle: React.CSSProperties = {
    padding: '7px 10px', borderRadius: '6px',
    border: `1px solid ${colors.border}`,
    background: colors.raised, color: colors.primary,
    fontSize: '13px', width: '100%', boxSizing: 'border-box',
    outline: 'none',
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '16px',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        background: colors.base,
        border: `1px solid ${colors.border}`,
        borderRadius: '12px',
        width: '100%', maxWidth: '540px',
        maxHeight: '90vh', overflowY: 'auto',
        boxShadow: '0 8px 40px rgba(0,0,0,0.18)',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 20px', borderBottom: `1px solid ${colors.border}`,
        }}>
          <div>
            <div style={{ fontSize: '14px', fontWeight: 700, color: colors.primary }}>New Order Request</div>
            <div style={{ fontSize: '12px', color: colors.muted, marginTop: '2px' }}>
              Order number will be assigned after creation
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.muted, display: 'flex' }}>
            <X size={16} />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <label style={labelStyle}>
            Client Name *
            <input style={inputStyle} value={form.client_name} onChange={set('client_name')} placeholder="Client name" required />
          </label>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
            <label style={labelStyle}>
              Requested By
              <select style={inputStyle} value={form.requested_by} onChange={set('requested_by')}>
                <option value="">— Select —</option>
                {users.map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
              </select>
            </label>
            <label style={labelStyle}>
              Assigned To
              <select style={inputStyle} value={form.assigned_to} onChange={set('assigned_to')}>
                <option value="">— Select —</option>
                {users.map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
              </select>
            </label>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
            <label style={labelStyle}>
              Confirm Date
              <input type="date" style={inputStyle} value={form.confirm_date} onChange={set('confirm_date')} />
            </label>
            <label style={labelStyle}>
              Due Date
              <input type="date" style={inputStyle} value={form.due_date} onChange={set('due_date')} />
            </label>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
            <label style={labelStyle}>
              Total Value (₹)
              <input type="number" min="0" step="0.01" style={inputStyle} value={form.total_value} onChange={set('total_value')} placeholder="0" />
            </label>
            <label style={labelStyle}>
              Lead Source
              <select style={inputStyle} value={form.lead_source} onChange={set('lead_source')}>
                <option value="">— Select —</option>
                {LEAD_SOURCE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
          </div>

          <label style={labelStyle}>
            Notes
            <textarea
              style={{ ...inputStyle, minHeight: '72px', resize: 'vertical', fontFamily: 'inherit' }}
              value={form.notes}
              onChange={set('notes')}
              placeholder="Any additional notes…"
            />
          </label>

          {error && (
            <div style={{ fontSize: '12px', color: colors.red, background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '6px', padding: '8px 12px' }}>
              {error}
            </div>
          )}

          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', paddingTop: '4px' }}>
            <button type="button" onClick={onClose} style={{
              padding: '8px 16px', borderRadius: '7px', fontSize: '13px', fontWeight: 600,
              background: 'transparent', border: `1px solid ${colors.border}`, color: colors.secondary, cursor: 'pointer',
            }}>
              Cancel
            </button>
            <button type="submit" disabled={saving} style={{
              padding: '8px 18px', borderRadius: '7px', fontSize: '13px', fontWeight: 600,
              background: '#DC1F2E', border: 'none', color: '#fff',
              cursor: saving ? 'not-allowed' : 'pointer',
              opacity: saving ? 0.7 : 1,
            }}>
              {saving ? 'Creating…' : 'Create Order'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function AllOrdersPage() {
  const [pageLoading,  setPageLoading]  = useState(true)
  const [profile,      setProfile]      = useState<UserProfile | null>(null)
  const [orders,       setOrders]       = useState<Order[]>([])
  const [users,        setUsers]        = useState<UserOption[]>([])
  const [listLoading,  setListLoading]  = useState(false)
  const [search,       setSearch]       = useState('')
  const [statusTab,    setStatusTab]    = useState<StatusFilter>('all')
  const [showNewModal, setShowNewModal] = useState(false)
  const [deletedBanner, setDeletedBanner] = useState(false)

  const router       = useRouter()
  const searchParams = useSearchParams()
  const supabase     = useMemo(() => createClient(), [])

  const loadOrders = async () => {
    setListLoading(true)
    const { data } = await supabase
      .from('orders')
      .select(`
        id, display_number, client_name,
        requested_by, assigned_to,
        confirm_date, due_date, total_value, status,
        requested_by_user:users!requested_by(full_name),
        assigned_to_user:users!assigned_to(full_name)
      `)
      .order('created_at', { ascending: false })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mapped: Order[] = ((data ?? []) as any[]).map(o => ({
      ...o,
      requested_by_name: o.requested_by_user?.full_name ?? undefined,
      assigned_to_name:  o.assigned_to_user?.full_name  ?? undefined,
      requested_by_user: undefined,
      assigned_to_user:  undefined,
    }))
    setOrders(mapped)
    setListLoading(false)
  }

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      const { data: me } = await supabase
        .from('users')
        .select('id, full_name, email, phone, role, team, position, is_active, created_at, employee_code, joining_date, monthly_salary, office_timing, fingerprint_employee_code')
        .eq('id', session.user.id)
        .single()

      setProfile(me as UserProfile)

      const paramStatus = searchParams.get('status') as StatusFilter | null
      if (paramStatus && STATUS_TABS.some(t => t.key === paramStatus)) {
        setStatusTab(paramStatus)
      }

      if (searchParams.get('deleted') === '1') {
        setDeletedBanner(true)
        router.replace('/orders/all')
      }

      const { data: usersData } = await supabase
        .from('users')
        .select('id, full_name')
        .eq('is_active', true)
        .order('full_name')
      setUsers((usersData ?? []) as UserOption[])

      await loadOrders()
      setPageLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  const visible = useMemo(() => {
    let list = orders
    if (statusTab !== 'all') list = list.filter(o => o.status === statusTab)
    const q = search.trim().toLowerCase()
    if (!q) return list
    return list.filter(o =>
      o.display_number.toLowerCase().includes(q) ||
      o.client_name.toLowerCase().includes(q)
    )
  }, [orders, statusTab, search])

  const isAdmin = profile?.role === 'admin'

  if (pageLoading) return <LoadingScreen />

  return (
    <OrdersLayout
      profile={profile}
      title="All Orders"
      subtitle="Complete order list across all statuses."
      onSignOut={handleSignOut}
      onRefresh={loadOrders}
    >
      {deletedBanner && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 14px', borderRadius: '8px', marginBottom: '12px',
          background: '#F0FDF4', border: '1px solid #BBF7D0',
          fontSize: '13px', color: '#166534',
        }}>
          <span>Request deleted successfully.</span>
          <button
            onClick={() => setDeletedBanner(false)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#166534', padding: 0, lineHeight: 1, fontSize: '13px' }}
          >
            ✕
          </button>
        </div>
      )}

      {/* ── Search + tabs + new button ── */}
      <div style={{ marginBottom: '16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <input
            className="boe-input"
            placeholder="Search by order number or client…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ maxWidth: '320px', flex: 1, minWidth: '180px' }}
          />
          {isAdmin && (
            <button
              onClick={() => setShowNewModal(true)}
              style={{
                padding: '8px 16px', borderRadius: '7px', fontSize: '13px', fontWeight: 600,
                background: '#DC1F2E', border: 'none', color: '#fff', cursor: 'pointer',
                whiteSpace: 'nowrap', flexShrink: 0,
              }}
            >
              + New Order Request
            </button>
          )}
        </div>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          {STATUS_TABS.map(tab => (
            <button
              key={tab.key}
              onClick={() => setStatusTab(tab.key)}
              style={{
                padding: '5px 12px', borderRadius: '6px', fontSize: '12px', fontWeight: 600,
                cursor: 'pointer', border: '1px solid',
                borderColor: statusTab === tab.key ? '#DC1F2E' : colors.border,
                background:   statusTab === tab.key ? 'rgba(220,31,46,0.07)' : 'transparent',
                color:        statusTab === tab.key ? '#DC1F2E' : colors.secondary,
                transition: 'all 0.1s',
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Table ── */}
      <div style={{
        background: colors.base,
        border: `1px solid ${colors.border}`,
        borderRadius: '10px',
        overflow: 'hidden',
      }}>
        <div style={{
          padding: '12px 20px', borderBottom: `1px solid ${colors.border}`,
          fontSize: '12px', color: colors.muted,
        }}>
          {listLoading ? 'Loading…' : `${visible.length} order${visible.length !== 1 ? 's' : ''}`}
        </div>

        {listLoading ? (
          <div style={{ padding: '40px', textAlign: 'center', color: colors.muted, fontSize: '13px' }}>Loading…</div>
        ) : visible.length === 0 ? (
          <div style={{ padding: '40px', textAlign: 'center', color: colors.muted, fontSize: '13px' }}>
            No orders found.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
                  {['Order #', 'Client', 'Requested By', 'Assigned To', 'Confirm Date', 'Due Date', 'Value', 'Status'].map(h => (
                    <th key={h} style={{
                      padding: '8px 16px', textAlign: 'left',
                      fontSize: '10px', fontWeight: 600, color: colors.muted,
                      textTransform: 'uppercase', letterSpacing: '0.05em',
                      whiteSpace: 'nowrap',
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map(o => {
                  const overdue = isOverdue(o.due_date, o.status)
                  return (
                    <tr
                      key={o.id}
                      onClick={() => router.push(`/orders/${o.id}`)}
                      style={{
                        borderBottom: `1px solid ${colors.border}`,
                        cursor: 'pointer', transition: 'background 0.1s',
                      }}
                      onMouseEnter={e => { (e.currentTarget as HTMLTableRowElement).style.background = colors.raised }}
                      onMouseLeave={e => { (e.currentTarget as HTMLTableRowElement).style.background = 'transparent' }}
                    >
                      <td style={{ padding: '11px 16px', fontWeight: 600, color: colors.primary, whiteSpace: 'nowrap' }}>
                        {o.display_number}
                      </td>
                      <td style={{ padding: '11px 16px', color: colors.primary, maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {o.client_name}
                      </td>
                      <td style={{ padding: '11px 16px', color: colors.secondary, whiteSpace: 'nowrap' }}>
                        {o.requested_by_name ?? '—'}
                      </td>
                      <td style={{ padding: '11px 16px', color: colors.secondary, whiteSpace: 'nowrap' }}>
                        {o.assigned_to_name ?? '—'}
                      </td>
                      <td style={{ padding: '11px 16px', color: colors.secondary, whiteSpace: 'nowrap' }}>
                        {fmtDate(o.confirm_date)}
                      </td>
                      <td style={{ padding: '11px 16px', whiteSpace: 'nowrap', color: overdue ? colors.red : colors.secondary, fontWeight: overdue ? 600 : 400 }}>
                        {fmtDate(o.due_date)}
                        {overdue && <span style={{ marginLeft: '4px', fontSize: '10px' }}>overdue</span>}
                      </td>
                      <td style={{ padding: '11px 16px', color: colors.secondary, whiteSpace: 'nowrap' }}>
                        {fmtAmount(o.total_value)}
                      </td>
                      <td style={{ padding: '11px 16px' }}>
                        <StatusBadge status={o.status} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showNewModal && (
        <NewOrderModal
          users={users}
          onClose={() => setShowNewModal(false)}
          onCreated={id => {
            setShowNewModal(false)
            router.push(`/orders/${id}`)
          }}
        />
      )}
    </OrdersLayout>
  )
}
