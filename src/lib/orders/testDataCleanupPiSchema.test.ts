/**
 * Repository check: Test Data Cleanup can remove a test Order created from an
 * approved PI, and still cannot remove anything real.
 *
 * THE DEFECT THIS DEFENDS AGAINST
 * -------------------------------
 * 20260915000000 introduced a SECOND provenance link, pointing both ways:
 *
 *   order_submissions.order_id         -> orders(id)             NO ACTION
 *   orders.source_order_submission_id  -> order_submissions(id)  NO ACTION
 *
 * Two NO ACTION foreign keys facing each other. execute_test_data_cleanup() knew
 * only how to release the OLDER pair, so deleting a test Order created from a PI
 * failed in production with a raw FK violation on Order 0001.
 *
 * WHY A REPO CHECK
 * ----------------
 * Every promise below lives in SQL or in one route, and each fails SILENTLY if a
 * later change relaxes it:
 *
 *   1. The PI is resolved into the chain, shown in the preview, and re-resolved
 *      under locks — not deleted from a stale graph.
 *   2. The deletion ORDER is the only one the foreign keys permit. Reversing two
 *      statements reinstates the production defect exactly.
 *   3. The cleanup bypass is reachable only from inside a transaction that has
 *      passed all five gates. A guard that gained a looser exemption would look
 *      like a fix and be a hole.
 *   4. A real Order and a real approved PI stay undeletable, and normal PI
 *      deletion is unchanged.
 *   5. Storage is removed BEFORE the rows, from keys derived server-side.
 *
 * TypeScript sees none of this. These tests read the migration and the route.
 *
 * Reads repository files only. No database, no network.
 *
 * Run:
 *   npx tsx --test src/lib/orders/testDataCleanupPiSchema.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations')

/** Normalised to LF: a Windows checkout stores CRLF, and every `\n` in the
 *  patterns below would otherwise silently match nothing. */
const lf = (s: string) => s.replace(/\r\n/g, '\n')
const migration = (file: string) => lf(readFileSync(join(MIGRATIONS, file), 'utf8'))
const source = (path: string) => lf(readFileSync(join(process.cwd(), path), 'utf8'))

const FILE = '20260916000000_order_submission_test_cleanup.sql'
const CLEANUP = '20260706000000_test_data_cleanup.sql'
const PROTECT = '20260705000000_protect_finalized_orders_and_payments.sql'
const DELETION = '20260914000000_order_submission_permanent_deletion.sql'
const PHASE_C = '20260915000000_order_submission_final_approval.sql'

const ROUTE = 'src/app/api/orders/submissions/test-cleanup/route.ts'
const PAGE = 'src/app/admin/control-center/test-data-cleanup/page.tsx'
const ORDER_PAGE = 'src/app/orders/[id]/page.tsx'

const sql = migration(FILE)

/**
 * The migration with `--` comments removed.
 *
 * ESSENTIAL HERE. The header quotes the production error verbatim and names the
 * very things this phase must not do, in order to explain why it does not do
 * them. A check scanning raw text would fail on the sentences promising exactly
 * what it verifies.
 */
const code = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')

/** Executable SQL minus `comment on ... is '...';`, whose prose has the same
 *  problem and legitimately contains semicolons. */
const declarations = code.replace(/comment on [\s\S]*?is\s+'(?:[^']|'')*'\s*;/gi, '')

/** One `create or replace function` block, body included. */
function fn(name: string, src = code): string {
  const start = src.indexOf(`create or replace function public.${name}`)
  assert.notEqual(start, -1, `${name} is missing`)
  const tag = /\$[A-Za-z_]*\$/.exec(src.slice(start))?.[0]
  assert.ok(tag, `${name} has no dollar-quoted body`)
  const open = src.indexOf(tag, start)
  const close = src.indexOf(tag, open + tag.length)
  assert.ok(close > 0, `${name} body is not closed`)
  return src.slice(start, close + tag.length)
}

const EXECUTE = fn('execute_test_data_cleanup')
const RESOLVE = fn('resolve_test_data_cleanup_chain')
const STORAGE = fn('test_cleanup_submission_storage')

// ── The file ──────────────────────────────────────────────────────────────────

