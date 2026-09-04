/**
 * The rules the run_task_health_check migration must satisfy — and proof that
 * each rule actually catches the thing it is named for.
 *
 * WHY THE FIXTURES ARE SYNTHETIC. The production function body has not been
 * supplied, so nothing here is a copy of it and nothing here should be read as
 * one. These are the smallest SQL strings that exercise one rule each. When the
 * real definition arrives, the migration is written from it and one line —
 * `auditHealthCheckMigration(readFileSync(<migration>, 'utf8'))` — points these
 * same rules at the real file.
 *
 * Run:
 *   npx tsx --test src/lib/tasks/healthCheckMigrationAudit.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  HEALTH_CHECK_SIGNATURE,
  PRESERVED_ACTIVITY_NOTES,
  auditHealthCheckMigration,
  failedRules,
  stripSqlComments,
} from './healthCheckMigrationAudit'

// A migration shaped like the one this change calls for: same signature, same
// language and return type, no security clause (production is INVOKER, which
// pg_get_functiondef omits), the three activity writes intact, no notifications.
// Structure only — the real branch bodies come from the inspected definition.
const COMPLIANT = `
-- Stop run_task_health_check from writing notifications nobody can act on.
-- Every INSERT INTO notifications is removed; the activity history is not.
create or replace function public.run_task_health_check()
returns void
language plpgsql
as $$
declare
  v_task record;
begin
  for v_task in select id, status, due_date, last_update_at from public.tasks loop
    if v_task.status in ('completed', 'cancelled') then
      continue;
    end if;

    if v_task.status = 'waiting' then
      continue;
    end if;

    if v_task.due_date < current_date and v_task.last_update_at < now() - interval '24 hours' then
      insert into public.task_activity_log (task_id, actor_id, action, note)
      values (v_task.id, null, 'escalated', '${PRESERVED_ACTIVITY_NOTES.overdue24}');
      continue;
    end if;

    if v_task.last_update_at < now() - interval '72 hours' then
      insert into public.task_activity_log (task_id, actor_id, action, note)
      values (v_task.id, null, 'escalated', '${PRESERVED_ACTIVITY_NOTES.escalate72}');
    end if;

    if v_task.last_update_at < now() - interval '5 days' then
      update public.tasks
         set is_stale = true, stale_day_count = 5
       where id = v_task.id;
      insert into public.task_activity_log (task_id, actor_id, action, note)
      values (v_task.id, null, 'stale_flagged', '${PRESERVED_ACTIVITY_NOTES.stale}');
    end if;
  end loop;
end;
$$;
`

/** COMPLIANT with one thing broken. */
const broken = (find: string, replace: string) => {
  assert.ok(COMPLIANT.includes(find), `fixture guard: "${find}" not in the compliant fixture`)
  return COMPLIANT.replace(find, replace)
}

describe('the compliant shape passes', () => {
  test('no findings', () => {
    assert.deepEqual(auditHealthCheckMigration(COMPLIANT), [])
  })

  test('the signature constant is what the rule looks for', () => {
    assert.equal(HEALTH_CHECK_SIGNATURE, 'public.run_task_health_check()')
    assert.ok(COMPLIANT.includes(`create or replace function ${HEALTH_CHECK_SIGNATURE}`))
  })

  test('an explicit SECURITY INVOKER is accepted as well as an omitted one', () => {
    // pg_get_functiondef omits the clause for an invoker function, so both a
    // faithful copy and an explicit restatement must pass.
    const explicit = broken('language plpgsql', 'language plpgsql\nsecurity invoker')
    assert.deepEqual(auditHealthCheckMigration(explicit), [])
  })
})

describe('comments cannot satisfy or violate a rule', () => {
  test('line and block comments are stripped before matching', () => {
    const s = stripSqlComments("select 1; -- insert into notifications\n/* delete from notifications */ select 2;")
    assert.equal(/notifications/.test(s), false)
    assert.ok(s.includes('select 1'))
    assert.ok(s.includes('select 2'))
  })

  test('a header explaining the removal does not trip the notification rules', () => {
    const withHeader = `-- Removes every INSERT INTO notifications and the overdue/escalation rows.\n-- delete from notifications was NOT done.\n${COMPLIANT}`
    assert.deepEqual(auditHealthCheckMigration(withHeader), [])
  })

  test('and a commented-out insert does not count as keeping one', () => {
    const commentedOut = broken(
      "    if v_task.status = 'waiting' then",
      "    -- insert into public.notifications (user_id, type) values (v_task.assigned_to, 'overdue');\n    if v_task.status = 'waiting' then",
    )
    assert.deepEqual(auditHealthCheckMigration(commentedOut), [])
  })
})

