/**
 * Repository check: the PI submission migration keeps the guarantees phase 2
 * exists to establish.
 *
 * WHY A REPO CHECK
 * ----------------
 * Every promise below lives only in SQL, and each fails SILENTLY if a later
 * change "helpfully" adds the obvious missing policy or relaxes a constraint:
 *
 *   1. No client role may write these tables. RLS alone is not the control —
 *      the privileges are revoked too — and a permissive INSERT policy added
 *      later would look like a fix while re-opening the table.
 *   2. History is append-only. An UPDATE or DELETE policy on
 *      order_submission_activity would make an audit trail editable and no
 *      screen would look any different.
 *   3. This phase cannot approve anything or create an Order. That is enforced
 *      by a status-transition trigger, not by an absence of UI, and the trigger
 *      is the thing worth defending.
 *   4. Storage is private and scoped by submission path, so knowing an object
 *      key grants nothing.
 *   5. approve_order is protected, so no preset can hand it out.
 *
 * TypeScript sees none of this. These tests read the migration itself.
 *
 * Reads repository files only. No database, no network.
 *
 * Run:
 *   npx tsx --test src/lib/orders/submissionSchema.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { PROTECTED_ACTIONS, isProtectedAction, standardActionsForLevel, PRESET_LEVELS } from '../permissions/levels'
import { isActionEnforced } from '../permissions/enforcement'
import { getRegisteredModule } from '../permissions/registry'
import { deriveOrdersCapabilities, NO_ORDERS_CAPABILITIES } from '../permissions/orders'
import '../permissions/modules'

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations')

/** Normalised to LF: a Windows checkout stores CRLF, and every `\n` in the
 *  patterns below would otherwise silently match nothing. */
const lf = (s: string) => s.replace(/\r\n/g, '\n')

/** The submission migration, located by content rather than a pinned filename. */
function submissionMigration(): { file: string; sql: string } {
  const candidates = readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .map(file => ({ file, sql: lf(readFileSync(join(MIGRATIONS_DIR, file), 'utf8')) }))
    .filter(({ sql }) => /create table public\.order_submissions\b/i.test(sql))

  assert.equal(candidates.length, 1, 'expected exactly one migration creating public.order_submissions')
  return candidates[0]
}

const { file: MIGRATION_FILE, sql } = submissionMigration()

/**
 * The migration with `--` comments removed.
 *
 * Essential here: the header prose deliberately NAMES the things this phase must
 * not do ("allocate_confirmed_order_number", "approved") in order to explain why
 * it does not do them. A check scanning raw text would fail on the sentences
 * promising the very thing it verifies.
 */
const code = sql.replace(/--[^\n]*/g, '')

/**
 * Executable SQL minus `comment on ... is '...';` statements.
 *
 * Those carry prose that legitimately names the things this phase must NOT do —
 * "never seed public.orders.display_number", "below 40% of grand_total" — in
 * order to document why. A forbidden-text check reading `code` would fail on the
 * sentence promising the very thing it verifies. The quoted string is matched
 * properly (doubled quotes included) rather than to the next semicolon, because
 * several of these comments contain one.
 */
const statements = code.replace(/comment on [\s\S]*?is\s+'(?:[^']|'')*'\s*;/g, '')

/** The body of one `create table public.<name> ( ... );` block. */
function tableBlock(name: string): string {
  const start = code.indexOf(`create table public.${name} (`)
  assert.ok(start >= 0, `create table public.${name} not found`)
  const open = code.indexOf('(', start)
  let depth = 0
  for (let i = open; i < code.length; i++) {
    if (code[i] === '(') depth++
    else if (code[i] === ')') {
      depth--
      if (depth === 0) return code.slice(open + 1, i)
    }
  }
  assert.fail(`unbalanced parentheses in create table public.${name}`)
}

/** The full text of one `create or replace function public.<name>(...) ... $$;` */
function functionBlock(name: string): string {
  const needle = `create or replace function public.${name}(`
  const start = code.indexOf(needle)
  assert.ok(start >= 0, `function ${name} not found`)
  const tag = /\$[A-Za-z_]*\$/.exec(code.slice(start))?.[0]
  assert.ok(tag, `function ${name} has no dollar-quoted body`)
  const bodyOpen = code.indexOf(tag, start)
  const bodyClose = code.indexOf(tag, bodyOpen + tag.length)
  assert.ok(bodyClose > 0, `function ${name} body is not closed`)
  return code.slice(start, bodyClose + tag.length)
}

const SUBMISSIONS = tableBlock('order_submissions')
const ITEMS = tableBlock('order_submission_items')
const ACTIVITY = tableBlock('order_submission_activity')

const ALL_TABLES = ['order_submissions', 'order_submission_items', 'order_submission_activity'] as const

/** Every SECURITY DEFINER function this migration defines. */
const DEFINER_FUNCTIONS = [
  'order_submissions_enforce_status_transition',
  'order_submissions_guard_frozen_columns',
  'can_view_order_submission',
  'can_edit_order_submission',
  'can_write_order_submission_file',
  'log_order_submission_activity',
  'assert_order_submission_actor',
  'assert_order_submission_editor',
  'create_order_submission',
  'replace_order_submission_parse',
  'submit_order_submission',
  'request_order_submission_changes',
] as const

/**
 * The functions a signed-in client may call. All three move a submission
 * through its states; NONE of them writes a price, a quantity, a total, a
 * product line or an image mapping.
 */
const CLIENT_RPCS = [
  'create_order_submission',
  'submit_order_submission',
  'request_order_submission_changes',
] as const

/** Callable only by the server. See the parsed-data-is-server-written suite. */
const SERVER_ONLY_RPCS = ['replace_order_submission_parse'] as const

/** Callable by nobody: reached only from inside a definer function. */
const INTERNAL_FUNCTIONS = [
  'assert_order_submission_actor',
  'assert_order_submission_editor',
  'log_order_submission_activity',
  'order_submissions_enforce_status_transition',
  'order_submissions_guard_frozen_columns',
] as const

// ══ 1. It is exactly one new migration ══════════════════════════════════════