describe('the fix is one new forward migration', () => {
  const files = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()

  test('it exists and sorts after everything it builds on', () => {
    assert.ok(files.includes(FILE))
    for (const earlier of [CLEANUP, PROTECT, DELETION, PHASE_C]) {
      assert.ok(files.includes(earlier), `${earlier} is missing`)
      assert.ok(FILE > earlier, `${FILE} must sort after ${earlier}`)
    }
  })

  test('it is the only migration added after Phase C', () => {
    assert.deepEqual(files.filter(f => f > PHASE_C), [FILE])
  })

  test('no two migrations share a version prefix', () => {
    const seen = new Set<string>()
    for (const file of files) {
      const version = /^(\d+)_/.exec(file)?.[1]
      assert.ok(version, `${file} has no numeric version prefix`)
      assert.ok(!seen.has(version), `duplicate migration version ${version}`)
      seen.add(version)
    }
  })

  test('it carries no credential and no connection string', () => {
    assert.ok(!/postgres:\/\/|supabase\.co|service_role_key|eyJ[A-Za-z0-9]/.test(sql))
  })
})

describe('every applied migration is unchanged', () => {
  test('20260915000000 and its predecessors still say what they said', () => {
    // Editing an applied migration changes history for a database that has
    // already run it: the file and the schema stop agreeing, and nothing warns.
    assert.ok(migration(PHASE_C).includes('create or replace function public.approve_order_submission'))
    assert.ok(migration(PHASE_C).includes('create trigger orders_protect_source_submission'))
    assert.ok(migration(DELETION).includes('create trigger order_submissions_guard_delete'))
    assert.ok(migration(PROTECT).includes('create or replace function public.in_test_data_cleanup'))
    assert.ok(migration(CLEANUP).includes('create or replace function public.execute_test_data_cleanup'))
  })

  test('the ORIGINAL guards in those files carry no cleanup exemption', () => {
    // Proof that the exemptions are added HERE, in a new file, rather than by
    // editing the migrations that own the guards.
    const phaseC = migration(PHASE_C)
    const guard = phaseC.slice(phaseC.indexOf('create or replace function public.prevent_order_source_submission_change'))
    assert.ok(!guard.slice(0, 900).includes('in_test_data_cleanup'),
      '20260915000000 must not have been edited to add the exemption')
  })

  test('this migration creates no table and drops nothing it does not own', () => {
    assert.ok(!/create table/i.test(declarations))
    assert.ok(!/drop (table|column|policy|constraint|index)/i.test(declarations))
    assert.ok(!/alter table/i.test(declarations),
      'the fix is entirely in function bodies; no schema is reshaped')
  })
})

// ── 1. The three exemptions, and nothing wider ────────────────────────────────

describe('three guards gain the cleanup exemption, and only that', () => {
  const GUARDS = [
    'prevent_order_source_submission_change',
    'order_submissions_guard_delete',
    'order_submission_activity_guard_delete',
  ] as const

  for (const name of GUARDS) {
    test(`${name} exempts the cleanup context and still refuses everybody else`, () => {
      const body = fn(name)
      assert.ok(body.includes('if public.in_test_data_cleanup() then'))
      assert.ok(body.includes('raise exception'), 'it must still refuse the ordinary case')
    })
  }

  test('the exemption is the ONLY thing added to each', () => {
    // Each guard is reproduced from the migration that owns it. Strip the
    // exemption back out and what remains must be the original body — which is
    // what makes "nothing else was altered" checkable rather than asserted.
    const EXEMPTION = /\s*if public\.in_test_data_cleanup\(\) then\s*return (new|old);\s*end if;\s*/

    const submissionDelete = fn('order_submissions_guard_delete').replace(EXEMPTION, '\n  ')
    assert.ok(submissionDelete.includes('order_submission_purge_in_progress(old.id)'),
      'the ordinary purge door survives')
    assert.ok(submissionDelete.includes('ORDER_SUBMISSION_DELETE_DENIED'))

    const activityDelete = fn('order_submission_activity_guard_delete').replace(EXEMPTION, '\n  ')
    assert.ok(activityDelete.includes('order_submission_purge_in_progress(old.submission_id)'))
    assert.ok(activityDelete.includes('ORDER_SUBMISSION_ACTIVITY_IMMUTABLE'))

    const provenance = fn('prevent_order_source_submission_change').replace(EXEMPTION, '\n  ')
    assert.ok(provenance.includes('ORDER_SOURCE_SUBMISSION_IMMUTABLE'))
    assert.ok(provenance.includes('old.source_order_submission_id is not null'),
      'setting it from NULL exactly once is still what the RPC relies on')
  })

  test('no OTHER guard is touched', () => {
    // In particular order_submissions_guard_order_link, which makes
    // order_submissions.order_id immutable for every caller INCLUDING an
    // authorized cleanup. That is stronger than this fix needs and is left
    // alone: the Order's reference is the one released, never the PI's.
    for (const untouched of [
      'order_submissions_guard_order_link',
      'order_submissions_enforce_status_transition',
      'order_submissions_guard_deletion_claim',
      'order_submissions_guard_finance_verification',
      'prevent_order_delete',
      'prevent_converted_order_request_delete',
      'finance_payment_requests_guard_approved_delete',
    ]) {
      assert.ok(!declarations.includes(`create or replace function public.${untouched}`),
        `${untouched} belongs to an applied migration and must not be restated`)
    }
  })

  test('the cleanup context itself is unchanged and client-unreachable', () => {
    assert.ok(!declarations.includes('create or replace function public.in_test_data_cleanup'),
      'the context function is 20260705000000’s and is not redefined')
    assert.ok(code.includes("has_function_privilege('authenticated', 'public.in_test_data_cleanup()', 'EXECUTE')"),
      'and the migration asserts at apply time that no client role can call it')
  })
})

