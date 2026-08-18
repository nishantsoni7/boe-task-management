/**
 * Repository check: the employee-reply migration adds one optional note and
 * nothing else.
 *
 * WHAT IS BEING DEFENDED
 * ----------------------
 * Submitting a PI runs about a hundred lines of validation before it moves a
 * status — actor, permission, row lock, ownership and state, blocking issues,
 * the workbook's path/existence/type, the item count, per-line completeness and
 * every image. Adding a note argument by COPYING all of that into a second
 * function would leave two versions of the security-critical part, drifting at
 * the first correction to either. So the body moved once into an internal
 * function no role may execute, and both public RPCs are one line over it.
 *
 * Everything below exists because the failure modes here are silent:
 *
 *   1. the internal function becoming client-callable, which would let a caller
 *      skip the note cap — or arrive with its own idea of the rules;
 *   2. the old one-argument RPC changing signature, which breaks every existing
 *      caller and a cached PostgREST schema;
 *   3. an accidental overload of one name, which PostgREST would resolve by
 *      which keys a client happened to send;
 *   4. the reply leaking into review_note, overwriting what management asked
 *      for with the answer to it;
 *   5. approval, numbering or payments arriving through the back door.
 *
 * Reads repository files only. No database, no network.
 *
 * Run:
 *   npx tsx --test src/lib/orders/submissionReplySchema.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { RESUBMIT_NOTE_MAX_LENGTH } from './submissionWorkflow'
import { PI_ACTIVITY_LABEL } from './submissionActivity'

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations')
const lf = (s: string) => s.replace(/\r\n/g, '\n')
const readMigration = (f: string) => lf(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))

const REPLY_FILE = '20260911000000_order_submission_employee_reply.sql'
const PHASE_A_FILE = '20260910000000_order_submission_phase_a_review.sql'
const IMAGES_FILE = '20260909000000_order_submission_item_images.sql'
const SUBMISSIONS_FILE = '20260908000000_order_pi_submissions.sql'

const sql = readMigration(REPLY_FILE)
const code = sql.replace(/--[^\n]*/g, '')
const statements = code.replace(/comment on [\s\S]*?is\s+'(?:[^']|'')*'\s*;/g, '')
const declarations = statements.slice(0, statements.lastIndexOf('do $$'))

function functionBlock(name: string): string {
  const needle = `create or replace function public.${name}(`
  const start = code.indexOf(needle)
  assert.ok(start >= 0, `function ${name} not found`)
  const tag = /\$[A-Za-z_]*\$/.exec(code.slice(start))?.[0]
  assert.ok(tag, `function ${name} has no dollar-quoted body`)
  const open = code.indexOf(tag, start)
  const close = code.indexOf(tag, open + tag.length)
  return code.slice(start, close + tag.length)
}

const INTERNAL = functionBlock('submit_order_submission_internal')
const PLAIN = functionBlock('submit_order_submission')
const WITH_NOTE = functionBlock('submit_order_submission_with_note')

// ── The file ──────────────────────────────────────────────────────────────────

describe('the reply migration is additive and correctly sequenced', () => {
  test('it is the newest migration and sorts after Phase A', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort()
    assert.equal(files[files.length - 1], REPLY_FILE)
    assert.ok(REPLY_FILE > PHASE_A_FILE)
  })

  test('no applied migration is edited', () => {
    // Phase A is already applied to production. Editing any of these three
    // would change history for a database that has already run them.
    for (const file of [SUBMISSIONS_FILE, IMAGES_FILE, PHASE_A_FILE]) {
      const applied = readMigration(file)
      assert.ok(!applied.includes('submit_order_submission_with_note'),
        `${file} must not mention the new RPC`)
      assert.ok(!applied.includes('submit_order_submission_internal'))
    }
    assert.ok(readMigration(PHASE_A_FILE).includes('reject_order_submission'),
      'and Phase A still contains what it always did')
  })

  test('it creates no table, drops nothing and alters no table', () => {
    for (const forbidden of [/create table/i, /drop table/i, /drop function/i,
                             /drop policy/i, /drop constraint/i, /alter table/i]) {
      assert.ok(!forbidden.test(declarations),
        `the reply migration must not ${String(forbidden)}`)
    }
  })

  test('it defines exactly three functions', () => {
    const defined = [...declarations.matchAll(/create or replace function public\.(\w+)/g)].map(m => m[1])
    assert.deepEqual(defined.sort(), [
      'submit_order_submission',
      'submit_order_submission_internal',
      'submit_order_submission_with_note',
    ])
  })
})

