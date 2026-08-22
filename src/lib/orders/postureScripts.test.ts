/**
 * THE POSTURE SCRIPTS ARE READ-ONLY, AND THAT IS THE WHOLE PROMISE.
 *
 * Both scripts exist to be run against PRODUCTION, immediately after a
 * migration lands — which is the only place the question "did these properties
 * survive?" actually matters, and the one place the behavioural assertion
 * scripts must never go, because those need fixture rows.
 *
 * Their safety rests entirely on containing no write. A header comment saying
 * so is not a guarantee; somebody adding one helpful INSERT to make a check
 * easier would turn a production-safe diagnostic into a production write, and
 * nothing would stop them. This is what stops them.
 *
 * Run:
 *   npx tsx --test src/lib/orders/postureScripts.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()

const SCRIPTS = [
  'supabase/tests/order_confirmed_handoff_posture.sql',
  'supabase/tests/order_pi_editing_posture.sql',
] as const

/**
 * SQL with its comments AND its string literals removed.
 *
 * Both are necessary, and the second was learned the hard way. The scripts
 * DESCRIBE the writes they do not perform, in order to explain why they are
 * safe — so a scan of the raw text fails on the very sentence promising the
 * property it is checking. Comments were the obvious half. The other half is
 * the FAILURE MESSAGES: `format('a TABLE-wide SELECT grant would expose …')`
 * is a sentence a reader sees, and it contains the word this scan looks for.
 *
 * Stripping the literals loses nothing real. In an actual write the dangerous
 * words are outside the quotes — `insert into t values ('x')` still matches —
 * so what is discarded is exactly the prose and never the statement.
 *
 * Dollar-quoted blocks are deliberately KEPT: the whole body of each script is
 * one `do $$ … $$`, and stripping it would leave nothing to check.
 */
const executable = (sql: string): string => {
  const withoutComments = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map(line => {
      const at = line.indexOf('--')
      return at === -1 ? line : line.slice(0, at)
    })
    .join('\n')

  // Single-quoted literals, with '' as the escape. Replaced by a placeholder
  // rather than removed, so two identifiers either side cannot be joined into
  // a word that was never written.
  return withoutComments.replace(/'(?:[^']|'')*'/g, ' ~ ')
}

describe('the posture scripts write nothing', () => {
  for (const path of SCRIPTS) {
    const code = executable(readFileSync(join(ROOT, path), 'utf8'))

    test(`${path} contains no write statement`, () => {
      // Word-boundary anchored, so `insert into` is caught and a column named
      // `inserted_at` is not.
      for (const verb of [
        'insert\\s+into', 'update\\s+\\w', 'delete\\s+from', 'truncate',
        'drop\\s+', 'create\\s+table', 'create\\s+or\\s+replace',
        'alter\\s+table', 'grant\\s+', 'revoke\\s+',
        'select\\s+.*\\s+for\\s+update', 'copy\\s+',
      ]) {
        const re = new RegExp(`\\b${verb}`, 'i')
        assert.ok(!re.test(code), `${path} contains a write: /${verb}/`)
      }
    })

    test(`${path} opens no transaction to roll back`, () => {
      // A script that needed a ROLLBACK would be one that wrote something. The
      // absence of both is the same claim stated twice, on purpose: an added
      // BEGIN is the first move somebody makes when they want to write.
      for (const verb of ['begin\\s*;', 'commit\\s*;', 'rollback\\s*;', 'savepoint']) {
        assert.ok(!new RegExp(`\\b${verb}`, 'i').test(code),
          `${path} manages a transaction: /${verb}/`)
      }
    })

    test(`${path} reports rather than returning silently`, () => {
      assert.match(code, /raise notice/i, 'it must say when it passed')
      assert.match(code, /raise exception/i, 'and fail loudly when it did not')
    })

    test(`${path} stops on the first error`, () => {
      assert.match(readFileSync(join(ROOT, path), 'utf8'), /\\set ON_ERROR_STOP on/,
        'a posture check that continued past an error could print OK after failing')
    })
  }

  test('the editing script covers all seven pending migrations’ surfaces', () => {
    const code = readFileSync(join(ROOT, SCRIPTS[1]), 'utf8')
    for (const surface of [
      'assert_order_submission_workbook_editor',   // 20261003000000
      'replace_order_submission_parse',            // 20261003000000
      'begin_order_submission_processing',         // 20261003000000
      'update_order_submission_client_details',    // 20260928000000
      'update_order_submission_schedule_terms',    // 20260929000000
      'update_order_submission_item_details',      // 20261002000000
      'reorder_order_submission_items',            // 20261002000000
      'request_order_submission_correction',       // 20260930000000
      'set_order_submission_billing_percentage',   // 20260927000000
      'supersede_order_documents',                 // 20260927000000
      'order_submission_activity_action_check',    // 20261001000000
      'row_version',                               // 20260928000000
    ]) {
      assert.ok(code.includes(surface), `the posture check never mentions ${surface}`)
    }
  })
})
