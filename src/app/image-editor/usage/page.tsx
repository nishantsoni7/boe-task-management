'use client'

// Picture credits: the founders' tracking page (administrators only; the API refuses anyone else).
//
// Answers four questions: how much is left in fal, what is being spent each day, who is using the most, and how
// many pictures are being made. Beneath that, the switches: pause, limits on/off, the team pool, the daily cap,
// and each person's monthly credits. Limits ship OFF, so everyone keeps working while real numbers build up here.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import { profileQueryOptions } from '@/hooks/queries/useProfile'
import type { UserProfile } from '@/lib/types'
import { LoadingScreen } from '@/components/ui/atoms'
import { ImageEditorLayout } from '@/components/layout/ImageEditorLayout'
import { isAdminRole } from '@/lib/permissions/moduleVisibility'
import { colors } from '@/lib/tokens'
import { formatINR } from '@/lib/currency'
import { TOOL_LABEL, type CreditTool } from '@/lib/imageCredits/costs'
import { daysOfBalanceLeft, rupees, type CreditReport, type FalBalance } from '@/lib/imageCredits/report'

type Settings = { enabled: boolean; enforce: boolean; monthly_pool: number; daily_cap: number; inr_per_usd: number }
type Payload = {
  report: CreditReport
  settings: Settings
  allowances: { user_id: string; monthly_credits: number }[]
  names: Record<string, string>
  staff: { id: string; name: string }[]
  balance: FalBalance
}