// ── One implementation, two doors ─────────────────────────────────────────────

describe('the security logic is written once', () => {
  test('the internal function carries every check the applied RPC had', () => {
    for (const rule of [
      'public.assert_order_submission_actor()',
      "public.actor_has_module_permission('orders', 'create')",
      'for update',
      'public.can_edit_order_submission(p_submission_id)',
      'ORDER_SUBMISSION_BLOCKED',
      'ORDER_SUBMISSION_INCOMPLETE',
      'ORDER_SUBMISSION_BAD_WORKBOOK_PATH',
      'ORDER_SUBMISSION_WORKBOOK_NOT_STORED',
      'ORDER_SUBMISSION_WORKBOOK_NOT_XLSX',
      'ORDER_SUBMISSION_BAD_IMAGE_PATH',
      'ORDER_SUBMISSION_IMAGE_NOT_STORED',
      'public.log_order_submission_activity(',
    ]) {
      assert.ok(INTERNAL.includes(rule), `the implementation must still perform: ${rule}`)
    }
  })

  test('it is the applied body, not a paraphrase of it', () => {
    // Every check in the applied version must survive verbatim. A reworded
    // guard is a guard somebody has re-reasoned about, and this migration is
    // not the place for that.
    const applied = readMigration(IMAGES_FILE)
    const appliedBody = applied.slice(
      applied.indexOf('create or replace function public.submit_order_submission(p_submission_id uuid)'))
    for (const line of [
      "if v_sub.source_workbook_path !~",
      "and (item_sequence is null or product_name is null)",
      "where m.item_id = i.id and m.role = 'representative'",
      "and o.metadata ->> 'mimetype' in ('image/png', 'image/jpeg', 'image/webp')",
      "set status = 'submitted',",
      "         review_note = null",
    ]) {
      assert.ok(appliedBody.includes(line), `sanity: the applied RPC contains ${line}`)
      assert.ok(INTERNAL.includes(line), `the implementation must keep: ${line}`)
    }
  })

  test('both doors are one line over the same implementation', () => {
    assert.ok(PLAIN.includes('return public.submit_order_submission_internal(p_submission_id, null);'),
      'a plain submission is a submission with no note')
    assert.ok(WITH_NOTE.includes('return public.submit_order_submission_internal(p_submission_id, p_note);'))
    // Neither wrapper re-implements a check of its own.
    for (const wrapper of [PLAIN, WITH_NOTE]) {
      assert.ok(!wrapper.includes('actor_has_module_permission'),
        'a wrapper must not carry a second copy of the authorization')
      assert.ok(!wrapper.includes('for update'))
    }
  })

  test('the internal function is executable by nobody', () => {
    assert.ok(code.includes(
      'revoke execute on function public.submit_order_submission_internal(uuid, text)\n  from public, anon, authenticated, service_role;'),
      'including service_role: nothing server-side needs to submit on an employee’s behalf')
    assert.ok(!/grant\s+execute on function public\.submit_order_submission_internal/.test(code))
    assert.ok(sql.includes('submit_order_submission_internal is executable by a role'),
      'and the migration asserts it')
  })
})

// ── The old RPC stays exactly as it was ───────────────────────────────────────

