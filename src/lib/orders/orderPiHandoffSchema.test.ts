/**
 * Repository check: the Order→PI handoff opens the RIGHT door, and only that one.
 *
 * WHY A REPO CHECK
 * ----------------
 * Everything this migration promises lives in SQL, and every promise fails
 * SILENTLY — in the permissive direction — if a later change relaxes it:
 *
 *   1. ORDER VISIBILITY IS ASKED, NEVER RE-STATED. can_view_order must be
 *      SECURITY INVOKER. A definer would have to spell out the OR of every
 *      orders SELECT policy, and that copy would drift the first time a policy
 *      moved — silently, and towards showing more.
 *   2. THE TWO DOORS STAY SEPARATE. PI-REVIEW visibility
 *      (can_view_order_submission) and ORDER visibility are different
 *      authorities over different audiences. Folding either into the other
 *      would hand PI drafts to operations, or Confirmed Order files to anyone
 *      who can review a PI.
 *   3. NO DRAFT COMES THROUGH. The new door is the existence of an Order, and
 *      only approve_order_submission() makes one.
 *   4. SELECT ONLY. Reading the PI a Confirmed Order came from confers no
 *      ability to change it or to replace a file.
 *   5. order-files STAYS PRIVATE AND HAS NO UPDATE POLICY — which is what makes
 *      a stored workbook immutable and what defeats upsert.
 *   6. THE STORAGE KEY IS DECODED SAFELY, and the two prefixes cannot cross.
 *   7. NOT ONE APPLIED MIGRATION IS EDITED.
 *
 * TypeScript sees none of this. These tests read the migration itself.
 *
 * Reads repository files only. No database, no network.
 *
 * Run:
 *   npx tsx --test src/lib/orders/orderPiHandoffSchema.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations')

/** Normalised to LF: a Windows checkout stores CRLF, and every `\n` in the
 *  patterns below would otherwise silently match nothing. */
const lf = (s: string) => s.replace(/\r\n/g, '\n')
const read = (file: string) => lf(readFileSync(join(MIGRATIONS, file), 'utf8'))

// NAMED FOR THE FEATURE IT BELONGS TO. `order_submission_*` is not decoration:
// four applied suites — finalApprovalSchema, finalApprovalScope,
// submissionDeletion and submissionSchema — treat that prefix as the declaration
// that a later migration is part of the PI submission feature rather than
// unrelated work reaching into its tables. This migration adds SELECT policies
// to those tables, so it must make that declaration, and it is entitled to.
const FILE = '20260924000000_order_submission_confirmed_order_handoff.sql'
const SUBMISSIONS = '20260908000000_order_pi_submissions.sql'
const ITEM_IMAGES = '20260909000000_order_submission_item_images.sql'
const FINAL_APPROVAL = '20260915000000_order_submission_final_approval.sql'
const BILLING = '20260923000000_order_submission_billing_percentage.sql'
const PROTECTED_VISIBILITY = '20260903000000_protected_visibility_actions.sql'
const BASE_ORDERS = '20260655_create_orders.sql'

const sql = read(FILE)

/**
 * The migration with `--` comments removed.
 *
 * ESSENTIAL HERE. The header deliberately NAMES the things this phase must not
 * do — "adds NO INSERT, UPDATE or DELETE policy", "does not make the bucket
 * public" — so a naive substring search over the raw file would find its own
 * prohibitions and call them implementations.
 */
const code = sql
  .split('\n')
  .map(line => {
    const at = line.indexOf('--')
    return at === -1 ? line : line.slice(0, at)
  })
  .join('\n')

