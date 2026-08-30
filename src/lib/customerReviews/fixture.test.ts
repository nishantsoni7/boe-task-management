/**
 * THE TEST DATA — sixteen cards, and the reasons they cannot reach production.
 *
 * Test data that runs against production IS test data in production, so the
 * fixture lives outside the migration chain and carries its own refusal. This
 * file proves both, and then proves the content is what it claims to be:
 * generic, visibly fictional, attributed to nobody, and not a review.
 *
 * Reads repository files only. No database, no network.
 *
 * Run:
 *   npx tsx --test src/lib/customerReviews/fixture.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { TEST_CATEGORIES } from './types'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const FIXTURE = 'supabase/fixtures/customer_review_test_cards.sql'
const TEARDOWN = 'supabase/fixtures/customer_review_test_cards_clear.sql'
const MIGRATION = 'supabase/migrations/20261017000000_customer_review_outreach.sql'
const MARKER = 'boe-disposable-customer-review-test'

const fixture = read(FIXTURE)
const teardown = read(TEARDOWN)

/** Executable SQL only — both files explain themselves at length up top. */
const sqlOnly = (source: string) =>
  source.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')

const teardownSql = sqlOnly(teardown)

/**
 * The header comments, read as prose.
 *
 * Two steps, and both are needed. The comments wrap at 79 characters, so a
 * sentence a test wants to find is split across two lines — and each
 * continuation line starts with its own `--`, so collapsing the whitespace
 * alone leaves the marker sitting in the middle of the sentence. The marker
 * comes off first, then the line breaks.
 */
