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
import { AttendancePayrollLayout } from '@/components/layout/AttendancePayrollLayout'
import { LoadingScreen, AlertBanner } from '@/components/ui/atoms'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import {
  SETTINGS_FIELDS,
  MAX_PAID_LEAVE_BANDS,
  SETTINGS_GROUP_LABELS,
  SETTINGS_GROUP_ORDER,
  DAY_OF_WEEK_LABELS,
  parsePayrollSettings,
  minutesToTimeInput,
  timeInputToMinutes,
  type PayrollSettings,
  type SettingsValidationIssue,
} from '@/lib/payroll/settings'
import {
  orderBands,
  addBand,
  updateBand,
  removeBand,
  canAddBand,
  canRemoveBand,
} from '@/lib/payroll/paidLeaveBands'

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

  // The paid-leave bands are compared too. Leaving them out meant an admin who
  // only changed a band found Save still disabled, with nothing on screen
  // explaining why — the form did not consider itself edited.
  const dirty = useMemo(
    () =>
      SETTINGS_FIELDS.some(f => draft[f.key] !== saved[f.key]) ||
      draft.paid_leave_tiers !== saved.paid_leave_tiers,
    [draft, saved],
  )

  const issueFor = (key: string) => issues.find(i => i.key === key)?.message

  /**
   * Every problem on a key, not just the first.
   *
   * The bands are one key that can carry several distinct faults at once — a
   * duplicate threshold and a non-monotonic allowance, say. Showing one and
   * hiding the rest means an admin fixes a value, saves, and is told about the
   * next one, which reads like the form is inventing objections.
   */
  const issuesFor = (key: string) => issues.filter(i => i.key === key).map(i => i.message)

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
    <AttendancePayrollLayout
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

              {group === 'leave' && (
                <PaidLeaveTiers
                  draft={draft}
                  issues={issuesFor('paid_leave_tiers')}
                  onChange={next => set('paid_leave_tiers', JSON.stringify(next))}
                />
              )}
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
    </AttendancePayrollLayout>
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

type DraftTier = { min_days_present: number; leave: number }

function parseTiers(draft: Draft): DraftTier[] {
  try {
    const parsed = JSON.parse(draft.paid_leave_tiers ?? '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/**
 * The paid-leave bands — add, edit, remove.
 *
 * WHY THERE ARE NO REORDER CONTROLS
 * ---------------------------------
 * The engine reads the bands top-down and awards the FIRST one an employee
 * reaches (computePaidLeaveEntitlement in engine.ts), so order is genuinely part
 * of the calculation — but it is not an independent property an admin can set.
 * It is entirely determined by the days-present threshold, and
 * parsePayrollSettings normalises the list by sorting on exactly that.
 *
 * Drag handles would therefore offer a choice that does not exist: any order the
 * admin arranged would be silently re-sorted on save, and an arrangement that
 * disagreed with the thresholds would simply be overwritten. So the rows sort
 * themselves as the thresholds change, and the priority the engine will actually
 * use is NUMBERED on screen instead. Nothing is hidden — the ordering is shown,
 * it just is not pretended to be editable separately from the number that
 * decides it.
 */
function PaidLeaveTiers({
  draft,
  issues,
  onChange,
}: {
  draft: Draft
  issues: string[]
  onChange: (next: DraftTier[]) => void
}) {
  const tiers = parseTiers(draft)

  // Displayed in engine order — highest threshold first, which is the order the
  // allowance is actually looked up in. Every operation goes through the shared
  // helpers in ../../lib/payroll/paidLeaveBands, so what this form does is the
  // same thing the tests assert rather than a second implementation of it.
  const ordered = orderBands(tiers)

  const update = (index: number, patch: Partial<DraftTier>) =>
    onChange(updateBand(ordered, index, patch))

  const remove = (index: number) => onChange(removeBand(ordered, index))

  const add = () => onChange(addBand(ordered))

  const atLimit = !canAddBand(ordered)

  return (
    <div style={{ marginTop: 18, borderTop: `1px solid ${colors.border}`, paddingTop: 14 }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 4, color: colors.primary }}>
        Paid leave earned by attendance
      </div>

      {/* Plain language, next to the editor rather than in a help page. */}
      <p style={{ fontSize: 11.5, lineHeight: 1.5, color: colors.tertiary, margin: '0 0 10px' }}>
        Each band says: an employee present at least this many days in the month earns
        this much paid leave. Payroll checks the bands from the highest days-present
        downwards and uses the <strong>first one the employee reaches</strong>, so the
        band with the largest threshold wins. The last band must start at 0 days so
        everybody falls into one. More days present can never earn less leave.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {ordered.map((tier, i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'flex-end',
              gap: 8,
              padding: '8px 10px',
              border: `1px solid ${colors.border}`,
              borderRadius: 8,
              background: colors.raised,
            }}
          >
            <span
              title="The order payroll checks the bands in"
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: colors.tertiary,
                minWidth: 18,
                paddingBottom: 8,
              }}
            >
              {i + 1}
            </span>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 130px', minWidth: 120 }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: colors.secondary }}>
                Days present (at least)
              </span>
              <input
                type="number"
                min={0}
                max={31}
                step={1}
                value={String(tier.min_days_present)}
                onChange={e => update(i, { min_days_present: e.target.value === '' ? NaN : Number(e.target.value) })}
                style={inputStyle(false)}
                aria-label={`Band ${i + 1} days present`}
              />
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 130px', minWidth: 120 }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: colors.secondary }}>
                Paid leave earned (days)
              </span>
              <input
                type="number"
                min={0}
                max={31}
                step={0.5}
                value={String(tier.leave)}
                onChange={e => update(i, { leave: e.target.value === '' ? NaN : Number(e.target.value) })}
                style={inputStyle(false)}
                aria-label={`Band ${i + 1} leave earned`}
              />
            </label>

            <button
              type="button"
              onClick={() => remove(i)}
              disabled={!canRemoveBand(ordered)}
              title={
                !canRemoveBand(ordered)
                  ? 'At least one band is required — payroll cannot work out an allowance without one.'
                  : 'Remove this band'
              }
              aria-label={`Remove band ${i + 1}`}
              style={{
                padding: '8px 12px',
                borderRadius: 7,
                border: `1px solid ${colors.border}`,
                background: 'transparent',
                fontSize: 12,
                fontWeight: 600,
                color: canRemoveBand(ordered) ? colors.red : colors.muted,
                cursor: canRemoveBand(ordered) ? 'pointer' : 'not-allowed',
              }}
            >
              Remove
            </button>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 10 }}>
        <button
          type="button"
          onClick={add}
          disabled={atLimit}
          style={{
            padding: '7px 13px',
            borderRadius: 7,
            border: `1px solid ${colors.border}`,
            background: 'transparent',
            fontSize: 12.5,
            fontWeight: 600,
            color: atLimit ? colors.muted : colors.primary,
            cursor: atLimit ? 'not-allowed' : 'pointer',
          }}
        >
          Add band
        </button>
        <span style={{ fontSize: 11.5, color: colors.tertiary }}>
          {ordered.length} of {MAX_PAID_LEAVE_BANDS}
        </span>
      </div>

      {/* Every problem, not just the first — the bands can carry several at once. */}
      {issues.length > 0 && (
        <ul style={{ margin: '10px 0 0', paddingLeft: 18 }}>
          {issues.map((message, i) => (
            <li key={i} style={{ fontSize: 11.5, fontWeight: 600, color: colors.red, lineHeight: 1.5 }}>
              {message}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
