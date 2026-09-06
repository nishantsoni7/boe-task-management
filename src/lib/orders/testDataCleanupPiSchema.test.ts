/**
 * Repository check: Test Data Cleanup removes a test Order created from an
 * approved PI, and cannot leave a record whose files are gone.
 *
 * TWO DEFECTS, AND THIS FILE DEFENDS AGAINST BOTH
 * -----------------------------------------------
 * A. Phase C's provenance link points both ways and both sides are NO ACTION, so
 *    neither row can be deleted first. The cleanup knew only the older pair and
 *    failed in production on Order 0001 with a raw foreign-key violation.
 *
 * B. The obvious fix — purge storage, then delete rows — is UNSAFE, and this is
 *    the failure the tests below mostly exist for. removeAllObjectsForSubmission
 *    deletes in batches and reports failures afterwards, so a partial success is
 *    a real outcome; and even a complete sweep is followed by a separate database
 *    call that can refuse. Either way an approved PI survives with its workbook
 *    and images destroyed.
 *
 * The remedy is the one 20260914000000 already uses for ordinary PI deletion: a
 * DURABLE CLAIM spanning the gap. What must therefore be true, and is checked
 * here, is that the claim exists, that it freezes the records, that nothing is
 * destroyed before it is taken, that finalization is idempotent and re-validates,
 * and that no path exists back to a single-call deletion.
 *
 * TypeScript sees none of this. These tests read the migration, the route and
 * the page.
 *
 * Reads repository files only. No database, no network.
 *
 * Run:
 *   npx tsx --test src/lib/orders/testDataCleanupPiSchema.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations')

/** Normalised to LF: a Windows checkout stores CRLF, and every `\n` in the
 *  patterns below would otherwise silently match nothing. */
const lf = (s: string) => s.replace(/\r\n/g, '\n')
const migration = (file: string) => lf(readFileSync(join(MIGRATIONS, file), 'utf8'))
const source = (path: string) => lf(readFileSync(join(process.cwd(), path), 'utf8'))
/** A TypeScript source with its `//` comments removed. Every module here
 *  documents at length what it must NOT do, naming the forbidden thing to
 *  explain why it is absent; a forbidden-text check must read code. */
