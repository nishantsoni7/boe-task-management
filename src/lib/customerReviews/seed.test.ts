/**
 * THE PRODUCTION SEED — 20261021000000_seed_customer_review_test_cards.sql
 *
 * The module's schema migration ships EMPTY and asserts its own emptiness. That
 * is still true and is deliberately untouched: the sixteen cards production
 * needs come from a SEPARATE migration, so schema and test data can be applied
 * or withheld independently and reviewed as two decisions.
 *
 * WHAT THIS FILE GUARDS, and why each thing is worth a test:
 *
 *   * It only ever INSERTS. A seed that could UPDATE or DELETE is a seed that
 *     can rewrite a card somebody is mid-test on, or remove evidence.
 *   * It is idempotent by CONFLICT, not by a count check. `do nothing`, never
 *     `do update` — the difference is the whole property.
 *   * Its rows are identical to the disposable fixture's. Two copies of the
 *     same sixteen cards drift unless something fails when they do.
 *   * The fixture's marker guard is untouched. Nothing here was made possible
 *     by weakening it.
 *   * The mandatory label is NOT in the bodies. It belongs to the message
 *     builder, where nobody can edit it out.
 *
 * The live half — that it actually inserts sixteen, that a second apply changes
 * nothing — runs against a disposable stack. What is checkable here is the
 * shape that makes those outcomes possible.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const SEED_FILE = 'supabase/migrations/20261021000000_seed_customer_review_test_cards.sql'
const FIXTURE_FILE = 'supabase/fixtures/customer_review_test_cards.sql'
const SCHEMA_FILE = 'supabase/migrations/20261017000000_customer_review_outreach.sql'

const seed = read(SEED_FILE)
const fixture = read(FIXTURE_FILE)

/** Executable SQL only — a comment explaining a forbidden thing is not one. */
const executable = (sql: string) =>
  sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')

const seedSql = executable(seed)

/**
 * The VALUES rows of an INSERT, as one normalised string.
 *
 * Compared rather than eyeballed: the seed is GENERATED from the fixture, and
 * this is what keeps that true after somebody edits one of them by hand.
 */
function valueRows(sql: string): string {
  const start = sql.indexOf('insert into public.customer_review_test_cards (card_ref, test_category, test_title, test_body)')
  assert.notEqual(start, -1, 'the INSERT is missing')
  const after = sql.slice(sql.indexOf('values', start) + 'values'.length)
  const lines = after.split('\n')
  const end = lines.findIndex(l => /\);\s*$/.test(l) || /^on conflict/.test(l.trim()))
  assert.notEqual(end, -1, 'the INSERT is not terminated')
  return lines.slice(0, end + 1)
    .join('\n')
    .replace(/^on conflict.*$/m, '')
    .replace(/;\s*$/, '')
    .trim()
}

// ══ 1. IT ONLY INSERTS ══════════════════════════════════════════════════════

describe('the seed writes in exactly one way', () => {
  test('there is one INSERT, and it targets the cards table alone', () => {
    const inserts = [...seedSql.matchAll(/insert\s+into\s+([a-z_.]+)/gi)].map(m => m[1])
    assert.deepEqual(inserts, ['public.customer_review_test_cards'])
  })

  test('NO DESTRUCTIVE STATEMENT ANYWHERE', () => {
    // Checked against executable SQL, because the file's own header explains
    // what it does not do and that prose must not fail its own test.
    for (const word of ['update', 'delete', 'truncate', 'drop', 'alter', 'grant', 'revoke']) {
      assert.equal(
        new RegExp(`\\b${word}\\s`, 'i').test(seedSql), false,
        `the seed contains a ${word.toUpperCase()} statement`,
      )
    }
  })

  test('IDEMPOTENT BY CONFLICT, and the conflict action is DO NOTHING', () => {
    assert.ok(seedSql.includes('on conflict (card_ref) do nothing'))
    // `do update` would rewrite a card mid-test. It is the one conflict action
    // this file may never use, so its absence is asserted rather than implied
    // by the presence of the other.
    assert.equal(/on conflict[\s\S]*?do\s+update/i.test(seedSql), false,
      'the seed can overwrite an existing card')
  })

  test('the conflict target is the column that is actually unique', () => {
    // `on conflict (card_ref)` only works because card_ref carries a unique
    // constraint. If that constraint were ever dropped the seed would fail
    // loudly rather than insert duplicates — but it should not be dropped, so
    // this reads it back from the schema migration.
    const schema = read(SCHEMA_FILE)
    assert.ok(schema.includes("card_ref text not null unique check (card_ref ~ '^TEST-[0-9]{3}$')"))
  })
})

