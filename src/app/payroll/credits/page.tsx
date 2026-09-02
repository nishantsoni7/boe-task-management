'use client'

// BOE Credits — the management view.
//
// Access: /payroll is admin-only (PayrollGuard → resolveManagementAccess), and
// every /api/boe-credits route this page calls refuses a non-admin regardless.
// This page adds no access decision of its own.
//
// What it is: the minimum read visibility needed to verify the foundation —
// every employee's available credits, each one's history, the two settings,
// and the one controlled correction (an admin adjustment with a reason). No
// charts, no monthly earned/used reporting, no analytics: those are not
// Phase 1A, and this screen should not grow them by accident.

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { colors } from '@/lib/tokens'
import { AttendancePayrollLayout } from '@/components/layout/AttendancePayrollLayout'
import { LoadingScreen, AlertBanner } from '@/components/ui/atoms'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { formatCredits } from '@/lib/boeCredits/ledger'
import { DEFAULT_BOE_CREDIT_SETTINGS } from '@/lib/boeCredits/settings'
import type { BoeCreditSettings, EmployeeCreditBalance } from '@/lib/boeCredits/types'
import { CreditHistoryModal, type CreditHistoryRow } from '@/components/boeCredits/CreditHistoryModal'
import { AdjustCreditsModal } from '@/components/boeCredits/AdjustCreditsModal'
import { CreditSettingsModal } from '@/components/boeCredits/CreditSettingsModal'

type SettingsHistoryRow = {
  id: string
  review_reward_credits: number
  credit_value: number
  note: string | null
  created_at: string
  created_by_name: string | null
}

type HistoryState = {
  employee: EmployeeCreditBalance
  available: number
  rows: CreditHistoryRow[]
}

function stamp(at: string | null): string {
  if (!at) return '—'
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? at : d.toLocaleString('en-IN')
}

const TH: React.CSSProperties = {
  padding: '11px 16px', textAlign: 'left',
  fontSize: 11.5, fontWeight: 700,
  color: '#8C94A6', textTransform: 'uppercase', letterSpacing: '0.05em',
  whiteSpace: 'nowrap',
}

const actionButton: React.CSSProperties = {
  fontSize: 12.5, fontWeight: 600,
  color: '#4F6FD0', cursor: 'pointer',
  padding: '4px 10px', borderRadius: 6,
  border: '1px solid rgba(79,111,208,0.3)',
  background: 'none', whiteSpace: 'nowrap',
}