// ── 2. The chain learns about the PI ──────────────────────────────────────────

describe('chain resolution resolves the PI, and refuses a pair that disagrees', () => {
  test('the PI is read from the ORDER, not from anything supplied', () => {
    assert.ok(RESOLVE.includes('select o.source_order_submission_id, o.is_test_data'))
    assert.ok(RESOLVE.includes('from public.orders o where o.id = v_order_id'))
  })

  test('it appears in to_delete as its own row type', () => {
    assert.ok(RESOLVE.includes("'type', 'order_submission'"))
    assert.ok(RESOLVE.includes('from public.order_submissions s where s.id = v_submission_id'))
  })

  test('its test-data status is INHERITED from the Order', () => {
    // order_submissions has no is_test_data column, and this migration
    // deliberately does not add one — see the header. The inheritance is only
    // sound because the link is verified in both directions.
    assert.ok(RESOLVE.includes("'is_test_data', coalesce(v_order_is_test, false)"))
    assert.ok(!/alter table public\.order_submissions[\s\S]{0,80}is_test_data/i.test(declarations),
      'no is_test_data column is added to order_submissions')
  })

  test('a dangling or disagreeing pair becomes a BLOCKING entry with a reason', () => {
    assert.ok(RESOLVE.includes('v_sub_order_id is null'))
    assert.ok(RESOLVE.includes('v_sub_order_id is distinct from v_order_id'))
    assert.ok(RESOLVE.includes('the PI this Order names is linked to a different Order'))
    assert.ok(RESOLVE.includes('does not exist, or is not linked back to any Order'))
    // A blocking entry is what makes `eligible` false, which is the gate.
    assert.ok(RESOLVE.includes("'eligible',        jsonb_array_length(v_block) = 0"))
  })

  test('a disagreeing pair is refused, never silently skipped or repaired', () => {
    assert.ok(!/update public\.order_submissions[\s\S]{0,120}set order_id/i.test(declarations),
      'a mismatched link is a fact for somebody to look at, not something to fix in passing')
  })

  test('the four PI tables are counted for the preview', () => {
    for (const table of [
      'order_submissions', 'order_submission_items',
      'order_submission_item_images', 'order_submission_activity',
    ]) {
      assert.ok(RESOLVE.includes(`'${table}',`), `${table} must be counted`)
    }
  })

  test('the storage PREFIX is returned, and kept out of storage_paths', () => {
    // storage_paths is consumed by the admin page as PAYMENT-PROOF keys and
    // removed from the payment-proofs bucket. PI files live in order-files under
    // a different policy and are removed by a different route; folding them
    // together would send one bucket's keys to the other.
    assert.ok(RESOLVE.includes("'submission_storage_prefix', v_prefix"))
    assert.ok(RESOLVE.includes("v_prefix := 'submissions/' || v_submission_id::text || '/'"))
    const paths = RESOLVE.slice(RESOLVE.indexOf('into v_paths'))
    assert.ok(paths.includes('from public.payment_proof_attachments a'))
    assert.ok(!paths.slice(0, 300).includes('submission'),
      'storage_paths keeps its existing meaning exactly')
  })

  test('every pre-existing key of the returned object survives', () => {
    for (const key of [
      'root_type', 'root_id', 'root_number', 'order_id', 'order_request_id',
      'payment_ids', 'to_delete', 'to_retain', 'blocking', 'storage_paths',
      'counts', 'eligible',
    ]) {
      assert.ok(RESOLVE.includes(`'${key}',`), `${key} must still be returned`)
    }
  })

  test('the three root types and the payment-retention rule are unchanged', () => {
    assert.ok(RESOLVE.includes("if p_root_type not in ('order', 'order_request', 'payment')"))
    assert.ok(RESOLVE.includes("if p_root_type = 'payment' then"))
    assert.ok(RESOLVE.includes('into v_retain'))
  })
})

