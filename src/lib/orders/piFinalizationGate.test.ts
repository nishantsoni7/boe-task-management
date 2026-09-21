/**
 * PHASE 1: THE MIGRATION ADDS THE GATE AND WIRES IT TO NOTHING.
 *
 * This feature ships in two halves, and the order is the point.
 *
 *   PHASE 1 (this migration)  the three columns, the editors, the seed, and
 *                             assert_order_submission_finalizable sitting
 *                             inert. Purely additive.
 *   PHASE 2 (a later, minimal five wrappers, one `perform` each.
 *            migration)
 *
 * WHY, CONCRETELY. The currently deployed application has no field for
 * client_city and no control for fabric_responsibility. Putting the seven-field
 * assertion in front of the submission doors at the same moment the columns
 * appear would refuse EVERY PI SUBMISSION between applying the migration and
 * deploying the new code — for values nobody could enter — and a failed deploy
 * would leave the Orders module unable to submit at all.
 *
 * SO THIS FILE PROVES THE OPPOSITE OF WHAT IT WILL PROVE LATER. Phase 1 must be
 * invisible to the running application: every submission door exactly as it
 * was, the gate called by none of them. The assertions that the five doors ARE
 * gated live with the Phase 2 migration, where they will be true, rather than
 * being asserted here against a file that deliberately does not do it.
 *
 * The migration's own `do $$` blocks re-derive all of this from pg_proc at
 * apply time, which is the authority. These read the SQL as text so the same
 * properties are checked in review and in CI without a database.
 *
 *   npx tsx --test src/lib/orders/piFinalizationGate.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { PI_FINALIZATION_REQUIREMENTS } from './piReadiness'

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations')
const MIGRATION_FILE = '20261225000000_order_submission_pi_header_terms_and_fabric.sql'
// Line endings are normalised at the door: this repository checks out CRLF on
// Windows and LF elsewhere, and an assertion that matched one and not the other
// would pass or fail by machine rather than by content.
const lf = (s: string) => s.replace(/\r\n/g, '\n')
const SQL = lf(readFileSync(join(MIGRATIONS, MIGRATION_FILE), 'utf8'))

/** Every migration, in apply order. */
const ALL = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()

/** The body of one `create or replace function` in this migration. */
function body(signature: string): string {
  const start = SQL.indexOf(`create or replace function public.${signature}`)
  assert.notEqual(start, -1, `${signature} is not created by ${MIGRATION_FILE}`)
  const end = SQL.indexOf('\n$$;', start)
  assert.notEqual(end, -1, `${signature} has no end`)
  return SQL.slice(start, end)
}

/** Every door that can move a PI out of draft, and its internal. */
const SUBMIT_DOORS = [
  'submit_pi_for_review',
  'submit_order_submission',
  'submit_order_submission_with_note',
  'submit_order_submission_with_advance',
  'submit_order_submission_with_advance_amount',
] as const

// ── 1. PHASE 1 IS INVISIBLE TO THE RUNNING APPLICATION ───────────────────────

describe('this migration is backward-compatible with the deployed application', () => {
  test('IT RE-EMITS NO SUBMISSION DOOR', () => {
    // The whole safety argument. A door re-emitted with the gate in front of it
    // would refuse submissions the moment this is applied, for fields the
    // deployed screens cannot set.
    for (const door of SUBMIT_DOORS) {
      assert.ok(!SQL.includes(`create or replace function public.${door}(`),
        `${door} must not be re-emitted until the new UI is live`)
    }
  })

  test('and therefore nothing calls the gate yet', () => {
    // The function is DEFINED — Phase 2 needs it, and defining it changes
    // nothing — but no caller exists.
    const calls = [...SQL.matchAll(/perform public\.assert_order_submission_finalizable/g)]
    assert.equal(calls.length, 0,
      'Phase 1 must define the gate and wire it to nothing')
  })

  test('it revokes nothing and narrows no grant', () => {
    const revokes = [...SQL.matchAll(/^revoke\s+(?:all|execute)\s+on\s+function\s+public\.(\w+)/gmi)]
      .map(m => m[1])
    // Every revoke in this file is the `revoke … from public, anon` that
    // immediately precedes a grant on a function this file itself creates.
    for (const name of revokes) {
      assert.ok(SQL.includes(`create or replace function public.${name}(`),
        `${name} is revoked but not created here — that would narrow existing access`)
    }
  })

  test('it makes no column NOT NULL and backfills nothing', () => {
    assert.ok(!/set not null/i.test(SQL), 'a NOT NULL would refuse every existing row')
    assert.ok(!/^\s*update public\.order_submissions set/mi.test(
      SQL.replace(/create or replace function[\s\S]*?\n\$\$;/g, '')),
      'the migration body must not rewrite any row')
  })

  test('it changes no approval behaviour', () => {
    for (const fn of ['approve_order_submission', 'approve_pi_review', 'approve_order_pi_revision']) {
      assert.ok(!SQL.includes(`create or replace function public.${fn}`),
        `${fn} must not be re-emitted`)
    }
  })

  test('the one editor it DOES re-emit keeps its signature and grant', () => {
    // update_order_submission_client_details gains client_city in its
    // allow-list. An old caller sends ten keys and never sends the eleventh, so
    // its behaviour is unchanged; the signature and grant must be too.
    assert.ok(SQL.includes(
      'create or replace function public.update_order_submission_client_details(\n  p_submission_id    uuid,\n  p_fields           jsonb,\n  p_expected_version integer default null,\n  p_reason           text default null\n)'),
      'the signature moved, which would orphan every existing caller')
    assert.ok(SQL.includes(
      'grant  execute on function public.update_order_submission_client_details(uuid, jsonb, integer, text) to authenticated;'))
  })

  test('AND THE MIGRATION ASSERTS ALL OF IT AGAINST A LIVE DATABASE', () => {
    // These read text; the migration re-derives from pg_proc at apply time.
    assert.ok(SQL.includes('Phase 1 must leave every submission door alone'),
      'the migration must check, at apply time, that no door gained the gate')
    assert.ok(SQL.includes("has_function_privilege('authenticated', v_col, 'execute')"),
      'and that each door is still callable by exactly whom it was')
  })
})

