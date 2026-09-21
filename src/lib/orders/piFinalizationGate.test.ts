/**
 * EVERY DOOR THAT CAN FINALIZE A PI, AND WHAT HAPPENS TO THE RECORDS THAT
 * ALREADY EXIST.
 *
 * The migration's own `do $$` blocks assert all of this against a live
 * database, which is the authority. These tests read the SQL as text, so the
 * same properties are checked in review and in CI without a database — and so
 * that removing one of them from the migration fails something.
 *
 * WHY A TEST FILE FOR A BYPASS. The first cut of this work gated
 * submit_pi_for_review and recorded in the migration header that the four
 * legacy doors were "not wrapped… no screen has called them". That was true
 * and irrelevant: all four are still `grant execute … to authenticated`, and
 * PostgREST exposes every granted function. A PI could have been finalized
 * with no salesperson and no client city by one HTTP request. The lesson is
 * that "no screen calls it" is not the same as "nobody can call it", and these
 * assertions exist so the next person cannot make the same mistake quietly.
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

// ── 1. Every submission door ──────────────────────────────────────────────────

/**
 * The five doors that can move a PI out of draft, and the internal each hands
 * off to. Four of them are the legacy ones no screen calls and every signed-in
 * caller can still reach.
 */
const SUBMIT_DOORS = [
  ['submit_pi_for_review(', 'submit_pi_for_review_internal'],
  ['submit_order_submission(', 'submit_order_submission_internal'],
  ['submit_order_submission_with_note(', 'submit_order_submission_internal'],
  ['submit_order_submission_with_advance(', 'submit_order_submission_advance_internal'],
  ['submit_order_submission_with_advance_amount(', 'submit_order_submission_advance_v2_internal'],
] as const

describe('every callable finalization path runs the gate', () => {
  for (const [door, internal] of SUBMIT_DOORS) {
    test(`${door.slice(0, -1)} refuses an incomplete PI before doing anything`, () => {
      const source = body(door)
      assert.ok(source.includes('assert_order_submission_finalizable'),
        `${door} does not run the gate`)
      // BEFORE, not after. A refusal that arrived after the delegation would
      // be a refusal of a submission that had already happened.
      assert.ok(
        source.indexOf('assert_order_submission_finalizable') < source.indexOf(internal),
        `${door} runs the gate after the work it is meant to gate`)
    })
  }

  test('and the migration asserts the same thing against the live database', () => {
    // These tests read text; the migration re-derives it from pg_proc at apply
    // time. Both must exist, or a hand-edited function could pass here.
    assert.ok(SQL.includes("raise exception 'ASSERTION FAILED: % does not run the finalization gate'"))
    assert.ok(SQL.includes('runs the gate AFTER the work it is meant to gate'))
  })

  test('THE LIST IS COMPLETE — no other granted function can submit a PI', () => {
    // Read every migration for a submission door granted to a browser-reachable
    // role. Any name here that the gate does not cover is a bypass.
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
    assert.deepEqual(piDoors, [
      'submit_order_submission',
      'submit_order_submission_with_advance',
      'submit_order_submission_with_advance_amount',
      'submit_order_submission_with_note',
      'submit_pi_for_review',
    ], 'a submission door exists that these tests do not know about')

    for (const name of piDoors) {
      assert.ok(SUBMIT_DOORS.some(([door]) => door.startsWith(`${name}(`)),
        `${name} is reachable by a browser and is not gated`)
    }
  })

  test('no browser-callable door was quietly opened to anon', () => {
    for (const [door] of SUBMIT_DOORS) {
      const name = door.slice(0, -1)
      const re = new RegExp(`grant\\s+execute\\s+on\\s+function\\s+public\\.${name}\\s*\\([^)]*\\)[\\s\\S]{0,40}?to\\s+([a-z_,\\s]+);`, 'gi')
      for (const m of SQL.matchAll(re)) {
        assert.ok(!/\banon\b|\bpublic\b/.test(m[1]), `${name} is granted to ${m[1].trim()}`)
      }
    }
  })
})

// ── 2. What the gate asks for ─────────────────────────────────────────────────

describe('the gate asks for the seven, and for nothing else', () => {
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

// ── 3. Approval is deliberately NOT gated ─────────────────────────────────────

describe('approval is left alone, so existing records are not stranded', () => {
  test('the migration re-emits no approval function', () => {
    for (const fn of ['approve_order_submission', 'approve_pi_review', 'approve_order_pi_revision']) {
      assert.ok(!SQL.includes(`create or replace function public.${fn}`),
        `${fn} must not be re-emitted here`)
    }
  })

  test('and says why in a form a reader will find', () => {
    assert.ok(/APPROVAL IS DELIBERATELY NOT GATED/.test(SQL))
  })
})

// ── 4. What happens to the records that already exist ─────────────────────────

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

// ── 5. A re-upload never undoes a person ──────────────────────────────────────

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
    assert.ok(opens.length >= 10, 'this migration defines several functions and assertion blocks')
  })

  test('NO DELIMITER LOST A DOLLAR', () => {
    // The exact damage: `as $` where `as $$` was meant, and `$;` for `$$;`.
    assert.ok(!/^as \$$/m.test(SQL), 'a function body opens with a single dollar')
    assert.ok(!/^\$;$/m.test(SQL), 'a function body closes with a single dollar')
    assert.ok(!/^do \$$/m.test(SQL), 'an anonymous block opens with a single dollar')
  })

  test('every function it creates is one this work owns', () => {
    const created = [...SQL.matchAll(/create or replace function public\.(\w+)/g)]
      .map(m => m[1])
    assert.deepEqual([...new Set(created)].sort(), [
      'assert_order_submission_finalizable',
      'seed_order_submission_pi_terms',
      'submit_order_submission',
      'submit_order_submission_with_advance',
      'submit_order_submission_with_advance_amount',
      'submit_order_submission_with_note',
      'submit_pi_for_review',
      'update_order_submission_client_details',
      'update_order_submission_pi_terms',
    ], 'this migration re-emits a function it should not')
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