// ── 3. Execution: locks, gates, then the only safe deletion order ─────────────

describe('execution re-resolves under locks and deletes in the one legal order', () => {
  test('the PI row is locked with the rest of the chain', () => {
    assert.ok(EXECUTE.includes('perform 1 from public.order_submissions where id = v_submission for update'))
  })

  test('the chain is re-resolved AFTER the locks', () => {
    const firstResolve = EXECUTE.indexOf('resolve_test_data_cleanup_chain')
    const lock = EXECUTE.indexOf('for update;', firstResolve)
    const secondResolve = EXECUTE.indexOf('resolve_test_data_cleanup_chain', lock)
    assert.ok(secondResolve > lock, 'the second pass is the one that counts')
  })

  test('the cleanup context is set only AFTER every gate', () => {
    const context = EXECUTE.indexOf('boe.cleanup_context')
    for (const gate of [
      'Only an admin may run Test Data Cleanup',
      'CLEANUP_DISABLED',
      'CLEANUP_REASON_REQUIRED',
      'CLEANUP_CONFIRMATION_INVALID',
      'CLEANUP_NOT_ELIGIBLE',
      'CLEANUP_PROVENANCE_MISMATCH',
    ]) {
      const at = EXECUTE.indexOf(gate)
      assert.ok(at !== -1, `${gate} is missing`)
      assert.ok(at < context, `${gate} must be checked before the bypass is opened`)
    }
    // And the migration asserts the same thing at apply time.
    assert.ok(code.includes('the cleanup context is set before the eligibility gate'))
    assert.ok(code.includes('the cleanup context is set before the confirmation gate'))
  })

  test('a final provenance assertion stands next to the deletion', () => {
    assert.ok(EXECUTE.includes('o.source_order_submission_id = s.id'))
    assert.ok(EXECUTE.includes('and o.is_test_data'))
    assert.ok(EXECUTE.includes('CLEANUP_PROVENANCE_MISMATCH'))
  })

  test('THE DELETION ORDER — the defect is reversing these two', () => {
    const clear = EXECUTE.indexOf('set source_order_submission_id = null')
    const delSub = EXECUTE.indexOf('delete from public.order_submissions where id = v_submission')
    const delOrd = EXECUTE.indexOf('delete from public.orders where id = v_order')

    assert.ok(clear > 0 && delSub > 0 && delOrd > 0)
    assert.ok(clear < delSub, 'the Order must release the PI before the PI can go')
    assert.ok(delSub < delOrd, 'the PI must go before the Order it points at')
    // Which is exactly what the production error was complaining about.
    assert.ok(code.includes('the PI must be deleted before the Order it belongs to'),
      'and the migration asserts the ordering at apply time')
  })

  test('the child rows are counted before the cascade removes them', () => {
    for (const table of [
      'order_submission_items', 'order_submission_item_images', 'order_submission_activity',
    ]) {
      assert.ok(EXECUTE.includes(`from public.${table}       where submission_id = v_submission`)
        || EXECUTE.includes(`from public.${table} where submission_id = v_submission`)
        || EXECUTE.includes(`from public.${table}    where submission_id = v_submission`),
        `${table} must be counted`)
    }
    const count = EXECUTE.indexOf('into v_n_items, v_n_images, v_n_events')
    const del = EXECUTE.indexOf('delete from public.order_submissions where id = v_submission')
    assert.ok(count > 0 && count < del, 'counted first, or the counts are all zero')
  })

  test('the audit is written BEFORE anything is removed, and carries the PI', () => {
    const audit = EXECUTE.indexOf('insert into public.test_data_cleanup_audit')
    const firstDelete = EXECUTE.indexOf('delete from public.notifications')
    assert.ok(audit > 0 && audit < firstDelete)
    // deleted_records carries the PI id and prefix; table_counts the four counts.
    assert.ok(EXECUTE.includes("v_chain->'to_delete', v_chain->'counts', v_chain->'storage_paths'"))
    assert.ok(EXECUTE.includes("'submission_storage_prefix',    v_chain->>'submission_storage_prefix'"))
    assert.ok(EXECUTE.includes("'order_submissions',            v_n_sub"))
  })

  test('every pre-existing deletion step and gate survives unchanged', () => {
    for (const step of [
      'delete from public.notifications',
      'delete from public.finance_payment_requests where id = any(v_payments)',
      'set source_order_request_id = null',
      'delete from public.order_requests where id = v_request',
      'delete from public.orders where id = v_order',
    ]) {
      assert.ok(EXECUTE.includes(step), `${step} must survive`)
    }
  })

  test('nothing here touches Order numbering', () => {
    for (const forbidden of [
      'order_number_cycle', 'allocate_confirmed_order_number', 'setval',
      'set_next_confirmed_order_number',
    ]) {
      assert.ok(!EXECUTE.includes(forbidden), `${forbidden} must not appear`)
    }
    assert.ok(code.includes('the cleanup RPC now touches Order numbering'),
      'and the migration asserts it at apply time')
  })

  test('a freed number becomes reusable through the EXISTING admin rule only', () => {
    // Deleting the Order that held 0001 means set_next_confirmed_order_number()
    // will now accept 1, because its rule is "> the highest EXISTING Order
    // number". Nothing here decides that for the admin, and nothing resets the
    // cycle behind their back.
    const cycle = migration('20260703000000_confirmed_order_number_cycle.sql')
    assert.ok(cycle.includes('highest existing'))
    // Asserted on the EXECUTION BODY. The migration's own apply-time assertion
    // block legitimately names order_number_cycle in order to REFUSE it, and a
    // whole-file scan would fail on the guard rather than on a breach.
    assert.ok(!EXECUTE.includes('order_number_cycle'))
    assert.ok(!RESOLVE.includes('order_number_cycle'))
    assert.ok(!STORAGE.includes('order_number_cycle'))
  })
})

