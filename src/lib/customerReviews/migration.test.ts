/**
 * The migration, audited against the SQL text.
 *
 * WHY A TEXT AUDIT. This migration is not applied to production, and CI has no
 * database to introspect, so what this file can prove is that the SQL says what
 * it must say: RLS on every table, no unconditional policy, an append-only
 * trail, NO client write privilege on the card table at all, storage policies
 * keyed on the card id, and a transition table identical to the browser's copy
 * in ./status.ts.
 *
 * AND WHY A TEXT AUDIT IS NOT ENOUGH. An earlier round of this module passed
 * every check here while its create button was impossible: the SELECT policy
 * re-read its own table, so `INSERT ... RETURNING` could never satisfy it.
 * Reading the SQL did not reveal that; executing it did, immediately. The
 * behavioural counterpart is
 * supabase/tests/customer_review_test_card_assertions.sql, and the two are
 * meant to be run together.
 *
 * The transition-table comparison is the point of the whole file. The UI's
 * table and the database's are two copies of one rule, and a divergence would
 * mean either a button that gets refused or — far worse — a move the screen
 * forbids and the database permits.
 *
 * Reads repository files only. No database, no network.
 *
 * Run:
 *   npx tsx --test src/lib/customerReviews/migration.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { TEST_CARD_TRANSITIONS } from './status'
import { TEST_CARD_STATUSES, TEST_CATEGORIES } from './types'

const ROOT = process.cwd()
const MIGRATIONS = join(ROOT, 'supabase/migrations')
const FILE = '20261017000000_customer_review_outreach.sql'

const lf = (s: string) => s.replace(/\r\n/g, '\n')
const sql = lf(readFileSync(join(MIGRATIONS, FILE), 'utf8'))
/** Executable SQL only — comments explain, they do not run. */
const code = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')

const CARDS = 'public.customer_review_test_cards'
const SHOTS = 'public.customer_review_test_card_screenshots'
const EVENTS = 'public.customer_review_test_card_events'

describe('the migration is one file, correctly sequenced', () => {
  test('it exists, and everything sitting behind it is accounted for', () => {
    const all = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()
    assert.ok(all.includes(FILE), 'the migration file is missing')

    // THIS FILE IS NO LONGER THE NEWEST, and that is fine. It was when the
    // branch was cut; main has since added two migrations numbered above it.
    // Both are unapplied and neither touches anything this module creates, so
    // whatever order the branches merge in, this one still applies before them
    // and after everything that came earlier.
    //
    // They are NAMED rather than allowed by a loosened rule: a third file
    // appearing behind this one still fails here and still has to be accounted
    // for on purpose. That is the property the original "is the head"
    // assertion was really defending.
    assert.deepEqual(all.slice(all.indexOf(FILE) + 1), [
      '20261018000000_unpin_tasks_submitted_for_approval.sql',
      '20261020000000_register_image_editor_module.sql',
      // The production seed for THIS module. It must sit behind the schema —
      // it inserts into tables this file creates — and the filename ordering
      // is what guarantees that whatever sequence the branches merge in.
      '20261021000000_seed_customer_review_test_cards.sql',
      // The Image Editor's result history, from a separate branch. Higher
      // still, unapplied, and it touches nothing this module creates.
      '20261022000000_image_editor_result_history.sql',
      // The drafts migration: it rewrites the still-available cards and adds
      // the batch table, so it applies after both the schema and the seed.
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
      // Twelve drafts a batch, editing a pending draft, and up to four review
      // images. It widens this file's kind check and rebuilds two of its
      // indexes; it creates none of the tables asserted below.
      '20261031000000_review_workflow_twelve_drafts_editing_and_images.sql',
      // BOE Credits Phase 1A: the append-only credit ledger, its derived balance
      // view, the settings table and the service-role posting functions. Two new
      // tables of its own; it touches nothing any other module creates.
      '20261101000000_boe_credits_foundation.sql',
    ])
  })

  test('it creates the three tables and the private bucket, and nothing else', () => {
    for (const table of [CARDS, SHOTS, EVENTS]) {
      assert.ok(code.includes(`create table ${table}`), `${table} is not created`)
    }
    assert.ok(
      /insert into storage\.buckets[\s\S]{0,400}'customer-review-test-screenshots'[\s\S]{0,200}false/.test(code),
      'the screenshot bucket is not created private',
    )
  })
})