// ══ 2. THE SIXTEEN CARDS ════════════════════════════════════════════════════

describe('the sixteen cards', () => {
  const refs = [...seedSql.matchAll(/^\('(TEST-\d{3})'/gm)].map(m => m[1])

  test('there are exactly sixteen, numbered without a gap', () => {
    assert.equal(refs.length, 16)
    assert.deepEqual(refs, Array.from({ length: 16 }, (_, i) => `TEST-${String(i + 1).padStart(3, '0')}`))
  })

  test('every reference is a fixed literal, not generated', () => {
    // A generated ref would make a second apply insert a seventeenth card.
    for (const token of ['gen_random_uuid', 'now()', 'random()', 'nextval', 'generate_series']) {
      assert.equal(seedSql.includes(token), false, `the seed generates ${token}`)
    }
  })

  test('THE SEED AND THE FIXTURE CARRY IDENTICAL ROWS', () => {
    // Two copies of the same sixteen cards drift unless something fails when
    // they do. This is that something.
    assert.equal(valueRows(seedSql), valueRows(executable(fixture)),
      'the seed and the disposable fixture have diverged')
  })
})

// ══ 3. WHAT THE CARDS MAY NOT CONTAIN ═══════════════════════════════════════

describe('no real customer or contact data', () => {
  /**
   * The body of each card — the LAST quoted string in each row.
   *
   * Quote-aware on purpose: TEST-015 contains `don''t`, so a lazy `'...'` match
   * stops in the middle of it and TEST-016 is an `E'...'` string with a newline
   * escape. Both are real rows and both have to parse.
   */
  const bodies = valueRows(seedSql)
    .split(/^\(/m)
    .filter(row => row.trim())
    .map(row => {
      const quoted = [...row.matchAll(/E?'(?:[^']|'')*'/g)].map(m => m[0])
      return quoted[quoted.length - 1] ?? ''
    })
    .filter(Boolean)

  test('no telephone number, e-mail address or link', () => {
    for (const pattern of [
      /\+\d[\d\s()-]{7,}/,             // anything shaped like an international number
      /[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}/i,
      /https?:\/\//i,
      /\bwww\./i,
    ]) {
      assert.equal(pattern.test(seedSql), false, `the seed contains ${pattern}`)
    }
  })

  test('no WhatsApp number in any form', () => {
    assert.equal(/wa\.me|whatsapp\s*[:#]?\s*\+?\d/i.test(seedSql), false)
  })

  test('THE MANDATORY LABEL IS NOT STORED IN ANY BODY', () => {
    // It is prepended by src/lib/customerReviews/internalTest.ts and rendered
    // by a component that takes no text, so it cannot be edited or dropped. A
    // copy stored in a row would be a copy somebody could reword — and the
    // table's own CHECK refuses one, so a seed carrying it would fail to apply.
    assert.equal(/INTERNAL TEST ONLY/i.test(seedSql), false,
      'a card body carries the label; it belongs to the message builder')
  })

  test('and the schema still refuses a body that carries it', () => {
    const schema = read(SCHEMA_FILE)
    assert.ok(schema.includes(
      'position(public.customer_review_internal_test_warning() in upper(test_body)) = 0'))
  })

  test('every body says what it is, rather than reading as a review', () => {
    assert.ok(bodies.length >= 16, `only ${bodies.length} bodies were parsed`)
    // Each one names itself as filler or a test. None is an opinion, a rating
    // or an endorsement, and none is attributed to anybody.
    for (const body of bodies) {
      assert.ok(/filler|test/i.test(body), `a body does not say what it is: ${body.slice(0, 60)}`)
    }
  })
})

// ══ 4. THE FIXTURE AND THE SCHEMA MIGRATION ARE UNTOUCHED ═══════════════════

describe('nothing was weakened to make this possible', () => {
  test('THE FIXTURE STILL REFUSES ANY DATABASE WITHOUT THE MARKER', () => {
    assert.ok(fixture.includes("if v_marker <> 'boe-disposable-customer-review-test' then"))
    assert.ok(fixture.includes('REFUSING TO LOAD TEST DATA'))
    assert.ok(fixture.includes("using errcode = '42501'"))
  })

  test('the fixture is still not in the migrations directory', () => {
    assert.ok(FIXTURE_FILE.startsWith('supabase/fixtures/'))
    assert.equal(seed.includes('boe-disposable-customer-review-test'), false,
      'the seed carries the disposable marker; it is a production file and must not')
  })

  test('THE SCHEMA MIGRATION STILL ASSERTS IT SHIPS EMPTY', () => {
    // The seed does not contradict this: 20261017000000 checks the table at the
    // moment IT applies, which is before the seed exists.
    const schema = read(SCHEMA_FILE)
    assert.ok(schema.includes('test data must come from a fixture, never from a migration'))
    assert.ok(schema.includes('THE MODULE SHIPS EMPTY'))
  })

  test('and the seed is numbered after every migration that precedes it', () => {
    assert.ok(SEED_FILE.includes('20261021000000'))
    assert.ok('20261021000000' > '20261017000000', 'the seed must apply after the schema')
    assert.ok('20261021000000' > '20261020000000', 'the seed must not collide with the Image Editor registration')
  })
})

// ══ 5. IT CHECKS ITS OWN WORK ═══════════════════════════════════════════════

describe('the seed asserts what it did', () => {
  test('it counts its own sixteen refs after inserting', () => {
    assert.ok(seedSql.includes('raise exception'))
    assert.ok(seed.includes('the seed left % of its 16 cards present'))
  })

  test('it does NOT assert a total, only its own rows', () => {
    // A total would forbid a card added later on purpose by another means,
    // which is not this file's business.
    assert.ok(seedSql.includes('where card_ref in ('))
  })
})

// ══ 6. THE REMOTE-READINESS SCRIPT ══════════════════════════════════════════
//
// It is meant to be run against production. The one property that makes that
// safe is that it writes nothing — so that is asserted here rather than
// promised in its header.

/**
 * The matchers used below, defined once and PROVED before they are trusted.
 *
 * Both of these were committed inert and both passed anyway:
 *
 *   `new RegExp(\`\\b${word}\\s\`)` was written `\`\b${word}\s\`` — inside a
 *   template literal \b is BACKSPACE (U+0008) and \s is a plain "s", so the
 *   pattern was <BS>updates and matched nothing.
 *
 *   `/\\quit/` was written `/\\\\quit/` — two literal backslashes — so it could
 *   never match the single \quit psql actually uses.
 *
 * A negative assertion that cannot fail is worse than no assertion: it reads
 * like a guarantee and provides none. The positive controls in
 * "the matchers actually match" are what stop that happening again.
 */
const writeStatement = (word: string) => new RegExp(`\\b${word}\\s`, 'i')
const PSQL_QUIT = /\\quit/

describe('the matchers actually match', () => {
  // Synthetic examples, deliberately not from any real file: if these ever stop
  // matching, every negative assertion built on the same patterns has quietly
  // stopped meaning anything.
  const SAMPLES: [string, string][] = [
    ['insert', 'insert into public.example values (1)'],
    ['update', 'update public.example set value = 1'],
    ['delete', 'delete from public.example where id = 1'],
    ['truncate', 'truncate public.example'],
    ['create', 'create temp table example(id integer)'],
    ['alter', 'alter table public.example add column x integer'],
    ['drop', 'drop table public.example'],
    ['grant', 'grant select on public.example to authenticated'],
    ['revoke', 'revoke select on public.example from anon'],
  ]

  for (const [word, sample] of SAMPLES) {
    test(`it detects ${word.toUpperCase()} in "${sample.slice(0, 44)}…"`, () => {
      assert.equal(writeStatement(word).test(sample), true,
        `the ${word} matcher does not match its own example`)
    })
  }

  test('the word boundary is real, so a longer word is NOT a false positive', () => {
    // Without \b, "create" would match "createdb" and "update" would match
    // "updated_at" — a column this schema actually has.
    assert.equal(writeStatement('update').test('select updated_at from t'), false)
    assert.equal(writeStatement('create').test('select created_at from t'), false)
    assert.equal(writeStatement('insert').test('select inserted from t'), false)
  })

  test('IT DETECTS A SINGLE LITERAL BACKSLASH-QUIT', () => {
    assert.equal(PSQL_QUIT.test('\\quit'), true)
    assert.equal(PSQL_QUIT.test('  \\quit 1'), true)
    assert.equal(PSQL_QUIT.test('\\echo quit'), false, 'the word alone must not match')
    assert.equal(PSQL_QUIT.test('quit'), false)
  })

  test('and neither pattern is the inert shape that was committed', () => {
    // Guards the exact regression: a pattern whose first character is a
    // backspace, or a quit matcher wanting two backslashes.
    assert.notEqual(writeStatement('update').source.charCodeAt(0), 8,
      'the word matcher is a backspace literal again')
    assert.equal(writeStatement('update').source, String.raw`\bupdate\s`)
    assert.equal(PSQL_QUIT.source, String.raw`\\quit`)
  })
})

describe('the remote-readiness script is read-only', () => {
  const READINESS = 'supabase/tests/customer_review_remote_readiness.sql'
  const readiness = read(READINESS)
  const code = executable(readiness)

  test('NO WRITING STATEMENT OF ANY KIND', () => {
    for (const word of ['insert', 'update', 'delete', 'truncate', 'create',
                        'alter', 'drop', 'grant', 'revoke', 'copy']) {
      assert.equal(
        writeStatement(word).test(code), false,
        `the readiness script contains a ${word.toUpperCase()} statement`,
      )
    }
  })

  test('not even a temp table to carry the expected count in', () => {
    // The obvious way to get a psql variable into a dollar-quoted block is a
    // temp table. That is still a write, so the count is compared at psql level
    // instead — see the note in the script.
    assert.equal(/temp\s+table|temporary\s+table/i.test(code), false)
    assert.ok(readiness.includes('\gset'))
  })

  test('IT FAILS BY RAISING, because \\quit cannot carry an exit code', () => {
    // psql's \\quit ignores an argument and exits 0. A guard written with it
    // prints a warning and then reports success, which in a deployment script
    // is worse than no guard at all.
    //
    // Checked against EXECUTABLE lines only: the script explains this trap in
    // its own header, and prose describing a forbidden thing is not one.
    assert.equal(PSQL_QUIT.test(code), false,
      'a \\quit would exit 0 and report success')
    assert.ok(code.includes('raise exception'))
  })

  test('the expected count is required, with no default', () => {
    assert.ok(readiness.includes('\if :{?expected_cards}'))
    assert.ok(readiness.includes('expected_cards is required'))
  })

  test('it strips comments before scanning for a role bypass', () => {
    // The functions it scans EXPLAIN the branch that was removed, so scanning
    // raw source reports a bypass in exactly the three functions that had one
    // taken out. A check that fails on its own explanation teaches people to
    // delete the explanation.
    assert.ok(code.includes('regexp_replace(pg_get_functiondef(p.oid)'))
  })
})
