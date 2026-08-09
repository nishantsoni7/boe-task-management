// Reading and writing payroll settings, and pinning them to a period.
//
// The engine is pure and ./settings is pure. This is the only module that knows
// payroll settings live in a database, and it is deliberately small: two reads,
// one write, and the snapshot rule.
//
// THE SNAPSHOT RULE, IN ONE PLACE
// -------------------------------
// Which settings a payroll calculation uses is not a preference, it is a
// correctness property, and getting it wrong is invisible until an employee
// queries a payslip. So the decision is made by ONE function —
// settingsForPeriod — and generation, regeneration and Monthly Review all call
// it rather than each deciding for itself.
//
//   period has a snapshot        → the snapshot, always. A generated or locked
//                                  month is a record of what was paid, and a
//                                  later settings change must not restate it.
//   period has none, ungenerated → the active settings. Nothing has been
//                                  calculated yet, so there is nothing to
//                                  preserve.
//   period has none, generated   → the documented legacy constants. It ran
//                                  before settings existed; today's settings
//                                  were never what produced those figures.
//
// The third case is the one worth stating aloud. Falling back to the active
// settings there would look reasonable and would silently rewrite the
// explanation of every historical payslip the first time an admin edited a rule.

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  DEFAULT_PAYROLL_SETTINGS,
  LEGACY_PAYROLL_SETTINGS,
  parsePayrollSettings,
  resolveSnapshotSettings,
  type PayrollSettings,
} from './settings'

// Callers pass a service-role client in; we accept any schema parameterisation.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Svc = SupabaseClient<any, any, any>

// ─── The active settings ──────────────────────────────────────────────────────

export type ActiveSettings = {
  settings: PayrollSettings
  /** The settings row the values came from, or null when the table is empty. */
  id: string | null
  created_at: string | null
  created_by: string | null
  /**
   * True when the row could not be read or did not parse and the defaults were
   * used instead. Surfaced so the settings page can say so rather than quietly
   * presenting defaults as if an admin had chosen them.
   */
  fell_back: boolean
}

/**
 * The settings in force right now — the newest row in the append-only table.
 *
 * Never throws and never returns null. A payroll run must not fail because the
 * settings table could not be read; it falls back to the defaults, which are the
 * constants the engine used before settings existed, and reports that it did.
 */
export async function fetchActiveSettings(svc: Svc): Promise<ActiveSettings> {
  const fallback: ActiveSettings = {
    settings: DEFAULT_PAYROLL_SETTINGS,
    id: null,
    created_at: null,
    created_by: null,
    fell_back: true,
  }

  const { data, error } = await svc
    .from('payroll_settings')
    .select('id, settings, created_at, created_by')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error || !data) return fallback

  const row = data as { id: string; settings: unknown; created_at: string; created_by: string | null }
  const parsed = parsePayrollSettings(row.settings)
  if (!parsed.ok) {
    // A stored row that no longer parses is a real problem, but not one that
    // should stop payroll. Log it and use the defaults.
    console.error('[payroll/settings] active settings row did not parse:', parsed.issues)
    return { ...fallback, id: row.id, created_at: row.created_at, created_by: row.created_by }
  }

  return {
    settings: parsed.settings,
    id: row.id,
    created_at: row.created_at,
    created_by: row.created_by,
    fell_back: false,
  }
}

/**
 * Save a new settings row.
 *
 * An INSERT, never an UPDATE — the table is append-only and a trigger enforces
 * it. `createdBy` is the admin who saved, which together with created_at IS the
 * audit trail; there is no separate audit table to keep in step.
 *
 * The caller is responsible for having validated `settings` through
 * parsePayrollSettings. It is re-validated here anyway, because this is the last
 * point before the value becomes the rule every future payroll runs on.
 */