describe('the migration itself', () => {
  test('nothing that lands after it touches the submission tables from outside the feature', () => {
    // It WAS the newest when it was written, and the original rule here demanded
    // that EVERY later migration mention order_submission. That was the right
    // instinct expressed too broadly: it made this feature's test fail whenever
    // the company shipped anything else, which says nothing about safety.
    //
    // THE PROPERTY THAT ACTUALLY MATTERS is narrower and stricter: a migration
    // landing after this one must not read, write or reshape the tables this one
    // creates unless it is part of the same feature. Unrelated work — a Task
    // Management label, a Payroll setting — may land whenever it likes, because
    // it cannot depend on something it never names.
    //
    // So a later migration is acceptable if EITHER it is part of the submission
    // feature, OR it names none of its tables. A file that quietly alters
    // order_submissions while claiming to be about something else fails here,
    // which the old spelling would have missed entirely as long as the word
    // "order_submission" appeared anywhere in it.
    // NARROWED ONCE MORE, in 20260918000000. "Names none of its tables" was the
    // right property while every neighbour was independent of the PI. The first
    // module that genuinely DEPENDS on a PI — payment allocation, which cannot
    // say which PI a payment belongs to without naming order_submissions in a
    // FOREIGN KEY — made a bare mention the wrong thing to forbid.
    //
    // What still must not happen is unchanged, and is what this now tests: an
    // outside migration may not RESHAPE these tables (alter, drop, or re-policy
    // them) and may not WRITE to them. Pointing a foreign key at one, reading one
    // to validate a target, or declaring a %rowtype of one are all safe — they
    // depend on the feature without changing it, which is what a neighbouring
    // module is supposed to do.
    //
    // Line comments are stripped first: this file's own name appears in the
    // prose of later migrations, and prose is not a statement.
// The ONE structural change an outside phase is allowed to make to these tables,
    // and the reason it is allowed: order_submission_activity.action is a CLOSED set,
    // and 20260915000000 §10 states that a phase producing a new kind of event
    // extends it "in its own migration — a visible change rather than a silent new
    // event type". That IS the sanctioned extension point, so a migration that only
    // drops and re-adds the action CHECK is doing what the design asks of it.
    //
    // Nothing else is forgiven: the statements below are removed before the
    // structural test runs, so a file that also alters a column, adds a policy, or
    // writes a row still fails on that.
    const PI_ACTIVITY_ACTION_CHECK_EXTENSION =
      /(?:execute\s+format\(\s*'alter\s+table\s+(?:public\.)?order_submission_activity\s+drop\s+constraint[^;]*;|alter\s+table\s+(?:public\.)?order_submission_activity\s+(?:drop|add)\s+constraint\s+[^;]*order_submission_activity_action_check[^;]*;|alter\s+table\s+(?:public\.)?order_submission_activity\s+add\s+constraint\s+order_submission_activity_action_check[^;]*;)/gi
    
    function withoutSanctionedActivityExtension(sql: string): string {
      return sql.replace(PI_ACTIVITY_ACTION_CHECK_EXTENSION, '')
    }

    const STRUCTURAL_OR_WRITE = (table: string) => new RegExp(
      '(?:' +
        `alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:public\\.)?${table}\\b` + '|' +
        `drop\\s+table\\s+(?:if\\s+exists\\s+)?(?:public\\.)?${table}\\b` + '|' +
        `insert\\s+into\\s+(?:public\\.)?${table}\\b` + '|' +
        `update\\s+(?:only\\s+)?(?:public\\.)?${table}\\s+set\\b` + '|' +
        `delete\\s+from\\s+(?:public\\.)?${table}\\b` + '|' +
        `truncate\\s+(?:table\\s+)?(?:public\\.)?${table}\\b` + '|' +
        `(?:create|alter|drop)\\s+policy\\s+[^;]*?\\bon\\s+(?:public\\.)?${table}\\b` + '|' +
        `(?:create|alter|drop)\\s+trigger\\s+[^;]*?\\bon\\s+(?:public\\.)?${table}\\b` +
      ')', 'is')

    const all = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort()
    const later = all.slice(all.indexOf(MIGRATION_FILE) + 1)

    for (const file of later) {
      const partOfFeature = /order_submission/i.test(file)
      if (partOfFeature) continue

      const text = withoutSanctionedActivityExtension(
        lf(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
          .split('\n').map(line => line.replace(/--.*$/, '')).join('\n'))

      for (const table of ALL_TABLES) {
        assert.ok(
          !STRUCTURAL_OR_WRITE(table).test(text),
          `${file} is not part of the submission feature but reshapes or writes ${table}`,
        )
      }
    }
  })

  test('every migration that IS part of the feature sorts after this one', () => {
    // The dependency direction, asserted rather than assumed: nothing belonging
    // to the submission feature may be ordered BEFORE the migration that creates
    // its tables. Phase A, the image table, the employee reply and Phase B all
    // depend on what this file creates, so a later phase renumbered downward —
    // exactly the mistake a version collision invites — fails here.
    // MIGRATION_FILE is named order_PI_submissions, not order_submission, so it
    // is named explicitly rather than matched — the set is "this file, plus
    // everything that carries the feature's prefix".
    const all = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort()
    const feature = all.filter(f => f === MIGRATION_FILE || /order_submission/i.test(f))

    assert.ok(feature.length >= 2, 'the feature spans several migrations')
    assert.equal(feature[0], MIGRATION_FILE,
      'the migration that CREATES the submission tables must come first')
    assert.deepEqual(feature, [...feature].sort(),
      'the feature migrations must be in ascending version order')
  })

  test('no two migrations share a version prefix, anywhere in the directory', () => {
    // Supabase keys supabase_migrations.schema_migrations on the numeric prefix,
    // not the filename. Two files sharing one version means only ONE can ever be
    // recorded — the second is silently treated as already applied and skipped,
    // with no error and no warning. That is a whole feature going missing in
    // production while `migration list` reports it as applied.
    const all = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort()
    const byVersion = new Map<string, string[]>()

    for (const file of all) {
      const version = /^(\d+)_/.exec(file)?.[1]
      assert.ok(version, `${file} has no numeric version prefix`)
      byVersion.set(version, [...(byVersion.get(version) ?? []), file])
    }

    const collisions = [...byVersion.entries()].filter(([, files]) => files.length > 1)
    assert.deepEqual(collisions, [],
      `these versions are claimed by more than one migration: ${
        collisions.map(([v, f]) => `${v} -> ${f.join(', ')}`).join(' | ')}`)
  })

  test('is still the only migration that creates the submission tables', () => {
    const creators = readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith('.sql'))
      .filter(f => /create table public\.order_submissions\b/i
        .test(lf(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))))
    assert.deepEqual(creators, [MIGRATION_FILE])
  })

  test('creates all three submission tables', () => {
    for (const table of ALL_TABLES) {
      assert.ok(
        new RegExp(`create table public\\.${table}\\b`).test(code),
        `${table} must be created here`,
      )
    }
  })

  test('alters no existing table and drops nothing', () => {
    // Additive only. ALTER is permitted on the three tables this file creates
    // (enabling RLS), and nowhere else. DROP TRIGGER IF EXISTS applies only to
    // its own new triggers.
    const alters = [...code.matchAll(/alter table\s+(?:if exists\s+)?public\.(\w+)/gi)]
      .map(m => m[1])
      .filter(t => !(ALL_TABLES as readonly string[]).includes(t))
    assert.deepEqual(alters, [], 'this migration must not alter a pre-existing table')

    const drops = [...code.matchAll(/drop\s+(table|column|policy|constraint|function)\s+/gi)]
      .map(m => m[0].trim().toLowerCase())
    for (const drop of drops) {
      assert.ok(!drop.startsWith('drop table'), 'must not drop a table')
      assert.ok(!drop.startsWith('drop column'), 'must not drop a column')
      assert.ok(!drop.startsWith('drop function'), 'must not drop a function')
    }
  })
})

// ══ 2. Column contracts ═════════════════════════════════════════════════════

describe('order_submissions columns', () => {
  const REQUIRED = [
    'id', 'status', 'submitted_by', 'created_by', 'assigned_to',
    'approved_by', 'approved_at', 'rejected_by', 'rejected_at', 'review_note',
    'client_name', 'creation_date', 'source_created_by', 'boe_gst', 'contact_number',
    'bill_to_name', 'bill_to_phone', 'bill_to_gst', 'billing_address',
    'ship_to_name', 'ship_to_phone', 'ship_to_gst', 'shipping_address',
    'order_confirmation_date', 'dispatch_commitment', 'source_order_number',
    'source_workbook_path', 'source_workbook_name', 'source_workbook_size_bytes',
    'source_workbook_sha256', 'template_version',
    'parse_warnings', 'parse_blocking_issues',
    'gross_product_amount', 'discount_amount', 'subtotal_after_discount',
    'fabric_cost', 'packing_cost', 'transportation_amount', 'transportation_text',
    'total_before_gst', 'gst_amount', 'grand_total',
    'advance_exception_reason', 'order_id', 'created_at', 'updated_at',
  ]

  for (const column of REQUIRED) {
    test(`declares ${column}`, () => {
      assert.ok(
        new RegExp(`^\\s*${column}\\s`, 'm').test(SUBMISSIONS),
        `order_submissions.${column} is missing`,
      )
    })
  }

  test('the five statuses are the controlled set', () => {
    const check = /status\s+text[\s\S]*?check \(status in \(([\s\S]*?)\)\)/.exec(SUBMISSIONS)
    assert.ok(check, 'status must carry a CHECK')
    const values = [...check[1].matchAll(/'(\w+)'/g)].map(m => m[1]).sort()
    assert.deepEqual(values, ['approved', 'draft', 'needs_changes', 'rejected', 'submitted'])
  })

  test('the parse snapshot is retained as two jsonb arrays', () => {
    for (const column of ['parse_warnings', 'parse_blocking_issues']) {
      assert.ok(
        new RegExp(`${column}\\s+jsonb\\s+not null default '\\[\\]'::jsonb`).test(SUBMISSIONS),
        `${column} must default to an empty jsonb array`,
      )
      assert.ok(
        new RegExp(`jsonb_typeof\\(${column}\\) = 'array'`).test(SUBMISSIONS),
        `${column} must be constrained to an array`,
      )
    }
  })

  test('source_order_number is documented as informational only', () => {
    assert.ok(
      /comment on column public\.order_submissions\.source_order_number/.test(sql),
      'the column must carry a comment',
    )
    assert.match(sql, /never seed public\.orders\.display_number or the order number cycle/)
  })
})

describe('financial constraints', () => {
  test('no money column may be negative', () => {
    const columns = [
      'gross_product_amount', 'discount_amount', 'subtotal_after_discount',
      'fabric_cost', 'packing_cost', 'transportation_amount',
      'total_before_gst', 'gst_amount', 'grand_total',
    ]
    for (const column of columns) {
      assert.ok(
        new RegExp(`check \\(${column} >= 0\\)|check \\(${column} is null or ${column} >= 0\\)`).test(SUBMISSIONS),
        `${column} must be constrained non-negative`,
      )
    }
  })

  test('the two figures the parser always produces are NOT NULL with a default', () => {
    for (const column of ['gross_product_amount', 'discount_amount']) {
      assert.ok(
        new RegExp(`${column}\\s+numeric\\(12,2\\) not null default 0`).test(SUBMISSIONS),
        `${column} must be not null default 0`,
      )
    }
  })

  test('the rest stay NULLABLE, because a PI legitimately writes words there', () => {
    // PiAmountOrText.amount is `number | null`: a workbook that says
    // "as applicable" in a commercial cell must not be rejected by the database
    // after the parser accepted it.
    for (const column of ['subtotal_after_discount', 'fabric_cost', 'packing_cost', 'total_before_gst', 'gst_amount', 'grand_total']) {
      assert.ok(
        !new RegExp(`${column}\\s+numeric\\(12,2\\) not null`).test(SUBMISSIONS),
        `${column} must remain nullable`,
      )
    }
  })

  test('transportation is numeric OR text, never both', () => {
    assert.match(
      SUBMISSIONS,
      /constraint order_submissions_transportation_one_form check \(\s*transportation_amount is null or transportation_text is null\s*\)/,
    )
  })

  test('the discount is stored as the discount whatever the label says', () => {
    assert.match(
      sql,
      /stored as the discount regardless of whether the workbook labels that row "Discount" or "Design Fees"/,
    )
  })
})

describe('review-state invariants', () => {
  test('anything past the employee-owned states carries no blocking issues', () => {
    assert.match(
      SUBMISSIONS,
      /order_submissions_reviewable_has_no_blocking_issues check \(\s*status in \('draft', 'needs_changes'\)\s*or jsonb_array_length\(parse_blocking_issues\) = 0/,
    )
  })

  test('anything past the employee-owned states has a client and a workbook', () => {
    const c = /order_submissions_reviewable_is_complete check \(([\s\S]*?)\n  \),/.exec(SUBMISSIONS)
    assert.ok(c, 'the completeness constraint must exist')
    assert.match(c[1], /client_name is not null/)
    assert.match(c[1], /source_workbook_path is not null/)
  })

  test('approval and rejection columns move together with the status', () => {
    assert.match(SUBMISSIONS, /order_submissions_approval_consistency check \(\s*\(status =\s+'approved' and approved_by is not null and approved_at is not null\)/)
    assert.match(SUBMISSIONS, /order_submissions_rejection_consistency check \(\s*\(status =\s+'rejected' and rejected_by is not null and rejected_at is not null\)/)
  })

  test('an Order can only be linked to an APPROVED submission', () => {
    assert.match(
      SUBMISSIONS,
      /order_submissions_order_link_requires_approval check \(\s*order_id is null or status = 'approved'\s*\)/,
    )
  })

  test('one Order per submission, and one submission per Order', () => {
    assert.match(
      code,
      /create unique index order_submissions_order_id_key\s*\n\s*on public\.order_submissions \(order_id\) where order_id is not null/,
    )
  })
})

// ══ 3. Items ════════════════════════════════════════════════════════════════

describe('order_submission_items', () => {
  test('declares every required column', () => {
    const required = [
      'id', 'submission_id', 'source_row', 'item_sequence', 'source_product_code',
      'product_name', 'quantity', 'dimensions', 'material', 'customization',
      'cost_per_piece', 'total_amount', 'image_storage_path', 'image_mime_type',
      'image_sha256', 'image_anchor_row', 'sort_order', 'created_at',
    ]
    for (const column of required) {
      assert.ok(
        new RegExp(`^\\s*${column}\\s`, 'm').test(ITEMS),
        `order_submission_items.${column} is missing`,
      )
    }
  })

  test('MATERIAL AND CUSTOMIZATION ARE SEPARATE COLUMNS', () => {
    // The single most important shape in this table: they answer different
    // questions and the factory needs both.
    assert.ok(/^\s*material\s+text/m.test(ITEMS), 'material must be its own column')
    assert.ok(/^\s*customization\s+text/m.test(ITEMS), 'customization must be its own column')
    assert.ok(
      !/material_and_customization|material_customization|customization_material/.test(code),
      'the two must never be merged into one column',
    )
  })

  test('customization is optional — never NOT NULL', () => {
    assert.ok(!/customization\s+text\s+not null/.test(ITEMS))
  })

  test('quantity and cost are required and strictly positive', () => {
    assert.match(ITEMS, /quantity\s+numeric\(12,2\) not null check \(quantity > 0\)/)
    assert.match(ITEMS, /cost_per_piece\s+numeric\(12,2\) not null check \(cost_per_piece > 0\)/)
  })

  test('the line total is required and non-negative', () => {
    assert.match(ITEMS, /total_amount\s+numeric\(12,2\) not null check \(total_amount >= 0\)/)
  })

  test('sequence, name and image are nullable at rest — required to submit', () => {
    // Deliberate: a draft must be able to hold an incomplete parse so the
    // employee can see what is wrong. submit_order_submission() is what refuses.
    for (const column of ['item_sequence', 'product_name', 'image_storage_path']) {
      assert.ok(
        !new RegExp(`${column}\\s+text\\s+not null`).test(ITEMS),
        `${column} must be nullable at rest`,
      )
      assert.ok(
        new RegExp(`${column} is null or btrim\\(${column}\\) <> ''`).test(ITEMS),
        `${column} must reject a blank string when present`,
      )
    }
    const submit = functionBlock('submit_order_submission')
    assert.match(submit, /item_sequence is null/)
    assert.match(submit, /product_name is null/)
    assert.match(submit, /image_storage_path is null/)
    assert.match(submit, /ORDER_SUBMISSION_INCOMPLETE/)
  })

  test('the item sequence is unique within a submission', () => {
    assert.match(
      code,
      /create unique index order_submission_items_sequence_key\s*\n\s*on public\.order_submission_items \(submission_id, item_sequence\)\s*\n\s*where item_sequence is not null/,
    )
  })

  test('the sort order is unique within a submission', () => {
    assert.match(
      code,
      /create unique index order_submission_items_sort_order_key\s*\n\s*on public\.order_submission_items \(submission_id, sort_order\)/,
    )
  })

  test('items disappear with their submission', () => {
    assert.match(ITEMS, /submission_id\s+uuid\s+not null references public\.order_submissions\(id\) on delete cascade/)
  })

  test('no official product code is generated', () => {
    assert.ok(!/\bproduct_code\b/.test(ITEMS.replace(/source_product_code/g, '')),
      'only source_product_code may exist at this stage')
  })

  test('the image mime type is limited to the three raster formats', () => {
    assert.match(ITEMS, /image_mime_type in \('image\/png', 'image\/jpeg', 'image\/webp'\)/)
  })
})

// ══ 4. Activity is append-only ══════════════════════════════════════════════

describe('order_submission_activity', () => {
  test('declares the required columns', () => {
    for (const column of ['submission_id', 'actor_id', 'action', 'previous_status', 'new_status', 'note', 'metadata', 'created_at']) {
      assert.ok(new RegExp(`^\\s*${column}\\s`, 'm').test(ACTIVITY), `${column} is missing`)
    }
  })

  test('the action set is closed to what this phase can produce', () => {
    const check = /check \(action in \(([\s\S]*?)\)\)/.exec(ACTIVITY)
    assert.ok(check, 'action must carry a CHECK')
    const values = [...check[1].matchAll(/'(\w+)'/g)].map(m => m[1]).sort()
    assert.deepEqual(values, ['changes_requested', 'parse_replaced', 'submission_created', 'submitted'])
    // Neither terminal action can be written, which matches a phase that cannot
    // reach either status.
    assert.ok(!values.includes('approved'))
    assert.ok(!values.includes('rejected'))
  })

  test('there is NO update or delete policy on history, for anyone', () => {
    const policies = [...code.matchAll(/create policy "([^"]+)" on public\.order_submission_activity\s*\n\s*for (\w+)/g)]
    assert.ok(policies.length > 0, 'expected at least one policy')
    for (const [, name, command] of policies) {
      assert.ok(
        command === 'select' || name.endsWith('_module_entry_gate'),
        `history must not carry a ${command} policy (${name})`,
      )
    }
  })

  test('only the definer logger writes it, and no role may call that', () => {
    assert.match(code, /insert into public\.order_submission_activity/)
    const inserts = [...code.matchAll(/insert into public\.order_submission_activity/g)]
    assert.equal(inserts.length, 1, 'exactly one writer')
    const logger = functionBlock('log_order_submission_activity')
    assert.match(logger, /insert into public\.order_submission_activity/)
    assert.match(
      code,
      /revoke execute on function public\.log_order_submission_activity\([^)]*\)\s*\n?\s*from public, anon, authenticated, service_role/,
    )
    assert.ok(
      !/grant\s+execute on function public\.log_order_submission_activity/.test(code),
      'the logger must not be granted to any role',
    )
  })

  test('the actor is an explicit parameter — safe, because nobody can call it', () => {
    // auth.uid() is NULL under the service role, so an auth.uid()-based logger
    // would attribute every server-side parse to nobody. An explicit actor is
    // only safe because EXECUTE is revoked from every role including
    // service_role, which the test above asserts.
    const logger = functionBlock('log_order_submission_activity')
    assert.match(logger, /p_actor_id\s+uuid/)
    assert.match(logger, /values\s*\n?\s*\(p_submission_id, p_actor_id/)
    assert.ok(
      !/auth\.uid\(\)/.test(logger),
      'the logger must not silently fall back to auth.uid()',
    )
  })

  test('every logged event carries the actor its caller validated', () => {
    // A call that forgot the actor would insert the ACTION into the actor
    // column, so this also catches argument-order drift.
    for (const [fn, actor] of [
      ['create_order_submission', 'v_actor'],
      ['replace_order_submission_parse', 'p_actor_id'],
      ['submit_order_submission', 'v_actor'],
      ['request_order_submission_changes', 'v_actor'],
    ] as const) {
      const body = functionBlock(fn)
      assert.match(
        body,
        new RegExp(`log_order_submission_activity\\(\\s*\\n?\\s*[\\w.]+, ${actor},`),
        `${fn} must pass ${actor} as the logged actor`,
      )
    }
  })
})

// ══ 5. RLS and writes ═══════════════════════════════════════════════════════

describe('row level security', () => {
  for (const table of ALL_TABLES) {
    test(`${table} has RLS enabled`, () => {
      assert.ok(
        new RegExp(`alter table public\\.${table}\\s+enable row level security`).test(code),
        `${table} must enable RLS`,
      )
    })
  }

  test('no client role holds INSERT, UPDATE, DELETE or TRUNCATE on any of them', () => {
    for (const table of ALL_TABLES) {
      assert.ok(
        new RegExp(`revoke insert, update, delete, truncate, references, trigger\\s*\\n\\s*on public\\.${table}\\s+from anon, authenticated`).test(code),
        `${table} must revoke client writes`,
      )
      assert.ok(
        new RegExp(`grant select on public\\.${table}\\s+to authenticated`).test(code),
        `${table} must grant only SELECT`,
      )
    }
  })

  test('there is not one permissive write policy on any of the three tables', () => {
    const policies = [...code.matchAll(/create policy "([^"]+)" on public\.(order_submissions|order_submission_items|order_submission_activity)\s*\n\s*(as restrictive )?for (\w+)/g)]
    assert.ok(policies.length >= 6, 'expected the select policies and the entry gates')
    for (const [, name, , restrictive, command] of policies) {
      if (restrictive) continue
      assert.equal(command, 'select', `${name} must be a SELECT policy, not ${command}`)
    }
  })

  test('no policy is USING (true)', () => {
    assert.ok(
      !/using\s*\(\s*true\s*\)/i.test(code),
      'a blanket USING (true) would expose every submission',
    )
  })

  test('every table carries the RESTRICTIVE Orders module entry gate', () => {
    for (const table of ALL_TABLES) {
      assert.ok(
        new RegExp(`create policy "${table}_module_entry_gate" on public\\.${table}\\s*\\n\\s*as restrictive for all to authenticated\\s*\\n\\s*using \\(public\\.module_entry_open\\('orders'\\)\\)`).test(code),
        `${table} must carry a restrictive module entry gate`,
      )
    }
  })

  test('visibility is one shared rule, used by the tables AND storage', () => {
    const viewer = functionBlock('can_view_order_submission')
    assert.match(viewer, /s\.created_by\s+= auth\.uid\(\)/)
    assert.match(viewer, /s\.submitted_by = auth\.uid\(\)/)
    assert.match(viewer, /s\.assigned_to\s+= auth\.uid\(\)/)
    assert.match(viewer, /actor_has_module_permission\('orders', 'approve_order'\)/)
    // Used by both child tables and by the storage SELECT policy.
    assert.ok((code.match(/can_view_order_submission\(/g) ?? []).length >= 4)
  })

  test('editing stops the moment a submission is submitted', () => {
    const editor = functionBlock('can_edit_order_submission')
    assert.match(editor, /s\.status in \('draft', 'needs_changes'\)/)
    assert.match(editor, /s\.order_id is null/)
    assert.match(editor, /u\.is_active/)
    assert.match(editor, /coalesce\(u\.is_deleted, false\) = false/)
  })
})

// ══ 6. RPC contract ═════════════════════════════════════════════════════════

describe('the write RPCs', () => {
  for (const fn of DEFINER_FUNCTIONS) {
    test(`${fn} is SECURITY DEFINER with a pinned search_path`, () => {
      const body = functionBlock(fn)
      assert.match(body, /security definer/)
      assert.match(body, /set search_path = public, pg_temp/)
    })
  }

  for (const fn of CLIENT_RPCS) {
    test(`${fn} is revoked from PUBLIC and anon, granted only to authenticated`, () => {
      assert.ok(
        new RegExp(`revoke execute on function public\\.${fn}\\([^)]*\\) from public, anon`).test(code),
        `${fn} must revoke public and anon`,
      )
      assert.ok(
        new RegExp(`grant\\s+execute on function public\\.${fn}\\([^)]*\\) to authenticated`).test(code),
        `${fn} must grant execute only to authenticated`,
      )
      assert.ok(
        !new RegExp(`grant\\s+execute on function public\\.${fn}\\([^)]*\\) to (public|anon)`).test(code),
        `${fn} must never be granted to public or anon`,
      )
    })
  }

  test('the internal helpers are callable by no role at all', () => {
    for (const fn of INTERNAL_FUNCTIONS) {
      assert.ok(
        new RegExp(`revoke execute on function public\\.${fn}\\([^)]*\\)\\s*\\n?\\s*from public, anon, authenticated`).test(code),
        `${fn} must be revoked from authenticated too`,
      )
      assert.ok(
        !new RegExp(`grant\\s+execute on function public\\.${fn}\\(`).test(code),
        `${fn} must not be granted to any role`,
      )
    }
  })

  test('every CLIENT RPC resolves the actor from auth.uid() and proves it is active', () => {
    for (const fn of CLIENT_RPCS) {
      const body = functionBlock(fn)
      assert.match(body, /public\.assert_order_submission_actor\(\)/, `${fn} must assert the actor`)
      assert.ok(!/p_actor|p_user_id/.test(body), `${fn} must not accept a caller-supplied actor`)
    }
    const actor = functionBlock('assert_order_submission_actor')
    assert.match(actor, /u\.is_active and coalesce\(u\.is_deleted, false\) = false/)
  })

  test('creating and submitting require orders.create', () => {
    for (const fn of ['create_order_submission', 'submit_order_submission']) {
      assert.match(
        functionBlock(fn),
        /actor_has_module_permission\('orders', 'create'\)/,
        `${fn} must require orders.create`,
      )
    }
  })

  test('reviewer actions require orders.approve_order', () => {
    assert.match(
      functionBlock('request_order_submission_changes'),
      /actor_has_module_permission\('orders', 'approve_order'\)/,
    )
  })

  test('employee edits are ownership-gated', () => {
    // The client door resolves auth.uid(); the server door validates an explicit
    // actor. Both end at ownership plus an editable state.
    assert.match(
      functionBlock('submit_order_submission'),
      /public\.can_edit_order_submission\(p_submission_id\)/,
      'submit must check ownership and state',
    )
    assert.match(
      functionBlock('replace_order_submission_parse'),
      /public\.assert_order_submission_editor\(p_submission_id, p_actor_id\)/,
      'the parse writer must validate the explicit actor against this submission',
    )
  })

  test('a submitted record cannot be edited outside the correction path', () => {
    // can_edit_order_submission allows only draft and needs_changes, and the
    // only route back to needs_changes is a reviewer calling
    // request_order_submission_changes.
    const editor = functionBlock('can_edit_order_submission')
    assert.ok(!/'submitted'/.test(editor), 'a submitted record must not be editable')
    const back = functionBlock('request_order_submission_changes')
    assert.match(back, /v_status <> 'submitted'/)
    assert.match(back, /ORDER_SUBMISSION_NOTE_REQUIRED/)
  })

  test('parse replacement is atomic: delete every item, then insert the new set', () => {
    const body = functionBlock('replace_order_submission_parse')
    const del = body.indexOf('delete from public.order_submission_items')
    const ins = body.indexOf('insert into public.order_submission_items')
    assert.ok(del > 0 && ins > del, 'items must be deleted before the replacement insert')
    assert.match(body, /for update/, 'the submission row must be locked')
  })

  test('submission is refused while any blocking issue remains', () => {
    const body = functionBlock('submit_order_submission')
    assert.match(body, /jsonb_array_length\(v_sub\.parse_blocking_issues\) > 0/)
    assert.match(body, /ORDER_SUBMISSION_BLOCKED/)
  })

  test('every RPC logs its status transition', () => {
    for (const fn of ['create_order_submission', 'submit_order_submission', 'request_order_submission_changes', 'replace_order_submission_parse']) {
      assert.match(
        functionBlock(fn),
        /perform public\.log_order_submission_activity\(/,
        `${fn} must write history`,
      )
    }
  })
})

// ══ 6b. Parsed commercial data is SERVER-written ════════════════════════════

describe('parsed data cannot be manufactured by a client', () => {
  test('every server-only RPC is revoked from PUBLIC, anon AND authenticated', () => {
    for (const fn of SERVER_ONLY_RPCS) {
      assert.ok(
        new RegExp(`revoke execute on function public\\.${fn}\\([^)]*\\)\\s*\\n?\\s*from public, anon, authenticated;`).test(code),
        `${fn} must revoke authenticated alongside public and anon`,
      )
      assert.ok(
        !new RegExp(`grant\\s+execute on function public\\.${fn}\\([^)]*\\)\\s*\\n?\\s*to authenticated`).test(code),
        `an authenticated grant on ${fn} would make every price client-writable`,
      )
      assert.ok(
        !new RegExp(`grant\\s+execute on function public\\.${fn}\\([^)]*\\)\\s*\\n?\\s*to (public|anon)`).test(code),
        `${fn} must never be granted to public or anon`,
      )
    }
  })

  test('the client and server-only sets are disjoint and cover every RPC', () => {
    // A function that drifted into both lists — or out of both — is exactly how
    // the parse writer would quietly become client-callable again.
    const declared = [...CLIENT_RPCS, ...SERVER_ONLY_RPCS]
    assert.equal(new Set(declared).size, declared.length, 'no RPC may be in both sets')
    const publicFunctions = [...code.matchAll(
      /grant\s+execute on function public\.(\w+)\(/g,
    )].map(m => m[1])
    for (const fn of declared) {
      assert.ok(publicFunctions.includes(fn), `${fn} must carry exactly one grant`)
    }
  })

  test('it is granted to service_role, explicitly rather than by default privilege', () => {
    assert.match(
      code,
      /grant\s+execute on function public\.replace_order_submission_parse\(uuid, uuid, jsonb\)\s*\n?\s*to service_role;/,
    )
  })

  test('the migration asserts the grant at apply time, both directions', () => {
    assert.match(code, /has_function_privilege\('authenticated', p\.oid, 'EXECUTE'\)/)
    assert.match(code, /has_function_privilege\('service_role', p\.oid, 'EXECUTE'\)/)
    assert.match(code, /parsed commercial data would be client-writable/)
  })

  test('it stays SECURITY DEFINER with a pinned search_path', () => {
    const body = functionBlock('replace_order_submission_parse')
    assert.match(body, /security definer/)
    assert.match(body, /set search_path = public, pg_temp/)
  })

  test('it still proves the submission exists and is editable', () => {
    const body = functionBlock('replace_order_submission_parse')
    assert.match(body, /for update/)
    assert.match(body, /Order submission % not found/)
    const editor = functionBlock('assert_order_submission_editor')
    assert.match(editor, /v_sub\.status not in \('draft', 'needs_changes'\)/)
    assert.match(editor, /ORDER_SUBMISSION_NOT_EDITABLE/)
  })

  test('the explicit actor is RE-VALIDATED, not trusted because service_role sent it', () => {
    const editor = functionBlock('assert_order_submission_editor')
    // active and not soft-deleted
    assert.match(editor, /u\.is_active/)
    assert.match(editor, /coalesce\(u\.is_deleted, false\) = false/)
    // holds orders.create, resolved FOR THAT ACTOR rather than for auth.uid()
    assert.match(editor, /resolve_permission\(p_actor_id, 'orders', 'create'\)/)
    assert.ok(
      !/auth\.uid\(\)/.test(editor),
      'the explicit-actor path must not consult auth.uid(), which is NULL under the service role',
    )
    // owns this submission
    assert.match(editor, /v_sub\.created_by = p_actor_id\s*\n?\s*or v_sub\.submitted_by = p_actor_id/)
    assert.match(editor, /ORDER_SUBMISSION_NOT_OWNED/)
    // and a null actor is refused outright
    assert.match(editor, /ORDER_SUBMISSION_ACTOR_REQUIRED/)
  })

  test('no client-callable function writes a commercial field or an item', () => {
    // The check that matters: the three doors a browser can reach must not
    // touch a price, a total or a product line.
    const COMMERCIAL = [
      'gross_product_amount', 'discount_amount', 'subtotal_after_discount',
      'fabric_cost', 'packing_cost', 'transportation_amount', 'total_before_gst',
      'gst_amount', 'grand_total',
    ]
    for (const fn of CLIENT_RPCS) {
      const body = functionBlock(fn)
      for (const column of COMMERCIAL) {
        assert.ok(
          !new RegExp(`${column}\\s*=`).test(body),
          `${fn} must not write ${column}`,
        )
      }
      assert.ok(
        !/insert into public\.order_submission_items|update public\.order_submission_items/.test(body),
        `${fn} must not write product lines`,
      )
    }
  })

  test('only the server-only function writes items at all', () => {
    const writers = [...code.matchAll(
      /(insert into|update|delete from) public\.order_submission_items/g,
    )]
    assert.ok(writers.length > 0)
    const parse = functionBlock('replace_order_submission_parse')
    for (const [statement] of writers) {
      assert.ok(parse.includes(statement), `"${statement}" must live inside the server-only function`)
    }
  })

  test('the parse writer never moves the status', () => {
    // It reads v_status for the audit row and writes it back nowhere. Status is
    // owned by submit / request_changes, which is what keeps the transition
    // graph the single account of how a submission moves.
    const body = functionBlock('replace_order_submission_parse')
    const update = /update public\.order_submissions set([\s\S]*?)where id = p_submission_id;/.exec(body)
    assert.ok(update, 'the parse update must be locatable')
    assert.ok(!/\bstatus\s*=/.test(update[1]), 'the parse writer must not assign status')
  })

  test('the authorization guards cannot evaluate to NULL and fall open', () => {
    // `not (NULL or false)` is NULL, and an IF on NULL does not take its branch —
    // so an uncoalesced boolean here would silently pass both guards.
    const editor = functionBlock('assert_order_submission_editor')
    assert.match(editor, /select coalesce\(u\.role = 'admin', false\) into v_is_admin/)
    assert.match(editor, /if not \(coalesce\(v_is_admin, false\)/)
    assert.match(editor, /or coalesce\(v_is_admin, false\)\) then/)
  })

  test('the required server flow is documented for the phase that builds it', () => {
    assert.match(sql, /authenticate the request and resolve the employee from that session/)
    assert.match(sql, /run the Phase 1 parser \(src\/lib\/pi\/masterSheetParser\.ts\) server-side/)
    assert.match(sql, /must NOT accept a parse result from the browser/)
  })
})

// ══ 6c. Storage writes follow the editable state ════════════════════════════

describe('storage read and write are separate authorities', () => {
  const insertPolicy = /create policy "order_files_insert"[\s\S]*?;/.exec(code)![0]
  const deletePolicy = /create policy "order_files_delete"[\s\S]*?;/.exec(code)![0]
  const selectPolicy = /create policy "order_files_select"[\s\S]*?;/.exec(code)![0]
  const writer = functionBlock('can_write_order_submission_file')
  const viewer = functionBlock('can_view_order_submission')

  test('SELECT resolves the VIEW predicate', () => {
    assert.match(selectPolicy, /can_view_order_submission\(public\.order_file_submission_id\(name\)\)/)
  })

  test('INSERT and DELETE resolve the WRITE predicate, not the view one', () => {
    for (const [name, policy] of [['insert', insertPolicy], ['delete', deletePolicy]] as const) {
      assert.match(
        policy,
        /can_write_order_submission_file\(public\.order_file_submission_id\(name\)\)/,
        `${name} must use the write predicate`,
      )
      assert.ok(
        !/can_view_order_submission/.test(policy),
        `${name} must not be satisfiable by the read rule`,
      )
      assert.ok(
        !/can_edit_order_submission/.test(policy),
        `${name} must use the narrower storage-write rule`,
      )
    }
  })

  test('a reviewer can SELECT — assigned_to is in the read rule', () => {
    assert.match(viewer, /s\.assigned_to\s+= auth\.uid\(\)/)
  })

  test('a reviewer canNOT insert or delete — assigned_to is absent from the write rule', () => {
    assert.ok(
      !/assigned_to/.test(writer),
      'an assigned reviewer must not gain write access by being assigned',
    )
  })

  test('an approve_order holder can SELECT but canNOT insert or delete', () => {
    assert.match(viewer, /actor_has_module_permission\('orders', 'approve_order'\)/)
    assert.ok(
      !/approve_order/.test(writer),
      'approval authority must not confer the ability to replace the file being approved',
    )
  })

  test('the owner may write only while the submission is draft or needs_changes', () => {
    assert.match(writer, /s\.status in \('draft', 'needs_changes'\)/)
    assert.match(writer, /s\.created_by = auth\.uid\(\) or s\.submitted_by = auth\.uid\(\)/)
    // ...so after submitted / rejected / approved there is no write path at all.
    assert.ok(!/'submitted'/.test(writer))
    assert.ok(!/'approved'/.test(writer))
    assert.ok(!/'rejected'/.test(writer))
  })

  test('the writer must be active and still hold orders.create', () => {
    assert.match(writer, /u\.is_active/)
    assert.match(writer, /coalesce\(u\.is_deleted, false\) = false/)
    assert.match(writer, /resolve_permission\(auth\.uid\(\), 'orders', 'create'\)/)
  })

  test('there is no admin back door in the storage write rule', () => {
    assert.ok(
      !/role\s*=\s*'admin'/.test(writer),
      'administrative file work goes through the service role, not a policy branch',
    )
  })

  test('an unrelated employee matches neither rule', () => {
    // Both predicates are EXISTS over a specific submission with an explicit
    // identity branch; there is no branch an unrelated employee can satisfy.
    for (const fn of [viewer, writer]) {
      assert.ok(!/using\s*\(\s*true\s*\)/.test(fn))
      assert.match(fn, /where s\.id = p_submission_id/)
    }
  })

  test('no UPDATE policy exists, so upsert cannot bypass immutability', () => {
    assert.ok(!/create policy "order_files_update"/.test(code))
    const orderFilePolicies = [...code.matchAll(/create policy "(order_files_\w+)" on storage\.objects\s*\n\s*for (\w+)/g)]
    assert.deepEqual(
      orderFilePolicies.map(m => [m[1], m[2]]),
      [
        ['order_files_select', 'select'],
        ['order_files_insert', 'insert'],
        ['order_files_delete', 'delete'],
      ],
    )
    // Asserted at apply time as well.
    assert.match(code, /An UPDATE policy exists on order-files; stored files would not be immutable/)
    // The reasoning is recorded so nobody adds the "obvious missing" policy.
    // Matched in short fragments because the prose wraps across comment lines.
    assert.match(sql, /x-upsert/)
    assert.match(sql, /with no UPDATE/)
  })

  test('the reserved orders/ prefix stays service-role only', () => {
    for (const policy of [selectPolicy, insertPolicy, deletePolicy]) {
      assert.match(policy, /order_file_submission_id\(name\)/)
    }
    // order_file_submission_id returns NULL for anything not under submissions/,
    // and both predicates are EXISTS over that id, so a NULL matches nothing.
    const decoder = functionBlock('order_file_submission_id')
    assert.match(decoder, /split_part\(p_object_name, '\/', 1\) <> 'submissions' then null/)
  })

  test('service-role processing is unaffected — no policy binds it', () => {
    for (const policy of [selectPolicy, insertPolicy, deletePolicy]) {
      assert.match(policy, /to authenticated/)
      assert.ok(!/to service_role/.test(policy))
    }
  })
})

// ══ 6d. Storage objects must actually exist ═════════════════════════════════

describe('submission proves its files exist', () => {
  const submit = functionBlock('submit_order_submission')

  test('the workbook path shape is re-derived, not trusted', () => {
    assert.match(
      submit,
      /source_workbook_path !~\s*\n?\s*\('\^submissions\/' \|\| p_submission_id::text \|\| '\/original\/\[\^\/\]\+\$'\)/,
    )
    assert.match(submit, /ORDER_SUBMISSION_BAD_WORKBOOK_PATH/)
  })

  test('the workbook object must exist in the order-files bucket', () => {
    assert.match(submit, /from storage\.objects o\s*\n\s*where o\.bucket_id = 'order-files'\s*\n\s*and o\.name = v_sub\.source_workbook_path/)
    assert.match(submit, /ORDER_SUBMISSION_WORKBOOK_NOT_STORED/)
  })

  test('the workbook object must be an XLSX by its STORED content type', () => {
    assert.match(
      submit,
      /o\.metadata ->> 'mimetype'\s*\n?\s*= 'application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet'/,
    )
    assert.match(submit, /ORDER_SUBMISSION_WORKBOOK_NOT_XLSX/)
  })

  test('every image path must name THIS submission and THAT item', () => {
    // i.id interpolated into the pattern is what refuses one product's photo
    // being presented as another's, and what refuses a cross-submission path.
    assert.match(
      submit,
      /'\^submissions\/' \|\| p_submission_id::text \|\| '\/images\/' \|\| i\.id::text\s*\n?\s*\|\| '\\\.\(png\|jpg\|jpeg\|webp\)\$'/,
    )
    assert.match(submit, /ORDER_SUBMISSION_BAD_IMAGE_PATH/)
  })

  test('every image object must exist and be PNG, JPEG or WEBP', () => {
    assert.match(
      submit,
      /and o\.metadata ->> 'mimetype' in \('image\/png', 'image\/jpeg', 'image\/webp'\)/,
    )
    assert.match(submit, /ORDER_SUBMISSION_IMAGE_NOT_STORED/)
    assert.match(submit, /not exists \(\s*\n\s*select 1 from storage\.objects o/)
  })

  test('traversal, absolute and backslash keys cannot satisfy the patterns', () => {
    // The patterns are anchored ^...$ with [^/]+ as the only free segment for
    // the workbook and a fixed {uuid}.{ext} leaf for images, so "..", a leading
    // slash and a backslash segment have nowhere to sit.
    assert.match(submit, /\^submissions\//)
    assert.match(submit, /\[\^\/\]\+\$/)
    assert.ok(
      !/like '%' \|\| v_sub\.source_workbook_path/.test(submit),
      'no substring matching — the whole key is pinned',
    )
  })

  test('storage.objects is referenced schema-qualified throughout', () => {
    const refs = [...submit.matchAll(/\bstorage\.objects\b/g)]
    assert.ok(refs.length >= 3, 'the workbook and both image checks read it')
    assert.ok(
      !/\bfrom objects\b|\bjoin objects\b/.test(submit),
      'never an unqualified reference',
    )
  })

  test('a populated path alone is no longer sufficient', () => {
    // The old behaviour: a non-blank string passed. That check still runs first
    // for a clear error, but it is now followed by real proof.
    const blankCheck = submit.indexOf("coalesce(btrim(v_sub.source_workbook_path), '') = ''")
    const existsCheck = submit.indexOf('ORDER_SUBMISSION_WORKBOOK_NOT_STORED')
    assert.ok(blankCheck > 0 && existsCheck > blankCheck, 'existence is proved after the blank check')
  })

  test('submit still runs its checks before the status moves', () => {
    const lastGuard = submit.lastIndexOf('ORDER_SUBMISSION_IMAGE_NOT_STORED')
    const statusMove = submit.indexOf("set status = 'submitted'")
    assert.ok(lastGuard > 0 && statusMove > lastGuard, 'nothing transitions before the proofs pass')
  })
})

// ══ 7. This phase cannot approve or create an Order ═════════════════════════

describe('phase boundary', () => {
  test('the transition trigger permits exactly three moves', () => {
    const body = functionBlock('order_submissions_enforce_status_transition')
    assert.match(body, /old\.status = 'draft'\s+and new\.status = 'submitted'/)
    assert.match(body, /old\.status = 'needs_changes' and new\.status = 'submitted'/)
    assert.match(body, /old\.status = 'submitted'\s+and new\.status = 'needs_changes'/)
    assert.match(body, /ORDER_SUBMISSION_TRANSITION_INVALID/)
  })

  test('the trigger also guards INSERT, so nothing can be born approved', () => {
    // Guarding UPDATE alone would leave a row creatable AT 'approved' by
    // anything holding INSERT — which is the service role, and the service role
    // bypasses RLS. This is what makes the phase boundary hold for every caller.
    assert.match(
      code,
      /create trigger order_submissions_enforce_status_transition\s*\n\s*before insert or update on public\.order_submissions/,
    )
    const body = functionBlock('order_submissions_enforce_status_transition')
    assert.match(body, /if tg_op = 'INSERT' then/)
    assert.match(body, /if new\.status <> 'draft' then/)
  })

  test('approved and rejected are unreachable', () => {
    const body = functionBlock('order_submissions_enforce_status_transition')
    assert.ok(!/new\.status = 'approved'/.test(body), 'no transition may reach approved')
    assert.ok(!/new\.status = 'rejected'/.test(body), 'no transition may reach rejected')
    assert.ok(
      !/set status\s*=\s*'approved'|status\s*=\s*'approved'\s*(,|\n\s*where)/.test(code),
      'nothing may set status to approved in this phase',
    )
    assert.ok(
      !/set status\s*=\s*'rejected'/.test(code),
      'nothing may set status to rejected in this phase',
    )
  })

  test('no approval or order-creation RPC exists', () => {
    for (const forbidden of ['approve_order_submission', 'reject_order_submission']) {
      assert.ok(
        !new RegExp(`create or replace function public\\.${forbidden}\\b`).test(code),
        `${forbidden} belongs to a later phase`,
      )
    }
  })

  test('no Order is created and no order number is allocated', () => {
    assert.ok(!/insert into public\.orders\b/i.test(statements), 'must not insert an Order')
    assert.ok(!/allocate_confirmed_order_number/.test(statements), 'must not allocate a number')
    assert.ok(!/format_confirmed_order_number/.test(statements), 'must not format a number')
    assert.ok(!/next_order_display_number/.test(statements), 'must not touch the legacy sequence')
    assert.ok(!/order_number_cycle/.test(statements), 'must not touch the number cycle')
    assert.ok(!/display_number/.test(statements), 'must not reference display_number')
  })

  test('order_id is never written by this phase', () => {
    assert.ok(
      !/set[\s\S]{0,200}?\border_id\s*=/.test(code.replace(/order_id is null/g, '')),
      'nothing may assign order_id in this phase',
    )
  })

  test('Order Requests, Orders and Finance records are untouched', () => {
    for (const table of ['order_requests', 'orders', 'finance_payment_requests', 'order_request_attachments']) {
      assert.ok(
        !new RegExp(`delete from public\\.${table}\\b`).test(code),
        `must not delete from ${table}`,
      )
      assert.ok(
        !new RegExp(`update public\\.${table}\\b`).test(code),
        `must not update ${table}`,
      )
    }
  })

  test('the 40% advance rule is stored but not enforced', () => {
    assert.ok(/advance_exception_reason\s+text/.test(SUBMISSIONS), 'the column must exist')
    assert.ok(
      !/0\.4|40 ?%|\* 0\.40/.test(statements),
      'no percentage arithmetic may be enforced in this phase',
    )
    // The rule is specified in the header prose so the approval phase does not
    // re-invent it.
    assert.match(sql, /at least 40% of grand_total/)
    assert.match(sql, /INCLUDING ZERO, requires a non-blank exception/)
  })
})

// ══ 8. Storage ══════════════════════════════════════════════════════════════

describe('the order-files bucket', () => {
  test('is created private, at 10 MiB', () => {
    const insert = /insert into storage\.buckets[\s\S]*?on conflict/.exec(code)
    assert.ok(insert, 'the bucket must be created')
    assert.match(insert[0], /'order-files'/)
    assert.match(insert[0], /\n\s*false,/, 'the bucket must be private')
    assert.match(insert[0], /10485760/)
    assert.equal(10485760, 10 * 1024 * 1024)
  })

  test('accepts only workbooks, the three raster formats, and PDF', () => {
    const insert = /insert into storage\.buckets[\s\S]*?on conflict/.exec(code)![0]
    const mimes = [...insert.matchAll(/'(application\/[\w.\-+]+|image\/\w+)'/g)].map(m => m[1]).sort()
    assert.deepEqual(mimes, [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'image/jpeg',
      'image/png',
      'image/webp',
    ])
    assert.ok(!/application\/octet-stream/.test(insert), 'octet-stream would admit any binary')
  })

  test('the conflict path re-asserts privacy rather than leaving it alone', () => {
    assert.match(code, /on conflict \(id\) do update set\s*\n\s*public\s*= excluded\.public/)
  })

  test('every object policy is scoped to this bucket and to a submission path', () => {
    const policies = [...code.matchAll(/create policy "(order_files_\w+)" on storage\.objects[\s\S]*?;/g)]
    assert.equal(policies.length, 3, 'expected select, insert and delete')
    for (const [policy, name] of policies) {
      assert.match(policy, /bucket_id = 'order-files'/, `${name} must be bucket-scoped`)
      assert.match(policy, /module_entry_open\('orders'\)/, `${name} must apply the module gate`)
      assert.match(policy, /order_file_submission_id\(name\)/, `${name} must resolve the submission from the path`)
      assert.ok(!/using\s*\(\s*true\s*\)/.test(policy), `${name} must not be blanket`)
    }
  })

  test('reading needs visibility; writing needs the narrower write rule', () => {
    // Full read/write separation is covered by its own suite above; this keeps
    // the bucket-level view of it beside the other bucket assertions.
    const select = /create policy "order_files_select"[\s\S]*?;/.exec(code)![0]
    assert.match(select, /can_view_order_submission\(public\.order_file_submission_id\(name\)\)/)
    for (const name of ['order_files_insert', 'order_files_delete']) {
      const policy = new RegExp(`create policy "${name}"[\\s\\S]*?;`).exec(code)![0]
      assert.match(policy, /can_write_order_submission_file\(public\.order_file_submission_id\(name\)\)/)
    }
  })

  test('there is no UPDATE policy — a stored object cannot be swapped in place', () => {
    assert.ok(
      !/create policy "order_files_update"/.test(code),
      'an in-place object update would let a workbook change under a reviewer',
    )
  })

  test('a traversal or absolute key resolves to nothing', () => {
    // Without this, a caller could authorize against their OWN submission id and
    // still have the stored key resolve elsewhere — including into the reserved
    // orders/ prefix.
    const fn = functionBlock('order_file_submission_id')
    assert.match(fn, /p_object_name like '\/%' then null/)
    assert.match(fn, /p_object_name like '%\/\.\.\/%' then null/)

    // Backslash is LIKE's default escape character. '%\%' would escape the
    // trailing % and match a literal percent sign — silently letting every
    // backslash key through. The pattern must carry TWO backslashes.
    // Plain string comparison rather than a regex: four levels of escaping is
    // how this check would come to assert the wrong thing.
    assert.ok(
      fn.includes("like '%\\\\%' then null"),
      'the backslash guard must use a doubled backslash',
    )
    assert.ok(
      !fn.includes("like '%\\%' then null"),
      'a single-backslash LIKE pattern matches a percent sign, not a backslash',
    )
  })

  test('the client may choose the item id, so image keys can be uploaded first', () => {
    // submissions/{submission_id}/images/{item_id} is only achievable if the
    // uploader knows the item id before the row exists.
    const body = functionBlock('replace_order_submission_parse')
    assert.match(body, /coalesce\(nullif\(item ->> 'id', ''\)::uuid, gen_random_uuid\(\)\)/)
    assert.match(sql, /submissions\/\{submission_id\}\/images\/\{item_id\}/)
  })

  test('a path outside submissions/ resolves to nothing, so it grants nothing', () => {
    const fn = functionBlock('order_file_submission_id')
    assert.match(fn, /pg_catalog\.split_part\(p_object_name, '\/', 1\) <> 'submissions'/)
    assert.match(fn, /then null/)
    // Schema-qualified, so a caller-controlled search_path cannot change what a
    // path decodes to inside a storage policy.
    assert.ok(
      !/(?<!pg_catalog\.)\bsplit_part\(/.test(fn),
      'every built-in in this function must be qualified to pg_catalog',
    )
    // A malformed id is refused by pattern BEFORE any cast, so the function
    // returns null instead of raising — storage policies fail closed.
    assert.match(fn, /\[0-9a-fA-F\]\{8\}-/)
  })

  test('the reserved order paths are reachable by no client role', () => {
    // orders/{order_id}/versions/... is documented and deliberately unpolicied:
    // only the service role can touch it until the approval phase.
    assert.match(sql, /orders\/\{order_id\}\/versions\/\{version\}\/approved\.xlsx/)
    for (const policy of [...code.matchAll(/create policy "order_files_\w+" on storage\.objects[\s\S]*?;/g)]) {
      assert.ok(
        !/'orders'\s*=\s*split_part|split_part\(name, '\/', 1\) = 'orders'/.test(policy[0]),
        'no policy may authorize the reserved orders/ prefix yet',
      )
    }
  })

  test('no other bucket is touched', () => {
    for (const bucket of ['task-attachments', 'payment-proofs', 'order-request-attachments', 'asset-documents']) {
      assert.ok(!new RegExp(`'${bucket}'`).test(code), `${bucket} must not be referenced`)
    }
  })
})

// ══ 9. The permission ═══════════════════════════════════════════════════════

describe('orders.approve_order', () => {
  test('is registered on Orders, denied by default', () => {
    assert.match(code, /insert into public\.permission_actions \(action_key, display_name, is_system\)\s*\nvalues \('approve_order', 'Approve Order Submissions', false\)/)
    assert.match(code, /join public\.permission_actions pa on pa\.action_key = 'approve_order'\s*\nwhere pm\.module_key = 'orders'/)
    assert.match(code, /select pm\.id, pa\.id, false/)
  })

  test('is granted to nobody by this migration', () => {
    assert.ok(!/insert into public\.employee_permission_overrides/i.test(code))
    assert.ok(!/insert into public\.role_permissions/i.test(code))
    assert.ok(!/insert into public\.department_permissions/i.test(code))
  })

  test('is NOT a reuse of orders.approve', () => {
    // orders.approve means "convert an Order Request" and is checked by three
    // existing RPCs. Reusing it would hand PI approval to everyone holding it.
    const rpc = functionBlock('request_order_submission_changes')
    assert.ok(
      !/actor_has_module_permission\('orders', 'approve'\)/.test(rpc),
      'the submission reviewer check must not resolve orders.approve',
    )
  })

  test('is protected, so no preset can grant it', () => {
    assert.equal(isProtectedAction('approve_order'), true)
    assert.ok(PROTECTED_ACTIONS.has('approve_order'))

    const ordersActions = getRegisteredModule('orders')?.actions.map(a => a.actionKey) ?? []
    assert.ok(ordersActions.includes('approve_order'), 'the module must register it')

    for (const level of PRESET_LEVELS) {
      assert.ok(
        !standardActionsForLevel(level, ordersActions).includes('approve_order'),
        `${level} must not grant approve_order`,
      )
    }
  })

  test('the capability is derived separately from Order Request approval', () => {
    const withApproveOnly = deriveOrdersCapabilities('employee', [
      { actionKey: 'view', allowed: true, source: 'employee_override' as const },
      { actionKey: 'approve', allowed: true, source: 'employee_override' as const },
    ])
    assert.equal(withApproveOnly.canApproveOrder, true)
    assert.equal(withApproveOnly.canApproveOrderSubmission, false, 'approve must not imply approve_order')

    const withSubmissionOnly = deriveOrdersCapabilities('employee', [
      { actionKey: 'view', allowed: true, source: 'employee_override' as const },
      { actionKey: 'approve_order', allowed: true, source: 'employee_override' as const },
    ])
    assert.equal(withSubmissionOnly.canApproveOrderSubmission, true)
    assert.equal(withSubmissionOnly.canApproveOrder, false, 'approve_order must not imply approve')
  })

  test('it needs module entry, like every other Orders capability', () => {
    const withoutEntry = deriveOrdersCapabilities('employee', [
      { actionKey: 'approve_order', allowed: true, source: 'employee_override' as const },
    ])
    assert.equal(withoutEntry.canApproveOrderSubmission, false)
  })

  test('an admin has it without holding the grant', () => {
    assert.equal(deriveOrdersCapabilities('admin', []).canApproveOrderSubmission, true)
  })

  test('no permissions at all means no submission authority', () => {
    assert.equal(NO_ORDERS_CAPABILITIES.canApproveOrderSubmission, false)
    assert.equal(deriveOrdersCapabilities('employee', []).canApproveOrderSubmission, false)
  })

  test('the enforcement map records it as really enforced', () => {
    assert.equal(isActionEnforced('orders', 'approve_order'), true)
  })

  test('no payment permission is added in this phase', () => {
    assert.ok(!/'finance'/.test(code), 'no Finance action may be registered here')
  })
})
