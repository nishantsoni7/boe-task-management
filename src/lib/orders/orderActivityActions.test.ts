/**
 * EVERY LOGGED ACTION IS A DECLARED ACTION.
 *
 * order_submission_activity.action carries a CLOSED check constraint, and
 * 20260908000000 stated the rule plainly: a migration that logs a new action
 * extends the constraint in the same migration, "which is a visible change
 * rather than a silent new event type."
 *
 * The rule was broken and nothing noticed. 20260923000000 added
 * set_order_submission_billing_percentage(), which logs 'billing_percentage_set',
 * and did not extend the constraint — so on the live database every SUCCESSFUL
 * billing write fails with a CHECK violation at the moment it records what it
 * did. It went unseen because it could not be reached: the authority check
 * refused the write first, for everybody. One bug stood in front of the other.
 *
 * Four migrations on this branch then logged nine more undeclared actions.
 *
 * WHY THE ASSERTIONS DID NOT CATCH IT: the local verification schema had no
 * such constraint, so a hundred behavioural checks ran against a column that
 * accepted any string. A stub more permissive than the real schema does not
 * prove less than the real thing — it proves the wrong thing, confidently.
 *
 * This test holds the two lists together from the source itself, so the next
 * migration cannot log an action it has not declared.
 *
 * Run:
 *   npx tsx --test src/lib/orders/orderActivityActions.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const DIR = join(process.cwd(), 'supabase/migrations')
const FILES = readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()

/** The action set as the LAST migration to define it leaves it. */
function currentActionSet(): { file: string; actions: Set<string> } {
  let file = ''
  let actions = new Set<string>()
  for (const f of FILES) {
    const text = readFileSync(join(DIR, f), 'utf8')
    // Both forms the schema has used: the inline CHECK on CREATE TABLE, and the
    // named constraint every later migration re-adds.
    const blocks = [
      ...text.matchAll(/constraint order_submission_activity_action_check\s*\n?\s*check \(action in \(([\s\S]*?)\)\)/g),
      ...text.matchAll(/action\s+text\s+not null\s*\n?\s*check \(action in \(([\s\S]*?)\)\)/g),
    ]
    if (blocks.length === 0) continue
    const body = blocks[blocks.length - 1][1]
    actions = new Set([...body.matchAll(/'([a-z_]+)'/g)].map(m => m[1]))
    file = f
  }
  return { file, actions }
}

/**
 * Every action any migration passes to the activity logger.
 *
 * THE THIRD POSITIONAL ARGUMENT, parsed by matching parentheses — not a
 * fixed-size text window. The calls span many lines and carry jsonb payloads
 * whose KEYS are also quoted lowercase words ('client', 'schedule', 'changed'),
 * so a windowed scan both truncates the long calls and mistakes payload keys
 * for action names. Reading exactly the argument that becomes `action` is the
 * only way to be right about both.
 */
