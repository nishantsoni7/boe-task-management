// The twelve properties the `run_task_health_check` migration must hold.
//
// WHY THIS IS A MODULE AND NOT TWELVE INLINE ASSERTIONS. The migration replaces
// a function that runs hourly against production on a schedule nobody watches,
// and `create or replace function` replaces the WHOLE body — so a property that
// is merely "true when I wrote it" is worth very little. Stating the rules as
// data, unit-testing each one against SQL crafted to break it, and only then
// pointing them at the real file means the checks are themselves checked.
//
// COMMENTS ARE STRIPPED BEFORE ANYTHING IS MATCHED. The migration's header will
// necessarily say what it removed — "every INSERT INTO notifications is gone" —
// and a naive substring search finds that sentence and reports the very thing
// the sentence says was removed. Every rule below reads code only.

/** The exact signature. Zero arguments — a differently-shaped overload is a new function. */
export const HEALTH_CHECK_SIGNATURE = 'public.run_task_health_check()'

/**
 * The three permanent activity records the function already writes and which
 * this change must leave untouched. Exact strings, because they are the only
 * evidence in the migration text that the history write survived the edit.
 */
export const PRESERVED_ACTIVITY_NOTES = {
  overdue24: 'Auto-escalated: overdue with no action for 24 hours',
  escalate72: 'Auto-escalated: no update for 72 hours',
  stale: 'Auto-flagged: same status for 5+ days with no progress',
} as const

export type AuditRuleId =
  | 'replaces-function'      // 1
  | 'no-notification-insert' // 2
  | 'no-notification-rows'   // 3
  | 'keeps-overdue-log'      // 4
  | 'keeps-72h-log'          // 5
  | 'keeps-stale-log'        // 6
  | 'keeps-stale-update'     // 7
  | 'keeps-waiting-skip'     // 8
  | 'keeps-overdue-continue' // 9
  | 'no-history-deletion'    // 10
  | 'no-cron-change'         // 11
  | 'no-security-definer'    // 12
  | 'keeps-language'
  | 'keeps-return-type'
  | 'no-privilege-changes'
  | 'no-search-path-added'

export type AuditFinding = { rule: AuditRuleId; message: string }

/**
 * SQL with comments removed.
 *
 * Handles `--` to end of line and `/* … *​/` blocks. Dollar-quoted function
 * bodies are NOT treated specially: comments inside the body are stripped too,
 * which is what we want — a `-- insert into notifications (removed)` note in
 * the body must not satisfy or violate any rule.
 */
export function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--.*$/gm, ' ')
}

const norm = (sql: string) => stripSqlComments(sql).replace(/\s+/g, ' ').toLowerCase()

/** True when `sql`'s code (not its comments) matches `re`. */
const hasCode = (sql: string, re: RegExp) => re.test(norm(sql))

/**
 * Audit a candidate migration. An empty array means every rule holds.
 *
 * Findings are returned rather than thrown so a caller can report all of them
 * at once — a migration that fails four rules should say so in one pass, not
 * four edit-and-rerun cycles.
 */
