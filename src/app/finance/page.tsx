'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { PageShell } from '@/components/layout/PageShell'
import { LoadingScreen } from '@/components/ui/atoms'
import { colors } from '@/lib/tokens'

// ── Status chips ──────────────────────────────────────────────────────────────

const STATUS_CHIPS = [
  { label: 'Pending Approval', bg: '#FFFBEB', color: '#92400E' },
  { label: 'Approved',         bg: '#F0FDF4', color: '#166534' },
  { label: 'Needs Clarification', bg: '#EFF6FF', color: '#1E40AF' },
  { label: 'Rejected',         bg: '#FEF2F2', color: '#991B1B' },
]

// ── Page ──────────────────────────────────────────────────────────────────────

export default function FinancePage() {
  const [loading, setLoading] = useState(true)
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }
      setLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (loading) return <LoadingScreen />

  return (
    <PageShell
      title="Finance"
      subtitle="Payment confirmations, order advances, and finance approvals."
      actions={
        <button
          onClick={() => router.push('/modules')}
          className="boe-btn boe-btn-ghost"
          style={{ padding: '6px 14px', fontSize: '12px' }}
        >
          ← Modules
        </button>
      }
    >

      {/* ── Payment Confirmations section ── */}
      <div className="boe-card" style={{ padding: '20px 22px', display: 'flex', flexDirection: 'column', gap: '16px' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: '15px', fontWeight: 700, color: colors.primary, marginBottom: '4px' }}>
              Payment Confirmations
            </div>
            <div style={{ fontSize: '12px', color: colors.muted }}>
              Sales can submit customer payment details here for admin confirmation.
            </div>
          </div>
          <button
            disabled
            className="boe-btn boe-btn-primary"
            style={{ padding: '8px 18px', fontSize: '13px', opacity: 0.5, cursor: 'not-allowed', flexShrink: 0 }}
          >
            + New Payment Confirmation
          </button>
        </div>

        {/* Status summary chips */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
          {STATUS_CHIPS.map(chip => (
            <span
              key={chip.label}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '6px',
                padding: '4px 10px', borderRadius: '6px',
                background: chip.bg, color: chip.color,
                fontSize: '11px', fontWeight: 600,
              }}
            >
              {chip.label}
              <span style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                minWidth: '16px', height: '16px', borderRadius: '4px',
                background: 'rgba(0,0,0,0.08)', fontSize: '10px', fontWeight: 700,
              }}>0</span>
            </span>
          ))}
        </div>

        {/* Empty state */}
        <div style={{
          padding: '32px 0', textAlign: 'center',
          borderTop: `1px solid ${colors.border}`,
          color: colors.muted, fontSize: '13px',
        }}>
          No payment confirmations yet.
        </div>

      </div>

    </PageShell>
  )
}
