'use client'

// "BOE Credits Settings" — the six numbers, editable by an admin, in one
// section. Saving writes a NEW settings row; the previous ones stay as
// history, and nothing already recorded is touched.
//
// The form validates with parseBoeCreditSettings, the same function the API
// uses, so it cannot accept something the server will reject. It never
// submits twice: the button is disabled while a save is in flight and until
// something has actually changed.

import { useRef, useState } from 'react'
import { colors } from '@/lib/tokens'
import { parseBoeCreditSettings, sameBoeCreditSettings } from '@/lib/boeCredits/settings'
import type { BoeCreditSettings } from '@/lib/boeCredits/types'

const inputStyle: React.CSSProperties = {
  width: '100%', maxWidth: 140, padding: '8px 10px', borderRadius: 8, fontSize: 14, fontWeight: 600,
  border: `1px solid ${colors.borderSoft}`, background: colors.base, color: colors.primary,
  fontFamily: 'inherit', boxSizing: 'border-box', fontVariantNumeric: 'tabular-nums', minHeight: 40,
}

type FieldKey = keyof BoeCreditSettings

const FIELDS: { key: FieldKey; label: string; unit: string; hint: string; step: string; money?: boolean }[] = [
  // TWO REWARDS, AND THE HINTS SAY WHICH IS WHICH RATHER THAN LEAVING THE
  // LABELS TO IMPLY IT. The stored field is still review_reward_credits; the
  // label is what changed, because the label is the part a person reads and the
  // field name is the part the history is written under.
  { key: 'review_reward_credits',       label: 'Text Review Reward',           unit: 'credit(s)', hint: 'Credits one verified text review earns.', step: '1' },
  { key: 'image_review_reward_credits', label: 'Image Review Reward',          unit: 'credit(s)', hint: 'Credits one verified image review earns. Set on its own, not from the text reward.', step: '1' },
  { key: 'credit_value',                label: 'Value of 1 Credit',            unit: '',          hint: 'Rupees one credit adds to salary when applied to payroll.', step: '0.01', money: true },
  { key: 'half_day_redemption_credits', label: 'Half Day Redemption',          unit: 'credits',   hint: 'Credits that cover a chargeable Half Day.', step: '1' },
  { key: 'full_day_redemption_credits', label: 'Full Day / Absent Redemption', unit: 'credits',   hint: 'Credits that cover a chargeable Absent day. Set on its own, not from the half day.', step: '1' },
  { key: 'minimum_monthly_reviews',     label: 'Minimum Reviews Per Month',    unit: 'reviews',   hint: 'Verified reviews a month needs before its credits become spendable.', step: '1' },
]

function toDraft(s: BoeCreditSettings): Record<FieldKey, string> {
  return {
    review_reward_credits:       String(s.review_reward_credits),
    image_review_reward_credits: String(s.image_review_reward_credits),
    credit_value:                Number.isInteger(s.credit_value) ? String(s.credit_value) : s.credit_value.toFixed(2),
    half_day_redemption_credits: String(s.half_day_redemption_credits),
    full_day_redemption_credits: String(s.full_day_redemption_credits),
    minimum_monthly_reviews:     String(s.minimum_monthly_reviews),
  }
}