function loggedActions(): Map<string, string[]> {
  const out = new Map<string, string[]>()

  const record = (action: string, file: string) => {
    if (!out.has(action)) out.set(action, [])
    if (!out.get(action)!.includes(file)) out.get(action)!.push(file)
  }

  /**
   * Record the action literals of one argument expression.
   *
   * A plain literal is the action. A `case when <cond> then 'a' else 'b' end`
   * yields TWO actions — but its condition may also contain literals that are
   * not actions at all (`p_outcome = 'resolved'`), so only what follows `then`
   * or `else` is read.
   */
  const record3 = (expr: string, file: string) => {
    if (/\bcase\b/i.test(expr)) {
      for (const r of expr.matchAll(/\b(?:then|else)\s+'([a-z_]+)'/gi)) record(r[1], file)
      return
    }
    for (const lit of expr.matchAll(/'([a-z_]+)'/g)) record(lit[1], file)
  }

  /** The comma-separated top-level arguments of a call starting at `open`. */
  const args = (text: string, open: number): string[] => {
    let depth = 0
    let start = open + 1
    const parts: string[] = []
    for (let i = open; i < text.length; i++) {
      const ch = text[i]
      if (ch === '(') depth++
      else if (ch === ')') {
        depth--
        if (depth === 0) { parts.push(text.slice(start, i)); return parts }
      } else if (ch === ',' && depth === 1) {
        parts.push(text.slice(start, i))
        start = i + 1
      }
    }
    return parts
  }

  for (const f of FILES) {
    const code = readFileSync(join(DIR, f), 'utf8')
      .split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')

    // log_order_submission_activity(submission, actor, ACTION, ...)
    //
    // A CALL, not a mention. Several migrations name this function inside their
    // own self-checks — as a quoted string in a list of names to verify — and
    // treating those as calls made the scan read whatever parentheses happened
    // to follow. So: the name must be immediately followed by '(' and must not
    // be preceded by a quote.
    for (const m of code.matchAll(/(^|[^'\w.])(?:public\.)?log_order_submission_activity\s*\(/g)) {
      const open = m.index! + m[0].length - 1
      const third = args(code, open)[2]
      if (third === undefined) continue
      record3(third, f)
    }

    // Direct inserts, which a SECURITY DEFINER function may still make.
    for (const m of code.matchAll(
      /insert into public\.order_submission_activity\s*\(([^)]*)\)\s*values\s*\(/g)) {
      const cols = m[1].split(',').map(c => c.trim())
      const idx = cols.indexOf('action')
      if (idx === -1) continue
      const open = code.indexOf('(', m.index! + m[0].length - 1)
      const value = args(code, open)[idx]
      if (value === undefined) continue
      record3(value, f)
    }
  }
  return out
}

describe('the closed action set', () => {
  const { file, actions } = currentActionSet()

  test('is defined, and by the LATEST migration that touches it', () => {
    // 20261001000000 is the action set's HOME — the file that gathered the
    // scattered definitions into one closed list and stated the rule. It is not
    // permanently the last word: the rule it states is that a migration logging
    // a NEW action extends the set in the same migration, so whichever file did
    // that most recently is the one this must name.
    //
    // 20261009000000 is that file. It adds order_number_reserved and
    // order_number_used and re-emits the whole set in full, which is exactly
    // what 20261001000000 asks of it.
    assert.ok(file.length > 0, 'no migration defines the action constraint')
    assert.equal(file,
      '20261009000000_split_payment_entry_and_order_submission_number_reservation.sql')
  })

  test('still admits every action the earlier phases wrote', () => {
    // Extending must never drop one: an existing row would violate the new
    // constraint and the migration would fail to apply on a real database.
    for (const kept of [
      'submission_created', 'parse_replaced', 'submitted', 'changes_requested',
      'rejected', 'advance_exception_requested', 'advance_exception_approved',
      'advance_exception_rejected', 'finance_verified', 'approved',
      'payment_recorded', 'payment_allocations_moved',
    ]) {
      assert.ok(actions.has(kept), `${kept} was dropped from the set`)
    }
  })

  test('is still CLOSED — the fix must not have opened it', () => {
    const text = readFileSync(join(DIR, file), 'utf8')
    assert.match(text, /check \(action in \(/)
    // The set must still be finite. A migration that dropped the constraint
    // and did not re-add one would let anything through.
    const drops = [...text.matchAll(/drop constraint if exists order_submission_activity_action_check/g)]
    const adds = [...text.matchAll(/add constraint order_submission_activity_action_check/g)]
    assert.equal(drops.length, adds.length, 'the constraint was dropped and not re-added')
  })
})

describe('every action a migration logs', () => {
  const { actions } = currentActionSet()
  const logged = loggedActions()

  test('there ARE logged actions to check, so this is not vacuous', () => {
    assert.ok(logged.size >= 12, `only ${logged.size} logged actions found; the scan is broken`)
  })

  test('is admitted by the constraint', () => {
    const undeclared: string[] = []
    for (const [action, files] of logged) {
      if (!actions.has(action)) undeclared.push(`${action} (${files.join(', ')})`)
    }
    assert.deepEqual(undeclared, [],
      'a migration logs an action the constraint refuses; the write will fail on a real database')
  })

  test('including the one 20260923000000 forgot', () => {
    // Named explicitly, because it is applied to the live database and is the
    // reason this test exists.
    assert.ok(logged.has('billing_percentage_set'))
    assert.ok(actions.has('billing_percentage_set'))
  })

  test('and the nine this branch added', () => {
    for (const a of [
      'billing_percentage_amended_by_admin',
      'client_details_updated', 'client_details_amended_by_admin',
      'schedule_terms_updated', 'schedule_terms_amended_by_admin',
      'correction_requested', 'correction_resolved', 'correction_rejected',
    ]) {
      assert.ok(logged.has(a), `${a} is not logged by any migration`)
      assert.ok(actions.has(a), `${a} is logged but not declared`)
    }
  })
})

describe('the local verification stub', () => {
  test('the migration records WHY this went unseen', () => {
    const text = readFileSync(
      join(DIR, '20261001000000_order_submission_activity_actions.sql'), 'utf8')
    assert.match(text, /did not carry this constraint/)
    assert.match(text, /proves the wrong thing, confidently/)
  })

  test('and that the authority bug was standing in front of it', () => {
    const text = readFileSync(
      join(DIR, '20261001000000_order_submission_activity_actions.sql'), 'utf8')
    assert.match(text, /standing in front of the\s*\n?--\s*logging bug/)
  })
})