export async function saveSettings(
  svc: Svc,
  settings: PayrollSettings,
  createdBy: string,
  note?: string | null,
): Promise<{ id: string; created_at: string }> {
  const parsed = parsePayrollSettings(settings)
  if (!parsed.ok) {
    throw new Error(`saveSettings: refusing to store invalid settings — ${JSON.stringify(parsed.issues)}`)
  }

  const { data, error } = await svc
    .from('payroll_settings')
    .insert({
      settings: parsed.settings,
      created_by: createdBy,
      note: note ?? null,
    })
    .select('id, created_at')
    .single()

  if (error || !data) throw new Error(`saveSettings: ${error?.message ?? 'insert failed'}`)
  return data as { id: string; created_at: string }
}

/** Every settings row, newest first — the audit trail. */
export type SettingsHistoryRow = {
  id: string
  created_at: string
  created_by: string | null
  note: string | null
}

export async function fetchSettingsHistory(svc: Svc, limit = 20): Promise<SettingsHistoryRow[]> {
  const { data, error } = await svc
    .from('payroll_settings')
    .select('id, created_at, created_by, note')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(`fetchSettingsHistory: ${error.message}`)
  return (data ?? []) as SettingsHistoryRow[]
}

// ─── The snapshot ─────────────────────────────────────────────────────────────

/** The fields of a period this module needs to decide which settings apply. */
export type PeriodSettingsContext = {
  status: 'draft' | 'generated' | 'locked'
  settings_snapshot: unknown
}

/**
 * Which settings a period's figures are to be read or recalculated with.
 *
 * Pure, so it can be tested without a database, and shared so generation and
 * Monthly Review cannot drift apart. See the rule table at the top of this file.
 */
export function settingsForPeriod(
  period: PeriodSettingsContext,
  active: PayrollSettings,
): PayrollSettings {
  if (period.settings_snapshot != null) return resolveSnapshotSettings(period.settings_snapshot)
  // No snapshot. A period that has never produced figures can safely adopt
  // today's rules; one that HAS produced them predates settings entirely.
  return period.status === 'draft' ? active : LEGACY_PAYROLL_SETTINGS
}

/**
 * Read the period fields the snapshot decision needs.
 *
 * Separate from fetchPeriod in ./store on purpose: that read feeds the engine
 * and its shape is the engine's input contract. This one is about policy.
 */
export async function fetchPeriodSettingsContext(
  svc: Svc,
  periodId: string,
): Promise<PeriodSettingsContext> {
  const { data, error } = await svc
    .from('payroll_periods')
    .select('status, settings_snapshot')
    .eq('id', periodId)
    .single()
  if (error || !data) throw new Error(`fetchPeriodSettingsContext: ${error?.message ?? 'not found'}`)
  return data as PeriodSettingsContext
}

/**
 * Pin settings to a period, and hand back what was pinned.
 *
 * WHEN THIS IS CALLED IS THE WHOLE POINT: before the first employee of a run is
 * calculated, never after. Writing the snapshot afterwards would leave a window
 * in which a concurrent settings save changed the rules midway through a run,
 * and the period would then claim to have been calculated with settings that
 * only applied to some of its employees.
 *
 * `replace` is what separates an ordinary regeneration from an intentional
 * recalculation:
 *
 *   false (default) — an existing snapshot is kept and returned untouched. This
 *                     is every regeneration triggered by an attendance
 *                     correction: the month is being recomputed from corrected
 *                     attendance under the rules it was always run with, and a
 *                     correction must not smuggle in a settings change.
 *
 *   true            — the active settings replace the snapshot. This is an
 *                     admin explicitly asking for the month to be recalculated
 *                     under today's rules, having unlocked it to do so.
 */
export async function pinSettingsToPeriod(
  svc: Svc,
  periodId: string,
  active: PayrollSettings,
  opts: { replace?: boolean } = {},
): Promise<PayrollSettings> {
  const existing = await fetchPeriodSettingsContext(svc, periodId)

  if (existing.settings_snapshot != null && !opts.replace) {
    return resolveSnapshotSettings(existing.settings_snapshot)
  }

  const { error } = await svc
    .from('payroll_periods')
    .update({ settings_snapshot: active })
    .eq('id', periodId)

  if (error) throw new Error(`pinSettingsToPeriod: ${error.message}`)
  return active
}
