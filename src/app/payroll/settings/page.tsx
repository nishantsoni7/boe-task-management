'use client'

// Payroll Settings — the calculation parameters, editable by an admin.
//
// Access: /payroll is admin-only (PayrollGuard → resolveManagementAccess), and
// /api/payroll/settings refuses a non-admin on both verbs regardless. This page
// adds no access decision of its own; it renders a form.
//
// The form renders FROM SETTINGS_FIELDS rather than from hand-written JSX per
// input. A field added to the settings type therefore appears here, in its
// group, with its own range and help text, and cannot be silently left out —
// which is what would otherwise turn "central settings" back into a number
// buried in the engine.

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { colors } from '@/lib/tokens'
import { PayrollLayout } from '@/components/layout/PayrollLayout'
import { LoadingScreen, AlertBanner } from '@/components/ui/atoms'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import {
  SETTINGS_FIELDS,
  SETTINGS_GROUP_LABELS,
  SETTINGS_GROUP_ORDER,
  DAY_OF_WEEK_LABELS,
  parsePayrollSettings,
  minutesToTimeInput,
  timeInputToMinutes,
  type PayrollSettings,
  type SettingsValidationIssue,
} from '@/lib/payroll/settings'

type HistoryRow = {
  id: string
  created_at: string
  created_by_name: string | null
  note: string | null
}

/**
 * The form's working copy.
 *
 * Every field is held as a STRING while being edited. Numbers would force a
 * half-typed "1" to become the value 1 mid-keystroke, and an emptied box to
 * become 0 — which for the office start time is midnight and for the per-day
 * divisor is a division by zero. Strings are converted once, on save.
 */
type Draft = Record<string, string>

function draftFromSettings(s: PayrollSettings): Draft {
  const draft: Draft = {}
  for (const field of SETTINGS_FIELDS) {
    const value = s[field.key]
    draft[field.key] = field.kind === 'time' ? minutesToTimeInput(value) : String(value)
  }
  draft.paid_leave_tiers = JSON.stringify(s.paid_leave_tiers)
  return draft
}

/** The draft, converted back. Returns the issues rather than throwing. */
function settingsFromDraft(draft: Draft): ReturnType<typeof parsePayrollSettings> {
  const candidate: Record<string, unknown> = {}

  for (const field of SETTINGS_FIELDS) {
    const raw = (draft[field.key] ?? '').trim()
    if (field.kind === 'time') {
      const minutes = timeInputToMinutes(raw)
      // null rather than NaN: parsePayrollSettings reports "must be a number",
      // which is the true statement about a cleared time box.
      candidate[field.key] = minutes == null ? null : minutes
    } else {
      candidate[field.key] = raw === '' ? null : Number(raw)
    }
  }

  try {
    candidate.paid_leave_tiers = JSON.parse(draft.paid_leave_tiers ?? '[]')
  } catch {
    candidate.paid_leave_tiers = null
  }

  return parsePayrollSettings(candidate)
}