describe('each rule catches the thing it is named for', () => {
  const cases: [string, string, string, string][] = [
    // [rule, description, find, replace]
    ['replaces-function', 'a renamed function',
      'create or replace function public.run_task_health_check()',
      'create or replace function public.run_task_health_check_v2()'],

    ['replaces-function', 'an added argument',
      'create or replace function public.run_task_health_check()',
      'create or replace function public.run_task_health_check(p_now timestamptz)'],

    ['no-notification-rows', 'a surviving overdue notification insert',
      "      continue;\n    end if;\n\n    if v_task.last_update_at < now() - interval '72 hours' then",
      "      insert into public.notifications (user_id, task_id, type, title)\n      values (v_task.assigned_to, v_task.id, 'overdue', 'Task overdue');\n      continue;\n    end if;\n\n    if v_task.last_update_at < now() - interval '72 hours' then"],

    ['no-notification-rows', 'a bare reference to the enum',
      'declare\n  v_task record;',
      "declare\n  v_task record;\n  v_type public.notification_type;"],

    ['keeps-overdue-log', 'a reworded 24h note',
      PRESERVED_ACTIVITY_NOTES.overdue24, 'Auto-escalated: overdue'],

    ['keeps-72h-log', 'a reworded 72h note',
      PRESERVED_ACTIVITY_NOTES.escalate72, 'Escalated after 72h'],

    ['keeps-stale-log', 'a reworded stale note',
      PRESERVED_ACTIVITY_NOTES.stale, 'Stale'],

    ['keeps-stale-update', 'the tasks update dropped',
      'update public.tasks\n         set is_stale = true, stale_day_count = 5\n       where id = v_task.id;', ''],

    ['keeps-waiting-skip', 'waiting no longer considered',
      "if v_task.status = 'waiting' then", "if false then"],

    ['no-cron-change', 'a schedule change smuggled in',
      'create or replace function', "select cron.unschedule('task-health');\ncreate or replace function"],

    ['no-security-definer', 'privilege escalation',
      'language plpgsql', 'language plpgsql\nsecurity definer'],

    ['keeps-language', 'a language swap',
      'language plpgsql', 'language sql'],

    ['keeps-return-type', 'a changed return type',
      'returns void', 'returns integer'],

    ['no-search-path-added', 'a speculative search_path',
      'language plpgsql', 'language plpgsql\nset search_path = public, pg_temp'],
  ]

  for (const [rule, description, find, replace] of cases) {
    test(`${rule}: ${description}`, () => {
      const failed = failedRules(broken(find, replace))
      assert.ok(failed.includes(rule as never),
        `expected rule "${rule}" to fire, got: ${failed.join(', ') || '(none)'}`)
    })
  }

  test('no-notification-insert and no-notification-rows both fire on an insert', () => {
    const withInsert = broken(
      "    end if;\n  end loop;",
      "    end if;\n    insert into public.notifications (user_id, type) values (v_task.assigned_to, 'escalation');\n  end loop;",
    )
    const failed = failedRules(withInsert)
    assert.ok(failed.includes('no-notification-insert'))
    assert.ok(failed.includes('no-notification-rows'))
  })

  test('no-history-deletion fires on a cleanup of the legacy rows', () => {
    const withCleanup = `delete from public.notifications where type in ('overdue','escalation');\n${COMPLIANT}`
    assert.ok(failedRules(withCleanup).includes('no-history-deletion'))
  })

  test('no-privilege-changes fires on a restated owner or grant', () => {
    for (const stmt of [
      'alter function public.run_task_health_check() owner to postgres;',
      'grant execute on function public.run_task_health_check() to authenticated;',
      'revoke execute on function public.run_task_health_check() from public;',
    ]) {
      assert.ok(failedRules(`${COMPLIANT}\n${stmt}`).includes('no-privilege-changes'), stmt)
    }
  })

  test('keeps-overdue-continue fires when the short-circuit is dropped', () => {
    // Both CONTINUEs removed: the closed-task skip and the overdue one.
    const noContinue = COMPLIANT.replace(/continue;/g, 'null;')
    assert.ok(failedRules(noContinue).includes('keeps-overdue-continue'))
  })

  test("the activity actions themselves are required, not just the notes", () => {
    // Every occurrence — 'escalated' is written by both the 24h and the 72h
    // branch, and one surviving use means the action is still recorded.
    assert.ok(failedRules(COMPLIANT.replaceAll("'escalated'", "'auto_escalated'"))
      .includes('keeps-overdue-log'))
    assert.ok(failedRules(COMPLIANT.replaceAll("'stale_flagged'", "'flagged'"))
      .includes('keeps-stale-log'))
  })

  test("renaming only ONE of the two 'escalated' writes is not enough to trip it", () => {
    // Stated so the asymmetry above is deliberate rather than an accident: this
    // rule asks whether the action still exists, and the per-branch notes in
    // keeps-overdue-log / keeps-72h-log are what pin each branch individually.
    assert.equal(failedRules(broken("'escalated'", "'auto_escalated'")).length, 0)
  })
})