export default function BoeCreditsPage() {
  const [profile,  setProfile]  = useState<UserProfile | null>(null)
  const [token,    setToken]    = useState('')
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState('')
  const [okMsg,    setOkMsg]    = useState('')

  const [balances, setBalances] = useState<EmployeeCreditBalance[]>([])
  const [settings, setSettings] = useState<BoeCreditSettings>(DEFAULT_BOE_CREDIT_SETTINGS)
  const [usingDefaults, setUsingDefaults] = useState(false)
  const [settingsHistory, setSettingsHistory] = useState<SettingsHistoryRow[]>([])

  const [history,   setHistory]   = useState<HistoryState | null>(null)
  const [adjusting, setAdjusting] = useState<EmployeeCreditBalance | null>(null)
  const [editingSettings, setEditingSettings] = useState(false)

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  const authHeaders = (t: string) => ({ authorization: `Bearer ${t}` })

  const loadBalances = async (t: string) => {
    const res  = await fetch('/api/boe-credits/balances', { headers: authHeaders(t) })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(json.error ?? 'Could not load credit balances.')
    setBalances(json.balances ?? [])
  }

  const loadSettings = async (t: string) => {
    const res  = await fetch('/api/boe-credits/settings', { headers: authHeaders(t) })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(json.error ?? 'Could not load credit settings.')
    setSettings(json.settings as BoeCreditSettings)
    setUsingDefaults(json.using_defaults === true)
    setSettingsHistory(json.history ?? [])
  }

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }
      setToken(session.access_token)

      const { data: prof } = await supabase
        .from('users')
        .select(USER_PROFILE_COLUMNS)
        .eq('id', session.user.id)
        .single()
      if (!prof) { router.push('/coming-soon'); return }
      setProfile(prof as UserProfile)

      try {
        await Promise.all([loadBalances(session.access_token), loadSettings(session.access_token)])
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
      setLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const openHistory = async (employee: EmployeeCreditBalance) => {
    setError('')
    const res  = await fetch(`/api/boe-credits/ledger?employee_id=${encodeURIComponent(employee.employee_id)}&limit=500`, {
      headers: authHeaders(token),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) { setError(json.error ?? 'Could not load the credit history.'); return }
    setHistory({ employee, available: json.available_credits ?? 0, rows: json.transactions ?? [] })
  }

  const submitAdjustment = async (employee: EmployeeCreditBalance, input: { credits: number; reason: string }) => {
    const res = await fetch('/api/boe-credits/adjustments', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(token) },
      body: JSON.stringify({ employee_id: employee.employee_id, credits: input.credits, reason: input.reason }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) return json.error ?? 'Could not record the adjustment.'

    setOkMsg(`Recorded ${formatCredits(input.credits, { signed: true })} for ${employee.full_name}.`)
    // The balance the server derived, not one computed here.
    setBalances(prev => prev.map(b => b.employee_id === employee.employee_id
      ? {
          ...b,
          available_credits: json.available_credits ?? b.available_credits,
          transaction_count: b.transaction_count + 1,
          last_transaction_at: new Date().toISOString(),
        }
      : b))
    return null
  }

  const submitSettings = async (input: { settings: BoeCreditSettings; note: string | null }) => {
    const res = await fetch('/api/boe-credits/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeaders(token) },
      body: JSON.stringify(input),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) {
      const issues = (json.issues ?? []) as { message: string }[]
      return issues.length > 0 ? issues.map(i => i.message).join(' ') : json.error ?? 'Could not save the settings.'
    }
    try { await loadSettings(token) } catch { /* the save succeeded; the reload is presentational */ }
    setOkMsg('Credit settings saved.')
    return null
  }

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  if (loading) return <LoadingScreen />

  const totalCredits = balances.reduce((sum, b) => sum + b.available_credits, 0)

  return (
    <AttendancePayrollLayout
      profile={profile}
      title="BOE Credits"
      subtitle="Employee credit balances and history"
      onSignOut={handleSignOut}
    >
      {error && <div style={{ marginBottom: 12 }}><AlertBanner variant="red">{error}</AlertBanner></div>}
      {okMsg && <div style={{ marginBottom: 12 }}><AlertBanner variant="green">{okMsg}</AlertBanner></div>}

      {/* ── Settings ─────────────────────────────────────────────────────── */}
      <div style={{
        border: `1px solid ${colors.border}`, borderRadius: 12,
        background: colors.base, marginBottom: 16, overflow: 'hidden',
      }}>
        <div style={{
          padding: '12px 16px', borderBottom: `1px solid ${colors.border}`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap',
        }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: colors.primary }}>Credit settings</div>
          <button onClick={() => setEditingSettings(true)} style={actionButton}>Edit</button>
        </div>
        <div style={{ padding: '12px 16px', display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.09em', color: colors.muted }}>
              Review reward
            </div>
            <div style={{ fontSize: 15, fontWeight: 600, color: colors.primary, fontVariantNumeric: 'tabular-nums' }}>
              {formatCredits(settings.review_reward_credits)}
            </div>
            <div style={{ fontSize: 11.5, color: colors.muted }}>per verified review</div>
          </div>
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.09em', color: colors.muted }}>
              Credit value
            </div>
            <div style={{ fontSize: 15, fontWeight: 600, color: colors.primary, fontVariantNumeric: 'tabular-nums' }}>
              ₹{settings.credit_value.toFixed(2)}
            </div>
            <div style={{ fontSize: 11.5, color: colors.muted }}>per credit, for Payroll</div>
          </div>
          {usingDefaults && (
            <div style={{ fontSize: 11.5, color: '#B45309', alignSelf: 'center' }}>
              Showing built-in defaults — no settings row could be read.
            </div>
          )}
        </div>
        {settingsHistory.length > 0 && (
          <div style={{ padding: '0 16px 12px', display: 'flex', flexDirection: 'column', gap: 4 }}>
            {settingsHistory.slice(0, 5).map(h => (
              <div key={h.id} style={{ fontSize: 12, color: colors.tertiary, lineHeight: 1.5 }}>
                <strong style={{ color: colors.primary }}>{stamp(h.created_at)}</strong>
                {' — '}{h.created_by_name ?? 'System'}
                {' · '}{formatCredits(h.review_reward_credits)} per review, ₹{Number(h.credit_value).toFixed(2)} per credit
                {h.note ? ` · ${h.note}` : ''}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Balances ─────────────────────────────────────────────────────── */}
      <div style={{
        border: `1px solid ${colors.border}`, borderRadius: 12,
        background: colors.base, overflow: 'hidden',
      }}>
        <div style={{
          padding: '12px 16px', borderBottom: `1px solid ${colors.border}`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap',
        }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: colors.primary }}>Employee balances</div>
          <span style={{ fontSize: 12, color: colors.muted, fontVariantNumeric: 'tabular-nums' }}>
            {balances.length} {balances.length === 1 ? 'employee' : 'employees'} · {formatCredits(totalCredits)} outstanding
          </span>
        </div>

        {balances.length === 0 ? (
          <div style={{ padding: '32px 24px', textAlign: 'center', color: colors.muted, fontSize: 13.5 }}>
            No employees to show.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid rgba(0,0,0,0.07)' }}>
                  <th style={TH}>Employee</th>
                  <th style={{ ...TH, textAlign: 'right' }}>Available</th>
                  <th style={{ ...TH, textAlign: 'right' }}>Entries</th>
                  <th style={TH}>Last activity</th>
                  <th style={TH}></th>
                </tr>
              </thead>
              <tbody>
                {balances.map((b, i) => (
                  <tr
                    key={b.employee_id}
                    style={{ borderBottom: i < balances.length - 1 ? '1px solid rgba(0,0,0,0.05)' : 'none' }}
                  >
                    <td style={{ padding: '12px 16px' }}>
                      <div style={{ fontSize: 13.5, fontWeight: 500, color: '#111318' }}>{b.full_name}</div>
                      {b.employee_code && (
                        <div style={{ fontSize: 11.5, color: '#8C94A6', marginTop: 1 }}>{b.employee_code}</div>
                      )}
                    </td>
                    <td style={{
                      padding: '12px 16px', textAlign: 'right', fontSize: 13.5, fontWeight: 600,
                      color: b.available_credits < 0 ? '#DC2626' : '#111318', fontVariantNumeric: 'tabular-nums',
                    }}>
                      {b.available_credits.toLocaleString('en-IN')}
                    </td>
                    <td style={{ padding: '12px 16px', textAlign: 'right', fontSize: 13.5, color: '#3D4455', fontVariantNumeric: 'tabular-nums' }}>
                      {b.transaction_count}
                    </td>
                    <td style={{ padding: '12px 16px', fontSize: 12.5, color: '#6B7280', whiteSpace: 'nowrap' }}>
                      {stamp(b.last_transaction_at)}
                    </td>
                    <td style={{ padding: '12px 16px' }}>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                        <button onClick={() => void openHistory(b)} style={actionButton}>History</button>
                        <button onClick={() => { setOkMsg(''); setAdjusting(b) }} style={actionButton}>Adjust</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {history && (
        <CreditHistoryModal
          transactions={history.rows}
          availableCredits={history.available}
          employeeLabel={history.employee.full_name}
          onClose={() => setHistory(null)}
        />
      )}

      {adjusting && (
        <AdjustCreditsModal
          employeeName={adjusting.full_name}
          availableCredits={adjusting.available_credits}
          onClose={() => setAdjusting(null)}
          onSubmit={input => submitAdjustment(adjusting, input)}
        />
      )}

      {editingSettings && (
        <CreditSettingsModal
          current={settings}
          onClose={() => setEditingSettings(false)}
          onSubmit={submitSettings}
        />
      )}
    </AttendancePayrollLayout>
  )
}