describe('the file is structurally intact', () => {
  // ADDED AFTER A REAL INCIDENT, and worth stating plainly: an edit to this
  // migration was once applied with a replacement string containing `$'`,
  // which String.replace reads as the special pattern "everything after the
  // match" — so the tail of the file was spliced back into the middle of it.
  // The result still contained every phrase the assertions below look for, and
  // every one of them passed. Only the line count gave it away.
  //
  // These checks are cheap and they catch that class of damage: duplicated
  // blocks, unbalanced dollar quotes, and a file that has silently doubled.

  test('every dollar-quoted body is closed', () => {
    // A function body opens and closes with `$$`, so the count must be even.
    // An odd count means a body ran off the end of the file — which Postgres
    // would refuse at apply time, and which no phrase-matching test would see.
    const dollars = (code.match(/\$\$/g) ?? []).length
    assert.equal(dollars % 2, 0, `${dollars} dollar-quote markers; a body is unclosed`)
  })

  test('every function has exactly one definition', () => {
    const names = [...code.matchAll(/create or replace function public\.(\w+)\(/g)].map(m => m[1])
    const seen = new Map()
    for (const name of names) seen.set(name, (seen.get(name) ?? 0) + 1)
    const repeated = [...seen].filter(([, n]) => n > 1).map(([name]) => name)
    assert.deepEqual(repeated, [], `defined more than once: ${repeated.join(', ')}`)
  })

  test('every section header appears exactly once', () => {
    // The numbered `═══ N. …` banners. A duplicate is the signature of a
    // spliced file.
    const headers = [...sql.matchAll(/^-- ═══ (\d+)\./gm)].map(m => m[1])
    assert.deepEqual(
      headers,
      [...new Set(headers)],
      `a section header is repeated: ${headers.join(', ')}`,
    )
    // ...and they are consecutive from 1, so none was lost either.
    assert.deepEqual(headers, headers.map((_, i) => String(i + 1)))
  })

  test('there is exactly one assertion block, and it is last', () => {
    const blocks = [...code.matchAll(/^do \$\$/gm)]
    assert.equal(blocks.length, 1, `${blocks.length} top-level do-blocks; expected one`)
    assert.ok(blocks[0].index > code.length * 0.5, 'the assertion block is not at the end of the file')
  })

  test('and every table is created exactly once', () => {
    const tables = [...code.matchAll(/create table public\.(\w+)/g)].map(m => m[1])
    assert.deepEqual(tables, [...new Set(tables)], `a table is created twice: ${tables.join(', ')}`)
    assert.equal(tables.length, 3)
  })
})

describe('the product this module is, and the product it is not', () => {
  test('THE STATUSES IN THE CHECK ARE THE STATUSES IN THE TYPE', () => {
    // 20261017000000 shipped four. 20261026000000 widened the CHECK to five by
    // adding `pending_approval` and renamed none of them, so the live constraint
    // is the one to read — this file's `code` is the original, which no longer
    // carries the whole answer on its own.
    const original = /status text not null default 'available' check \(status in \(([\s\S]*?)\)\)/.exec(code)
    assert.ok(original, 'the status CHECK is missing')
    const four = [...original![1].matchAll(/'([a-z_]+)'/g)].map(m => m[1])
    assert.deepEqual(four.sort(), ['available', 'booked', 'submitted', 'verified'])

    const approval = readFileSync(
      join(process.cwd(), 'supabase/migrations/20261026000000_review_workflow_batch_approval.sql'),
      'utf8',
    ).replace(/\r\n/g, '\n')
    const widened = /add constraint customer_review_test_cards_status_check\n  check \(status in \(([\s\S]*?)\)\);/.exec(approval)
    assert.ok(widened, 'the widened status CHECK is missing')
    const five = [...widened![1].matchAll(/'([a-z_]+)'/g)].map(m => m[1])

    // THE TYPE AND THE LIVE CONSTRAINT AGREE, which is the claim that matters:
    // a status the browser can hold and the database refuses, or the other way
    // round, is how a screen starts offering a move nothing will accept.
    assert.deepEqual(five.sort(), [...TEST_CARD_STATUSES].sort())
    assert.equal(five.length, 5)
    // Nothing was renamed on the way.
    for (const status of four) assert.ok(five.includes(status), `${status} was dropped`)
  })

  test('THE TEN TEST CATEGORIES ARE THE TEN IN THE CHECK', () => {
    const check = /test_category text not null check \(test_category in \(([\s\S]*?)\)\)/.exec(code)
    assert.ok(check, 'the test_category CHECK is missing')
    const inSql = [...check![1].matchAll(/'([a-z_]+)'/g)].map(m => m[1])
    assert.deepEqual(inSql.sort(), [...TEST_CATEGORIES].sort())
    // Every category name says it is a test, in the database as well as on the
    // screen — so a label can never be read as a claim about a real project.
    for (const key of inSql) assert.ok(key.endsWith('_test'), `${key} does not name itself a test`)
  })

  test('THERE IS NO CUSTOMER ANYWHERE IN THE SCHEMA', () => {
    // The columns that made the earlier draft a customer-facing system. Their
    // absence is the correction, and it is asserted rather than described:
    // a column that does not exist cannot be filled in by a future screen.
    for (const gone of [
      'customer_name',
      'whatsapp_number',
      'interaction_type',
      'greeting_name',
      'project_reference',
      'genuine_customer_confirmed',
      'image_permission_confirmed',
    ]) {
      assert.equal(
        code.includes(`${gone} `), false,
        `${gone} is back; this module must hold no customer data`,
      )
    }
  })

  test('THERE IS NO REVIEW DESTINATION, AND NO PUBLIC POSTING', () => {
    // Matched as a COLUMN DEFINITION, not as any occurrence of the name: the
    // migration legitimately mentions these words inside its own guard against
    // exactly such a column, and a test that could not tell the two apart would
    // fail on the assertion that protects it.
    for (const gone of ['review_url', 'review_public_url', 'review_link', 'google_review']) {
      assert.equal(
        new RegExp(`^\\s{2}${gone}\\s+(text|uuid|boolean|timestamptz)`, 'm').test(code), false,
        `${gone} is back as a column; there is no public destination here`,
      )
    }
    // ...and the migration asserts the same thing about itself at apply time,
    // so a column added by a LATER migration fails too.
    assert.ok(code.includes('look like a public review destination'))
    assert.ok(code.includes('look like customer contact data'))
  })

  test('THERE IS NO PHONE COLUMN AT ALL', () => {
    // The correction that came with letting a tester type any number: the
    // module stopped storing one. A column constrained to E.164 would be a
    // column that holds a number, so the assertion is that no such constraint
    // exists — and that the two columns which replaced it hold shapes a number
    // cannot take.
    assert.equal(code.includes('whatsapp_target text check ('), false,
      'a column that holds a full number is back')
    assert.equal(/~ '\^\\\+\[1-9\]\[0-9\]\{7,14\}\$'/.test(code), false,
      'a column is constrained to E.164, which means it holds a number')

    // ONE COLUMN, AND IT HOLDS FOUR DIGITS.
    assert.ok(code.includes('whatsapp_target_last_four text check ('))
    assert.ok(code.includes("whatsapp_target_last_four ~ '^[0-9]{4}$'"))

    // THE FINGERPRINT COLUMN IS GONE, along with the consistency constraint
    // that paired it with the four digits. It was an HMAC of the E.164 form,
    // kept so that two tests sent to one number could be correlated — a use
    // this workflow does not have. What it did have was a dependency on a
    // server credential (SUPABASE_SERVICE_ROLE_KEY, reused as a key, which is
    // not what that credential is for) and no rotation story.
    for (const token of ['whatsapp_target_fingerprint',
                         'customer_review_test_cards_target_consistent']) {
      assert.equal(code.includes(token), false,
        `the recipient fingerprint survives somewhere: ${token}`)
    }

    // A 64-hex column is not forbidden outright — the screenshot table has one
    // — so the check is that the ONLY one is the image content digest, which is
    // about bytes the server itself produced and about no recipient.
    const digests = [...code.matchAll(/(\w+) text (?:not null )?check \(\1 ~ '\^\[0-9a-f\]\{64\}\$'\)/g)]
      .map(m => m[1])
    assert.deepEqual(digests, ['content_sha256'])

    // And nothing in the executable SQL builds, stores or reads one under
    // another name. Prose is exempt on purpose: the column's COMMENT says the
    // fingerprint existed and was removed, which is the sort of thing the next
    // reader needs and the sort of thing a blunt keyword sweep would delete.
    const executable = code
      .split(/;\n/)
      .filter(stmt => !/^\s*comment on /i.test(stmt))
      .join(';\n')
    assert.equal(/fingerprint|hmac/i.test(executable), false,
      'a fingerprint or HMAC is referenced by executable SQL')
  })

  test('the mandatory label exists in SQL, and a card body may not carry a copy', () => {
    assert.ok(code.includes('create or replace function public.customer_review_internal_test_warning()'))
    assert.ok(code.includes('INTERNAL TEST ONLY - NOT A CUSTOMER REVIEW - DO NOT PUBLISH'))
    // The body CHECK: the label is prepended by trusted code, so a copy stored
    // in the row would be one an editor could reword.
    assert.ok(
      code.includes('position(public.customer_review_internal_test_warning() in upper(test_body)) = 0'),
      'a card body is not prevented from carrying its own copy of the label',
    )
  })

  test('a card body cannot contain a link of any kind', () => {
    assert.ok(
      /test_body !~\* '\(https\?:\/\/\|www\\\.\|wa\\\.me\)'/.test(code),
      'a card body is not prevented from containing a URL',
    )
  })

  test('THE MIGRATION SHIPS NO TEST DATA, and says so at apply time', () => {
    // A migration runs against production. The sixteen fixture cards live
    // outside the migration chain, and this is the assertion that keeps them
    // there.
    assert.equal(
      /insert into public\.customer_review_test_cards/.test(code), false,
      'the migration inserts test cards; they belong in supabase/fixtures',
    )
    assert.ok(code.includes('test data must come from a fixture, never from a migration'))
  })
})

describe('row-level security', () => {
  test('every table has it enabled', () => {
    for (const table of [CARDS, SHOTS, EVENTS]) {
      assert.ok(
        code.includes(`alter table ${table.padEnd(0)}`) || code.includes(`alter table ${table}`),
        `${table} does not enable RLS`,
      )
      assert.ok(
        new RegExp(`alter table\\s+${table.replace(/\./g, '\\.')}\\s+enable row level security`).test(code),
        `${table} does not enable RLS`,
      )
    }
  })

  test('every policy is scoped to the authenticated role', () => {
    const policies = [...code.matchAll(/create policy "([^"]+)"[\s\S]{0,200}?for (\w+) to (\w+)/g)]
      .filter(m => m[1].startsWith('customer_review_test'))
    assert.ok(policies.length >= 4, 'expected at least four policies')
    for (const p of policies) {
      assert.equal(p[3], 'authenticated', `${p[1]} is granted to ${p[3]}`)
    }
  })

  test('no policy is unconditional', () => {
    // CASE-SENSITIVE, deliberately. The migration's own assertion block raises
    // "internal-test polic(ies) are USING (true)", and a case-insensitive match
    // finds that message — so the test failed on the very check that protects
    // the property it is testing. Policy bodies are written in lower case here.
    assert.equal(/using \(\s*true\s*\)/.test(code), false, 'a USING (true) policy exists')
    assert.equal(/with check \(\s*true\s*\)/.test(code), false, 'a WITH CHECK (true) policy exists')
  })

  test('THE CARD TABLE HAS EXACTLY ONE POLICY, AND IT READS', () => {
    // The module's central structural claim: nothing with a browser session can
    // create, edit or destroy a test card. Cards are fixture-loaded and move
    // only through the definer functions.
    const cardPolicies = [...code.matchAll(/create policy "([^"]+)" on public\.customer_review_test_cards\s+for (\w+)/g)]
    assert.equal(cardPolicies.length, 1, `the card table has ${cardPolicies.length} policies`)
    assert.equal(cardPolicies[0][2], 'select')
  })

  test('...and the privileges are gone as well as the policies', () => {
    assert.ok(
      /revoke insert, update, delete, truncate, references, trigger\s+on public\.customer_review_test_cards from authenticated, anon/.test(code),
      'the card table still grants a write privilege to a client role',
    )
    // No column-level UPDATE grant sneaks back in either.
    assert.equal(
      /grant update \([\s\S]*?\) on public\.customer_review_test_cards/.test(code), false,
      'a column UPDATE grant exists on the card table',
    )
  })

  test('the card table decides on the row it is given, not on a second lookup', () => {
    const policy = /create policy "customer_review_test_cards_select"[\s\S]*?;/.exec(code)?.[0] ?? ''
    assert.ok(policy, 'the card SELECT policy is missing')
    // The card-id helper is STABLE and re-reads this table; the row-shaped one
    // takes booked_by as a value.
    assert.equal(/can_view_customer_review_test_card\(/.test(policy), false,
      'the policy re-queries its own table')
    assert.ok(policy.includes('can_view_customer_review_test_card_row('))
    // ...and the available branch is gated on an authorization check, or the
    // pool is visible to anybody signed in.
    assert.ok(policy.includes('can_use_customer_review_test_cards()'))
    assert.equal(/\bfrom\s+(public\.)?users\b/.test(policy), false,
      'the policy reads public.users as the caller')
  })

  test('the CHILD tables read through the shared card-id predicate', () => {
    for (const table of [SHOTS, EVENTS]) {
      // `on <table>` may sit on the line after the policy name, so the
      // whitespace between them has to be allowed to include a newline.
      const policy = new RegExp(
        `create policy "[^"]+"\\s+on ${table.replace(/\./g, '\\.')}[\\s\\S]*?;`,
      ).exec(code)?.[0] ?? ''
      assert.ok(policy.includes('can_view_customer_review_test_card('),
        `${table} does not use the card-id predicate`)
    }
  })

  test('a screenshot marked for removal is invisible to every reader', () => {
    const policy = /create policy "customer_review_test_screenshots_select"[\s\S]*?;/.exec(code)?.[0] ?? ''
    assert.ok(policy.includes('removal_started_at is null'),
      'a half-removed screenshot would still be readable')
  })

  test('the trail has a SELECT policy and no other', () => {
    const trail = [...code.matchAll(
      /create policy "([^"]+)" on public\.customer_review_test_card_events\s+for (\w+)/g,
    )]
    assert.equal(trail.length, 1)
    assert.equal(trail[0][2], 'select')
  })

  test('the trail is unwritable by grant as well as by policy', () => {
    assert.ok(
      /revoke insert, update, delete, truncate\s+on public\.customer_review_test_card_events from authenticated, anon/.test(code),
      'the trail can still be written by a client role',
    )
  })

  test('the migration asserts every one of those at apply time', () => {
    // Belt and braces: the file re-checks its own policies when it runs, so a
    // future edit that reinstates a mistake fails the migration rather than
    // shipping quietly.
    for (const claim of [
      'row level security is not enabled on all three internal-test tables',
      'cards must be fixture-loaded and moved only by the definer functions',
      'it must be append-only',
      'internal-test polic(ies) are USING (true)',
      're-queries its own table',
      'reads public.users as the caller',
      'does not gate the available pool on can_use_customer_review_test_cards()',
    ]) {
      assert.ok(code.includes(claim), `the migration does not assert: ${claim}`)
    }
  })

  test('the migration pins an exact allow-list of browser-callable functions', () => {
    // The name heuristic over p_user_id/p_actor_id is a MESSAGE, not a control:
    // it matches parameter names, so a future `p_who uuid` walks past it. The
    // allow-list is the control — any function granted to authenticated whose
    // exact signature is not on it fails the migration at apply time.
    assert.ok(code.includes('these are executable by authenticated and are not on the approved list'),
      'the migration must carry an exact allow-list, not only the name heuristic')
    for (const sig of [
      'can_use_customer_review_test_cards()',
      'can_view_customer_review_test_card(p_card_id uuid)',
      'can_view_customer_review_test_card_row(p_booked_by uuid)',
      'book_customer_review_test_card(p_card_id uuid)',
      'confirm_customer_review_test_card_sent(p_card_id uuid)',
    ]) {
      assert.ok(code.includes(sig), `${sig} is not on the allow-list`)
    }
    // ...and each must be shown to derive its own actor.
    assert.ok(code.includes('does not derive its actor from auth.uid()'))
  })
})