export function CreditSettingsForm({
  current, loading, updatedAt, onSubmit,
}: {
  current: BoeCreditSettings
  /** True while the page is still fetching the settings. */
  loading: boolean
  updatedAt?: string | null
  /** Resolves to null on success, or the error to show. */
  onSubmit: (input: { settings: BoeCreditSettings; note: string | null }) => Promise<string | null>
}) {
  const [draft,  setDraft]  = useState<Record<FieldKey, string>>(() => toDraft(current))
  const [note,   setNote]   = useState('')
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState('')
  const [saved,  setSaved]  = useState(false)
  const inFlight = useRef(false)

  // A fresh `current` (first load, or after a save) resets the draft: the
  // page keys this form by the settings' timestamp, so it remounts on it.

  const parsed = parseBoeCreditSettings(draft)
  const issueFor = (key: FieldKey) => parsed.ok ? null : parsed.issues.find(i => i.key === key)?.message ?? null
  const dirty = parsed.ok && !sameBoeCreditSettings(parsed.settings, current)

  const save = async () => {
    if (inFlight.current) return
    setError('')
    setSaved(false)
    if (!parsed.ok) { setError('Some values are not valid. Check the highlighted fields.'); return }
    if (!dirty) return
    inFlight.current = true
    setSaving(true)
    try {
      const failure = await onSubmit({ settings: parsed.settings, note: note.trim() || null })
      if (failure) { setError(failure); return }
      setNote('')
      setSaved(true)
    } finally {
      inFlight.current = false
      setSaving(false)
    }
  }

  return (
    <section
      aria-labelledby="credit-settings-heading"
      style={{ border: `1px solid ${colors.border}`, borderRadius: 12, background: colors.base, overflow: 'hidden' }}
    >
      <div style={{ padding: '12px 16px', borderBottom: `1px solid ${colors.border}`, display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'baseline' }}>
        <div id="credit-settings-heading" style={{ fontSize: 13.5, fontWeight: 700, color: colors.primary }}>BOE Credits Settings</div>
        {updatedAt && (
          <span style={{ fontSize: 11.5, color: colors.muted }}>
            Last changed {new Date(updatedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
          </span>
        )}
      </div>

      <div style={{ padding: '14px 16px 16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {loading ? (
          <div style={{ fontSize: 13, color: colors.muted }} aria-busy="true">Loading settings…</div>
        ) : (
          <>
            {error && (
              <div role="alert" style={{ fontSize: 12.5, color: '#B91C1C', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 8, padding: '8px 12px' }}>
                {error}
              </div>
            )}
            {saved && !error && (
              <div role="status" style={{ fontSize: 12.5, color: '#047857', background: 'rgba(5,150,105,0.09)', border: '1px solid rgba(5,150,105,0.3)', borderRadius: 8, padding: '8px 12px' }}>
                Settings saved. They apply to future reviews, redemptions and payroll applications.
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 250px), 1fr))', gap: 14 }}>
              {FIELDS.map(f => {
                const issue = issueFor(f.key)
                return (
                  <label key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
                    <span style={{ fontSize: 12.5, fontWeight: 600, color: '#3D4455' }}>{f.label}</span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {f.money && <span style={{ fontSize: 14, fontWeight: 600, color: colors.tertiary }}>₹</span>}
                      <input
                        type="number"
                        inputMode={f.money ? 'decimal' : 'numeric'}
                        min={f.money ? 0.01 : 1}
                        step={f.step}
                        value={draft[f.key]}
                        disabled={saving}
                        aria-invalid={issue != null}
                        onChange={e => { setDraft(d => ({ ...d, [f.key]: e.target.value })); setError(''); setSaved(false) }}
                        style={{ ...inputStyle, borderColor: issue ? '#DC2626' : colors.borderSoft }}
                      />
                      {f.unit && <span style={{ fontSize: 12.5, color: colors.tertiary }}>{f.unit}</span>}
                    </span>
                    <span style={{ fontSize: 11.5, color: issue ? '#C13030' : colors.muted, lineHeight: 1.45 }}>
                      {issue ?? f.hint}
                    </span>
                  </label>
                )
              })}
            </div>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: '#3D4455' }}>Note <span style={{ fontWeight: 400, color: colors.muted }}>(optional — why the settings changed)</span></span>
              <input
                type="text" maxLength={500}
                value={note}
                disabled={saving}
                onChange={e => setNote(e.target.value)}
                style={{ ...inputStyle, maxWidth: 520, fontWeight: 400 }}
              />
            </label>

            <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving || !dirty}
                className="boe-btn boe-btn-primary"
                style={{ padding: '8px 18px', fontSize: 13, minHeight: 40 }}
              >
                {saving ? 'Saving…' : 'Save Changes'}
              </button>
              <span style={{ fontSize: 12, color: colors.muted, lineHeight: 1.5, maxWidth: 560 }}>
                Changes apply to future transactions only. Existing credit history, attendance redemptions and
                payroll applications keep their original values.
              </span>
            </div>
          </>
        )}
      </div>
    </section>
  )
}