describe('an empty or unrelated file fails loudly rather than silently passing', () => {
  test('empty input reports the missing function first', () => {
    const failed = failedRules('')
    assert.ok(failed.includes('replaces-function'))
    assert.ok(failed.includes('keeps-72h-log'))
    assert.ok(failed.includes('keeps-stale-update'))
  })

  test('a findings list is returned whole, not one at a time', () => {
    const findings = auditHealthCheckMigration('')
    assert.ok(findings.length >= 5)
    for (const f of findings) {
      assert.equal(typeof f.rule, 'string')
      assert.ok(f.message.length > 0, 'every finding explains itself')
    }
  })
})


// ─── The real migration ──────────────────────────────────────────────────────
//
// Everything above proves the RULES work. This proves the MIGRATION does.

const ROOT = process.cwd()
const MIGRATION_FILE = '20261015000000_task_health_check_stops_notifying.sql'
const MIGRATION_PATH = join(ROOT, 'supabase/migrations', MIGRATION_FILE)
const BASELINE_PATH  = join(ROOT, 'docs/proposals/run_task_health_check.production.sql')

const MIGRATION = readFileSync(MIGRATION_PATH, 'utf8')
const BASELINE  = readFileSync(BASELINE_PATH, 'utf8')

/** Code lines only: comments stripped, trimmed, blanks dropped. */
const codeLines = (sql: string): string[] =>
  stripSqlComments(sql).split('\n').map(l => l.trim()).filter(l => l.length > 0)

/** Multiset difference: what is in `a` that `b` does not also have, counting duplicates. */
function missingFrom(a: string[], b: string[]): string[] {
  const pool = new Map<string, number>()
  for (const line of b) pool.set(line, (pool.get(line) ?? 0) + 1)
  const out: string[] = []
  for (const line of a) {
    const left = pool.get(line) ?? 0
    if (left > 0) pool.set(line, left - 1)
    else out.push(line)
  }
  return out
}