describe('the predicates', () => {
  test('the row predicate admits exactly the HOLDER and a RESOLVED verifier', () => {
    const fn = /create or replace function public\.can_view_customer_review_test_card_row[\s\S]*?\$\$;/
      .exec(code)?.[0] ?? ''
    assert.ok(fn, 'the row predicate is missing')
    assert.ok(fn.includes('p_booked_by = auth.uid()'), 'the holder branch is gone')
    assert.ok(fn.includes("'verify'"), 'the verifier branch is gone')
    assert.ok(fn.includes('u.is_active'), 'an inactive user is no longer excluded')

    // THE ADMIN BRANCH IS GONE. It used to sit between the two above, so an
    // administrator whose `verify` had been revoked could still read every
    // tester's rows — the one thing revoking `verify` is supposed to stop.
    assert.equal(fn.includes("u.role = 'admin'"), false, 'the admin branch is back')

    // It must not go back to the table it is deciding about.
    assert.equal(/from public\.customer_review_test_cards/.test(fn), false)
  })

  test('NO VISIBILITY PREDICATE READS A ROLE AT ALL', () => {
    // All three at once, so a branch reintroduced in any of them fails here
    // even if its own test were relaxed.
    for (const name of ['can_use_customer_review_test_cards',
                        'can_view_customer_review_test_card_row',
                        'can_view_customer_review_test_card']) {
      const fn = new RegExp('create or replace function public\\.' + name + '\\([\\s\\S]*?\\$\\$;')
        .exec(code)?.[0] ?? ''
      assert.ok(fn, name + ' is missing')
      assert.equal(/u\.role/.test(fn), false, name + ' still reads users.role')
      assert.equal(/'admin'/.test(fn), false, name + ' still names the admin role')
      // …and each still asks the engine, so this did not pass by deleting the
      // authorization instead of correcting it.
      assert.ok(fn.includes('public.resolve_permission(auth.uid()'), name + ' asks nothing')
    }
  })

  test('the available-pool predicate takes no argument at all', () => {
    const fn = /create or replace function public\.can_use_customer_review_test_cards\(\)[\s\S]*?\$\$;/
      .exec(code)?.[0] ?? ''
    assert.ok(fn, 'the pool predicate is missing')
    assert.ok(fn.includes('auth.uid()'))
    assert.ok(fn.includes('u.is_active'))
    // Zero arguments is the point: there is nothing to ask about but the caller.
    assert.ok(code.includes('can_use_customer_review_test_cards()\nreturns boolean'))
  })

  test('an inactive employee sees nothing, whatever their grants say', () => {
    for (const name of [
      'can_use_customer_review_test_cards',
      'can_view_customer_review_test_card',
      'can_view_customer_review_test_card_row',
    ]) {
      const fn = new RegExp(`create or replace function public\\.${name}[\\s\\S]*?\\$\\$;`).exec(code)?.[0] ?? ''
      assert.ok(fn.includes('is_active'), `${name} does not require an active user`)
    }
  })

  test('THERE IS NO CREATE OR EDIT PREDICATE, because nothing is creatable or editable', () => {
    assert.equal(code.includes('can_create_customer_review'), false)
    assert.equal(code.includes('can_edit_customer_review'), false)
  })

  test('the predicates cannot be aimed at another user by a client', () => {
    // Structural: no browser-callable function takes an acting-user id, and the
    // migration checks the same thing about the live database.
    const granted = [...code.matchAll(
      /grant\s+execute on function public\.(\w+)\(([^)]*)\)[^;]*to authenticated/g,
    )]
    for (const [, name, args] of granted) {
      assert.equal(/p_user_id|p_actor_id|p_acting/.test(args), false,
        `${name} accepts an acting-user id and is browser-callable`)
    }
  })
})