const tsCode = (s: string) =>
  s.split('\n').filter(l => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*')).join('\n')

const FILE = '20260916000000_order_submission_test_cleanup.sql'
const CLEANUP = '20260706000000_test_data_cleanup.sql'
const PROTECT = '20260705000000_protect_finalized_orders_and_payments.sql'
const DELETION = '20260914000000_order_submission_permanent_deletion.sql'
const PHASE_C = '20260915000000_order_submission_final_approval.sql'
const CYCLE = '20260703000000_confirmed_order_number_cycle.sql'

const ROUTE = 'src/app/api/orders/test-data-cleanup/route.ts'
const PAGE = 'src/app/admin/control-center/test-data-cleanup/page.tsx'
const ORDER_PAGE = 'src/app/orders/[id]/page.tsx'

const sql = migration(FILE)
const code = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')
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

const BEGIN = fn('begin_test_data_cleanup')
const FINALIZE = fn('finalize_test_data_cleanup')
const RELEASE = fn('release_test_data_cleanup')
const RESOLVE = fn('resolve_test_data_cleanup_chain')
const STORAGE = fn('test_cleanup_claim_storage')
const RETIRED = fn('execute_test_data_cleanup')

// ── The file ──────────────────────────────────────────────────────────────────

describe('the fix is one new forward migration', () => {
  const files = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()

  test('it exists and sorts after everything it builds on', () => {
    assert.ok(files.includes(FILE))
    for (const earlier of [CLEANUP, PROTECT, DELETION, PHASE_C, CYCLE]) {
      assert.ok(files.includes(earlier), `${earlier} is missing`)
      assert.ok(FILE > earlier, `${FILE} must sort after ${earlier}`)
    }
  })

  // THE FIX ITSELF IS ONE FILE, and it is the first thing to land after Phase C.
  // Later migrations belong to later work — this asserts that none of them is a
  // second attempt at THIS fix, not that the repository stopped moving.
  test('the fix is one file, and the first one after Phase C', () => {
    const afterPhaseC = files.filter(f => f > PHASE_C)
    assert.equal(afterPhaseC[0], FILE)
    assert.deepEqual(afterPhaseC.filter(f => f.includes('test_cleanup')), [FILE])
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
    assert.ok(migration(PHASE_C).includes('create or replace function public.approve_order_submission'))
    assert.ok(migration(PHASE_C).includes('create trigger orders_protect_source_submission'))
    assert.ok(migration(DELETION).includes('create trigger order_submissions_guard_delete'))
    assert.ok(migration(PROTECT).includes('create or replace function public.in_test_data_cleanup'))
    assert.ok(migration(CLEANUP).includes('create table if not exists public.test_data_cleanup_audit'))
  })

  test('the ORIGINAL guards carry no cleanup exemption', () => {
    // Proof that the exemptions are added HERE rather than by editing the
    // migrations that own the guards.
    const phaseC = migration(PHASE_C)
    const guard = phaseC.slice(phaseC.indexOf('create or replace function public.prevent_order_source_submission_change'))
    assert.ok(!guard.slice(0, 900).includes('in_test_data_cleanup'),
      '20260915000000 must not have been edited')
  })

  test('this migration alters no EXISTING table and drops nothing it does not own', () => {
    // The one ALTER is on the table this file creates, enabling RLS on it. Every
    // other change is a function body.
    const altered = [...declarations.matchAll(/alter table (?:if exists )?public\.(\w+)/gi)].map(m => m[1])
    assert.deepEqual([...new Set(altered)], ['test_data_cleanup_claims'],
      'no pre-existing table is reshaped')
    assert.ok(!/drop (table|column|policy|constraint|index)/i.test(declarations))
  })
})

// ── B. The claim — the correction this revision is about ─────────────────────

describe('a DURABLE claim spans the gap between files and rows', () => {
  test('the claim is a table, not a transaction-local flag', () => {
    assert.ok(code.includes('create table if not exists public.test_data_cleanup_claims'))
    assert.ok(code.includes('claim_token         uuid        not null unique default gen_random_uuid()'),
      'unguessable, and generated by the database')
    assert.ok(code.includes('finalized_at        timestamptz'))
  })

  test('it records the whole chain, so a retry resumes the AUTHORIZED operation', () => {
    for (const column of [
      'order_id', 'order_request_id', 'order_submission_id', 'payment_ids',
      'chain', 'reason', 'confirmation', 'storage_prefix', 'audit_id',
    ]) {
      assert.ok(code.includes(column), `the claim must record ${column}`)
    }
  })

  test('no client role can read it — the token must never reach a browser', () => {
    assert.ok(code.includes('revoke all on table public.test_data_cleanup_claims from public, anon, authenticated'))
    assert.ok(code.includes('alter table public.test_data_cleanup_claims enable row level security'))
    assert.ok(!/create policy[\s\S]{0,80}test_data_cleanup_claims/i.test(declarations),
      'there is no SELECT policy, so the token is unreadable even to an admin client')
    assert.ok(code.includes('test_data_cleanup_claims is reachable by a client role'),
      'and the migration asserts it at apply time')
  })

  test('one open claim per root, per Order and per PI', () => {
    for (const index of [
      'test_data_cleanup_claims_open_root_uidx',
      'test_data_cleanup_claims_open_order_uidx',
      'test_data_cleanup_claims_open_submission_uidx',
    ]) {
      assert.ok(code.includes(`create unique index if not exists ${index}`), `${index} is missing`)
    }
    // Partial, so a CONSUMED claim never blocks a future one.
    assert.ok(code.includes('where finalized_at is null'))
  })

  test('a claimed Order and a claimed PI are FROZEN against mutation', () => {
    const orders = fn('orders_guard_cleanup_claim')
    const subs = fn('order_submissions_guard_cleanup_claim')
    for (const guard of [orders, subs]) {
      assert.ok(guard.includes('if public.in_test_data_cleanup() then'),
        'the finalization itself must still be able to act')
      assert.ok(guard.includes('test_data_cleanup_claim_open'))
      assert.ok(guard.includes('raise exception'))
    }
    assert.ok(orders.includes('ORDER_CLEANUP_CLAIMED'))
    assert.ok(subs.includes('ORDER_SUBMISSION_CLEANUP_CLAIMED'))
    assert.ok(code.includes('create trigger orders_guard_cleanup_claim'))
    assert.ok(code.includes('create trigger order_submissions_guard_cleanup_claim'))
  })
})

describe('begin destroys nothing and gates everything', () => {
  test('every gate is checked BEFORE the claim is taken', () => {
    const claimAt = BEGIN.indexOf('insert into public.test_data_cleanup_claims')
    assert.ok(claimAt > 0)
    for (const gate of [
      'Only an admin may run Test Data Cleanup',
      'CLEANUP_DISABLED',
      'CLEANUP_REASON_REQUIRED',
      'CLEANUP_CONFIRMATION_INVALID',
      'CLEANUP_NOT_ELIGIBLE',
      'CLEANUP_PROVENANCE_MISMATCH',
    ]) {
      const at = BEGIN.indexOf(gate)
      assert.ok(at !== -1, `${gate} is missing`)
      assert.ok(at < claimAt, `${gate} must be checked before the claim`)
    }
    assert.ok(code.includes('gate % is checked after the claim is taken'),
      'and the migration asserts the ordering at apply time')
  })

  test('it never opens the cleanup context and deletes nothing', () => {
    assert.ok(!BEGIN.includes('boe.cleanup_context'),
      'only finalization may stand the production guards down')
    assert.ok(!/delete from public\./i.test(BEGIN))
    assert.ok(code.includes('begin_test_data_cleanup opens the cleanup context'))
    assert.ok(code.includes('begin_test_data_cleanup deletes something'))
  })

  test('it locks the chain and re-resolves before judging eligibility', () => {
    assert.ok(BEGIN.includes('perform 1 from public.order_submissions where id = v_submission for update'))
    const firstResolve = BEGIN.indexOf('resolve_test_data_cleanup_chain')
    const lock = BEGIN.indexOf('for update;', firstResolve)
    const second = BEGIN.indexOf('resolve_test_data_cleanup_chain', lock)
    assert.ok(second > lock, 'the second pass is the one that counts')
  })

  test('the permanent audit is written at CLAIM time, before anything can go', () => {
    const audit = BEGIN.indexOf('insert into public.test_data_cleanup_audit')
    const claim = BEGIN.indexOf('insert into public.test_data_cleanup_claims')
    assert.ok(audit > 0 && audit < claim,
      'an operation that destroys data must be on the record before it starts')
  })

  test('the SAME admin retrying resumes; a DIFFERENT one is refused', () => {
    assert.ok(BEGIN.includes('CLEANUP_CLAIMED_BY_OTHER'))
    assert.ok(BEGIN.includes("'resumed',       true"))
    assert.ok(BEGIN.includes('v_existing.claimed_by is distinct from v_actor'))
    // The resumed branch must NOT re-resolve the chain: that would be a
    // different operation wearing the same claim, possibly after its files are
    // already gone. It runs from `if found then` to the return that ends it.
    const branchStart = BEGIN.indexOf('if found then')
    assert.ok(branchStart > 0)
    const branchEnd = BEGIN.indexOf('end if;', BEGIN.indexOf("'audit_id',              v_existing.audit_id"))
    assert.ok(branchEnd > branchStart)
    const resumed = BEGIN.slice(branchStart, branchEnd)
    assert.ok(!resumed.includes('resolve_test_data_cleanup_chain'),
      'a resumed claim replays the authorized operation, it does not re-derive one')
    assert.ok(!resumed.includes('insert into public.test_data_cleanup_audit'),
      'and it does not write a second audit row for one operation')
  })
})

describe('finalize is the only thing that deletes, and it is idempotent', () => {
  test('a finalized claim answers instead of acting', () => {
    assert.ok(FINALIZE.includes('if v_claim.finalized_at is not null then'))
    assert.ok(FINALIZE.includes("'already_finalized', true"))
    const answer = FINALIZE.indexOf("'already_finalized', true")
    const firstDelete = FINALIZE.indexOf('delete from public.notifications')
    assert.ok(answer < firstDelete, 'it must return before deleting anything')
    assert.ok(code.includes('finalize_test_data_cleanup is not idempotent'))
  })

  test('it re-locks and re-validates against the LIVE rows', () => {
    assert.ok(FINALIZE.includes('for update'))
    assert.ok(FINALIZE.includes('resolve_test_data_cleanup_chain'))
    assert.ok(FINALIZE.includes('CLEANUP_NOT_ELIGIBLE'))
    assert.ok(FINALIZE.includes('CLEANUP_PROVENANCE_MISMATCH'))
    assert.ok(FINALIZE.includes('CLEANUP_CHAIN_CHANGED'),
      'a chain that moved despite the freeze is refused, not acted on')
  })

  test('the context is opened only after the re-check', () => {
    assert.ok(FINALIZE.indexOf('CLEANUP_NOT_ELIGIBLE') < FINALIZE.indexOf('boe.cleanup_context'))
    assert.ok(code.includes('the cleanup context is opened before the eligibility re-check'))
  })

  test('THE DELETION ORDER — defect A is reversing these', () => {
    const clear = FINALIZE.indexOf('set source_order_submission_id = null')
    const delSub = FINALIZE.indexOf('delete from public.order_submissions')
    const delOrd = FINALIZE.indexOf('delete from public.orders where id = v_order')
    assert.ok(clear > 0 && delSub > 0 && delOrd > 0)
    assert.ok(clear < delSub, 'the Order must release the PI before the PI can go')
    assert.ok(delSub < delOrd, 'the PI must go before the Order it points at')
    assert.ok(code.includes('the PI must be deleted before the Order it belongs to'))
  })

  test('it does NOT re-check the enabled setting, deliberately', () => {
    // By finalization the files are gone. Refusing would leave exactly the
    // corruption this design exists to prevent, so the five gates are enforced
    // at claim time and the claim carries that authorization forward.
    assert.ok(!FINALIZE.includes('CLEANUP_DISABLED'))
    assert.ok(!FINALIZE.includes('permanently_disabled'))
    assert.ok(sql.includes('IT DOES NOT RE-CHECK THE ENABLED SETTING, deliberately'),
      'and the reasoning is written down where the next reader will find it')
  })

  test('the claim is consumed, not deleted', () => {
    assert.ok(FINALIZE.includes('set finalized_at = now()'))
    assert.ok(!/delete from public\.test_data_cleanup_claims/.test(FINALIZE),
      'the consumed claim is what makes a repeated finalize answer instead of act')
  })

  test('the audit is completed with the real counts', () => {
    assert.ok(FINALIZE.includes('update public.test_data_cleanup_audit'))
    assert.ok(FINALIZE.includes("'order_submissions',            v_n_sub"))
    assert.ok(FINALIZE.includes("'submission_storage_prefix',    v_claim.storage_prefix"))
  })
})

describe('release gives the records back only when nothing was destroyed', () => {
  test('it clears the claim and unfreezes the records', () => {
    assert.ok(RELEASE.includes('delete from public.test_data_cleanup_claims'))
  })

  test('it refuses a claim that has already been consumed', () => {
    assert.ok(RELEASE.includes("'already_finalized'"))
  })

  test('the permanent audit survives a release, marked released', () => {
    assert.ok(RELEASE.includes('update public.test_data_cleanup_audit'))
    assert.ok(RELEASE.includes("'released', true"))
    assert.ok(!/delete from public\.test_data_cleanup_audit/.test(declarations),
      'an authorized-then-abandoned cleanup is a thing that happened')
  })
})

describe('the single-call door is closed', () => {
  test('execute_test_data_cleanup refuses and says where to go', () => {
    assert.ok(RETIRED.includes('CLEANUP_USE_CLAIM_PROTOCOL'))
    assert.ok(!/delete from public\./i.test(RETIRED))
    assert.ok(!RETIRED.includes('boe.cleanup_context'))
    assert.ok(code.includes('the retired single-call cleanup still deletes'),
      'and the migration asserts it at apply time')
  })

  test('it is retired rather than dropped, so a stale client gets a message', () => {
    assert.ok(!/drop function[\s\S]{0,80}execute_test_data_cleanup/i.test(declarations))
  })

  test('nothing in the application calls it any more', () => {
    assert.ok(!tsCode(source(PAGE)).includes('execute_test_data_cleanup'))
    assert.ok(!tsCode(source(ROUTE)).includes('execute_test_data_cleanup'))
  })
})

// ── A. The PI in the chain ───────────────────────────────────────────────────

describe('chain resolution resolves the PI, and refuses a pair that disagrees', () => {
  test('the PI is read from the ORDER, not from anything supplied', () => {
    assert.ok(RESOLVE.includes('select o.source_order_submission_id, o.is_test_data'))
  })

  test('its test-data status is INHERITED from the Order', () => {
    assert.ok(RESOLVE.includes("'is_test_data', coalesce(v_order_is_test, false)"))
    assert.ok(!/alter table public\.order_submissions[\s\S]{0,80}is_test_data/i.test(declarations),
      'no is_test_data column is added to order_submissions')
  })

  test('a dangling or disagreeing pair becomes a BLOCKING entry with a reason', () => {
    assert.ok(RESOLVE.includes('v_sub_order_id is null'))
    assert.ok(RESOLVE.includes('v_sub_order_id is distinct from v_order_id'))
    assert.ok(RESOLVE.includes('the PI this Order names is linked to a different Order'))
    assert.ok(RESOLVE.includes("'eligible',        jsonb_array_length(v_block) = 0"))
  })

  test('a disagreeing pair is refused, never silently repaired', () => {
    assert.ok(!/update public\.order_submissions[\s\S]{0,120}set order_id/i.test(declarations))
  })

  test('the four PI tables are counted for the preview', () => {
    for (const table of [
      'order_submissions', 'order_submission_items',
      'order_submission_item_images', 'order_submission_activity',
    ]) {
      assert.ok(RESOLVE.includes(`'${table}',`), `${table} must be counted`)
    }
  })

  test('the PI prefix is kept OUT of storage_paths', () => {
    // storage_paths is consumed as PAYMENT-PROOF keys against the payment-proofs
    // bucket. PI files live in order-files; folding them together would send one
    // bucket's keys to the other.
    assert.ok(RESOLVE.includes("'submission_storage_prefix', v_prefix"))
    const paths = RESOLVE.slice(RESOLVE.indexOf('into v_paths'))
    assert.ok(paths.includes('from public.payment_proof_attachments a'))
    assert.ok(!paths.slice(0, 300).includes('submission'))
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
})

describe('the provenance guarantees survive the fix', () => {
  test('three guards gain the cleanup exemption and still refuse everybody else', () => {
    for (const name of [
      'prevent_order_source_submission_change',
      'order_submissions_guard_delete',
      'order_submission_activity_guard_delete',
    ]) {
      const body = fn(name)
      assert.ok(body.includes('if public.in_test_data_cleanup() then'))
      assert.ok(body.includes('raise exception'))
    }
    // The ordinary purge door survives on both submission guards.
    assert.ok(fn('order_submissions_guard_delete').includes('order_submission_purge_in_progress(old.id)'))
    assert.ok(fn('order_submission_activity_guard_delete').includes('order_submission_purge_in_progress(old.submission_id)'))
  })

  test('no OTHER guard is touched', () => {
    for (const untouched of [
      'order_submissions_guard_order_link',
      'order_submissions_enforce_status_transition',
      'order_submissions_guard_deletion_claim',
      'order_submissions_guard_finance_verification',
      'prevent_order_delete',
      'prevent_converted_order_request_delete',
      'finance_payment_requests_guard_approved_delete',
      'in_test_data_cleanup',
    ]) {
      assert.ok(!declarations.includes(`create or replace function public.${untouched}`),
        `${untouched} belongs to an applied migration and must not be restated`)
    }
  })

  test('neither foreign key is dropped, altered or made deferrable', () => {
    assert.ok(!/on delete cascade/i.test(declarations),
      'a cascade would delete an approved PI whenever its Order went, for any reason')
    assert.ok(code.includes('is no longer a NO ACTION foreign key'))
  })

  test('both uniqueness indexes are asserted present', () => {
    assert.ok(code.includes('order_submissions_order_id_key'))
    assert.ok(code.includes('orders_source_order_submission_id_uidx'))
  })

  test('normal PI deletion is unchanged and still refuses an approved PI', () => {
    for (const untouched of [
      'begin_order_submission_deletion', 'release_order_submission_deletion',
      'finalize_order_submission_deletion', 'order_submission_deletable_statuses',
    ]) {
      assert.ok(!declarations.includes(`create or replace function public.${untouched}`))
    }
    assert.ok(code.includes("if 'approved' = any (public.order_submission_deletable_statuses())"))
  })

  test('final approval, the advance workflow and payments are untouched', () => {
    for (const untouched of [
      'approve_order_submission', 'verify_pi_finance_check',
      'approve_pi_advance_exception', 'approve_finance_payment_request',
    ]) {
      assert.ok(!declarations.includes(`create or replace function public.${untouched}`))
    }
  })

  test('no RLS policy on a business table is created, altered or dropped', () => {
    assert.ok(!/create policy|alter policy|drop policy/i.test(declarations))
  })
})

// ── Order-number reuse ───────────────────────────────────────────────────────

describe('a freed Order number is genuinely reusable, with no manual repair', () => {
  test('finalization gives back the numbers this cleanup freed', () => {
    assert.ok(FINALIZE.includes('v_freed'))
    assert.ok(FINALIZE.includes('update public.order_number_cycle set next_number = v_next'))
    assert.ok(FINALIZE.includes("'order_numbers_reclaimed',      v_reclaimed"))
  })

  test('it only reclaims from the TOP of the range, so an admin decision stands', () => {
    // An administrator who set the cycle to 1000 has said something; deleting a
    // test Order is not a reason to unsay it. Only a number immediately below
    // the cycle, freed by this cleanup, is taken back.
    assert.ok(FINALIZE.includes('(v_next - 1) = any (v_freed)'))
    assert.ok(FINALIZE.includes('while v_next > greatest(v_highest + 1, 1)'),
      'and it never goes below the highest surviving Order + 1')
  })

  test('it never ADVANCES the cycle, and never rewrites the admin audit columns', () => {
    assert.ok(!/next_number\s*=\s*v_next\s*\+/.test(FINALIZE))
    assert.ok(!FINALIZE.includes('configured_at'))
    assert.ok(!FINALIZE.includes('configured_by'))
  })

  test('the invariant it respects is the allocator’s own', () => {
    assert.ok(migration(CYCLE).includes('highest existing'))
    assert.ok(!declarations.includes('setval'))
    assert.ok(!declarations.includes('allocate_confirmed_order_number'))
  })
})

// ── The route owns the whole sequence ────────────────────────────────────────

describe('one route owns claim -> storage -> finalize', () => {
  const route = source(ROUTE)
  const routeCode = tsCode(route)

  test('the old two-call route is gone', () => {
    assert.ok(!existsSync(join(process.cwd(), 'src/app/api/orders/submissions/test-cleanup/route.ts')),
      'the storage-only PI purge route was the unsafe half and must not survive')
  })

  test('it calls the three RPCs in order, and nothing else destructive', () => {
    const begin = routeCode.indexOf("'begin_test_data_cleanup'")
    const sweep = routeCode.indexOf('removeAllObjectsForSubmission(')
    const final = routeCode.indexOf("'finalize_test_data_cleanup'")
    assert.ok(begin > 0 && sweep > begin && final > sweep,
      'claim, then storage, then rows')
  })

  test('the browser sends only what the admin typed', () => {
    assert.ok(route.includes('const { rootType, rootId, reason, confirmation } = body'))
    for (const forbidden of ['submissionId', 'storagePaths', 'claimToken', 'paths']) {
      assert.ok(!new RegExp(`${forbidden}[^A-Za-z]*[=:][^=]*body`).test(routeCode),
        `${forbidden} must never come from the request body`)
    }
  })

  test('the claim token never reaches a response', () => {
    // It is read into a local and passed to the RPCs; no response body carries it.
    const responses = [...routeCode.matchAll(/NextResponse\.json\(([\s\S]{0,400}?)\)/g)].map(m => m[1])
    for (const body of responses) {
      assert.ok(!/token/i.test(body), 'a response body must not carry the claim token')
    }
  })

  test('admin is proved before the service role is used destructively', () => {
    const roleCheck = routeCode.indexOf("me.role !== 'admin'")
    const claim = routeCode.indexOf("'begin_test_data_cleanup'")
    assert.ok(roleCheck > 0 && roleCheck < claim)
    assert.ok(route.includes('is_active === false'))
    assert.ok(route.includes('is_deleted === true'))
  })

  test('release is decided by ATTEMPTED destruction, never by CONFIRMED removals', () => {
    // THE CORRECTION. A `.remove()` can delete objects and then lose its
    // response: the client sees a throw, or a reply naming nothing, and the
    // confirmed count is zero while the files are gone. Releasing on an absent
    // confirmation unfreezes a record whose workbook no longer exists.
    assert.ok(route.includes('let storageRemovalAttempted = false'))
    assert.ok(route.includes('if (!storageRemovalAttempted) await release()'))
    assert.ok(route.includes('reserved: storageRemovalAttempted'))
    // The old, unsafe predicate must be gone entirely.
    assert.ok(!routeCode.includes('sweptAnything'),
      'the confirmed-removals predicate was the bug and must not survive')
  })

  test('the flag is set by a callback that runs BEFORE each remove request', () => {
    assert.ok(route.includes('const markRemovalAttempt = () => { storageRemovalAttempted = true }'))
    assert.ok(route.includes('onRemoveAttempt: markRemovalAttempt'))
    // EVERY destructive helper, not just the PI one. Three of them now: the
    // Order Request's attachments, the PI's own files, and — since Confirmed
    // Orders gained generated documents — the Order's own
    // orders/{order_id}/versions/ prefix, which belongs to no PI and which
    // nothing else would ever remove.
    assert.equal((route.match(/onRemoveAttempt: markRemovalAttempt/g) ?? []).length, 3,
      'Order Request attachments, PI files AND the Order’s generated documents')
  })

  test('the returned fact is read too, as defence in depth', () => {
    assert.ok(route.includes('if (attachments.removalAttempted) storageRemovalAttempted = true'))
    assert.ok(route.includes('if (removal.removalAttempted) storageRemovalAttempted = true'))
  })

  test('every release site is guarded by the attempted flag', () => {
    for (const match of [...routeCode.matchAll(/await release\(\)/g)]) {
      const line = routeCode.slice(routeCode.lastIndexOf('\n', match.index!) + 1, match.index! + 15)
      assert.ok(/if \(!storageRemovalAttempted\)/.test(line),
        `an unguarded release: ${line.trim()}`)
    }
  })

  test('confirmed removals are named for what they are, and decide nothing', () => {
    assert.ok(route.includes('let confirmedRemoved = 0'))
    assert.ok(route.includes('confirmedRemovedFiles: confirmedRemoved'))
    // It is only ever accumulated and reported — never branched on.
    assert.ok(!/if\s*\([^)]*confirmedRemoved/.test(routeCode),
      'a decision taken on confirmed removals is the defect returning')
  })

  test('a listing failure before any remove may still release', () => {
    // The one provably safe path: nothing destructive went out, so the record
    // can be handed back whole. A false-positive reservation is recoverable;
    // releasing after uncertain deletion is not.
    assert.ok(sql.includes('release_test_data_cleanup') || true)
    assert.ok(route.includes('if (!storageRemovalAttempted) await release()'))
  })

  test('a failed finalize NEVER releases the claim', () => {
    const failure = routeCode.slice(routeCode.indexOf('if (finalErr)'))
    assert.ok(!failure.slice(0, 600).includes('release()'),
      'the files are gone; the records must stay frozen until it completes')
    assert.ok(route.includes('reserved: true'))
  })

  test('no comment equates "not confirmed removed" with "nothing removed"', () => {
    for (const file of [ROUTE, 'src/lib/orders/submissionFilesServer.ts',
                        'src/lib/orderRequestAttachmentsServer.ts',
                        'src/app/api/orders/submissions/delete/route.ts']) {
      const text = source(file)
      assert.ok(!/leaves a complete, retryable record/.test(text),
        `${file} repeats the false claim`)
      assert.ok(!/nothing is in flight, so\s*\n?\s*\/\/ giving the record back cannot be overtaken/i.test(text),
        `${file} still reasons from settledness alone`)
    }
  })

  test('it removes Order Request attachments inside the same claim window', () => {
    assert.ok(route.includes('removeAllObjectsForRequest'))
    const attach = routeCode.indexOf('removeAllObjectsForRequest(')
    const begin = routeCode.indexOf("'begin_test_data_cleanup'")
    const final = routeCode.indexOf("'finalize_test_data_cleanup'")
    assert.ok(attach > begin && attach < final,
      'it has the same failure mode as the PI files and needs the same protection')
  })

  test('an already-deleted PI is not an error on retry', () => {
    assert.ok(STORAGE.includes("'already_deleted'"))
    assert.ok(route.includes('if (info?.found && typeof info.submission_id'))
  })

  test('it uses the established bounded, settled sweep — with no timeout', () => {
    assert.ok(!/setTimeout|Promise\.race|AbortController/.test(routeCode),
      'a promise race is not cancellation; the reasoning is in submissionFilesServer.ts')
    const files = source('src/lib/orders/submissionFilesServer.ts')
    assert.ok(files.includes('export const LIST_CONCURRENCY = 8'))
    assert.ok(files.includes('mapWithLimit'))
  })

  test('the false claim about retryability is gone', () => {
    assert.ok(!/leaves a complete, retryable record/.test(route),
      'that reasoning was wrong and must not be repeated')
  })
})

describe('the PI storage keys come from the claim, never from a guess', () => {
  test('the resolver requires a claim token and admin', () => {
    assert.ok(STORAGE.includes("u.role = 'admin'"))
    assert.ok(STORAGE.includes('where claim_token = p_claim_token'))
    assert.ok(STORAGE.includes('CLEANUP_CLAIM_INVALID'))
  })

  test('every key it returns is confined to that submission’s prefix', () => {
    assert.ok(STORAGE.includes("where path like ('submissions/' || v_sub.id::text || '/%')"))
  })

  test('it reads keys from all three places they live', () => {
    assert.ok(STORAGE.includes('v_sub.source_workbook_path'))
    assert.ok(STORAGE.includes('from public.order_submission_item_images m'))
    assert.ok(STORAGE.includes('i.image_storage_path'))
  })

  test('it reserves nothing and deletes nothing', () => {
    assert.ok(!/delete from|update public\./i.test(STORAGE))
  })
})

// ── The page makes ONE request ───────────────────────────────────────────────

describe('the admin page coordinates no destructive step', () => {
  const page = source(PAGE)
  const pageCode = tsCode(page)

  test('it makes exactly one cleanup call', () => {
    assert.ok(page.includes("'/api/orders/test-data-cleanup'"))
    assert.ok(!pageCode.includes("'/api/orders/requests/attachments/cleanup'"),
      'the attachment purge moved inside the claim window, server-side')
    assert.ok(!pageCode.includes("'/api/orders/submissions/test-cleanup'"))
    assert.ok(!pageCode.includes('execute_test_data_cleanup'))
  })

  test('it sends what the admin typed, and nothing else', () => {
    assert.ok(page.includes('rootType:     preview.root_type'))
    assert.ok(page.includes('rootId:       preview.root_id'))
    assert.ok(page.includes('reason,'))
    assert.ok(page.includes('confirmation: typed,'))
    assert.ok(!/orderId|submissionId|claim_token/.test(pageCode))
  })

  test('a failure preserves the typed reason and confirmation for a retry', () => {
    const failure = pageCode.slice(pageCode.indexOf('if (!ok)'))
    assert.ok(!failure.slice(0, 400).includes("setTyped('')"))
    assert.ok(!failure.slice(0, 400).includes("setReason('')"))
  })

  test('payment proofs are still removed after the commit, from their own bucket', () => {
    const call = pageCode.indexOf("'/api/orders/test-data-cleanup'")
    const proofs = pageCode.indexOf('storage.from(PROOF_BUCKET).remove(res.storage_paths)')
    assert.ok(proofs > call, 'object storage is not transactional; proofs go after')
  })

  test('the PI is shown in the preview, with its counts and its prefix', () => {
    assert.ok(page.includes("order_submission: 'PI submission'"))
    assert.ok(page.includes("order_submissions:            'PI submissions'"))
    assert.ok(page.includes("order_submission_items:       'PI product lines'"))
    assert.ok(page.includes('preview.submission_storage_prefix'))
  })

  test('a blocking PI explains itself rather than showing a blank number', () => {
    assert.ok(page.includes('b.reason'))
    assert.ok(page.includes('r.number ?? TYPE_LABEL[r.type]'))
  })

  test('the page still reconstructs no graph of its own', () => {
    assert.ok(page.includes('preview_test_data_cleanup'))
  })
})

// ── The Activity label ───────────────────────────────────────────────────────

describe('the Order Activity trail names the PI event in English', () => {
  const page = source(ORDER_PAGE)

  test('the raw key never reaches the screen', () => {
    assert.ok(page.includes("order_created_from_pi_submission: 'Order created from PI submission'"))
    assert.ok(page.includes('EVENT_TYPE_LABEL[entry.event_type] ?? entry.event_type'))
  })

  test('it takes the same green as the other Order-created event', () => {
    const dot = page.slice(page.indexOf('function ActivityDot'))
    assert.ok(dot.slice(0, 600).includes('order_created_from_pi_submission: colors.green'))
  })

  test('the label matches the event the approval RPC actually writes', () => {
    assert.ok(migration(PHASE_C).includes("'order_created_from_pi_submission'"))
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
