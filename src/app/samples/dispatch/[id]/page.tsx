'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { colors, font } from '@/lib/tokens'
import { LoadingScreen } from '@/components/ui/atoms'
import {
  Package, CheckCircle2, Truck, Phone, MapPin,
  AlertTriangle, ArrowLeft, Send,
} from 'lucide-react'

type SampleStatus = 'pending_approval' | 'approved' | 'rejected' | 'dispatched' | 'returned' | 'lost'

type SampleRequest = {
  id: string
  catalog_type: string
  catalog_name: string
  client_name: string
  client_phone: string | null
  client_address: string | null
  status: SampleStatus
  approved_at: string | null
  dispatched_at: string | null
  dispatched_by: string | null
  courier_name: string | null
  tracking_number: string | null
  dispatch_note: string | null
  notes: string | null
  requested_by_name?: string
  approved_by_name?: string
  dispatched_by_name?: string
}

const CATALOG_LABELS: Record<string, string> = {
  fabric_catalog:          'Fabric Catalog',
  metal_color_catalog:     'Metal Color Catalog',
  rope_catalog:            'Rope Catalog',
  wooden_swatches_catalog: 'Wooden Swatches Catalog',
  other:                   'Other',
}

function formatDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

const inp: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '9px 12px',
  borderRadius: '8px', fontSize: '14px',
  border: `1.5px solid ${colors.border}`, background: '#fff',
  color: colors.primary, outline: 'none', fontFamily: 'inherit',
}

const lbl: React.CSSProperties = {
  fontSize: '11.5px', fontWeight: 700, color: colors.secondary,
  textTransform: 'uppercase', letterSpacing: '0.05em',
  display: 'block', marginBottom: '5px',
}