// ── 2. The gate exists, and says the right things ────────────────────────────

describe('the gate is defined, ready for Phase 2', () => {
  const gate = body('assert_order_submission_finalizable(')

  for (const requirement of PI_FINALIZATION_REQUIREMENTS) {
    test(`it checks ${requirement.key}`, () => {
      assert.ok(gate.includes(requirement.key))
    })
  }

  test('an UNANSWERED fabric question is refused; a deliberate one is not', () => {
    assert.ok(/fabric_responsibility is null/.test(gate),
      'NULL means nobody was asked, and that is the refusal')
    assert.ok(!/fabric_responsibility\s*=\s*'not_selected'/.test(gate),
      "'not selected yet' is one of the three offered answers and must pass")
  })

  test('it reads and raises, and writes nothing', () => {
    assert.ok(/\bstable\b/.test(gate), 'the gate must be STABLE')
    for (const write of ['update public.', 'insert into', 'delete from']) {
      assert.ok(!gate.includes(write), `the gate must not ${write}`)
    }
  })

  test('every message names its own field rather than saying "required fields"', () => {
    const messages = [...gate.matchAll(/ORDER_SUBMISSION_INCOMPLETE: ([^']+)'/g)].map(m => m[1])
    assert.equal(messages.length, 7, 'one message per requirement')
    assert.equal(new Set(messages).size, 7, 'and no two say the same thing')
    for (const message of messages) {
      assert.ok(!/required fields/i.test(message), `"${message}" makes the reader hunt`)
    }
  })
})

// ── 3. The doors Phase 2 will have to cover ──────────────────────────────────

describe('the bypass Phase 2 closes is enumerated, not assumed', () => {
  test('exactly five granted functions can submit a PI', () => {
    // Read every migration for a submission door granted to a browser-reachable
    // role. Phase 2 must cover this list; a name appearing here that it does
    // not cover would be a bypass left open.
    const granted = new Set<string>()
    for (const file of ALL) {
      const sql = lf(readFileSync(join(MIGRATIONS, file), 'utf8'))
      for (const m of sql.matchAll(
        /grant\s+execute\s+on\s+function\s+public\.(submit_\w+)\s*\([^)]*\)\s*(?:\n\s*)?to\s+([a-z_,\s]+);/gi)) {
        const [, name, roles] = m
        if (!/authenticated|anon|public/i.test(roles)) continue
        granted.add(name)
      }
    }
    // Payment requests are a different module and finalize no PI.
    const piDoors = [...granted].filter(n => !n.startsWith('submit_payment_request')).sort()
    assert.deepEqual(piDoors, [...SUBMIT_DOORS].sort(),
      'a submission door exists that the Phase 2 plan does not know about')
  })

  test('THE GAP IS DOCUMENTED, not left for somebody to discover', () => {
    // Between the deploy and Phase 2, the seven-field rule is the screen's
    // alone: an ordinary user cannot submit an incomplete PI, but a direct
    // PostgREST call to one of the five doors can. That window is deliberate
    // and time-boxed, and the file has to say so.
    assert.ok(/KNOWN, TIME-BOXED GAP/.test(SQL),
      'the migration must name the window it leaves open')
    assert.ok(/PHASE 2/.test(SQL), 'and say what closes it')
  })
})

// ── 4. What happens to the records that already exist ────────────────────────

describe('existing records after this migration', () => {
  test('NO COLUMN BACKFILLS HISTORY — the default is set in its own statement', () => {
    // `add column … default` fills every existing row. That would make a PI
    // approved months ago read as though it had always stated these terms, and
    // regenerating its documents would print a condition nobody agreed to.
    const add = SQL.slice(SQL.indexOf('add column if not exists commercial_terms_note'))
      .slice(0, 120)
    assert.ok(!/default/i.test(add),
      'commercial_terms_note must be ADDED without a default')
    assert.ok(/alter column commercial_terms_note\s*\n?\s*set default/i.test(SQL),
      'and the default set afterwards, which applies only to new rows')
  })

  test('neither do the other two', () => {
    for (const column of ['client_city', 'fabric_responsibility']) {
      const add = SQL.slice(SQL.indexOf(`add column if not exists ${column}`)).slice(0, 120)
      assert.ok(!/default/i.test(add), `${column} must have no default`)
    }
  })

  test('and the migration proves at apply time that no row was rewritten', () => {
    for (const column of ['fabric_responsibility', 'commercial_terms_note', 'client_city']) {
      assert.ok(SQL.includes(`where ${column} is not null`),
        `nothing asserts that ${column} was left alone`)
    }
  })

  test('NO TABLE CHECK, so an unrelated update to an old PI still works', () => {
    // A CHECK over `status not in ('draft','needs_changes')` would refuse the
    // next ordinary UPDATE of every PI already submitted — a finance
    // verification, a PI approval — because those rows carry no city and never
    // will. The only CHECK added is the value list on the new column.
    const checks = [...SQL.matchAll(/add constraint (\w+)\s*\n?\s*check/gi)].map(m => m[1])
    assert.deepEqual(checks, ['order_submissions_fabric_responsibility_valid'])
  })

  test('the value CHECK admits NULL, so every existing row satisfies it', () => {
    assert.ok(/check \(fabric_responsibility is null\s*or fabric_responsibility in/.test(SQL.replace(/\s+/g, ' ')),
      'a NULL must pass, or every existing row would violate the constraint')
  })

  test('an already-submitted PI keeps its city and terms but is never asked for them', () => {
    // The editors refuse to EMPTY a value on a submitted PI, which is about
    // keeping a record consistent — not about demanding one it never had.
    // Nothing anywhere requires an old record to acquire the new fields.
    assert.ok(SQL.includes('ORDER_SUBMISSION_CLIENT_CITY_REQUIRED'))
    assert.ok(SQL.includes('ORDER_SUBMISSION_TERMS_REQUIRED'))
    assert.ok(SQL.includes('ORDER_SUBMISSION_FABRIC_RESPONSIBILITY_REQUIRED'))
    // Each fires only when the caller SENT the key and emptied it.
    assert.ok(SQL.includes("v_changes ? 'client_city'"))
  })
})

// ── 5. A re-upload never undoes a person ─────────────────────────────────────

describe('re-uploading a workbook does not overwrite an answer', () => {
  const seed = body('seed_order_submission_pi_terms(')

  test('the fabric answer is written only while nobody has answered', () => {
    assert.ok(seed.includes('v_fabric is not null and fabric_responsibility is null'))
  })

  test('the terms only while they are still untouched', () => {
    // NULL, or still exactly the standard wording the default puts there.
    // Anything else is somebody's edit.
    assert.ok(seed.includes(
      'commercial_terms_note is null or btrim(commercial_terms_note) = c_standard'))
  })

  test('the city only into an empty field', () => {
    assert.ok(seed.includes('v_city is not null and client_city is null'))
  })

  test('THE PARSE WRITER IS NOT TAUGHT TO TOUCH ANY OF THEM', () => {
    // replace_order_submission_parse REPLACES every column it writes on every
    // upload, which is right for a value the workbook is the record of and
    // wrong for these three. It is not re-emitted here, and no later migration
    // may quietly add them.
    assert.ok(!SQL.includes('create or replace function public.replace_order_submission_parse'))
    for (const file of ALL) {
      const sql = lf(readFileSync(join(MIGRATIONS, file), 'utf8'))
      if (!sql.includes('create or replace function public.replace_order_submission_parse')) continue
      for (const column of ['fabric_responsibility', 'commercial_terms_note', 'client_city']) {
        assert.ok(!new RegExp(`^\\s*${column}\\s*=`, 'm').test(sql),
          `${file} makes the parse writer assign ${column}, which would undo an edit on re-upload`)
      }
    }
  })

  test('the seed writes no figure and no status, and leaves no trail of its own', () => {
    for (const column of ['fabric_cost', 'status', 'row_version', 'order_id']) {
      assert.ok(!new RegExp(`\\b${column}\\s*=`).test(seed), `the seed assigns ${column}`)
    }
    // It is part of reading the workbook, not an edit somebody made; the parse
    // it belongs to is what the trail records.
    assert.ok(!seed.includes('log_order_submission_activity'))
    assert.ok(!seed.includes('supersede_order_documents'))
  })

  test('and it is reachable by the service role alone', () => {
    assert.ok(SQL.includes('revoke all on function public.seed_order_submission_pi_terms(uuid, text, text, text)\n  from public, anon, authenticated;'))
    assert.ok(SQL.includes('to service_role;'))
  })
})

// ── 6. The file is structurally sound SQL ────────────────────────────────────

/**
 * WHY THIS EXISTS, AND WHY IT IS NOT PARANOIA.
 *
 * Every function body in this migration is dollar-quoted — `as $$ … $$;` — and
 * a tool that spliced one of them in did so with String.replace, which treats
 * `$$` in a STRING replacement as an escape for a single `$`. Five bodies
 * landed as `as $ … $;`. PostgreSQL would have refused the whole file, so this
 * was never going to reach a database quietly — but it reached a review, and it
 * cost a round trip to find by reading.
 *
 * There is no psql on this machine and no container to apply against, so the
 * migration cannot be executed here. These assertions check the properties that
 * a parse would have caught, which is the part worth having in CI anyway: an
 * unbalanced quote is a defect whether or not a database is nearby.
 */
describe('the migration is structurally sound', () => {
  test('every dollar-quoted body opens and closes', () => {
    const all = (re: RegExp): string[] => SQL.match(re) ?? []
    const opens = all(/^(?:as|do) \$\$$/gm)
    const closes = [...all(/^\$\$;$/gm), ...all(/^end \$\$;$/gm)]
    assert.equal(opens.length, closes.length,
      `${opens.length} bodies open and ${closes.length} close`)
    assert.ok(opens.length >= 6, 'this migration defines several functions and assertion blocks')
  })

  test('NO DELIMITER LOST A DOLLAR', () => {
    // The exact damage: `as $` where `as $$` was meant, and `$;` for `$$;`.
    assert.ok(!/^as \$$/m.test(SQL), 'a function body opens with a single dollar')
    assert.ok(!/^\$;$/m.test(SQL), 'a function body closes with a single dollar')
    assert.ok(!/^do \$$/m.test(SQL), 'an anonymous block opens with a single dollar')
  })

  test('every function it creates is one Phase 1 owns', () => {
    const created = [...SQL.matchAll(/create or replace function public\.(\w+)/g)].map(m => m[1])
    assert.deepEqual([...new Set(created)].sort(), [
      'assert_order_submission_finalizable',
      'seed_order_submission_pi_terms',
      'update_order_submission_client_details',
      'update_order_submission_pi_terms',
    ], 'Phase 1 creates a function it should not — a submission door, perhaps')
  })

  test('and every one of them is SECURITY DEFINER with a pinned search_path', () => {
    const bodies = SQL.split('create or replace function public.').slice(1)
    for (const b of bodies) {
      const name = b.slice(0, b.indexOf('('))
      assert.ok(/security definer/.test(b.slice(0, 400)), `${name} is not SECURITY DEFINER`)
      assert.ok(/set search_path = public, pg_temp/.test(b.slice(0, 400)),
        `${name} does not pin search_path`)
    }
  })

  test('it alters only order_submissions, and adds only the three columns', () => {
    const altered = [...SQL.matchAll(/alter table (?:if exists )?public\.(\w+)/g)].map(m => m[1])
    assert.deepEqual([...new Set(altered)], ['order_submissions'])
    const added = [...SQL.matchAll(/add column if not exists (\w+)/g)].map(m => m[1])
    assert.deepEqual([...new Set(added)].sort(),
      ['client_city', 'commercial_terms_note', 'fabric_responsibility'])
  })

  test('it writes no row of business data', () => {
    // A migration that UPDATEs or INSERTs business rows is changing production
    // data, which this one must never do. The only DML is none.
    for (const dml of [/^\s*update public\.order_submissions set/mi, /^\s*insert into public\./mi, /^\s*delete from public\./mi]) {
      assert.ok(!dml.test(SQL.replace(/create or replace function[\s\S]*?\n\$\$;/g, '')),
        'the migration body runs DML against a business table')
    }
  })
})