describe('the existing one-argument RPC remains compatible', () => {
  test('same name, same argument name, same return shape', () => {
    assert.ok(PLAIN.includes('create or replace function public.submit_order_submission(p_submission_id uuid)'))
    assert.ok(PLAIN.includes('returns jsonb'))
  })

  test('the signature assertion reads catalog COLUMNS, never rendered text', () => {
    // THE DEFECT THIS PINS. The first version of this assertion compared
    // pg_get_function_identity_arguments(p.oid) to 'uuid', and the migration
    // failed on a real database because that function returns the NAMED form:
    //
    //   pg_get_function_identity_arguments  →  p_submission_id uuid
    //   pg_get_function_arguments           →  p_submission_id uuid
    //
    // Verified against PostgreSQL 16. Those are display helpers, and what they
    // render is a presentation decision that can differ between server
    // versions; an assertion built on it asserts the formatting, not the
    // signature. Nothing in this migration may depend on either again.
    // `code` is the migration with its `--` comments stripped. Essential here:
    // the assertion block DOCUMENTS the two rendering helpers in order to
    // explain why it does not use them, and a search over raw text would fail
    // on the sentence promising the very thing it verifies.
    for (const rendered of ['pg_get_function_identity_arguments', 'pg_get_function_arguments']) {
      assert.ok(!code.includes(rendered),
        `${rendered} renders text and must not decide whether a signature is correct`)
    }

    // pronargs / proargtypes / proargnames ARE the signature.
    for (const stable of [
      'p.pronargs = 1',
      "p.proargtypes[0] = 'uuid'::regtype",
      'array_length(p.proargnames, 1) = 1',
      "p.proargnames[1] = 'p_submission_id'",
      "p.prokind  = 'f'",
    ]) {
      assert.ok(code.includes(stable), `the assertion must check: ${stable}`)
    }
  })

  test('the two array bases are used correctly, and they differ', () => {
    // proargtypes is an oidvector and is indexed FROM 0; proargnames is a
    // text[] and is indexed FROM 1. Getting either the wrong way round yields a
    // silent null and an assertion that can never fail. Both bases verified
    // against PostgreSQL 16: proargnames[0] is null.
    assert.ok(code.includes("p.proargtypes[0] = 'uuid'::regtype"), 'first TYPE at index 0')
    assert.ok(code.includes("p.proargnames[1] = 'p_submission_id'"), 'first NAME at index 1')
    assert.ok(!code.includes("p.proargtypes[1] = 'uuid'::regtype"),
      'uuid is the FIRST argument of every one of these functions')
    assert.ok(!/proargnames\[0\]/.test(code), 'a text[] has no index 0')
  })

  test('the note RPC and the internal function are checked the same way', () => {
    // Types AND names, for both, because PostgREST calls by argument name: a
    // renamed argument is a broken RPC even though the types still match.
    assert.ok(code.includes('p.pronargs = 2'))
    assert.ok(code.includes("p.proargtypes[1] = 'text'::regtype"))
    assert.ok(code.includes("p.proargnames[2] = 'p_note'"))
    assert.ok(code.includes('array_length(p.proargnames, 1) = 2'))
    for (const name of ['submit_order_submission_with_note', 'submit_order_submission_internal']) {
      assert.ok(code.includes(`p.proname  = '${name}'`), `${name} must have its own signature check`)
    }
  })

  test('an added OUT parameter cannot slip through', () => {
    // pronargs counts input arguments only, so an OUT parameter changes
    // proargnames without changing pronargs. Asserting array_length as well is
    // what closes that gap.
    const checks = [...code.matchAll(/array_length\(p\.proargnames, 1\) = \d/g)]
    assert.equal(checks.length, 3, 'one for each of the three functions')
  })

  test('its privileges are restated rather than assumed', () => {
    assert.ok(code.includes('revoke execute on function public.submit_order_submission(uuid) from public, anon;'))
    assert.ok(code.includes('grant  execute on function public.submit_order_submission(uuid) to authenticated;'))
  })

  test('the two RPCs are separate names, never an overload', () => {
    // PostgREST resolves a function by the argument names in the request body.
    // Two functions sharing a name would be told apart only by which keys a
    // caller happened to send — so a client omitting the note key would
    // silently select a different function.
    assert.ok(sql.includes('is overloaded (% variants); PostgREST would resolve it by argument names'),
      'the migration fails if a second variant of any of the three names appears')
    // Counted per name, over all three, rather than for one of them.
    assert.ok(sql.includes("select unnest(array['submit_order_submission',"))
    assert.ok(sql.includes("'submit_order_submission_with_note',"))
    assert.ok(sql.includes("'submit_order_submission_internal'])"))
    const defined = [...declarations.matchAll(/create or replace function public\.(\w+)\(/g)].map(m => m[1])
    assert.equal(new Set(defined).size, defined.length, 'each name is defined once')
  })

  test('the new RPC is authenticated-only, like every other client door', () => {
    assert.ok(code.includes('revoke execute on function public.submit_order_submission_with_note(uuid, text) from public, anon;'))
    assert.ok(code.includes('grant  execute on function public.submit_order_submission_with_note(uuid, text) to authenticated;'))
  })

  test('all three are SECURITY DEFINER with a pinned search_path', () => {
    for (const [name, block] of [['internal', INTERNAL], ['plain', PLAIN], ['with_note', WITH_NOTE]] as const) {
      assert.ok(block.includes('security definer'), `${name} must be SECURITY DEFINER`)
      assert.ok(block.includes('set search_path = public, pg_temp'), `${name} must pin search_path`)
    }
    assert.ok(sql.includes('are not SECURITY DEFINER with a pinned search_path'),
      'and the migration asserts it for all three')
  })
})

// ── The reply itself ──────────────────────────────────────────────────────────

describe('the reply is optional, trimmed, capped and recorded', () => {
  test('it is trimmed before anything else looks at it', () => {
    assert.ok(INTERNAL.includes("v_note       text := nullif(btrim(coalesce(p_note, '')), '');"),
      'whitespace-only becomes NULL, so it is indistinguishable from an omitted note')
  })

  test('the cap matches the screen, and is checked before the row is locked', () => {
    assert.ok(INTERNAL.includes(`char_length(v_note) > ${RESUBMIT_NOTE_MAX_LENGTH}`))
    assert.ok(INTERNAL.includes('ORDER_SUBMISSION_NOTE_TOO_LONG'))
    const capAt = INTERNAL.indexOf('ORDER_SUBMISSION_NOTE_TOO_LONG')
    const lockAt = INTERNAL.indexOf('for update')
    assert.ok(capAt > -1 && lockAt > capAt,
      'an over-long note is refused before any lock is taken')
  })

  test('it lands on the submitted event in the append-only trail', () => {
    assert.ok(INTERNAL.includes(
      "p_submission_id, v_actor, 'submitted', v_sub.status, 'submitted', v_note,"),
      'the note argument of the activity logger is the reply')
    assert.equal(PI_ACTIVITY_LABEL.submitted, 'Submitted for approval',
      'which the Activity section already renders under this heading')
  })

  test('it NEVER overwrites the management review note', () => {
    // review_note is management's field. Clearing it on resubmission is the
    // applied behaviour and is unchanged; what must never happen is the
    // employee's answer being written over the reviewer's request.
    assert.ok(!INTERNAL.includes('review_note = v_note'))
    assert.ok(!INTERNAL.includes('review_note = p_note'))
    assert.ok(INTERNAL.includes('review_note = null'), 'the applied behaviour is unchanged')
    assert.ok(sql.includes('the employee reply must never overwrite the management review note'),
      'and the migration asserts it')
  })

  test('only draft and needs_changes can be submitted', () => {
    // Delegated to can_edit_order_submission, which admits exactly those two —
    // and the status transition trigger refuses every other origin regardless.
    assert.ok(INTERNAL.includes('public.can_edit_order_submission(p_submission_id)'))
    const applied = readMigration(SUBMISSIONS_FILE)
    assert.ok(applied.includes("and s.status in ('draft', 'needs_changes')"),
      'sanity: that helper is the one that admits the two employee-owned states')
  })

  test('submitted_at is still the transition trigger’s to write', () => {
    assert.ok(!INTERNAL.includes('submitted_at ='),
      'a resubmission’s time is stamped by the protected transition, not by this function')
  })
})

// ── The boundary ──────────────────────────────────────────────────────────────

describe('nothing about approval arrives with the reply', () => {
  test('no approval, numbering, advance, document or payment behaviour', () => {
    // NOT a blanket search for "xlsx": the inherited workbook validation
    // legitimately says "the stored workbook is not an .xlsx file". What must
    // be absent is document GENERATION and everything downstream of approval.
    for (const forbidden of ['approved', 'order_number', 'display_number', 'allocate_confirmed',
                             'advance', 'payment', 'generate_', 'pdfkit', 'order_id']) {
      assert.ok(!declarations.includes(forbidden),
        `${forbidden} belongs to a later phase`)
    }
    assert.ok(INTERNAL.includes('ORDER_SUBMISSION_WORKBOOK_NOT_XLSX'),
      'while the workbook type check it inherited is still there')
  })

  test('the migration refuses to apply over an approved or linked record', () => {
    assert.ok(sql.includes("where status = 'approved'"))
    assert.ok(sql.includes('where order_id is not null'))
  })

  test('no client role gains a table write, and the triggers stay armed', () => {
    assert.ok(sql.includes('client roles hold write privileges'))
    assert.ok(sql.includes('These triggers on order_submissions are not enabled'),
      'including the timestamp, transition and frozen-column triggers')
    assert.ok(!/grant[^;]*(insert|update|delete)[^;]*(anon|authenticated)/i.test(declarations))
  })

  test('no credential or project identifier is in the file', () => {
    assert.ok(!/postgres:\/\/|supabase\.co|service_role_key|eyJ[A-Za-z0-9]/.test(sql))
  })
})