export default function DispatchPage() {
  const router   = useRouter()
  const params   = useParams()
  const id       = params.id as string
  const supabase = useMemo(() => createClient(), [])

  const [loading, setLoading]         = useState(true)
  const [request, setRequest]         = useState<SampleRequest | null>(null)
  const [notFound, setNotFound]       = useState(false)
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  const [form, setForm]               = useState({ courier_name: '', tracking_number: '', dispatch_note: '' })
  const [saving, setSaving]           = useState(false)
  const [done, setDone]               = useState(false)
  const [error, setError]             = useState<string | null>(null)

  useEffect(() => {
    const load = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }
      setCurrentUserId(session.user.id)

      const { data } = await supabase
        .from('sample_dispatches')
        .select(`
          id, catalog_type, catalog_name, client_name, client_phone, client_address,
          status, approved_at, dispatched_at, dispatched_by, courier_name, tracking_number, dispatch_note, notes,
          requested_by_user:users!requested_by(full_name),
          approved_by_user:users!approved_by(full_name),
          dispatched_by_user:users!dispatched_by(full_name)
        `)
        .eq('id', id)
        .single()

      if (!data) { setNotFound(true); setLoading(false); return }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const row = data as any
      setRequest({
        ...row,
        requested_by_name:  row.requested_by_user?.full_name  ?? null,
        approved_by_name:   row.approved_by_user?.full_name   ?? null,
        dispatched_by_name: row.dispatched_by_user?.full_name ?? null,
      })
      setLoading(false)
    }
    load()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const handleDispatch = async () => {
    if (!form.courier_name.trim()) { setError('Courier name is required.'); return }
    setError(null); setSaving(true)
    const { error: dbErr } = await supabase.from('sample_dispatches').update({
      status:          'dispatched',
      dispatched_at:   new Date().toISOString(),
      dispatched_by:   currentUserId,
      courier_name:    form.courier_name.trim(),
      tracking_number: form.tracking_number.trim() || null,
      dispatch_note:   form.dispatch_note.trim() || null,
    }).eq('id', id)
    setSaving(false)
    if (dbErr) { setError(dbErr.message); return }
    setDone(true)
  }

  if (loading) return <LoadingScreen />

  if (notFound) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: colors.raised, padding: '24px' }}>
      <div style={{ textAlign: 'center', color: colors.muted }}>
        <AlertTriangle size={36} strokeWidth={1.5} style={{ margin: '0 auto 12px', color: colors.red }} />
        <div style={{ fontSize: '16px', fontWeight: 700, color: colors.primary, marginBottom: '6px' }}>Request not found</div>
        <div style={{ fontSize: '13px' }}>This QR code may be invalid or the request was removed.</div>
        <button onClick={() => router.push('/samples')} style={{ marginTop: '20px', padding: '8px 20px', borderRadius: '8px', border: 'none', background: '#1A2035', color: '#fff', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}>
          Go to Sample Tracking
        </button>
      </div>
    </div>
  )

  const r = request!

  if (done) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: colors.raised, padding: '24px' }}>
      <div style={{ background: '#fff', borderRadius: '14px', maxWidth: 480, width: '100%', padding: '32px 28px', textAlign: 'center', boxShadow: '0 4px 24px rgba(0,0,0,0.10)' }}>
        <div style={{ width: 56, height: 56, borderRadius: '50%', background: colors.greenTint, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px', color: colors.green }}>
          <CheckCircle2 size={28} strokeWidth={2} />
        </div>
        <div style={{ fontSize: '18px', fontWeight: 700, color: colors.primary, fontFamily: font.display, marginBottom: '8px' }}>Dispatched!</div>
        <div style={{ fontSize: '13.5px', color: colors.muted, marginBottom: '20px' }}>
          <strong style={{ color: colors.primary }}>{r.catalog_name}</strong> has been marked as dispatched.
          {form.courier_name && <> Courier: <strong style={{ color: colors.secondary }}>{form.courier_name}</strong>.</>}
          {form.tracking_number && <> Tracking: <strong style={{ color: colors.secondary }}>{form.tracking_number}</strong>.</>}
        </div>
        <button onClick={() => router.push('/samples')} style={{ padding: '9px 24px', borderRadius: '8px', border: 'none', background: '#1A2035', color: '#fff', fontSize: '13.5px', fontWeight: 700, cursor: 'pointer' }}>
          Back to Sample Tracking
        </button>
      </div>
    </div>
  )

  const canDispatch = r.status === 'approved'
  const alreadyDispatched = r.status === 'dispatched'

  return (
    <div style={{ minHeight: '100vh', background: colors.raised, padding: '24px 16px' }}>
      <div style={{ maxWidth: 520, margin: '0 auto' }}>

        {/* Back link */}
        <button
          onClick={() => router.push('/samples')}
          style={{ display: 'flex', alignItems: 'center', gap: '6px', background: 'none', border: 'none', color: colors.muted, fontSize: '13px', cursor: 'pointer', marginBottom: '20px', padding: 0 }}
        >
          <ArrowLeft size={14} strokeWidth={2} />
          Sample Tracking
        </button>

        {/* Page title */}
        <div style={{ marginBottom: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px' }}>
            <div style={{ width: 36, height: 36, borderRadius: '9px', background: '#1A203514', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#1A2035' }}>
              <Truck size={17} strokeWidth={1.8} />
            </div>
            <div style={{ fontSize: '18px', fontWeight: 700, color: colors.primary, fontFamily: font.display }}>Dispatch Sample</div>
          </div>
          <div style={{ fontSize: '13px', color: colors.muted, marginLeft: '46px' }}>
            Confirm courier details and mark this sample as dispatched.
          </div>
        </div>

        {/* Request details card */}
        <div style={{ background: '#fff', borderRadius: '12px', border: `1.5px solid ${colors.border}`, marginBottom: '16px', overflow: 'hidden' }}>
          <div style={{ background: '#1A2035', color: '#fff', padding: '12px 16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Package size={14} strokeWidth={2} />
            <span style={{ fontSize: '12.5px', fontWeight: 700, letterSpacing: '0.02em' }}>Request Details</span>
            <span style={{ marginLeft: 'auto', fontSize: '10.5px', opacity: 0.6 }}>{r.id.slice(0, 16).toUpperCase()}</span>
          </div>
          <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '0' }}>
            {([
              ['Catalog',    `${r.catalog_name} (${CATALOG_LABELS[r.catalog_type] ?? r.catalog_type})`],
              ['Client',     r.client_name],
              r.client_phone   ? ['Phone',    r.client_phone]   : null,
              r.client_address ? ['Address',  r.client_address] : null,
              r.requested_by_name ? ['Requested by', r.requested_by_name] : null,
              r.approved_by_name  ? ['Approved by',  r.approved_by_name]  : null,
              r.approved_at ? ['Approved on', formatDate(r.approved_at)] : null,
              r.notes ? ['Notes', r.notes] : null,
            ] as (string[] | null)[]).filter(Boolean).map(row => row as string[]).map(([label, value]) => (
              <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '7px 0', borderBottom: `1px solid ${colors.border}`, fontSize: '13px', gap: '12px' }}>
                <span style={{ color: colors.muted, flexShrink: 0, fontWeight: 500 }}>{label}</span>
                <span style={{ color: colors.primary, fontWeight: 600, textAlign: 'right', wordBreak: 'break-word', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  {label === 'Phone' && <Phone size={11} strokeWidth={1.8} color={colors.muted} />}
                  {label === 'Address' && <MapPin size={11} strokeWidth={1.8} color={colors.muted} />}
                  {value}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Status: already dispatched */}
        {alreadyDispatched && (
          <div style={{ background: '#fff', borderRadius: '12px', border: `1.5px solid #1A203530`, padding: '20px 16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
              <CheckCircle2 size={18} strokeWidth={2} color='#2E9E6B' />
              <span style={{ fontSize: '14px', fontWeight: 700, color: colors.primary, fontFamily: font.display }}>Already Dispatched</span>
            </div>
            <div style={{ fontSize: '13px', color: colors.muted, display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <div>Dispatched on <strong style={{ color: colors.secondary }}>{formatDate(r.dispatched_at)}</strong></div>
              {r.dispatched_by_name && <div>Dispatched by <strong style={{ color: colors.secondary }}>{r.dispatched_by_name}</strong></div>}
              {r.courier_name && <div>Courier: <strong style={{ color: colors.secondary }}>{r.courier_name}</strong></div>}
              {r.tracking_number && <div>Tracking: <strong style={{ color: colors.secondary }}>{r.tracking_number}</strong></div>}
              {r.dispatch_note && <div>Note: {r.dispatch_note}</div>}
            </div>
          </div>
        )}

        {/* Status: not ready */}
        {!canDispatch && !alreadyDispatched && (
          <div style={{ background: '#fff', borderRadius: '12px', border: `1.5px solid ${colors.border}`, padding: '20px 16px', textAlign: 'center' }}>
            <AlertTriangle size={24} strokeWidth={1.5} color='#B45309' style={{ margin: '0 auto 10px' }} />
            <div style={{ fontSize: '14px', fontWeight: 700, color: colors.primary, marginBottom: '6px' }}>Cannot dispatch</div>
            <div style={{ fontSize: '13px', color: colors.muted }}>
              This request has status <strong>{r.status.replace('_', ' ')}</strong> and is not ready for dispatch.
            </div>
          </div>
        )}

        {/* Dispatch form */}
        {canDispatch && (
          <div style={{ background: '#fff', borderRadius: '12px', border: `1.5px solid ${colors.border}`, padding: '20px 16px' }}>
            <div style={{ fontSize: '14px', fontWeight: 700, color: colors.primary, fontFamily: font.display, marginBottom: '16px' }}>Enter Dispatch Details</div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div>
                <label style={lbl}>Courier / Carrier Name <span style={{ color: colors.red }}>*</span></label>
                <input
                  type="text"
                  placeholder="e.g. DTDC, Blue Dart, hand delivery…"
                  value={form.courier_name}
                  onChange={e => setForm(f => ({ ...f, courier_name: e.target.value }))}
                  style={inp}
                />
              </div>
              <div>
                <label style={lbl}>Tracking Number <span style={{ color: colors.muted, textTransform: 'none', fontWeight: 500 }}>(optional)</span></label>
                <input
                  type="text"
                  placeholder="Waybill / tracking ID"
                  value={form.tracking_number}
                  onChange={e => setForm(f => ({ ...f, tracking_number: e.target.value }))}
                  style={inp}
                />
              </div>
              <div>
                <label style={lbl}>Dispatch Note <span style={{ color: colors.muted, textTransform: 'none', fontWeight: 500 }}>(optional)</span></label>
                <textarea
                  placeholder="Any special instructions or remarks…"
                  value={form.dispatch_note}
                  onChange={e => setForm(f => ({ ...f, dispatch_note: e.target.value }))}
                  rows={2}
                  style={{ ...inp, resize: 'vertical' }}
                />
              </div>

              {error && (
                <div style={{ fontSize: '13px', color: colors.red, background: colors.redTint, padding: '8px 12px', borderRadius: '7px' }}>
                  {error}
                </div>
              )}

              <button
                onClick={handleDispatch}
                disabled={saving}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '7px',
                  background: '#1A2035', color: '#fff', border: 'none', borderRadius: '9px',
                  padding: '12px', fontSize: '14px', fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer',
                  opacity: saving ? 0.65 : 1, fontFamily: font.display,
                }}
              >
                <Send size={15} strokeWidth={2} />
                {saving ? 'Saving…' : 'Confirm Dispatch'}
              </button>
            </div>
          </div>
        )}

      </div>
    </div>
  )
}
