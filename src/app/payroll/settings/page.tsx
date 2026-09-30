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
import { AttendancePayrollLayout } from '@/components/layout/AttendancePayrollLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { Badge, Notice, StateBlock, ui } from '@/components/attendancePayroll/ui'
import styles from './settings.module.css'
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
  const [loaded,  setLoaded]  = useState(false)
  const [loadError, setLoadError] = useState('')
  const [retrying, setRetrying] = useState(false)

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  // The same request the page always made, kept in a function so a failed load
  // can be tried again without leaving the page.
  const loadSettings = async (accessToken: string) => {
    setLoadError('')
    try {
      const res  = await fetch('/api/payroll/settings', {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      const json = await res.json()
      if (res.ok) {
        const d = draftFromSettings(json.settings as PayrollSettings)
        setDraft(d)
        setSaved(d)
        setUsingDefaults(json.using_defaults === true)
        setHistory(json.history ?? [])
        setLoaded(true)
      } else {
        setLoadError(json.error ?? 'Could not load payroll settings.')
      }
    } catch {
      setLoadError('Could not reach the server. Check your connection and try again.')
    }
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

      await loadSettings(session.access_token)
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

  const retryLoad = async () => {
    setRetrying(true)
    await loadSettings(token)
    setRetrying(false)
  }

  if (loading || !profile) return <LoadingScreen />

  return (
    <AttendancePayrollLayout
      profile={profile}
      title="Payroll rules"
      subtitle="The numbers every salary calculation uses. Changes apply to new payroll only."
      onSignOut={async () => { await supabase.auth.signOut(); router.push('/login') }}
    >
      {!loaded ? (
        <StateBlock
          kind="error"
          title="Could not load payroll rules"
          action={
            <button type="button" className={`boe-btn boe-btn-ghost ${ui.btnSm}`} onClick={() => void retryLoad()} disabled={retrying}>
              {retrying ? 'Trying…' : 'Try again'}
            </button>
          }
        >
          {loadError}
        </StateBlock>
      ) : (
      <div className={styles.page}>

        {/* The one thing an admin must understand before changing anything. */}
        <Notice kind="warning">
          Changes apply to newly generated payroll and periods intentionally recalculated
          after unlocking. Existing generated payroll remains unchanged.
        </Notice>

        {usingDefaults && (
          <Notice kind="warning">
            No saved settings were found, so the built-in defaults are shown. Saving will
            record them as your settings.
          </Notice>
        )}

        {error && <Notice kind="error">{error}</Notice>}

        {SETTINGS_GROUP_ORDER.map(group => {
          const fields = SETTINGS_FIELDS.filter(f => f.group === group)
          if (fields.length === 0) return null
          return (
            <section key={group} className={ui.surface} aria-labelledby={`grp-${group}`}>
              <div className={ui.surfaceHead}>
                <h2 className={ui.surfaceTitle} id={`grp-${group}`}>{SETTINGS_GROUP_LABELS[group]}</h2>
              </div>
              <div className={ui.surfaceBody}>
                <div className={styles.groupFields}>
                  {fields.map(field => {
                    const problem = issueFor(field.key)
                    return (
                      <label key={field.key} className={ui.field}>
                        <span className={ui.label}>
                          {field.label}
                          {field.unit && field.kind === 'number' && (
                            <span className={ui.optional}> ({field.unit})</span>
                          )}
                          {/* A stored setting that no calculation reads. Labelled
                              rather than hidden: it is pinned inside every period
                              snapshot already written, so an admin comparing a
                              historical period against this page must still find
                              it — but must not believe editing it does anything. */}
                          {field.inactive && (
                            <span className={styles.inactiveTag}><Badge tone="neutral">{field.inactive.badge}</Badge></span>
                          )}
                        </span>

                        {field.kind === 'day_of_week' ? (
                          <select
                            className={ui.input}
                            value={draft[field.key] ?? ''}
                            onChange={e => set(field.key, e.target.value)}
                            disabled={!!field.inactive}
                            aria-invalid={problem ? true : undefined}
                          >
                            {DAY_OF_WEEK_LABELS.map((label, i) => (
                              <option key={label} value={String(i)}>{label}</option>
                            ))}
                          </select>
                        ) : (
                          <input
                            className={`${ui.input}${field.inactive ? ` ${styles.readonly}` : ''}`}
                            type={field.kind === 'time' ? 'time' : 'number'}
                            value={draft[field.key] ?? ''}
                            min={field.kind === 'number' ? field.min : undefined}
                            max={field.kind === 'number' ? field.max : undefined}
                            step={field.kind === 'number' ? field.step : undefined}
                            onChange={e => set(field.key, e.target.value)}
                            readOnly={!!field.inactive}
                            aria-describedby={field.inactive ? `${field.key}-inactive` : undefined}
                            aria-invalid={problem ? true : undefined}
                          />
                        )}

                        <span
                          id={field.inactive ? `${field.key}-inactive` : undefined}
                          className={styles.help}
                        >
                          {field.help}
                        </span>

                        {problem && <span className={styles.problem}>{problem}</span>}
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
              </div>
            </section>
          )
        })}

        {/* Note kept with the saved version */}
        <section className={ui.surface}>
          <div className={ui.surfaceBody}>
            <label className={ui.field}>
              <span className={ui.label}>
                Note <span className={ui.optional}>(optional)</span>
              </span>
              <input
                className={ui.input}
                type="text"
                value={note}
                maxLength={500}
                placeholder="Why this changed — kept with the saved version"
                onChange={e => setNote(e.target.value)}
              />
            </label>
          </div>
        </section>

        {history.length > 0 && (
          <section className={ui.surface}>
            <div className={ui.surfaceHead}>
              <h2 className={ui.surfaceTitle}>Change history</h2>
            </div>
            <div className={ui.surfaceBody}>
              <ul className={styles.historyList}>
                {history.map(h => (
                  <li key={h.id}>
                    <strong>{new Date(h.created_at).toLocaleString('en-IN')}</strong>
                    {' — '}
                    {h.created_by_name ?? 'System'}
                    {h.note ? ` · ${h.note}` : ''}
                  </li>
                ))}
              </ul>
            </div>
          </section>
        )}

        {/* Save: always at hand, and says what happened. */}
        <div className={styles.saveBar}>
          <div className={styles.saveStatus} role="status" aria-live="polite">
            {error ? (
              <span className={styles.problem}>Not saved. {error}</span>
            ) : okMsg && !dirty ? (
              <span style={{ color: '#065F46', fontWeight: 600 }}>{okMsg}</span>
            ) : dirty ? (
              <span className={styles.saveStatusDirty}>You have unsaved changes.</span>
            ) : (
              <span>No changes to save.</span>
            )}
          </div>
          <div className={styles.saveActions}>
            <button
              type="button"
              onClick={handleReset}
              disabled={saving || !dirty}
              className={`boe-btn boe-btn-ghost ${ui.btn}`}
            >
              Discard changes
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !dirty}
              className={`boe-btn boe-btn-primary ${ui.btn}`}
            >
              {saving ? 'Saving…' : 'Save settings'}
            </button>
          </div>
        </div>
      </div>
      )}
    </AttendancePayrollLayout>
  )
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
    <div className={styles.tiers}>
      <h3 className={styles.tiersTitle}>Paid leave earned by attendance</h3>

      {/* Plain language, next to the editor rather than in a help page. */}
      <p className={styles.tiersHelp}>
        Each band says: an employee present at least this many days in the month earns
        this much paid leave. Payroll checks the bands from the highest days-present
        downwards and uses the <strong>first one the employee reaches</strong>, so the
        band with the largest threshold wins. The last band must start at 0 days so
        everybody falls into one. More days present can never earn less leave.
      </p>

      <div className={styles.bands}>
        {ordered.map((tier, i) => (
          <div key={i} className={styles.band}>
            <span className={styles.bandNo} title="The order payroll checks the bands in">
              {i + 1}
            </span>

            <label className={ui.field}>
              <span className={ui.label}>Days present (at least)</span>
              <input
                className={ui.input}
                type="number"
                min={0}
                max={31}
                step={1}
                value={String(tier.min_days_present)}
                onChange={e => update(i, { min_days_present: e.target.value === '' ? NaN : Number(e.target.value) })}
                aria-label={`Band ${i + 1} days present`}
              />
            </label>

            <label className={ui.field}>
              <span className={ui.label}>Paid leave earned (days)</span>
              <input
                className={ui.input}
                type="number"
                min={0}
                max={31}
                step={0.5}
                value={String(tier.leave)}
                onChange={e => update(i, { leave: e.target.value === '' ? NaN : Number(e.target.value) })}
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
              className={`boe-btn boe-btn-ghost ${ui.btnSm}${canRemoveBand(ordered) ? ` ${styles.danger}` : ''}`}
            >
              Remove
            </button>
          </div>
        ))}
      </div>

      <div className={styles.tiersFoot}>
        <button
          type="button"
          onClick={add}
          disabled={atLimit}
          className={`boe-btn boe-btn-ghost ${ui.btnSm}`}
        >
          Add band
        </button>
        <span className={ui.hint}>
          {ordered.length} of {MAX_PAID_LEAVE_BANDS}
        </span>
      </div>

      {/* Every problem, not just the first — the bands can carry several at once. */}
      {issues.length > 0 && (
        <ul className={styles.tierIssues}>
          {issues.map((message, i) => (
            <li key={i}>{message}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