describe('the transition table matches the browser’s copy exactly', () => {
  test('every SQL edge is in status.ts, and every status.ts edge is in SQL', () => {
    // THE POINT OF THIS FILE. Two copies of one rule: a divergence means either
    // a button the database refuses, or — far worse — a move the screen forbids
    // and the database permits.
    const fn = /v_legal := case c\.status([\s\S]*?)end;/.exec(code)?.[0] ?? ''
    assert.ok(fn, 'the transition CASE is missing')

    const fromSql: Record<string, string[]> = {}
    for (const m of fn.matchAll(/when '(\w+)'\s+then p_next_status in \(([^)]*)\)/g)) {
      fromSql[m[1]] = [...m[2].matchAll(/'(\w+)'/g)].map(x => x[1]).sort()
    }

    // Booking is NOT a transition — it has its own function, because it must be
    // a single conditional UPDATE to win a race. 'available' therefore has no
    // outgoing edge in either copy.
    assert.equal(fromSql['available'], undefined, 'available must not be in the transition table')
    assert.deepEqual(TEST_CARD_TRANSITIONS.available, [])

    for (const [from, tos] of Object.entries(fromSql)) {
      assert.deepEqual(
        tos,
        [...(TEST_CARD_TRANSITIONS[from as keyof typeof TEST_CARD_TRANSITIONS] ?? [])].sort(),
        `SQL and status.ts disagree about what a '${from}' card may become`,
      )
    }

    for (const [from, tos] of Object.entries(TEST_CARD_TRANSITIONS)) {
      if (tos.length === 0) continue
      assert.ok(fromSql[from], `status.ts allows moves from '${from}' and the SQL has no case for it`)
    }
  })

  test('booking is a separate function, and it is one conditional UPDATE', () => {
    const fn = /create or replace function public\.book_customer_review_test_card[\s\S]*?\$\$;/
      .exec(code)?.[0] ?? ''
    assert.ok(fn, 'the booking function is missing')
    // The claim, as one statement. `where id = ... and status = 'available'` is
    // evaluated by the UPDATE itself, so a second transaction re-reads the row
    // it waited for, matches nothing, and takes the refusal branch.
    assert.ok(/update public\.customer_review_test_cards[\s\S]*?where id = p_card_id\s+and status = 'available'/.test(fn),
      'booking is not a single conditional UPDATE')
    // ...and NOT a read-then-write, which is the shape that loses a race.
    assert.equal(/select \* into c[\s\S]*?for update[\s\S]*?update public\.customer_review_test_cards/.test(fn), false,
      'booking reads the row before claiming it')
    assert.ok(fn.includes('v_uid uuid := auth.uid()'), 'booking does not derive its actor from auth.uid()')
    assert.ok(fn.includes('CUSTOMER_REVIEW_TEST_ALREADY_BOOKED'))
  })

  test('verifying and returning require `verify`, and nothing else does', () => {
    const fn = /create or replace function public\.transition_customer_review_test_card[\s\S]*?\$\$;/
      .exec(code)?.[0] ?? ''
    assert.ok(/if p_next_status in \('verified', 'booked'\) then\s+if not v_verify then/.test(fn),
      'the verifier-only branch does not cover exactly verified and booked')
    assert.ok(fn.includes('v_holder and v_use'), 'submitting is not scoped to the card’s holder')
  })

  test('a return has to say why', () => {
    const fn = /create or replace function public\.transition_customer_review_test_card[\s\S]*?\$\$;/
      .exec(code)?.[0] ?? ''
    assert.ok(/if p_next_status = 'booked' and v_detail is null then/.test(fn),
      'a card can be returned with no reason')
  })
})