// ── 4. Neither foreign key nor either uniqueness rule is weakened ────────────

describe('the provenance guarantees survive the fix', () => {
  test('neither foreign key is dropped, altered or made deferrable', () => {
    assert.ok(!/alter[\s\S]{0,60}(drop constraint|deferrable)/i.test(declarations))
    assert.ok(!/on delete cascade/i.test(declarations),
      'a cascade would delete an approved PI whenever its Order went, for any reason')
    assert.ok(code.includes('is no longer a NO ACTION foreign key'),
      'and the migration asserts both at apply time')
  })

  test('both uniqueness indexes are asserted present', () => {
    assert.ok(code.includes('order_submissions_order_id_key'))
    assert.ok(code.includes('orders_source_order_submission_id_uidx'))
    assert.ok(code.includes('uniqueness index % is missing'))
  })

  test('normal PI deletion is unchanged and still refuses an approved PI', () => {
    for (const untouched of [
      'begin_order_submission_deletion', 'release_order_submission_deletion',
      'finalize_order_submission_deletion', 'order_submission_deletable_statuses',
      'order_submission_deletable_by',
    ]) {
      assert.ok(!declarations.includes(`create or replace function public.${untouched}`),
        `${untouched} must not be restated`)
    }
    assert.ok(code.includes("if 'approved' = any (public.order_submission_deletable_statuses())"),
      'and the migration refuses to apply if approval ever became ordinarily deletable')
  })

  test('final approval, the advance workflow and payments are untouched', () => {
    for (const untouched of [
      'approve_order_submission', 'verify_pi_finance_check',
      'approve_pi_advance_exception', 'reject_pi_advance_exception',
      'submit_order_submission_advance_internal', 'approve_finance_payment_request',
    ]) {
      assert.ok(!declarations.includes(`create or replace function public.${untouched}`),
        `${untouched} is out of scope for this fix`)
    }
  })

  test('no RLS policy is created, altered or dropped', () => {
    assert.ok(!/create policy|alter policy|drop policy/i.test(declarations))
  })
})