export function auditHealthCheckMigration(sql: string): AuditFinding[] {
  const findings: AuditFinding[] = []
  const fail = (rule: AuditRuleId, message: string) => findings.push({ rule, message })

  // 1. It replaces exactly this function, with exactly this signature.
  if (!hasCode(sql, /create or replace function public\.run_task_health_check\s*\(\s*\)/)) {
    fail('replaces-function',
      `must contain "create or replace function ${HEALTH_CHECK_SIGNATURE}" — a different ` +
      'signature creates a second function and leaves the scheduled one untouched')
  }

  // 2. No notification is written.
  if (hasCode(sql, /insert\s+into\s+(public\.)?"?notifications"?/)) {
    fail('no-notification-insert', 'contains an INSERT INTO notifications')
  }

  // 3. Nothing about notifications at all — the strongest form of "creates no
  //    overdue or escalation notification row". `notification_type` is included
  //    so a bare enum cast cannot slip a row in by another route.
  if (hasCode(sql, /\bnotifications\b|\bnotification_type\b/)) {
    fail('no-notification-rows',
      'still references the notifications table or its enum; the function must not touch either')
  }

  // 4-6. The permanent history the escalation produces, unchanged.
  const notes: [AuditRuleId, string, string][] = [
    ['keeps-overdue-log',  PRESERVED_ACTIVITY_NOTES.overdue24,  'the 24h overdue activity-log note'],
    ['keeps-72h-log',      PRESERVED_ACTIVITY_NOTES.escalate72, 'the 72h escalation activity-log note'],
    ['keeps-stale-log',    PRESERVED_ACTIVITY_NOTES.stale,      'the stale-flag activity-log note'],
  ]
  for (const [rule, note, label] of notes) {
    if (!norm(sql).includes(note.toLowerCase())) {
      fail(rule, `${label} is missing — expected the exact string "${note}"`)
    }
  }
  if (!hasCode(sql, /'escalated'/)) {
    fail('keeps-overdue-log', "the activity action 'escalated' is missing")
  }
  if (!hasCode(sql, /'stale_flagged'/)) {
    fail('keeps-stale-log', "the activity action 'stale_flagged' is missing")
  }

  // 7. The stale calculation still writes back to the task.
  if (!hasCode(sql, /update\s+(public\.)?"?tasks"?\b/) || !hasCode(sql, /\bis_stale\b/)) {
    fail('keeps-stale-update', 'the UPDATE of public.tasks that records staleness is missing')
  }

  // 8. A waiting task is skipped rather than escalated.
  if (!hasCode(sql, /'waiting'/)) {
    fail('keeps-waiting-skip', "the 'waiting' status is no longer referenced — waiting tasks must still be skipped")
  }

  // 9. The overdue branch still short-circuits. Both this and rule 8 depend on
  //    CONTINUE surviving, so the count is checked rather than mere presence:
  //    the production function skips on waiting AND after handling overdue.
  const continues = (norm(sql).match(/\bcontinue\b/g) ?? []).length
  if (continues < 2) {
    fail('keeps-overdue-continue',
      `expected at least 2 CONTINUE statements (waiting skip + overdue short-circuit), found ${continues}`)
  }

  // 10. Historical rows are not touched. Redundant with rule 3 and deliberately
  //     kept separate: this is the one that would be reported if someone ever
  //     "tidied up" the 16k legacy rows inside a function migration.
  if (hasCode(sql, /delete\s+from\s+(public\.)?"?notifications"?|truncate\b/)) {
    fail('no-history-deletion', 'deletes notification history; historical rows must be left in place')
  }

  // 11. Timing is not this migration's business.
  if (hasCode(sql, /\bcron\.(schedule|unschedule|alter_job|job)\b/)) {
    fail('no-cron-change', 'modifies pg_cron; the schedule must not change')
  }

  // 12. Privilege escalation is not this migration's business either. Note the
  //     asymmetry: SECURITY DEFINER is banned, but SECURITY INVOKER is NOT
  //     required — it is PostgreSQL's default and pg_get_functiondef omits the
  //     clause entirely for an invoker function, so demanding the words would
  //     reject a faithful copy of production.
  if (hasCode(sql, /security\s+definer/)) {
    fail('no-security-definer', 'introduces SECURITY DEFINER; production is SECURITY INVOKER')
  }

  // Identity that must survive the replace.
  if (!hasCode(sql, /language\s+plpgsql/)) {
    fail('keeps-language', 'LANGUAGE plpgsql is missing')
  }
  if (!hasCode(sql, /returns\s+void/)) {
    fail('keeps-return-type', 'RETURNS void is missing')
  }

  // Speculative ownership/grant statements were explicitly ruled out: CREATE OR
  // REPLACE preserves both for an existing signature, so restating them can only
  // differ from production, never match it more closely.
  if (hasCode(sql, /alter\s+function[\s\S]{0,120}owner\s+to|^\s*grant\s|\bgrant\s+execute\b|^\s*revoke\s|\brevoke\s+\w+\s+on\s+function\b/)) {
    fail('no-privilege-changes', 'contains an owner/grant/revoke statement; replace preserves both')
  }

  // Production reports no proconfig. Adding one changes how the function
  // resolves names at runtime, which is a behavioural change, not a tidy-up.
  if (hasCode(sql, /\bset\s+search_path\s*=/)) {
    fail('no-search-path-added',
      'adds a search_path override; the production function has no function configuration')
  }

  return findings
}

/** Convenience for tests: the rule ids that failed, sorted. */
export function failedRules(sql: string): AuditRuleId[] {
  return [...new Set(auditHealthCheckMigration(sql).map(f => f.rule))].sort()
}