describe('WhatsApp is preparation, and never delivery', () => {
  test('the recorder touches no status column', () => {
    const fn = /create or replace function public\.record_customer_review_test_card_whatsapp_opened[\s\S]*?\$\$;/
      .exec(code)?.[0] ?? ''
    assert.ok(fn, 'the WhatsApp recorder is missing')
    // The single most important negative in the module.
    assert.equal(/set[\s\S]*?\bstatus\s*=/.test(fn), false,
      'the WhatsApp recorder assigns a status')
    assert.ok(fn.includes('whatsapp_opened_at        = now()'))
    assert.ok(fn.includes('whatsapp_opened_count     = whatsapp_opened_count + 1'))
    assert.ok(fn.includes('whatsapp_target_last_four = p_target_last_four'))
    // Three assignments and no fourth: the fingerprint is not written under a
    // different name.
    const setClause = fn.slice(fn.indexOf('set whatsapp_opened_at'), fn.indexOf('where id = p_card_id;', fn.indexOf('set whatsapp_opened_at')))
    assert.equal(setClause.split('=').length - 1, 3, 'the recorder writes a fourth column')
  })

  test('it is reachable by service_role alone, because it takes an actor', () => {
    // THREE ARGUMENTS. A grant that names a signature no longer defined is a
    // silent no-op — it does not error, and it leaves the function granted to
    // whatever it was granted to before — so the arity here is load-bearing.
    assert.ok(code.includes(
      'revoke execute on function public.record_customer_review_test_card_whatsapp_opened(uuid, text, uuid)\n  from public, anon, authenticated;',
    ))
    assert.ok(code.includes(
      'grant  execute on function public.record_customer_review_test_card_whatsapp_opened(uuid, text, uuid)\n  to service_role;',
    ))
    assert.equal(code.includes('record_customer_review_test_card_whatsapp_opened(uuid, text, text, uuid)'), false,
      'the four-argument signature is still named somewhere')
  })

  test('THE RECIPIENT REACHES SQL ALREADY REDUCED, and nothing else is accepted', () => {
    // The number is validated in the route and never travels further. What the
    // function accepts is a digest and four digits — shapes a phone number
    // cannot take — so "SQL never sees a number" is a property of the signature
    // rather than a habit of its one caller.
    const fn = /create or replace function public\.record_customer_review_test_card_whatsapp_opened[\s\S]*?\$\$;/
      .exec(code)?.[0] ?? ''
    assert.ok(fn.includes('p_target_last_four text'))
    assert.ok(fn.includes("p_target_last_four !~ '^[0-9]{4}$'"))
    assert.ok(fn.includes('CUSTOMER_REVIEW_TEST_BAD_TARGET'))

    // THE PARAMETER LIST IS THE PROPERTY. Four digits is a shape a telephone
    // number cannot take, so "SQL never sees a number" holds for any caller
    // rather than for the one caller that exists today. Counted, so a
    // reintroduced parameter fails here even under an innocent name.
    const params = fn.slice(fn.indexOf('(') + 1, fn.indexOf(')'))
    assert.deepEqual(
      params.split(',').map(x => x.trim().split(/\s+/)[0]).filter(Boolean),
      ['p_card_id', 'p_target_last_four', 'p_actor_id'],
    )
  })

  test('confirming a send is a SEPARATE function that also moves no status', () => {
    const fn = /create or replace function public\.confirm_customer_review_test_card_sent[\s\S]*?\$\$;/
      .exec(code)?.[0] ?? ''
    assert.ok(fn, 'the confirmation function is missing')
    assert.equal(/set[\s\S]*?\bstatus\s*=/.test(fn), false, 'confirming assigns a status')
    assert.ok(fn.includes('sent_confirmed_at = now()'))
    // ...and it cannot be reached before a link was ever built.
    assert.ok(fn.includes('whatsapp_opened_at is null'))
  })

  test('submitting requires the tester’s own claim AND a screenshot', () => {
    const fn = /create or replace function public\.assert_customer_review_test_card_submittable[\s\S]*?\$\$;/
      .exec(code)?.[0] ?? ''
    assert.ok(fn, 'the submission guard is missing')
    assert.ok(fn.includes('c.sent_confirmed_at is null'))
    assert.ok(fn.includes('from public.customer_review_test_card_screenshots'))
    // whatsapp_opened_at is NOT accepted in place of the confirmation.
    assert.equal(fn.includes('whatsapp_opened_at is not null'), false,
      'the submission guard treats an opened link as evidence of a send')
  })
})