describe('the migration satisfies every rule', () => {
  test('zero audit findings', () => {
    const findings = auditHealthCheckMigration(MIGRATION)
    assert.deepEqual(findings, [],
      findings.map(f => `${f.rule}: ${f.message}`).join('\n'))
  })

  // The twelve numbered requirements, asserted individually so a failure names
  // the requirement rather than "the audit failed".
  const code = codeLines(MIGRATION).join('\n')

  test('1. replaces public.run_task_health_check()', () => {
    assert.ok(code.includes('CREATE OR REPLACE FUNCTION public.run_task_health_check()'))
    assert.equal(/run_task_health_check\s*\(\s*\w/.test(code), false, 'no arguments')
  })

  test('2. contains no INSERT INTO notifications', () => {
    assert.equal(/insert\s+into\s+notifications/i.test(code), false)
  })

  test('3. creates no overdue or escalation notification rows', () => {
    assert.equal(/\bnotifications\b/i.test(code), false, 'the table is not referenced at all')
    for (const t of ['Task overdue - no action taken', 'Task escalated to senior',
                     'Danger zone - task needs update', 'Caution - task update overdue']) {
      assert.equal(code.includes(t), false, `notification title still present: ${t}`)
    }
  })

  test('4. the overdue activity-log entry remains, guard and actor included', () => {
    assert.ok(code.includes("'Auto-escalated: overdue with no action for 24 hours'"))
    assert.ok(code.includes('INSERT INTO task_activity_log (task_id, actor_id, action, note)'))
    // Both the dedup guard and the write survive: the note appears twice, once
    // in the IF NOT EXISTS and once in the VALUES.
    assert.equal(
      (code.match(/Auto-escalated: overdue with no action for 24 hours/g) ?? []).length, 2)
  })

  test('5. the 72-hour activity-log entry remains, guard and actor included', () => {
    assert.equal((code.match(/Auto-escalated: no update for 72 hours/g) ?? []).length, 2)
    assert.ok(code.includes('IF hours_since_update >= 72 THEN'))
  })

  test('6. the stale_flagged activity-log entry remains', () => {
    assert.equal(
      (code.match(/Auto-flagged: same status for 5\+ days with no progress/g) ?? []).length, 2)
    assert.ok(code.includes("'stale_flagged'"))
  })

  test('7. the tasks stale UPDATE remains, unchanged', () => {
    assert.ok(code.includes('UPDATE tasks'))
    assert.ok(code.includes('SET is_stale = true,'))
    assert.ok(code.includes('stale_day_count ='))
    assert.ok(code.includes('FLOOR(EXTRACT(EPOCH FROM (now() - t.last_update_at)) / 86400)'))
  })

  test('8. waiting tasks still CONTINUE without escalation', () => {
    assert.ok(code.includes("IF t.status = 'waiting' THEN\nCONTINUE;\nEND IF;"))
  })

  test('9. the overdue CONTINUE remains', () => {
    // Immediately after the overdue branch's guarded log write, as in production.
    assert.ok(code.includes('END IF;\nCONTINUE;\nEND IF;'))
    assert.equal((code.match(/^CONTINUE;$/gm) ?? []).length, 2, 'exactly the two originals')
  })

  test('10. no historical notification deletion', () => {
    assert.equal(/delete\s+from/i.test(code), false)
    assert.equal(/truncate/i.test(code), false)
  })

  test('11. no cron modification', () => {
    assert.equal(/\bcron\b/i.test(code), false)
  })

  test('12. no SECURITY DEFINER', () => {
    assert.equal(/security\s+definer/i.test(code), false)
    // And INVOKER is not restated: pg_get_functiondef omits the clause for an
    // invoker function, so the faithful copy has neither word.
    assert.equal(/security\s+invoker/i.test(code), false)
  })

  test('identity: plpgsql, void, and no proconfig', () => {
    assert.ok(code.includes('LANGUAGE plpgsql'))
    assert.ok(code.includes('RETURNS void'))
    assert.equal(/set\s+search_path/i.test(code), false)
  })

  test('no ownership, grant or revoke statement', () => {
    assert.equal(/\bowner\s+to\b|\bgrant\b|\brevoke\b/i.test(code), false)
  })
})

describe('line-by-line against the production baseline', () => {
  // The permitted removals, exactly: four notification inserts (9 lines each)
  // and the two now-empty ELSIF branch headers.
  const REMOVED_INSERT_BLOCK_LINES = 9
  const EXPECTED_REMOVED = 4 * REMOVED_INSERT_BLOCK_LINES + 2

  const base = codeLines(BASELINE)
  const mig  = codeLines(MIGRATION)
  const removed = missingFrom(base, mig)
  const added   = missingFrom(mig, base)

  test('NOTHING was added or altered', () => {
    assert.deepEqual(added, [],
      `these lines exist in the migration but not in production:\n${added.join('\n')}`)
  })

  test('exactly 38 lines were removed', () => {
    assert.equal(removed.length, EXPECTED_REMOVED,
      `removed:\n${removed.join('\n')}`)
  })

  test('every removed line belongs to a notification insert or an empty ELSIF', () => {
    const permitted = new Set([
      'INSERT INTO notifications (user_id, task_id, type, title, body, is_push_sent)',
      'VALUES (', ');', 'true', 't.id,', 't.created_by,', 't.assigned_to,',
      "'overdue',", "'escalation',",
      "'Task overdue - no action taken',",
      "'This task passed its deadline 24 hours ago with no update.',",
      "'Task escalated to senior',", "'No update recorded for 72 hours.',",
      "'Danger zone - task needs update',", "'No update recorded for 48 hours.',",
      "'Caution - task update overdue',", "'No update recorded for 24 hours.',",
      'ELSIF hours_since_update >= 48 THEN',
      'ELSIF hours_since_update >= 24 THEN',
    ])
    for (const line of removed) {
      assert.ok(permitted.has(line), `unexpected removal: ${line}`)
    }
  })

  test('the four notification inserts are all gone, and only they', () => {
    assert.equal(removed.filter(l => l.startsWith('INSERT INTO notifications')).length, 4)
    assert.equal(base.filter(l => l.startsWith('INSERT INTO notifications')).length, 4)
    assert.equal(mig.filter(l => l.startsWith('INSERT INTO notifications')).length, 0)
  })

  test('the three activity-log writes survive in both files, unchanged in count', () => {
    const logWrites = (ls: string[]) =>
      ls.filter(l => l === 'INSERT INTO task_activity_log (task_id, actor_id, action, note)').length
    assert.equal(logWrites(base), 3)
    assert.equal(logWrites(mig), 3)
  })

  test('the 24h/48h ELSIF branches are gone entirely, not left empty', () => {
    assert.equal(mig.includes('ELSIF hours_since_update >= 48 THEN'), false)
    assert.equal(mig.includes('ELSIF hours_since_update >= 24 THEN'), false)
    assert.equal(mig.some(l => l.startsWith('ELSIF')), false, 'no ELSIF remains at all')
    // The 72h test is now a plain IF, and the >= 24 threshold survives only in
    // the overdue condition, where it always belonged.
    assert.ok(mig.includes('IF hours_since_update >= 72 THEN'))
    assert.ok(mig.includes('AND hours_since_update >= 24 THEN'))
  })

  test('control flow still balances', () => {
    const count = (ls: string[], re: RegExp) => ls.filter(l => re.test(l)).length
    // Every THEN-opening IF is closed. `ELSIF` would open none, and there are none.
    const opens  = count(mig, /\bTHEN$/)
    const closes = count(mig, /^END IF;$/)
    assert.equal(opens, closes, 'IF/END IF do not balance')
    assert.equal(count(mig, /^LOOP$/), count(mig, /^END LOOP;$/))
    // Removals cannot have changed the nesting relative to production.
    assert.equal(opens, count(base, /\bTHEN$/) - 2, 'exactly the two ELSIF branch heads went')
  })

  test('every threshold and filter survives verbatim', () => {
    for (const invariant of [
      "SELECT * FROM tasks",
      "WHERE status NOT IN ('completed', 'blocked')",
      "hours_since_update := EXTRACT(EPOCH FROM (now() - t.last_update_at)) / 3600;",
      "AND hours_since_update >= 24 THEN",
      "IF hours_since_update >= 72 THEN",
      "AND created_at > now() - INTERVAL '6 days';",
      "AND EXTRACT(EPOCH FROM (now() - t.created_at)) / 86400 >= 5 THEN",
      "IF t.type = 'completion'",
      "AND t.status IN ('started', 'working') THEN",
      "IF days_same_status = 0",
    ]) {
      assert.ok(base.includes(invariant), `fixture guard: baseline lacks "${invariant}"`)
      assert.ok(mig.includes(invariant), `migration lost: "${invariant}"`)
    }
  })

  test('the baseline is a complete, runnable rollback', () => {
    assert.ok(BASELINE.includes('CREATE OR REPLACE FUNCTION public.run_task_health_check()'))
    assert.ok(BASELINE.trimEnd().endsWith('$function$;'))
    assert.equal(base.filter(l => l.startsWith('INSERT INTO notifications')).length, 4,
      'rollback must restore the original behaviour, inserts included')
  })
})

describe('the migration is placed correctly', () => {
  const files = readdirSync(join(ROOT, 'supabase/migrations')).filter(f => f.endsWith('.sql')).sort()

  test('only 116 and 118 sit after it, and 116 is now applied too', () => {
    // 115 was the last file when this was written. 116 (the notifications
    // activity-link column) was added later and has SINCE been pushed, so 116
    // — not 115 — is now the newest thing that has run against the database.
    // What this still guards is that 115 is the only migration 116 follows.
    const newer = files.filter(f => f.slice(0, 14) > MIGRATION_FILE.slice(0, 14))
    // 117 (Customer Review Outreach), 118 (Top 3 Focus unpin) and 120 (the
    // Image Editor module registration) came later still and NONE is applied.
    // All three appear in the pending list in
    // participantAndOrderTotalSecurity.test.ts and deliberately not in FROZEN.
    // This assertion is exact, so a file cannot appear after 115 without being
    // named here.
    assert.deepEqual(newer, [
      '20261016000000_notifications_link_activity_log.sql',
      '20261017000000_customer_review_outreach.sql',
      '20261018000000_unpin_tasks_submitted_for_approval.sql',
      '20261020000000_register_image_editor_module.sql',
      '20261021000000_seed_customer_review_test_cards.sql',
      // 122. The Image Editor result history, unapplied like the rest of the
      // tail: one bucket, one table, its own policies, nothing replaced.
      '20261022000000_image_editor_result_history.sql',
      '20261023000000_review_workflow_ai_drafts.sql',
      // The batch-approval pair, in the order they must apply. The deletion
      // migration runs FIRST so the schema one lands on an empty card table
      // and can enforce its approval invariants without a legacy exemption.
      '20261025000000_review_workflow_remove_legacy_test_data.sql',
      '20261026000000_review_workflow_batch_approval.sql',
      // Provider-call idempotency: a request key is CLAIMED before the model
      // is called, so two simultaneous requests cannot both be billed for.
      '20261027000000_review_workflow_generation_claims.sql',
      // Assets & Access, from a separate branch: the delegated Access Register
      // permission and the asset handover acknowledgement. Neither touches
      // this work's tables, policies or functions.
      '20261028000000_assets_access_manage_access_records.sql',
      '20261029000000_asset_handover_acknowledgement.sql',
      // Verifier deletion, and the Add-versus-Replace choice at approval.
      '20261030000000_review_workflow_deletion_and_replacement.sql',
      // Twelve drafts a batch, editing a pending draft before approval, and up
      // to four review images. It touches only this module's own tables.
      '20261031000000_review_workflow_twelve_drafts_editing_and_images.sql',
      // BOE Credits Phase 1A: the append-only credit ledger, its derived balance
      // view, the settings table and the service-role posting functions. Two new
      // tables of its own; it touches nothing any other module creates.
      '20261101000000_boe_credits_foundation.sql',
      // BOE Credits Phase 1B: re-creates transition_customer_review_test_card() so a
      // verified review posts its review_reward in the same transaction. One
      // function, no table, no data.
      '20261102000000_boe_credits_review_reward.sql',
      // BOE Credits Phase 1C: the attendance redemption record table and the
      // service-role function that covers one attendance day with credits. One
      // new table of its own; it touches nothing any other module creates.
      '20261103000000_boe_credits_attendance_redemption.sql',
      // BOE Credits Phase 1D: configurable settings, monthly review qualification
      // and the payroll salary addition. Three new credits tables of its own; it
      // touches nothing any other module creates.
      '20261104000000_boe_credits_phase_1d.sql',
      // Half-day company holidays: adds holiday_type/half_session to
      // payroll_holidays. Touches nothing this migration reaches.
      '20261105000000_holiday_half_day.sql',
    ])
    // 116's applied status is recorded in the FROZEN ledger, never in its own
    // header: that header still reads "NOT APPLIED" and is left stale on
    // purpose, because the ledger pins a hash of the exact bytes the database
    // ran and a comment-only edit would break it. Assert the ledger.
    const ledger = readFileSync(
      join(ROOT, 'src/lib/finance/participantAndOrderTotalSecurity.test.ts'), 'utf8')
    const frozen = ledger.slice(ledger.indexOf('const FROZEN'), ledger.indexOf('const actual'))
    assert.ok(frozen.includes(newer[0]), '116 must be pinned as applied in the FROZEN ledger')
    assert.ok(frozen.includes('9d586c1e27cb00ad4ad3724a125d5f454e222ce8729efe7a0a6dafab29338fa8'),
      "and pinned to the bytes that ran")
  })

  test('its timestamp is unique, and later than every migration it followed', () => {
    const stamps = files.map(f => f.slice(0, 14))
    assert.equal(new Set(stamps).size, stamps.length, 'duplicate migration timestamp')
    const mine = MIGRATION_FILE.slice(0, 14)
    // 116 was written after this and is correctly stamped after it. What this
    // guards is that nothing PRECEDING 115 shares or exceeds its timestamp,
    // which is what would change its apply order.
    for (const other of stamps.filter(s => s !== mine && s < '20261016000000')) {
      assert.ok(other < mine, `${other} is not earlier than ${mine}`)
    }
  })

  test('it ends cleanly', () => {
    assert.ok(MIGRATION.trimEnd().endsWith('$function$;'))
  })
})