// ── 5. Storage: server-derived keys, removed before the rows ─────────────────

describe('PI storage is resolved server-side and removed before any row', () => {
  test('the resolver answers only for a TEST Order that names its PI back', () => {
    assert.ok(STORAGE.includes("u.role = 'admin'"), 'admin only')
    assert.ok(STORAGE.includes("'order_not_test_data'"))
    assert.ok(STORAGE.includes("'provenance_mismatch'"))
    assert.ok(STORAGE.includes('v_sub.order_id is distinct from p_order_id'))
    assert.ok(STORAGE.includes('if not v_order.is_test_data then'))
  })

  test('every key it returns is confined to this submission’s prefix', () => {
    assert.ok(STORAGE.includes("where path like ('submissions/' || v_sub.id::text || '/%')"))
  })

  test('it reads keys from the database, from all three places they live', () => {
    assert.ok(STORAGE.includes('v_sub.source_workbook_path'))
    assert.ok(STORAGE.includes('from public.order_submission_item_images m'))
    assert.ok(STORAGE.includes('i.image_storage_path'),
      'including the pre-20260909000000 per-item column')
  })

  test('it reserves nothing and deletes nothing', () => {
    assert.ok(!STORAGE.includes('deletion_claim_token'))
    assert.ok(!/delete from/i.test(STORAGE))
    assert.ok(!/update public\./i.test(STORAGE))
  })

  test('the route takes an ORDER id — never a submission id, never a path', () => {
    const route = source(ROUTE)
    assert.ok(route.includes('{ orderId } = await req.json()'))
    assert.ok(!/paths\s*[:=].*req\.json|body\.paths|storagePaths/.test(route),
      'a browser-supplied path list is the thing this must never accept')
    assert.ok(!route.includes('submissionId } = await req.json'))
    // The submission comes from the database, through the resolver above.
    assert.ok(route.includes("authClient.rpc(\n    'test_cleanup_submission_storage'"))
  })

  test('the route proves admin before it reaches for the service role', () => {
    const route = source(ROUTE)
    const roleCheck = route.indexOf("me.role !== 'admin'")
    const removal = route.indexOf('removeAllObjectsForSubmission(')
    assert.ok(roleCheck > 0 && roleCheck < removal)
    assert.ok(route.includes('is_active === false'))
    assert.ok(route.includes('is_deleted === true'))
  })

  test('it uses the established bounded, settled sweep — with no timeout', () => {
    const route = source(ROUTE)
    assert.ok(route.includes('removeAllObjectsForSubmission'))
    assert.ok(!/setTimeout|Promise\.race|AbortController/.test(route),
      'a promise race is not cancellation; the reasoning is in submissionFilesServer.ts')
    const files = source('src/lib/orders/submissionFilesServer.ts')
    assert.ok(files.includes('export const LIST_CONCURRENCY = 8'), 'bounded concurrency')
    assert.ok(files.includes('mapWithLimit'))
  })

  test('a storage failure returns a failure and deletes no row', () => {
    const route = source(ROUTE)
    assert.ok(route.includes('if (removal.failed.length > 0)'))
    assert.ok(route.includes('502'))
    // The route deletes no ROW, ever — it removes files and reports. Scanned
    // over code, not commentary: the header legitimately explains where in the
    // sequence the RPC runs, which is the point of the route existing.
    const routeCode = route.split('\n').filter(l => !l.trimStart().startsWith('//')).join('\n')
    assert.ok(!routeCode.includes('execute_test_data_cleanup'),
      'the route removes files; the RPC removes rows, and the page sequences them')
    assert.ok(!/\.delete\(\)|\.from\('order_submissions'\)/.test(routeCode))
  })

  test('an Order with no PI is skipped, not treated as a failure', () => {
    const route = source(ROUTE)
    assert.ok(route.includes("SKIPPABLE"))
    assert.ok(route.includes("'no_submission'"))
    assert.ok(route.includes('skipped: true'))
  })
})