describe('the private bucket', () => {
  test('THE BUCKET HAS EXACTLY ONE CLIENT POLICY, AND IT READS', () => {
    const bucketPolicies = [...code.matchAll(/create policy "(customer_review_test[^"]*)"\s+on storage\.objects\s+for (\w+)/g)]
    assert.equal(bucketPolicies.length, 1, `the bucket has ${bucketPolicies.length} client policies`)
    assert.equal(bucketPolicies[0][2], 'select')
  })

  test('reading an object asks the same question as reading the card', () => {
    const policy = /create policy "customer_review_test_screenshots_storage_select"[\s\S]*?;/.exec(code)?.[0] ?? ''
    assert.ok(policy.includes('can_view_customer_review_test_card(c.id)'))
    assert.ok(policy.includes("split_part(storage.objects.name, '/', 1)"))
  })

  test('the object path is the authorization, and it is the card id', () => {
    assert.ok(code.includes("split_part(storage_path, '/', 1) = card_id::text"),
      'the metadata row does not pin its path to its card')
  })

  test('NO CLIENT MAY REGISTER OR REMOVE AN IMAGE', () => {
    assert.ok(
      /revoke insert, update, delete, truncate\s+on public\.customer_review_test_card_screenshots from authenticated, anon/.test(code),
    )
    assert.equal(
      /create policy "[^"]*"\s+on storage\.objects\s+for (insert|delete)/.test(code), false,
      'a client INSERT or DELETE policy exists on the bucket',
    )
    // ...and the migration checks the same thing about the live database.
    assert.ok(code.includes('only the trusted upload route may register an image'))
    assert.ok(code.includes('removal must go through the trusted route'))
  })

  test('the two removal halves are service-role only', () => {
    for (const sig of [
      'begin_customer_review_test_screenshot_removal(uuid, uuid)',
      'finish_customer_review_test_screenshot_removal(uuid)',
    ]) {
      assert.ok(code.includes(`revoke execute on function public.${sig}`), `${sig} is not revoked`)
      assert.ok(code.includes(`grant  execute on function public.${sig} to service_role;`), `${sig} is not granted to service_role`)
    }
  })

  test('every removal is recorded in the append-only trail', () => {
    const fn = /create or replace function public\.customer_review_test_screenshots_log_removal[\s\S]*?\$\$;/
      .exec(code)?.[0] ?? ''
    assert.ok(fn.includes("'screenshot_removed'"))
    // The remover, not the uploader: the delete arrives through the service
    // role, where auth.uid() is null.
    assert.ok(fn.includes('coalesce(old.removal_by, auth.uid(), old.uploaded_by)'))
  })
})

