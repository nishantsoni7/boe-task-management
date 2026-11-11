/**
 * The migration that stops run_task_health_check from writing "Auto-escalated"
 * lines (20270610000000), proved against the function as it is live today
 * (20261015000000).
 *
 * WHAT MUST HOLD. The two escalation lines stop. The stale flag — the
 * `is_stale` / `stale_day_count` update and its 'stale_flagged' line — is a
 * separate feature the owner did not ask to remove, so its text is compared
 * CHARACTER FOR CHARACTER with the live function. Nothing may be added, and the
 * only lines taken away are the two escalation writes and the 72-hour wrapper.
 *
 * healthCheckMigrationAudit.test.ts keeps pinning the OLD migration (it still
 * expects the escalation writes, correctly: that file is applied and frozen).
 *
 * Run:
 *   npm run test:file -- src/lib/tasks/escalationRemovalMigration.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { stripSqlComments } from './healthCheckMigrationAudit'

const DIR = join(process.cwd(), 'supabase/migrations')
const NEW_FILE = '20270610000000_task_health_check_stops_escalating.sql'
const OLD_FILE = '20261015000000_task_health_check_stops_notifying.sql'
const read = (file: string) => readFileSync(join(DIR, file), 'utf8').replace(/\r\n/g, '\n')

const NEW = read(NEW_FILE)
const OLD = read(OLD_FILE)

/** Code lines only: comments stripped, trimmed, blanks dropped. */
const codeLines = (sql: string): string[] =>
  stripSqlComments(sql).split('\n').map(l => l.trim()).filter(l => l.length > 0)

/** Multiset difference: what `a` has that `b` does not also have, counting duplicates. */
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

const newCode = codeLines(NEW)
const oldCode = codeLines(OLD)
const code = newCode.join('\n')

describe('the new function writes no escalation line', () => {
  test("no 'escalated' action and no 'Auto-escalated' text in the code", () => {
    assert.equal(/escalated/i.test(code), false)
  })

  test('the 24-hour and 72-hour notes are gone, the stale note is not', () => {
    assert.equal(code.includes('overdue with no action for 24 hours'), false)
    assert.equal(code.includes('no update for 72 hours'), false)
    assert.equal((code.match(/Auto-flagged: same status for 5\+ days with no progress/g) ?? []).length, 2,
      'the stale guard and the stale write both remain')
  })

  test('only one INSERT remains, and it is the stale line', () => {
    const inserts = newCode.filter(l => l.startsWith('INSERT INTO'))
    assert.deepEqual(inserts, ['INSERT INTO task_activity_log (task_id, actor_id, action, note)'])
    assert.ok(code.includes("'stale_flagged',"))
  })

  test('no other migration writes an escalation line either', () => {
    for (const f of readdirSync(DIR).filter(n => n.endsWith('.sql') && n !== OLD_FILE)) {
      assert.equal(/'escalated'/.test(stripSqlComments(read(f))), false, `${f} writes or tests 'escalated'`)
    }
  })
})

describe('the stale flag is carried over untouched', () => {
  // Everything from the stale check to the end of the function, as raw text.
  const tail = (sql: string) => sql.slice(sql.indexOf("    IF t.type = 'completion'"))

  test('the stale block and the end of the function are identical to the live function', () => {
    assert.ok(NEW.includes("    IF t.type = 'completion'"), 'fixture guard')
    assert.equal(tail(NEW), tail(OLD))
  })

  test('the task selection, the hours calculation and the waiting skip are unchanged', () => {
    for (const keep of [
      'SELECT * FROM tasks',
      "WHERE status NOT IN ('completed', 'blocked')",
      'hours_since_update := EXTRACT(EPOCH FROM (now() - t.last_update_at)) / 3600;',
      "IF t.status = 'waiting' THEN",
    ]) {
      assert.ok(oldCode.includes(keep), `fixture guard: the live function lacks "${keep}"`)
      assert.ok(newCode.includes(keep), `lost: "${keep}"`)
    }
  })

  test('an overdue, silent task still skips the rest of the loop, so the stale flag marks the same tasks', () => {
    assert.ok(code.includes('IF t.due_date IS NOT NULL\nAND now() > t.due_date\nAND hours_since_update >= 24 THEN\nCONTINUE;\nEND IF;'))
    assert.equal((code.match(/^CONTINUE;$/gm) ?? []).length, 2, 'the overdue skip and the waiting skip')
  })
})

describe('line by line against the live function', () => {
  const added = missingFrom(newCode, oldCode)
  const removed = missingFrom(oldCode, newCode)

  test('nothing was added or altered', () => {
    assert.deepEqual(added, [], `lines in the new function that the live one does not have:\n${added.join('\n')}`)
  })

  test('exactly the two escalation writes and the 72-hour wrapper were removed', () => {
    // Two guarded INSERT blocks of 14 lines each, plus the 72-hour IF and its END IF.
    assert.equal(removed.length, 30, `removed:\n${removed.join('\n')}`)
    const count = (line: string) => removed.filter(l => l === line).length
    assert.equal(count("AND action = 'escalated'"), 2)
    assert.equal(count("'escalated',"), 2)
    assert.equal(count('INSERT INTO task_activity_log (task_id, actor_id, action, note)'), 2)
    assert.equal(count("AND note = 'Auto-escalated: overdue with no action for 24 hours'"), 1)
    assert.equal(count("AND note = 'Auto-escalated: no update for 72 hours'"), 1)
    assert.equal(count('IF hours_since_update >= 72 THEN'), 1)
  })

  test('control flow still balances', () => {
    const count = (re: RegExp) => newCode.filter(l => re.test(l)).length
    assert.equal(count(/\bTHEN$/), count(/^END IF;$/), 'IF / END IF')
    assert.equal(count(/^LOOP$/), count(/^END LOOP;$/), 'LOOP / END LOOP')
  })
})

describe('it replaces one function and nothing else', () => {
  test('same function, signature, language and return type', () => {
    assert.ok(code.includes('CREATE OR REPLACE FUNCTION public.run_task_health_check()'))
    assert.ok(code.includes('RETURNS void'))
    assert.ok(code.includes('LANGUAGE plpgsql'))
    assert.ok(NEW.trimEnd().endsWith('$function$;'))
  })

  test('no notification, delete, cron, security, search_path, owner or grant statement', () => {
    assert.equal(/\bnotifications?\b/i.test(code), false)
    assert.equal(/\bdelete\b|\btruncate\b/i.test(code), false)
    assert.equal(/\bcron\b/i.test(code), false)
    assert.equal(/security\s+(definer|invoker)/i.test(code), false)
    assert.equal(/set\s+search_path/i.test(code), false)
    assert.equal(/\bowner\s+to\b|\bgrant\b|\brevoke\b/i.test(code), false)
  })

  test('its timestamp is unique and later than the migration it replaces', () => {
    const stamps = readdirSync(DIR).filter(n => n.endsWith('.sql')).map(n => n.slice(0, 14))
    assert.equal(new Set(stamps).size, stamps.length, 'duplicate migration timestamp')
    assert.ok(NEW_FILE.slice(0, 14) > OLD_FILE.slice(0, 14))
  })

  test('the live migration it is compared with was not edited', () => {
    // Applied migrations are immutable; this file also pins itself in the FROZEN
    // ledger (participantAndOrderTotalSecurity.test.ts). Here: the rollback text is still there.
    assert.ok(OLD.includes("'Auto-escalated: no update for 72 hours'"))
    assert.ok(OLD.includes("'Auto-escalated: overdue with no action for 24 hours'"))
  })
})