/** One function body, from its CREATE OR REPLACE to the closing dollar tag. */
function fnBody(name: string): string {
  const start = code.search(new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\s*\\(`, 'i'))
  assert.ok(start >= 0, `${name} is not defined in ${FILE}`)
  const end = code.indexOf('\n$$;', start)
  assert.ok(end > start, `no closing dollar tag for ${name}`)
  return code.slice(start, end + 4)
}

// ── 1. Ordering, and nothing applied is edited ────────────────────────────────

describe('the migration takes its place without disturbing anything applied', () => {
  test('its timestamp is after 20260923000000', () => {
    assert.ok(FILE > BILLING, `${FILE} must sort after ${BILLING}`)
  })

  test('nothing was slipped in between it and the last applied migration', () => {
    // Not "it is the newest": later phases on this same branch legitimately add
    // their own files after it — the document-generation phase supersedes one
    // of the policies created here, and must therefore sort AFTER it. What must
    // stay true is that this file is the FIRST thing after the applied history.
    const files = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()
    assert.equal(files[files.indexOf(BILLING) + 1], FILE)
  })

  test('no applied migration has been modified on this branch', () => {
    // The authority is git, not a checksum this repository maintains: an edit
    // to an applied migration would silently change what the remote database is
    // believed to contain.
    //
    // A file that does not exist at origin/main is NEW, not edited — later
    // phases on this branch add their own, and adding one is the whole point.
    const changed = execFileSync('git', ['diff', '--name-only', 'origin/main', '--', 'supabase/migrations'], {
      encoding: 'utf8',
      cwd: process.cwd(),
    }).split('\n').map(s => s.trim()).filter(Boolean)

    const atBase = new Set(
      execFileSync('git', ['ls-tree', '--name-only', 'origin/main:supabase/migrations'], {
        encoding: 'utf8',
        cwd: process.cwd(),
      }).split('\n').map(s => s.trim()).filter(Boolean))

    const edited = changed.filter(path => atBase.has(path.split('/').pop() ?? path))
    assert.deepEqual(edited, [], `applied migrations were edited: ${edited.join(', ')}`)
  })

  test('it re-emits none of the SECURITY DEFINER functions the approval path relies on', () => {
    for (const fn of [
      'approve_order_submission',
      'can_view_order_submission',
      'can_write_order_submission_file',
      'allocate_confirmed_order_number',
      'module_entry_open',
      'resolve_permission',
    ]) {
      assert.ok(
        !new RegExp(`create\\s+(or\\s+replace\\s+)?function\\s+public\\.${fn}\\s*\\(`, 'i').test(code),
        `${fn} must not be redefined by the handoff migration`,
      )
    }
  })
})

// ── 2. Order visibility is ASKED, never re-stated ─────────────────────────────

describe('can_view_order', () => {
  const body = fnBody('can_view_order')

  test('is SECURITY INVOKER, so RLS itself answers', () => {
    assert.match(body, /security\s+invoker/i)
    assert.ok(!/security\s+definer/i.test(body),
      'a definer would bypass the very policies this predicate stands for')
  })

  test('reads public.orders and does nothing else', () => {
    assert.match(body, /from\s+public\.orders/i)
    // NOT a re-statement of any policy's expression. Each of these appearing
    // here would mean a second copy of a visibility rule that already exists.
    for (const copied of [
      /users\.role\s*=\s*'admin'/i,
      /u\.role\s*=\s*'admin'/i,
      /team\s*=\s*'operations'/i,
      /requested_by\s*=\s*auth\.uid\(\)/i,
      /assigned_to\s*=\s*auth\.uid\(\)/i,
      /resolve_permission\s*\(/i,
    ]) {
      assert.ok(!copied.test(body),
        `can_view_order must not restate an orders policy expression: ${copied}`)
    }
  })

  test('is STABLE, so PostgreSQL forbids it from writing', () => {
    assert.match(body, /\bstable\b/i)
  })

  test('pins its search_path', () => {
    assert.match(body, /set\s+search_path\s*=\s*public,\s*pg_temp/i)
  })

  test('is denied to public and anon, granted to authenticated', () => {
    assert.match(code, /revoke\s+execute\s+on\s+function\s+public\.can_view_order\(uuid\)\s+from\s+public,\s*anon/i)
    assert.match(code, /grant\s+execute\s+on\s+function\s+public\.can_view_order\(uuid\)\s+to\s+authenticated/i)
  })

  test('the policies it stands for still exist where they always did', () => {
    // If any of these moved or was renamed, `can_view_order` still asks the
    // right question — but this test is what makes that claim checkable.
    const base = read(BASE_ORDERS)
    assert.match(base, /create policy "orders_admin_select" on public\.orders/i)
    assert.match(base, /create policy "orders_operations_select" on public\.orders/i)
    assert.match(base, /create policy "orders_sales_select" on public\.orders/i)
    assert.match(read(PROTECTED_VISIBILITY),
      /create policy "orders_permission_engine_select" on public\.orders/i)
    assert.match(read(PROTECTED_VISIBILITY),
      /resolve_permission\(auth\.uid\(\),\s*'orders',\s*'view_all'\)/i)
  })
})

// ── 3. The two doors stay separate ────────────────────────────────────────────

describe('PI-review visibility and Order visibility are different authorities', () => {
  test('the new door delegates to can_view_order and to nothing else', () => {
    const body = fnBody('can_view_order_submission_via_order')
    assert.match(body, /public\.can_view_order\(/)
    assert.match(body, /public\.confirmed_order_id_for_submission\(/)
    assert.ok(!/can_view_order_submission\s*\(/.test(body.replace(/can_view_order_submission_via_order/g, '')),
      'the Order door must not consult the PI-review door')
  })

  test('can_view_order_submission is neither redefined nor altered here', () => {
    assert.ok(!/can_view_order_submission\s*\(uuid\)\s+is\b/i.test(code) ||
      /can_view_order_submission_via_order\(uuid\) is/i.test(code))
    assert.ok(!/alter\s+policy\s+"order_submissions_select"/i.test(code),
      'the PI-review policy must keep exactly what it grants today')
  })

  test('the migration asserts, in SQL, that the review door never consults the Order door', () => {
    assert.match(sql, /can_view_order_submission must not consult the Order door/i)
  })

  test('a PI reviewer gains nothing here: the door is the ORDER, not approve_order', () => {
    const body = fnBody('can_view_order_submission_via_order')
    assert.ok(!/approve_order/i.test(body))
    assert.ok(!/actor_has_module_permission/i.test(body))
    assert.ok(!/can_verify_pi_finance/i.test(body))
  })
})

// ── 4. No draft comes through ─────────────────────────────────────────────────

describe('the door is the existence of an Order', () => {
  test('the link is resolved from orders.source_order_submission_id', () => {
    const body = fnBody('confirmed_order_id_for_submission')
    assert.match(body, /from\s+public\.orders/i)
    assert.match(body, /source_order_submission_id\s*=\s*p_submission_id/i)
    assert.match(body, /limit\s+1/i)
  })

  test('it resolves the link only — it authorizes nothing', () => {
    const body = fnBody('confirmed_order_id_for_submission')
    assert.ok(!/auth\.uid\(\)/i.test(body), 'a link lookup must not consult the caller')
    assert.match(body, /security\s+definer/i)
  })

  test('one submission has at most one Order, by index and not by convention', () => {
    assert.match(read(FINAL_APPROVAL),
      /create unique index if not exists orders_source_order_submission_id_uidx/i)
  })

  test('nothing in the migration reads order_submissions.status to open the door', () => {
    const body = fnBody('can_view_order_submission_via_order') + fnBody('confirmed_order_id_for_submission')
    assert.ok(!/status\s+in\s*\(/i.test(body),
      'the door is the Order, so no status list is needed and none may creep in')
  })
})

// ── 5. SELECT only, everywhere ────────────────────────────────────────────────

describe('the new policies grant sight and nothing else', () => {
  const NEW_POLICIES = [
    'order_submissions_confirmed_order_select',
    'order_submission_items_confirmed_order_select',
    'order_submission_item_images_confirmed_order_select',
    'order_files_confirmed_order_select',
  ]

  test('all four exist', () => {
    for (const name of NEW_POLICIES) {
      assert.ok(code.includes(`create policy "${name}"`), `${name} is missing`)
    }
  })

  test('every one is `for select`', () => {
    for (const name of NEW_POLICIES) {
      const at = code.indexOf(`create policy "${name}"`)
      const decl = code.slice(at, at + 400)
      assert.match(decl, /for\s+select\s+to\s+authenticated/i, name)
    }
  })

  test('no INSERT, UPDATE or DELETE policy is created anywhere in the migration', () => {
    for (const cmd of ['insert', 'update', 'delete']) {
      assert.ok(!new RegExp(`create policy[\\s\\S]{0,300}?for\\s+${cmd}\\b`, 'i').test(code),
        `the migration must not create a ${cmd.toUpperCase()} policy`)
    }
  })

  test('nothing is granted beyond execute on the four new functions', () => {
    const grants = [...code.matchAll(/^\s*grant\s+([\s\S]*?);/gim)].map(m => m[1].replace(/\s+/g, ' ').trim())
    for (const grant of grants) {
      assert.match(grant, /^execute on function public\.(can_view_order|confirmed_order_id_for_submission|can_view_order_submission_via_order|order_file_order_id)\(/i,
        `unexpected grant: ${grant}`)
    }
  })

  test('the migration adds no permission action and grants nobody anything', () => {
    assert.ok(!/insert\s+into\s+public\.permission_actions/i.test(code))
    assert.ok(!/insert\s+into\s+public\.employee_permission_overrides/i.test(code))
    assert.ok(!/insert\s+into\s+public\.module_permission_actions/i.test(code))
  })

  test('the module entry gate is not weakened — the restrictive policies are untouched', () => {
    assert.ok(!/module_entry_gate/i.test(code),
      'the RESTRICTIVE gates must keep ANDing exactly as they do today')
    // And they are still where 20260908/20260909 put them.
    assert.match(read(SUBMISSIONS), /order_submissions_module_entry_gate[\s\S]{0,120}as restrictive/i)
    assert.match(read(ITEM_IMAGES), /order_submission_item_images_module_entry_gate[\s\S]{0,120}as restrictive/i)
  })

  test('the storage door still requires Order Management entry', () => {
    const at = code.indexOf('create policy "order_files_confirmed_order_select"')
    const decl = code.slice(at, at + 900)
    assert.match(decl, /bucket_id\s*=\s*'order-files'/)
    assert.match(decl, /public\.module_entry_open\('orders'\)/)
  })
})

// ── 6. The PI's review trail is NOT opened ────────────────────────────────────

describe('what the Order door deliberately does not reach', () => {
  test('order_submission_activity gets no new policy', () => {
    assert.ok(!/create policy[^;]*on public\.order_submission_activity/i.test(code),
      "the PI's review trail belongs to the review audience; the Order has its own log")
  })

  test('no Finance table is touched', () => {
    for (const table of [
      'finance_payment_requests',
      'finance_payment_allocations',
      'payment_proof_attachments',
    ]) {
      assert.ok(!code.includes(table), `${table} must not appear in this migration`)
    }
  })

  test('public.orders itself gains no policy — that would recurse', () => {
    assert.ok(!/create policy[^;]*on public\.orders\b/i.test(code))
  })
})

// ── 7. The storage key is decoded safely ──────────────────────────────────────

describe('order_file_order_id', () => {
  const body = fnBody('order_file_order_id')

  test('accepts only the reserved orders/{id}/versions/... shape', () => {
    assert.match(body, /split_part\(p_object_name, '\/', 1\)\s*<>\s*'orders'/i)
    assert.match(body, /split_part\(p_object_name, '\/', 3\)\s*<>\s*'versions'/i)
    assert.match(body, /\[0-9a-fA-F\]\{8\}-/)
  })

  test('fails closed on null, a leading slash, a backslash and every traversal form', () => {
    assert.match(body, /when p_object_name is null then null/i)
    assert.match(body, /when p_object_name like '\/%' then null/i)
    assert.match(body, /like '%\\\\%' then null/i)
    assert.match(body, /p_object_name = '\.\.'/)
    assert.match(body, /like '\.\.\/%'/)
    assert.match(body, /like '%\/\.\.'/)
    assert.match(body, /like '%\/\.\.\/%'/)
  })

  test('pins every built-in to pg_catalog, so search_path cannot redirect it', () => {
    for (const call of body.match(/\bsplit_part\(/g) ?? []) void call
    assert.ok(!/(?<!pg_catalog\.)\bsplit_part\(/.test(body),
      'an unqualified split_part could be redirected by a caller-controlled search_path')
  })

  test('is IMMUTABLE and is not a definer — it is pure string arithmetic', () => {
    assert.match(body, /\bimmutable\b/i)
    assert.ok(!/security\s+definer/i.test(body))
  })

  test('the migration proves at apply time that the two prefixes cannot cross', () => {
    assert.match(sql, /order_file_order_id decoded a submissions key/i)
    assert.match(sql, /order_file_submission_id decoded an orders key/i)
  })

  test('the submissions decoder it pairs with is unchanged', () => {
    assert.ok(!/create\s+or\s+replace\s+function\s+public\.order_file_submission_id/i.test(code))
    assert.match(read(SUBMISSIONS), /create or replace function public\.order_file_submission_id/i)
  })
})

// ── 8. The bucket ─────────────────────────────────────────────────────────────

describe('order-files is untouched as a bucket', () => {
  test('it is not recreated, made public, or re-limited', () => {
    assert.ok(!/insert\s+into\s+storage\.buckets/i.test(code))
    assert.ok(!/update\s+storage\.buckets/i.test(code))
    assert.ok(!/public\s*=\s*true/i.test(code))
  })

  test('the migration re-asserts that it is private at the 10 MiB limit', () => {
    assert.match(code, /id\s*=\s*'order-files'\s+and\s+public\s*=\s*false\s+and\s+file_size_limit\s*=\s*10485760/i)
  })

  test('the migration re-asserts that no UPDATE policy exists on it', () => {
    assert.match(sql, /An UPDATE policy exists on order-files; stored files would not be immutable/)
    assert.match(code, /p\.polname like 'order_files_%'[\s\S]{0,80}p\.polcmd = 'w'/i)
  })

  test('the reserved orders/ prefix is authorized for READING only', () => {
    const at = code.indexOf('create policy "order_files_confirmed_order_select"')
    const decl = code.slice(at, at + 900)
    assert.match(decl, /public\.can_view_order\(public\.order_file_order_id\(name\)\)/)
    assert.match(decl, /for\s+select/i)
  })
})

// ── 9. The apply-time assertions are actually there ───────────────────────────

describe('the migration refuses to apply partially', () => {
  test('it checks the security mode of each predicate', () => {
    assert.match(sql, /can_view_order must exist and must be SECURITY INVOKER/i)
    assert.match(sql, /confirmed_order_id_for_submission must exist and must be SECURITY DEFINER/i)
    assert.match(sql, /can_view_order_submission_via_order must exist and must be SECURITY INVOKER/i)
  })

  test('it checks that exactly four SELECT policies were created', () => {
    assert.match(sql, /expected exactly four new confirmed-order SELECT policies/i)
    assert.match(sql, /a confirmed-order policy was created for something other than SELECT/i)
  })

  test('it checks that no client write policy has appeared on a PI table', () => {
    assert.match(sql, /a client write policy exists on a PI table/i)
  })

  test('it exercises the decoders rather than only inspecting the catalog', () => {
    assert.match(sql, /order_file_order_id did not fail closed on an unsafe key/i)
    assert.match(sql, /can_view_order must be false for a null Order/i)
    assert.match(sql, /can_view_order_submission_via_order must be false for a null submission/i)
  })
})

// ── 10. The audiences, one by one ─────────────────────────────────────────────
//
// WHY THIS SECTION EXISTS. Sections 2–5 prove the SHAPE of the door. This one
// names the people who walk through it, and the people who do not, and points at
// the exact expression that decides each — so "an operations lead can see the
// approved PI" and "a PI reviewer cannot see a Confirmed Order's files" are
// claims with an address rather than beliefs.
//
// A CHAIN, EVALUATED IN ORDER, for a viewer asking for submission S:
//
//   can_view_order_submission_via_order(S)
//     → confirmed_order_id_for_submission(S)      the LINK  (no authority)
//     → can_view_order(that id)                   the DECISION
//     → `select 1 from public.orders where id = …` under the CALLER's RLS
//     → the OR of every permissive SELECT policy on public.orders
//
// So the audience list below IS the list of orders SELECT policies, and nothing
// else can be added to it from this migration.

describe('who reaches the approved PI through a Confirmed Order', () => {
  const base = read(BASE_ORDERS)
  const engine = read(PROTECTED_VISIBILITY)

  test('an active admin — orders_admin_select', () => {
    assert.match(base, /CREATE POLICY "orders_admin_select" ON public\.orders\s+FOR SELECT TO authenticated\s+USING \(\s*EXISTS \(SELECT 1 FROM public\.users WHERE users\.id = auth\.uid\(\) AND users\.role = 'admin'\)/i)
  })

  test('a holder of orders.view_all — orders_permission_engine_select', () => {
    const at = engine.indexOf('create policy "orders_permission_engine_select" on public.orders')
    assert.ok(at >= 0)
    assert.match(engine.slice(at, at + 300), /resolve_permission\(auth\.uid\(\),\s*'orders',\s*'view_all'\)/i)
  })

  test('the requester and the assigned user — orders_sales_select', () => {
    const at = base.indexOf('CREATE POLICY "orders_sales_select" ON public.orders')
    assert.ok(at >= 0)
    const decl = base.slice(at, at + 300)
    assert.match(decl, /requested_by = auth\.uid\(\)/)
    assert.match(decl, /OR assigned_to = auth\.uid\(\)/)
  })

  test('the operations team, which existing Order RLS already admits — orders_operations_select', () => {
    // Named explicitly because it is the audience the PI-review door does NOT
    // contain, and the reason this migration exists at all.
    assert.match(base, /CREATE POLICY "orders_operations_select" ON public\.orders[\s\S]{0,200}team = 'operations'/i)
  })

  test('an unauthorized employee reaches NOTHING — there is no fallback branch', () => {
    // can_view_order has exactly one statement and no OR of its own. If the
    // caller matches no orders policy, the select returns no row and the
    // predicate is false. There is nowhere for a default-allow to hide.
    const body = fnBody('can_view_order')
    // The executable body only: `create OR replace` in the header is not a
    // branch, and matching it would make this assertion meaningless.
    const sqlBody = body.slice(body.indexOf('as $$') + 5)
    assert.equal((sqlBody.match(/\bselect\b/gi) ?? []).length, 2, 'exactly `select exists ( select 1 … )`')
    assert.ok(!/\bor\b/i.test(sqlBody.replace(/\border\w*/gi, '')), 'no alternative branch may exist')
    assert.ok(!/\btrue\b/i.test(sqlBody), 'nothing may short-circuit to true')
  })

  test('a PI reviewer WITHOUT Order access reaches no Confirmed Order file', () => {
    // orders.approve_order is what makes somebody a PI reviewer
    // (can_view_order_submission). It appears nowhere in the Order door, and
    // the Order door is the only thing the new storage policy consults for the
    // submissions/ prefix.
    const at = code.indexOf('create policy "order_files_confirmed_order_select"')
    const decl = code.slice(at, at + 900)
    assert.ok(!/approve_order/i.test(decl))
    assert.ok(!/can_view_order_submission\(/.test(decl))
    assert.match(decl, /can_view_order_submission_via_order\(public\.order_file_submission_id\(name\)\)/)
  })

  test('and the reverse holds: an Order viewer reaches no PI that never became an Order', () => {
    // The link is the Order. A draft, a returned record and a rejected one all
    // have no row in public.orders naming them, so the predicate is false for
    // every viewer, including an admin.
    assert.match(fnBody('confirmed_order_id_for_submission'), /where\s+o\.source_order_submission_id = p_submission_id/i)
  })

  test('the whole chain is three functions and no fourth', () => {
    const defined = [...code.matchAll(/create\s+or\s+replace\s+function\s+public\.(\w+)/gi)].map(m => m[1])
    assert.deepEqual(defined.sort(), [
      'can_view_order',
      'can_view_order_submission_via_order',
      'confirmed_order_id_for_submission',
      'order_file_order_id',
    ])
  })
})
