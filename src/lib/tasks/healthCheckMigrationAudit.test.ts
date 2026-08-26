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