const prose = (source: string) =>
  source
    .split('\n')
    .map(l => l.replace(/^\s*--\s?/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')

/** ('TEST-001', 'restaurant_test', 'title', 'body') — one tuple per card. */
function cards(): { ref: string; category: string; title: string; body: string }[] {
  const out: { ref: string; category: string; title: string; body: string }[] = []
  const re = /\('(TEST-\d{3})',\s*'([a-z_]+)',\s*'((?:[^']|'')*)',\s*E?'((?:[^']|'')*)'\)/g
  for (const m of fixture.matchAll(re)) {
    out.push({
      ref: m[1],
      category: m[2],
      title: m[3].replace(/''/g, "'"),
      body: m[4].replace(/''/g, "'"),
    })
  }
  return out
}

const CARDS = cards()

describe('IT CANNOT RUN AGAINST PRODUCTION', () => {
  test('THIS FILE is not a migration, and no fixture is', () => {
    const migrations = readdirSync(join(ROOT, 'supabase/migrations'))

    // NO FIXTURE IS IN THE CHAIN. That is the property, and it is unchanged.
    assert.equal(migrations.some(f => f.includes('fixture')), false)
    assert.ok(FIXTURE.startsWith('supabase/fixtures/'))
    assert.equal(migrations.includes('customer_review_test_cards.sql'), false)

    // THE FILENAME PROXY IS GONE, and it is worth saying why rather than just
    // deleting it. This used to read "no migration filename contains
    // test_card", which was an accurate stand-in for "the fixture is not in the
    // chain" right up until a migration legitimately carried card data.
    //
    // 20261021000000 is that migration: the production seed, which holds the
    // same sixteen rows so a deployed module has something to book. It is named
    // here rather than admitted by loosening the rule, so a SECOND unexplained
    // card-carrying migration still fails.
    assert.deepEqual(
      migrations.filter(f => f.includes('test_card')),
      ['20261021000000_seed_customer_review_test_cards.sql'],
    )
  })

  test('AND THE SEED IS THE ONLY MIGRATION THAT MAY INSERT A CARD', () => {
    // The boundary this file exists to defend, restated for the world where a
    // production seed exists: exactly one migration inserts cards, and it is
    // the one that says so in its name.
    const dir = join(ROOT, 'supabase/migrations')
    const inserters = readdirSync(dir)
      .filter(f => f.endsWith('.sql'))
      .filter(f => /insert\s+into\s+public\.customer_review_test_cards/i.test(
        readFileSync(join(dir, f), 'utf8')
          .split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')))
    assert.deepEqual(inserters, ['20261021000000_seed_customer_review_test_cards.sql'])
  })

  test('and the seed carries no marker guard, because it is a production file', () => {
    // The fixture's guard is what keeps IT out of production. The seed is meant
    // to run there, so it has none — and must not gain one, or it would refuse
    // the only database it exists for.
    const seed = read('supabase/migrations/20261021000000_seed_customer_review_test_cards.sql')
    assert.equal(seed.includes(MARKER), false)
    assert.equal(seed.includes('REFUSING TO LOAD TEST DATA'), false)
  })

  test('THE MIGRATION INSERTS NO CARDS, and asserts that about itself', () => {
    const migration = read(MIGRATION)
    const code = migration.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')
    assert.equal(/insert into public\.customer_review_test_cards/.test(code), false)
    assert.ok(code.includes('test data must come from a fixture, never from a migration'))
  })

  test('THE FIXTURE REFUSES ANY DATABASE WITHOUT THE DISPOSABLE MARKER', () => {
    // The property that matters, and it belongs to THIS FILE rather than to the
    // harness around it: a guard that only exists in the runner protects only
    // the people who use the runner. Pointing psql at production and running
    // this file raises and inserts nothing.
    const guard = fixture.slice(0, fixture.indexOf('insert into'))
    assert.ok(guard.includes("shobj_description(oid, 'pg_database')"))
    assert.ok(guard.includes(`v_marker <> '${MARKER}'`))
    assert.ok(guard.includes('REFUSING TO LOAD TEST DATA'))
    assert.ok(guard.includes("errcode = '42501'"))
  })

  test('the guard runs BEFORE the first insert, not after', () => {
    assert.ok(fixture.indexOf('REFUSING TO LOAD TEST DATA') < fixture.indexOf('insert into'))
  })

  test('THE TEARDOWN CARRIES THE SAME GUARD, because a DELETE is worse', () => {
    assert.ok(teardown.includes(`v_marker <> '${MARKER}'`))
    assert.ok(teardown.includes('REFUSING TO CLEAR TEST DATA'))
    // Ordered against the EXECUTABLE SQL: the header comment explains what the
    // file does not do ("it does not `delete from ...` unqualified") long
    // before the guard, and searching the raw text finds that explanation.
    assert.ok(teardownSql.indexOf('REFUSING TO CLEAR') < teardownSql.indexOf('delete from'))
  })

  test('the teardown removes exactly what the fixture inserts, by reference', () => {
    // Not TRUNCATE, and not an unqualified DELETE: a teardown that clears more
    // than its fixture created is one that will eventually clear something
    // somebody wanted.
    assert.equal(/truncate/i.test(teardownSql), false)
    const listed = [...teardownSql.matchAll(/'(TEST-\d{3})'/g)].map(m => m[1]).sort()
    assert.deepEqual(listed, CARDS.map(c => c.ref).sort())
    assert.equal((teardownSql.match(/delete from/g) ?? []).length, 1)
    assert.ok(teardownSql.includes('where card_ref in ('))
  })

  test('the runner loads it as its own explicitly-numbered step', () => {
    const runner = read('supabase/tests/run_customer_review_outreach_local.sh')
    assert.ok(runner.includes(`FIXTURE="${FIXTURE}"`))

    // The step number is derived rather than hard-coded, so adding a step to
    // the runner is not a test failure — but MISNUMBERING one still is. The
    // fixture must be step 9 of however many the runner declares, because the
    // concurrency probe that follows it deliberately runs against a database
    // the fixture has already populated.
    const total = /══ all (\w+) steps passed/.exec(runner)?.[1]
    assert.ok(total, 'the runner no longer says how many steps it has')
    const totals = [...runner.matchAll(/══ \$?\w*\/(\d+)/g)].map(m => m[1])
    assert.ok(totals.length > 0, 'the runner has no numbered steps at all')
    assert.equal(new Set(totals).size, 1,
      `the runner's steps disagree about the total: ${[...new Set(totals)].join(', ')}`)
    assert.ok(runner.includes(`9/${totals[0]}`), 'the fixture is not step 9')

    // ...and checks that all sixteen landed, rather than assuming.
    assert.ok(runner.includes('the fixture loaded $LOADED card(s), expected 16'))
  })

  test('and the step after it proves the screenshot index under real concurrency', () => {
    // The fixture step is followed by a probe that runs two psql PROCESSES at
    // one card. It is in this file's care because it depends on the runner's
    // step numbering staying coherent — and because a probe that silently
    // stopped racing would still print a pass.
    const runner = read('supabase/tests/run_customer_review_outreach_local.sh')
    assert.ok(runner.includes('10/10'), 'the concurrency probe is not the tenth step')

    // Two background processes, waited on separately.
    assert.equal((runner.match(/race_insert .*&$/gm) ?? []).length, 2,
      'the probe does not start two concurrent sessions')
    assert.ok(runner.includes('wait "$PID_A"') && runner.includes('wait "$PID_B"'))

    // Output goes to files, not to variables assigned inside a background
    // subshell — that assignment never reaches the parent, and the checks below
    // would read an empty string and pass on nothing.
    assert.ok(runner.includes('RACE_DIR'))
    assert.equal(/RACE_\w+_OUT="\$\(/.test(runner), false,
      'the probe assigns a background subshell’s output to a variable')

    // And it fails for the right reasons: one row left, and the loser refused
    // BY THE NAMED INDEX rather than by a deadlock or a dropped connection.
    assert.ok(runner.includes('The partial unique index is not doing its job'))
    assert.ok(runner.includes('duplicate key value'))
    assert.ok(runner.includes('customer_review_screenshot_one_live_per_card'))
  })

  test('both files say how they are loaded and cleared', () => {
    assert.ok(fixture.includes('HOW IT IS LOADED'))
    assert.ok(fixture.includes('HOW IT IS CLEARED'))
    assert.ok(fixture.includes('customer_review_test_cards_clear.sql'))
    assert.ok(teardown.includes('HOW IT IS LOADED'))
  })
})

describe('the sixteen cards', () => {
  test('there are sixteen, numbered without a gap', () => {
    assert.equal(CARDS.length, 16)
    assert.deepEqual(
      CARDS.map(c => c.ref),
      Array.from({ length: 16 }, (_, i) => `TEST-${String(i + 1).padStart(3, '0')}`),
    )
  })

  test('every one of the ten categories is covered', () => {
    const used = new Set(CARDS.map(c => c.category))
    for (const category of TEST_CATEGORIES) {
      assert.ok(used.has(category), `no card covers ${category}`)
    }
  })

  test('and every category used is one the schema accepts', () => {
    for (const c of CARDS) {
      assert.ok((TEST_CATEGORIES as readonly string[]).includes(c.category), `${c.ref}: ${c.category}`)
    }
  })

  test('SHORT, MEDIUM AND LONG bodies are all present', () => {
    // The fixture exists to exercise layout, so the range has to be real.
    const lengths = CARDS.map(c => c.body.length)
    assert.ok(Math.min(...lengths) < 150, 'no short body')
    assert.ok(lengths.some(n => n >= 250 && n < 500), 'no medium body')
    assert.ok(Math.max(...lengths) > 600, 'no long body')
  })

  test('every body fits the column’s CHECK constraint', () => {
    for (const c of CARDS) {
      assert.ok(c.body.length >= 20, `${c.ref} is too short`)
      assert.ok(c.body.length <= 900, `${c.ref} is ${c.body.length} characters, over the 900 limit`)
      assert.ok(c.title.length <= 120, `${c.ref} has a title over 120 characters`)
    }
  })

  test('the awkward shapes are covered: a long token, punctuation, a newline', () => {
    assert.ok(CARDS.some(c => c.body.split(/\s/).some(w => w.length > 40)),
      'no card exercises an unbroken token')
    assert.ok(CARDS.some(c => /["&+%#]/.test(c.body)),
      'no card exercises punctuation encoding')
    assert.ok(fixture.includes("E'"), 'no card exercises a newline in the body')
  })
})

describe('none of it is a review, and none of it is anybody’s', () => {
  test('NO CARD CARRIES ITS OWN COPY OF THE MANDATORY LABEL', () => {
    // The label is prepended by trusted code and rendered by a component that
    // takes no text. A copy stored in a row would be one an editor could
    // reword — which is why the column's CHECK refuses it, and why the fixture
    // must not try.
    for (const c of CARDS) {
      assert.equal(
        c.body.toUpperCase().includes('INTERNAL TEST ONLY'), false,
        `${c.ref} embeds the label in its body`,
      )
    }
  })

  test('NO CARD CONTAINS A LINK OF ANY KIND', () => {
    for (const c of CARDS) {
      assert.equal(/https?:\/\/|www\.|wa\.me/i.test(c.body), false, `${c.ref} contains a link`)
      assert.equal(/https?:\/\/|www\./i.test(c.title), false, `${c.ref} has a link in its title`)
    }
  })

  test('NO CARD READS AS AN ENDORSEMENT', () => {
    // The restriction that matters most. These are layout fixtures; a sentence
    // that could be lifted out and read as a customer's opinion would be a
    // fabricated review, whatever the surrounding label said.
    for (const c of CARDS) {
      const lower = c.body.toLowerCase()
      for (const phrase of [
        'excellent', 'wonderful', 'delighted', 'highly recommend', 'recommend',
        'great service', 'love the', 'loved the', 'best quality', 'very happy',
        'thank you', 'thanks to', 'five star', '5 star', 'stars',
      ]) {
        assert.equal(lower.includes(phrase), false, `${c.ref} reads as an endorsement: "${phrase}"`)
      }
    }
  })

  test('NO CARD IS ATTRIBUTED TO A PERSON, A COMPANY OR A PLACE', () => {
    for (const c of CARDS) {
      // No first-person account of an experience.
      assert.equal(/\bI\s+(ordered|bought|visited|received|got|had)\b/.test(c.body), false,
        `${c.ref} is written in the first person about an event`)
      // No signature, no attribution.
      assert.equal(/[-—]\s*[A-Z][a-z]+\s+[A-Z]/.test(c.body), false, `${c.ref} looks signed`)
      // No email, no phone, no handle.
      assert.equal(/@|\+\d{6,}/.test(c.body), false, `${c.ref} contains contact details`)
    }
  })

  test('EVERY CARD SAYS WHAT IT IS, IN ITS OWN FIRST SENTENCE', () => {
    // So a fragment read out of context — in a screenshot, in a notification
    // preview — still identifies itself as filler.
    for (const c of CARDS) {
      const first = c.body.split('.')[0].toLowerCase()
      assert.ok(
        first.includes('test') || first.includes('filler') || first.includes('placeholder'),
        `${c.ref} does not identify itself as a test in its first sentence: "${first}"`,
      )
    }
  })

  test('every title names itself a layout or message test too', () => {
    for (const c of CARDS) {
      assert.ok(/test/i.test(c.title), `${c.ref} has a title that does not say it is a test`)
    }
  })

  test('the file states, in writing, that none of it is copied from anywhere', () => {
    assert.ok(prose(fixture).includes('None of it is copied, adapted or paraphrased from any real review'))
    assert.ok(fixture.includes('NONE OF IT IS A REVIEW'))
  })
})