const th: React.CSSProperties = { textAlign: 'left', fontSize: 11, fontWeight: 600, color: colors.secondary, padding: '6px 8px', whiteSpace: 'nowrap' }
const td: React.CSSProperties = { fontSize: 13, padding: '7px 8px', borderTop: '1px solid var(--boe-border)', whiteSpace: 'nowrap' }
const dayLabel = (day: string) => new Date(`${day}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="boe-card" style={{ padding: 14, flex: '1 1 190px' }}>
      <div style={{ fontSize: 11, color: colors.secondary, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: colors.primary, marginTop: 2 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: colors.secondary, marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr>{head.map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

export default function ImageCreditsUsagePage() {
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const queryClient = useQueryClient()
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({ monthlyPool: '', dailyCap: '', inrPerUsd: '' })
  const [newPerson, setNewPerson] = useState({ userId: '', credits: '' })
  const [edits, setEdits] = useState<Record<string, string>>({})

  const call = useCallback(async (path: string, init?: RequestInit) => {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) { router.push('/login'); return null }
    return fetch(path, { ...init, cache: 'no-store', headers: { ...init?.headers, Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' } })
  }, [supabase, router])

  const load = useCallback(async () => {
    const res = await call('/api/image-credits/report')
    if (!res) return
    const json = await res.json().catch(() => null) as (Payload & { error?: string }) | null
    if (!res.ok || !json?.report) { setError(json?.error ?? 'The numbers could not be loaded.'); return }
    setError(null); setData(json)
    setForm({ monthlyPool: String(json.settings.monthly_pool), dailyCap: String(json.settings.daily_cap), inrPerUsd: String(json.settings.inr_per_usd) })
    setEdits({})
  }, [call])

  useEffect(() => {
    let active = true
    void (async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }
      const p = await queryClient.ensureQueryData(profileQueryOptions(queryClient, session.user.id))
      if (!active) return
      if (!p) { router.push('/login'); return }
      setProfile(p as UserProfile)
      setAuthLoading(false)
      if (isAdminRole((p as UserProfile).role)) void load()
    })()
    return () => { active = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const send = async (path: string, body: unknown) => {
    setSaving(true); setError(null)
    const res = await call(path, { method: 'POST', body: JSON.stringify(body) })
    setSaving(false)
    if (!res) return
    if (!res.ok) { setError(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? 'That could not be saved.'); return }
    await load()
  }

  if (authLoading) return <LoadingScreen message="Loading picture credits..." />

  const signOut = async () => { await supabase.auth.signOut(); router.push('/login') }
  const admin = isAdminRole(profile?.role)

  return (
    <ImageEditorLayout profile={profile} title="Picture credits" subtitle="What is left in fal, what is spent, and who is using it" onSignOut={signOut}>
      <div style={{ maxWidth: 1040 }}>
        {!admin && <div className="boe-alert-amber"><span style={{ fontSize: 13 }}>Only an administrator can open this page.</span></div>}
        {error && <div className="boe-alert-red" style={{ marginBottom: 14 }}><span style={{ fontSize: 13, color: '#B42332' }}>{error}</span></div>}
        {admin && data && <Body data={data} form={form} setForm={setForm} newPerson={newPerson} setNewPerson={setNewPerson}
          edits={edits} setEdits={setEdits} saving={saving} send={send} />}
      </div>
    </ImageEditorLayout>
  )
}

function Body({ data, form, setForm, newPerson, setNewPerson, edits, setEdits, saving, send }: {
  data: Payload
  form: { monthlyPool: string; dailyCap: string; inrPerUsd: string }
  setForm: (f: { monthlyPool: string; dailyCap: string; inrPerUsd: string }) => void
  newPerson: { userId: string; credits: string }
  setNewPerson: (p: { userId: string; credits: string }) => void
  edits: Record<string, string>
  setEdits: (e: Record<string, string>) => void
  saving: boolean
  send: (path: string, body: unknown) => Promise<void>
}) {
  const { report, settings, allowances, names, staff, balance } = data
  const rate = settings.inr_per_usd
  const name = (id: string | null) => (id ? names[id] ?? 'Former member' : 'Former member')
  const inr = (usd: number) => formatINR(rupees(usd, rate))
  const monthTotal = report.month.credits
  const days = balance.connected && balance.usd !== null ? daysOfBalanceLeft(balance.usd, report.usd_prev7) : null
  const top = report.people[0]
  const allowanceOf = new Map(allowances.map(a => [a.user_id, a.monthly_credits]))
  const used = new Map(report.people.map(p => [p.user_id ?? '', p.credits]))
  const withoutAllowance = staff.filter(s => !allowanceOf.has(s.id))
  const toggle = (key: 'enabled' | 'enforce') => send('/api/image-credits/settings', { [key]: !settings[key] })

  return (
    <>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
        <Tile label="Left in fal"
          value={balance.connected ? (balance.usd !== null ? `${inr(balance.usd)}` : 'Could not read') : 'Not connected'}
          sub={balance.connected ? (balance.usd !== null ? `$${balance.usd.toFixed(2)}` : balance.error) : 'Add a fal BILLING key as FAL_BILLING_KEY to show it here'} />
        <Tile label="Spent today" value={inr(report.today.usd)} sub={`${report.today.presses} pictures · ${report.today.credits} credits`} />
        <Tile label="Spent this month" value={inr(report.month.usd)} sub={`${report.month.presses} pictures · ${monthTotal} credits`} />
        <Tile label="Balance lasts about" value={days === null ? 'Not enough data' : `${days} days`} sub="at the pace of the last 7 days" />
      </div>

      <p style={{ fontSize: 13, color: colors.secondary, margin: '0 0 14px' }}>
        {top ? <>Most this month: <strong style={{ color: colors.primary }}>{name(top.user_id)}</strong> with {top.presses} pictures ({inr(top.usd)}).</>
          : 'No pictures have been made this month yet.'}
        {' '}Amounts are what fal charges us, estimated at ₹{rate} to the dollar; compare with fal’s own bill now and then.
      </p>

      <div className="boe-card" style={{ padding: 14, marginBottom: 14 }}>
        <h3 style={{ margin: '0 0 6px', fontSize: 14 }}>Last 14 days</h3>
        {report.daily.length === 0 ? <p style={{ fontSize: 13, color: colors.secondary }}>Nothing recorded yet.</p> : (
          <Table head={['Day', 'Pictures', 'Credits', 'Spent', 'Most by']}>
            {report.daily.map(d => (
              <tr key={d.day}>
                <td style={td}>{dayLabel(d.day)}</td><td style={td}>{d.presses}</td><td style={td}>{d.credits}</td>
                <td style={td}>{inr(d.usd)}</td><td style={td}>{d.top_user ? `${name(d.top_user)} (${d.top_presses})` : '–'}</td>
              </tr>
            ))}
          </Table>
        )}
      </div>

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 14 }}>
        <div className="boe-card" style={{ padding: 14, flex: '2 1 420px' }}>
          <h3 style={{ margin: '0 0 6px', fontSize: 14 }}>This month, by person</h3>
          {report.people.length === 0 ? <p style={{ fontSize: 13, color: colors.secondary }}>Nothing recorded yet.</p> : (
            <Table head={['Person', 'Pictures', 'Credits', 'Spent', 'Share']}>
              {report.people.map(p => (
                <tr key={p.user_id ?? 'former'}>
                  <td style={td}>{name(p.user_id)}</td><td style={td}>{p.presses}</td><td style={td}>{p.credits}</td>
                  <td style={td}>{inr(p.usd)}</td><td style={td}>{monthTotal > 0 ? `${Math.round((p.credits / monthTotal) * 100)}%` : '–'}</td>
                </tr>
              ))}
            </Table>
          )}
        </div>
        <div className="boe-card" style={{ padding: 14, flex: '1 1 260px' }}>
          <h3 style={{ margin: '0 0 6px', fontSize: 14 }}>This month, by tool</h3>
          {report.tools.length === 0 ? <p style={{ fontSize: 13, color: colors.secondary }}>Nothing recorded yet.</p> : (
            <Table head={['Tool', 'Pictures', 'Spent']}>
              {report.tools.map(t => (
                <tr key={t.tool}><td style={td}>{TOOL_LABEL[t.tool as CreditTool] ?? t.tool}</td><td style={td}>{t.presses}</td><td style={td}>{inr(t.usd)}</td></tr>
              ))}
            </Table>
          )}
        </div>
      </div>

      <div className="boe-card" style={{ padding: 14, marginBottom: 14 }}>
        <h3 style={{ margin: '0 0 8px', fontSize: 14 }}>Switches</h3>
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, marginBottom: 8 }}>
          <input type="checkbox" checked={settings.enabled} disabled={saving} onChange={() => void toggle('enabled')} />
          <span><strong>Picture making is on.</strong> Switch it off to stop every picture button for everyone at once.</span>
        </label>
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, marginBottom: 10 }}>
          <input type="checkbox" checked={settings.enforce} disabled={saving} onChange={() => void toggle('enforce')} />
          <span><strong>Limits are on.</strong> Off: everyone who can use the buttons keeps working and every press is only recorded.
            On: only people with credits below can make pictures, within their monthly credits, the daily cap and the team pool.</span>
        </label>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          {([['monthlyPool', 'Team credits each month'], ['dailyCap', 'Daily cap per person (credits)'], ['inrPerUsd', '₹ per dollar (display only)']] as const).map(([key, label]) => (
            <label key={key} style={{ fontSize: 12, color: colors.secondary }}>{label}<br />
              <input className="boe-input" style={{ width: 150 }} inputMode="decimal" value={form[key]} onChange={e => setForm({ ...form, [key]: e.target.value })} />
            </label>
          ))}
          <button className="boe-btn boe-btn-primary" disabled={saving}
            onClick={() => void send('/api/image-credits/settings', { monthlyPool: Number(form.monthlyPool), dailyCap: Number(form.dailyCap), inrPerUsd: Number(form.inrPerUsd) })}>Save numbers</button>
        </div>
        <p style={{ fontSize: 12, color: colors.secondary, margin: '8px 0 0' }}>
          1 credit is about ₹4. Studio Image costs 1 credit a photo; Clean up, Change it and Customize image cost 2. Month and day follow India time.
        </p>
      </div>

      <div className="boe-card" style={{ padding: 14 }}>
        <h3 style={{ margin: '0 0 6px', fontSize: 14 }}>Credits for each person (used only while limits are on)</h3>
        {allowances.length > 0 && (
          <Table head={['Person', 'Credits a month', 'Used this month', '']}>
            {allowances.map(a => (
              <tr key={a.user_id}>
                <td style={td}>{name(a.user_id)}</td>
                <td style={td}>
                  <input className="boe-input" aria-label={`Credits a month for ${name(a.user_id)}`} style={{ width: 90 }} inputMode="numeric"
                    value={edits[a.user_id] ?? String(a.monthly_credits)} onChange={e => setEdits({ ...edits, [a.user_id]: e.target.value })} />
                </td>
                <td style={td}>{used.get(a.user_id) ?? 0}</td>
                <td style={td}>
                  <button className="boe-btn" disabled={saving} onClick={() => void send('/api/image-credits/allowance', { userId: a.user_id, monthlyCredits: Number(edits[a.user_id] ?? a.monthly_credits) })}>Save</button>{' '}
                  <button className="boe-btn" disabled={saving} onClick={() => void send('/api/image-credits/allowance', { userId: a.user_id, monthlyCredits: null })}>Remove</button>
                </td>
              </tr>
            ))}
          </Table>
        )}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 10 }}>
          <label style={{ fontSize: 12, color: colors.secondary }}>Add a person<br />
            <select className="boe-input" value={newPerson.userId} onChange={e => setNewPerson({ ...newPerson, userId: e.target.value })}>
              <option value="">Choose…</option>
              {withoutAllowance.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label style={{ fontSize: 12, color: colors.secondary }}>Credits a month<br />
            <input className="boe-input" style={{ width: 110 }} inputMode="numeric" value={newPerson.credits} onChange={e => setNewPerson({ ...newPerson, credits: e.target.value })} />
          </label>
          <button className="boe-btn boe-btn-primary" disabled={saving || !newPerson.userId || newPerson.credits.trim() === ''}
            onClick={() => { void send('/api/image-credits/allowance', { userId: newPerson.userId, monthlyCredits: Number(newPerson.credits) }); setNewPerson({ userId: '', credits: '' }) }}>Add</button>
        </div>
      </div>
    </>
  )
}