export default function PayrollSettingsPage() {
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [token,   setToken]   = useState('')
  const [loading, setLoading] = useState(true)
  const [saving,  setSaving]  = useState(false)

  const [draft,   setDraft]   = useState<Draft>({})
  const [saved,   setSaved]   = useState<Draft>({})
  const [issues,  setIssues]  = useState<SettingsValidationIssue[]>([])
  const [error,   setError]   = useState('')
  const [okMsg,   setOkMsg]   = useState('')
  const [note,    setNote]    = useState('')
  const [usingDefaults, setUsingDefaults] = useState(false)
  const [history, setHistory] = useState<HistoryRow[]>([])

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

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

      const res  = await fetch('/api/payroll/settings', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      const json = await res.json()
      if (res.ok) {
        const d = draftFromSettings(json.settings as PayrollSettings)
        setDraft(d)
        setSaved(d)
        setUsingDefaults(json.using_defaults === true)
        setHistory(json.history ?? [])
      } else {
        setError(json.error ?? 'Could not load payroll settings.')
      }
      setLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const dirty = useMemo(
    () => SETTINGS_FIELDS.some(f => draft[f.key] !== saved[f.key]),
    [draft, saved],
  )

  const issueFor = (key: string) => issues.find(i => i.key === key)?.message

  const set = (key: string, value: string) => {
    setDraft(d => ({ ...d, [key]: value }))
    setOkMsg('')
    // Clear this field's error as soon as it is touched; keep the others, so a
    // form with three problems does not appear to have one.
    setIssues(list => list.filter(i => i.key !== key))
  }

  const handleSave = async () => {
    setError('')
    setOkMsg('')

    // Validated with the SAME function the API uses, so the form cannot accept
    // something the server will reject, or refuse something it would allow.
    const parsed = settingsFromDraft(draft)
    if (!parsed.ok) {
      setIssues(parsed.issues)
      setError('Some values are not valid. Check the highlighted fields.')
      return
    }
    setIssues([])
    setSaving(true)

    const res  = await fetch('/api/payroll/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ settings: parsed.settings, note: note || null }),
    })
    const json = await res.json()
    setSaving(false)

    if (!res.ok) {
      setIssues(json.issues ?? [])
      setError(json.error ?? 'Could not save payroll settings.')
      return
    }

    const d = draftFromSettings(json.settings as PayrollSettings)
    setDraft(d)
    setSaved(d)
    setNote('')
    setUsingDefaults(false)
    setOkMsg('Payroll settings saved.')
  }

  const handleReset = () => {
    setDraft(saved)
    setIssues([])
    setError('')
    setOkMsg('')
  }

  if (loading || !profile) return <LoadingScreen />

  return (
    <PayrollLayout
      profile={profile}
      title="Payroll Settings"
      subtitle="The numbers every salary calculation uses"
      onSignOut={async () => { await supabase.auth.signOut(); router.push('/login') }}
    >
      <div style={{ maxWidth: 880, display: 'flex', flexDirection: 'column', gap: 20 }}>

        {/* The one thing an admin must understand before changing anything. */}
        <AlertBanner variant="amber">
          Changes apply to newly generated payroll and periods intentionally recalculated
          after unlocking. Existing generated payroll remains unchanged.
        </AlertBanner>

        {usingDefaults && (
          <AlertBanner variant="amber">
            No saved settings were found, so the built-in defaults are shown. Saving will
            record them as your settings.
          </AlertBanner>
        )}

        {error  && <AlertBanner variant="red">{error}</AlertBanner>}
        {okMsg  && <AlertBanner variant="green">{okMsg}</AlertBanner>}

        {SETTINGS_GROUP_ORDER.map(group => {
          const fields = SETTINGS_FIELDS.filter(f => f.group === group)
          if (fields.length === 0) return null
          return (
            <section
              key={group}
              style={{
                border: `1px solid ${colors.border}`,
                borderRadius: 10,
                padding: '16px 18px',
                background: colors.base,
              }}
            >
              <h2 style={{ fontSize: 14, fontWeight: 650, margin: '0 0 14px', color: colors.primary }}>
                {SETTINGS_GROUP_LABELS[group]}
              </h2>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
                  gap: 16,
                }}
              >
                {fields.map(field => {
                  const problem = issueFor(field.key)
                  return (
                    <label key={field.key} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                      <span style={{ fontSize: 12.5, fontWeight: 600, color: colors.primary }}>
                        {field.label}
                        {field.unit && field.kind === 'number' && (
                          <span style={{ fontWeight: 400, color: colors.tertiary }}> ({field.unit})</span>
                        )}
                      </span>

                      {field.kind === 'day_of_week' ? (
                        <select
                          value={draft[field.key] ?? ''}
                          onChange={e => set(field.key, e.target.value)}
                          style={inputStyle(!!problem)}
                        >
                          {DAY_OF_WEEK_LABELS.map((label, i) => (
                            <option key={label} value={String(i)}>{label}</option>
                          ))}
                        </select>
                      ) : (
                        <input
                          type={field.kind === 'time' ? 'time' : 'number'}
                          value={draft[field.key] ?? ''}
                          min={field.kind === 'number' ? field.min : undefined}
                          max={field.kind === 'number' ? field.max : undefined}
                          step={field.kind === 'number' ? field.step : undefined}
                          onChange={e => set(field.key, e.target.value)}
                          style={inputStyle(!!problem)}
                        />
                      )}

                      <span style={{ fontSize: 11.5, lineHeight: 1.45, color: colors.tertiary }}>
                        {field.help}
                      </span>

                      {problem && (
                        <span style={{ fontSize: 11.5, fontWeight: 600, color: colors.red }}>
                          {problem}
                        </span>
                      )}
                    </label>
                  )
                })}
              </div>

              {group === 'leave' && <PaidLeaveTiers draft={draft} issue={issueFor('paid_leave_tiers')} />}
            </section>
          )
        })}

        {/* Save */}
        <section
          style={{
            border: `1px solid ${colors.border}`,
            borderRadius: 10,
            padding: '16px 18px',
            background: colors.base,
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: colors.primary }}>
              Note <span style={{ fontWeight: 400, color: colors.tertiary }}>(optional)</span>
            </span>
            <input
              type="text"
              value={note}
              maxLength={500}
              placeholder="Why this changed — kept with the saved version"
              onChange={e => setNote(e.target.value)}
              style={inputStyle(false)}
            />
          </label>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button
              onClick={handleSave}
              disabled={saving || !dirty}
              style={{
                padding: '9px 18px',
                borderRadius: 8,
                border: 'none',
                fontSize: 13,
                fontWeight: 600,
                cursor: saving || !dirty ? 'not-allowed' : 'pointer',
                background: saving || !dirty ? colors.borderMed : colors.primary,
                color: '#fff',
              }}
            >
              {saving ? 'Saving…' : 'Save settings'}
            </button>

            <button
              onClick={handleReset}
              disabled={saving || !dirty}
              style={{
                padding: '9px 18px',
                borderRadius: 8,
                border: `1px solid ${colors.border}`,
                fontSize: 13,
                fontWeight: 600,
                cursor: saving || !dirty ? 'not-allowed' : 'pointer',
                background: 'transparent',
                color: colors.primary,
              }}
            >
              Discard changes
            </button>
          </div>
        </section>

        {history.length > 0 && (
          <section
            style={{
              border: `1px solid ${colors.border}`,
              borderRadius: 10,
              padding: '16px 18px',
              background: colors.base,
            }}
          >
            <h2 style={{ fontSize: 14, fontWeight: 650, margin: '0 0 10px', color: colors.primary }}>
              Change history
            </h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {history.map(h => (
                <div key={h.id} style={{ fontSize: 12.5, color: colors.tertiary, lineHeight: 1.5 }}>
                  <strong style={{ color: colors.primary }}>
                    {new Date(h.created_at).toLocaleString('en-IN')}
                  </strong>
                  {' — '}
                  {h.created_by_name ?? 'System'}
                  {h.note ? ` · ${h.note}` : ''}
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </PayrollLayout>
  )
}

function inputStyle(hasError: boolean): React.CSSProperties {
  return {
    padding: '8px 10px',
    borderRadius: 7,
    border: `1px solid ${hasError ? colors.red : colors.border}`,
    fontSize: 13,
    color: colors.primary,
    background: colors.base,
    width: '100%',
  }
}

/**
 * The paid-leave bands, read-only here.
 *
 * They are a list rather than a scalar, and a full editor for them is a
 * different piece of work from a form of numbers — it needs add, remove and
 * reorder, and the ordering rule (highest days-present first, last band at 0) is
 * load-bearing. Showing them keeps the page honest about what the settings
 * contain; editing them stays with the API until that editor exists.
 */
function PaidLeaveTiers({ draft, issue }: { draft: Draft; issue?: string }) {
  let tiers: Array<{ min_days_present: number; leave: number }> = []
  try {
    tiers = JSON.parse(draft.paid_leave_tiers ?? '[]')
  } catch {
    tiers = []
  }

  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6, color: colors.primary }}>
        Paid leave earned by attendance
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {tiers.map((t, i) => (
          <div key={i} style={{ fontSize: 12.5, color: colors.tertiary }}>
            {t.min_days_present}+ days present → {t.leave} day{t.leave === 1 ? '' : 's'} paid leave
          </div>
        ))}
      </div>
      {issue && (
        <div style={{ fontSize: 11.5, fontWeight: 600, color: colors.red, marginTop: 6 }}>
          {issue}
        </div>
      )}
    </div>
  )
}