describe('the two sentences the database writes onto the activity trail', () => {
  const SCHEMA = sql
  const DRAFTS = lf(readFileSync(join(MIGRATIONS, '20261023000000_review_workflow_ai_drafts.sql'), 'utf8'))

  test('the drafts migration restates both functions, and says why', () => {
    for (const fn of [
      'create or replace function public.book_customer_review_test_card(p_card_id uuid)',
      'create or replace function public.confirm_customer_review_test_card_sent(p_card_id uuid)',
    ]) {
      assert.ok(DRAFTS.includes(fn), `the drafts migration does not restate ${fn}`)
    }
    assert.ok(DRAFTS.includes('ROWS ALREADY WRITTEN ARE LEFT ALONE'))
  })

  test('the new wording replaces the old, in the new file only', () => {
    assert.ok(DRAFTS.includes("'Review booked.'"))
    assert.ok(DRAFTS.includes("'The candidate confirmed by hand that they sent the message.'"))
    assert.equal(DRAFTS.includes("'Test card booked.'"), false)
    assert.equal(DRAFTS.includes('they sent the internal test message'), false)

    // 20261017000000 IS APPLIED IN PRODUCTION AND IS NOT EDITED. Its copy of
    // the old sentences must still be there, or this file was changed instead
    // of being superseded.
    assert.ok(SCHEMA.includes("'Test card booked.'"))
    assert.ok(SCHEMA.includes('they sent the internal test message'))
  })

  test('AND NOTHING ELSE ABOUT EITHER FUNCTION CHANGED', () => {
    // The restatement is a copy with two sentences swapped. Anything else that
    // differs is an unreviewed change to a shipped authorization path, so the
    // bodies are compared line by line and exactly two lines may differ.
    const bodyOf = (source: string, signature: string) => {
      const start = source.indexOf(signature)
      assert.ok(start >= 0, `missing: ${signature}`)
      const end = source.indexOf('\n$$;', start)
      assert.ok(end > start, `unterminated: ${signature}`)
      return source.slice(start, end).replace(/\r\n/g, '\n').split('\n')
    }

    for (const signature of [
      'create or replace function public.book_customer_review_test_card(p_card_id uuid)',
      'create or replace function public.confirm_customer_review_test_card_sent(p_card_id uuid)',
    ]) {
      const before = bodyOf(SCHEMA, signature)
      const after = bodyOf(DRAFTS, signature)
      assert.equal(after.length, before.length, `${signature} changed length`)
      const differing = before
        .map((line, i) => (line === after[i] ? null : `${line}  ->  ${after[i]}`))
        .filter(Boolean)
      assert.equal(differing.length, 1,
        `${signature} differs on ${differing.length} lines:\n${differing.join('\n')}`)
    }
  })
})

describe('permission registration', () => {
  test('the module key and both action keys are unchanged', () => {
    // They are what every existing Control Center grant is written against.
    assert.ok(code.includes("('customer_review_requests', 'Review Workflow Test (Internal)'"))
    assert.ok(code.includes("('use',    'Use Customer Review Outreach',   false)"))
    assert.ok(code.includes("('verify', 'Verify & Close Review Requests', false)"))
  })

  test('it matches src/lib/permissions/modules.ts', () => {
    const modules = lf(readFileSync(join(ROOT, 'src/lib/permissions/modules.ts'), 'utf8'))
    assert.ok(modules.includes("moduleKey: 'customer_review_requests'"))
    assert.ok(modules.includes("displayName: 'Review Workflow'"))
  })

  test('both actions are deny-by-default, and no employee override is seeded', () => {
    assert.ok(/insert into public\.module_permission_actions[\s\S]*?select pm\.id, pa\.id, false/.test(code))
    assert.ok(code.includes('this migration must create none'))
  })

  test('no app_modules row is created', () => {
    assert.equal(code.includes('app_modules'), false,
      'an app_modules row would be a Control Center control that nothing reads')
  })
})