// ── 6. The page sequences files before rows ──────────────────────────────────

describe('the admin page removes PI files BEFORE the database rows', () => {
  const page = source(PAGE)

  test('the purge runs before execute_test_data_cleanup', () => {
    const purge = page.indexOf("'/api/orders/submissions/test-cleanup'")
    const rpc = page.indexOf("supabase.rpc('execute_test_data_cleanup'")
    assert.ok(purge > 0 && rpc > 0 && purge < rpc)
  })

  test('a failed purge aborts and says nothing was deleted', () => {
    assert.ok(page.includes('Nothing was deleted — please retry.'))
    const abort = page.slice(page.indexOf('piPurgeFailed'))
    assert.ok(abort.includes('return'), 'it must not fall through to the RPC')
  })

  test('the page sends only an order id', () => {
    assert.ok(page.includes('body: JSON.stringify({ orderId })'))
    assert.ok(!page.includes('JSON.stringify({ submissionId'))
    assert.ok(!/storage_paths[\s\S]{0,80}test-cleanup/.test(page))
  })

  test('the existing Order Request attachment purge still runs', () => {
    assert.ok(page.includes("'/api/orders/requests/attachments/cleanup'"))
    assert.ok(page.includes('body: JSON.stringify({ requestId })'))
  })

  test('payment proofs are still removed AFTER the commit, from the proof bucket', () => {
    const rpc = page.indexOf("supabase.rpc('execute_test_data_cleanup'")
    const proofs = page.indexOf('storage.from(PROOF_BUCKET).remove(res.storage_paths)')
    assert.ok(proofs > rpc, 'object storage is not transactional; proofs go after the commit')
  })

  test('the PI is shown in the preview, with its counts and its prefix', () => {
    assert.ok(page.includes("order_submission: 'PI submission'"))
    assert.ok(page.includes("order_submissions:            'PI submissions'"))
    assert.ok(page.includes("order_submission_items:       'PI product lines'"))
    assert.ok(page.includes("order_submission_item_images: 'PI images'"))
    assert.ok(page.includes("order_submission_activity:    'PI activity rows'"))
    assert.ok(page.includes('preview.submission_storage_prefix'))
  })

  test('a blocking PI explains itself rather than showing a blank number', () => {
    assert.ok(page.includes('b.reason'))
    assert.ok(page.includes('r.number ?? TYPE_LABEL[r.type]'))
  })

  test('the page still reconstructs no graph of its own', () => {
    assert.ok(page.includes('preview_test_data_cleanup'))
    // The only ids it sends come from the server-resolved preview.
    assert.ok(page.includes("preview.to_delete.filter(r => r.type === 'order')"))
  })
})

// ── 7. The Activity label ────────────────────────────────────────────────────

describe('the Order Activity trail names the PI event in English', () => {
  const page = source(ORDER_PAGE)

  test('the raw key never reaches the screen', () => {
    assert.ok(page.includes("order_created_from_pi_submission: 'Order created from PI submission'"))
    // The renderer falls back to the raw event_type, which is exactly what was
    // showing before this entry existed.
    assert.ok(page.includes('EVENT_TYPE_LABEL[entry.event_type] ?? entry.event_type'))
  })

  test('it takes the same green as the other Order-created event', () => {
    const dot = page.slice(page.indexOf('function ActivityDot'))
    assert.ok(dot.slice(0, 600).includes('order_created_from_pi_submission: colors.green'))
  })

  test('the label matches the event the approval RPC actually writes', () => {
    assert.ok(migration(PHASE_C).includes("'order_created_from_pi_submission'"),
      'the key must be the one 20260915000000 writes, character for character')
  })

  test('the existing labels are untouched', () => {
    for (const label of [
      "created:          'Order created'",
      "order_created_from_request: 'Order created from request'",
      "order_amended:    'Order amended'",
    ]) {
      assert.ok(page.includes(label), `${label} must survive`)
    }
  })
})
