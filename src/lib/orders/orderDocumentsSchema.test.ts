/**
 * Repository check: the document-generation phase keeps the guarantees it exists
 * to establish.
 *
 * WHY A REPO CHECK
 * ----------------
 * Every promise below lives in SQL, and each fails SILENTLY if a later change
 * relaxes it:
 *
 *   1. `ready` IS IMPOSSIBLE WITHOUT BOTH FILES. Not a convention — a CHECK
 *      constraint. A half-generated version must not be representable.
 *   2. THE REQUEST IS SECURITY INVOKER. This is the subtle one. Inside a
 *      SECURITY DEFINER function the current user is the function's owner, and
 *      the owner of these tables bypasses row-level security — so can_view_order
 *      would be asked on the owner's behalf and would answer `true` for every
 *      Order in the business. The check would read correctly and authorize
 *      everybody.
 *   3. THE WORKER HALF IS SERVER-ONLY. A browser that could claim, complete or
 *      fail could publish a file of its choosing.
 *   4. THE LEASE TOKEN IS NOT GRANTED TO A CLIENT ROLE, at column level.
 *   5. A CLAIM IS ATOMIC — one UPDATE with the eligibility test in its WHERE
 *      clause, never a read followed by a write.
 *   6. RETRY MOVES NO ORDER, NO NUMBER AND NO MONEY.
 *   7. PUBLICATION, NOT LOCATION, authorizes a document read — which is what
 *      makes "a partial upload never becomes downloadable" true.
 *   8. NOT ONE APPLIED MIGRATION IS EDITED.
 *
 * It also pins the TypeScript path helpers to the SQL ones, because two
 * implementations of one key convention is exactly how a file gets written
 * somewhere the policy will not authorize.
 *
 * Reads repository files only. No database, no network.
 *
 * Run:
 *   npx tsx --test src/lib/orders/orderDocumentsSchema.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import {
  ORDER_DOCUMENT_STATUSES,
  orderDocumentAttemptPath,
  orderDocumentVersionPrefix,
} from './orderDocuments'

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations')
const lf = (s: string) => s.replace(/\r\n/g, '\n')
const read = (file: string) => lf(readFileSync(join(MIGRATIONS, file), 'utf8'))

const FILE = '20260925000000_order_document_generation.sql'
const HANDOFF = '20260924000000_order_submission_confirmed_order_handoff.sql'
const SUBMISSIONS = '20260908000000_order_pi_submissions.sql'

const sql = read(FILE)

/** The migration with `--` comments removed. Essential: the header deliberately
 *  NAMES what this phase must not do, and a naive search would find its own
 *  prohibitions and call them implementations. */
const code = sql
  .split('\n')
  .map(line => {
    const at = line.indexOf('--')
    return at === -1 ? line : line.slice(0, at)
  })
  .join('\n')

function fnBody(name: string): string {
  const start = code.search(new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\s*\\(`, 'i'))
  assert.ok(start >= 0, `${name} is not defined in ${FILE}`)
  const end = code.indexOf('\n$$;', start)
  assert.ok(end > start, `no closing dollar tag for ${name}`)
  return code.slice(start, end + 4)
}

// ── 1. Placement ──────────────────────────────────────────────────────────────

describe('the migration takes its place without disturbing anything applied', () => {
  test('its timestamp is after 20260923000000 and after the handoff', () => {
    assert.ok(FILE > '20260923000000_order_submission_billing_percentage.sql')
    assert.ok(FILE > HANDOFF, 'it supersedes a policy the handoff created, so it must sort after it')
  })

  test('nothing was slipped in between it and the handoff it supersedes', () => {
    // Not "it is the newest": a later phase on this same branch adds its own
    // file, which is what a branch of several phases looks like. What must stay
    // true is that this one lands immediately after the migration whose storage
    // policy it narrows.
    const files = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()
    assert.equal(files[files.indexOf(HANDOFF) + 1], FILE)
  })

  test('no applied migration has been modified on this branch', () => {
    // A file that does not exist at origin/main is NEW, not edited. Only a file
    // that WAS there and has changed would silently alter what the remote
    // database is believed to contain.
    const changed = execFileSync('git', ['diff', '--name-only', 'origin/main', '--', 'supabase/migrations'], {
      encoding: 'utf8', cwd: process.cwd(),
    }).split('\n').map(s => s.trim()).filter(Boolean)

    const atBase = new Set(
      execFileSync('git', ['ls-tree', '--name-only', 'origin/main:supabase/migrations'], {
        encoding: 'utf8', cwd: process.cwd(),
      }).split('\n').map(s => s.trim()).filter(Boolean))

    const edited = changed.filter(path => atBase.has(path.split('/').pop() ?? path))
    assert.deepEqual(edited, [], `applied migrations were edited: ${edited.join(', ')}`)
  })

  test('it does not re-emit approval, numbering or any permission function', () => {
    for (const fn of [
      'approve_order_submission', 'allocate_confirmed_order_number',
      'can_view_order', 'can_view_order_submission', 'can_view_order_submission_via_order',
      'module_entry_open', 'resolve_permission', 'actor_has_module_permission',
      'order_file_submission_id', 'order_file_order_id',
    ]) {
      assert.ok(
        !new RegExp(`create\\s+(or\\s+replace\\s+)?function\\s+public\\.${fn}\\s*\\(`, 'i').test(code),
        `${fn} must not be redefined by the document phase`)
    }
  })

  test('approval itself is not touched — it stays atomic and stays small', () => {
    assert.ok(!/alter\s+function\s+public\.approve_order_submission/i.test(code))
    assert.match(sql, /It does not touch approve_order_submission\(\)/)
  })
})

// ── 2. The register's invariants ──────────────────────────────────────────────

describe('what the table refuses to represent', () => {
  test('`ready` without BOTH files is a CHECK violation, not a convention', () => {
    assert.match(code, /constraint order_document_versions_ready_is_complete\s*\n?\s*check \(\s*\n?\s*status <> 'ready'/i)
    const at = code.indexOf('order_document_versions_ready_is_complete')
    const decl = code.slice(at, at + 400)
    assert.match(decl, /excel_path is not null/)
    assert.match(decl, /pdf_path is not null/)
    assert.match(decl, /completed_at is not null/)
  })

  test('the four states are closed in SQL and match the TypeScript set', () => {
    const at = code.indexOf('order_document_versions_status_known')
    const decl = code.slice(at, at + 200)
    for (const status of ORDER_DOCUMENT_STATUSES) {
      assert.ok(decl.includes(`'${status}'`), `${status} must be in the CHECK`)
    }
    // And no fifth.
    const listed = decl.match(/'(\w+)'/g) ?? []
    assert.equal(listed.length, ORDER_DOCUMENT_STATUSES.length)
  })

  test('a claim is all three lease columns or none of them', () => {
    const at = code.indexOf('order_document_versions_claim_consistent')
    const decl = code.slice(at, at + 400)
    assert.match(decl, /status = 'claimed' and claim_token is not null and claimed_at is not null/i)
    assert.match(decl, /status <> 'claimed' and claim_token is null and claimed_at is null/i)
  })

  test('a failure must carry a code', () => {
    assert.match(code, /constraint order_document_versions_failed_has_code[\s\S]{0,160}last_error_code is not null/i)
  })

  test('ONE version per Order, and ONE generation in flight per Order', () => {
    assert.match(code, /create unique index if not exists order_document_versions_order_version_uidx\s*\n?\s*on public\.order_document_versions \(order_id, version\)/i)
    const at = code.indexOf('order_document_versions_active_uidx')
    const decl = code.slice(at, at + 220)
    assert.match(decl, /\(order_id\)/)
    assert.match(decl, /where status in \('pending', 'claimed'\)/i)
  })
})

// ── 3. The guard ──────────────────────────────────────────────────────────────

describe('order_document_versions_guard', () => {
  const body = fnBody('order_document_versions_guard')

  test('refuses to move a row between Orders or between versions', () => {
    assert.match(body, /ORDER_DOCUMENT_IMMUTABLE_ORDER/)
    assert.match(body, /ORDER_DOCUMENT_IMMUTABLE_VERSION/)
  })

  test('makes `ready` terminal, for the status AND for the files', () => {
    assert.equal((body.match(/ORDER_DOCUMENT_READY_IS_TERMINAL/g) ?? []).length, 2)
  })

  test('makes attempt history append-only', () => {
    assert.match(body, /ORDER_DOCUMENT_ATTEMPTS_ARE_HISTORY/)
  })

  test('refuses a file outside the version\'s OWN prefix, with a trailing slash', () => {
    // `like prefix || '/%'` and not a bare prefix test: .../versions/1 must not
    // authorize .../versions/10.
    assert.match(body, /not like v_prefix \|\| '\/%'/)
    assert.equal((body.match(/ORDER_DOCUMENT_PATH_OUTSIDE_VERSION/g) ?? []).length, 2)
  })

  test('refuses a key that does not decode back to this Order', () => {
    assert.match(body, /order_file_order_id\(new\.excel_path\) is distinct from new\.order_id/)
    assert.match(body, /order_file_order_id\(new\.pdf_path\) is distinct from new\.order_id/)
  })

  test('refuses a version out of sequence, and an Order with no source PI', () => {
    assert.match(body, /ORDER_DOCUMENT_VERSION_OUT_OF_SEQUENCE/)
    assert.match(body, /ORDER_DOCUMENT_NO_SOURCE_PI/)
    assert.match(body, /source_order_submission_id is not null/)
  })

  test('is a trigger, so the service role is bound by it too', () => {
    assert.match(code, /create trigger order_document_versions_guard_trg\s*\n?\s*before insert or update on public\.order_document_versions/i)
    assert.match(code, /revoke execute on function public\.order_document_versions_guard\(\)\s*\n?\s*from public, anon, authenticated, service_role/i)
  })
})

// ── 4. THE SUBTLE ONE: the request must be SECURITY INVOKER ───────────────────

describe('the request is authorized by RLS, as the caller', () => {
  const body = fnBody('request_order_document_generation')

  test('request_order_document_generation is SECURITY INVOKER', () => {
    assert.match(body, /security\s+invoker/i)
    assert.ok(!/security\s+definer/i.test(body),
      'as a definer, can_view_order would be asked on behalf of the table owner, who bypasses RLS — and would authorize every Order in the business')
  })

  test('and the migration refuses to apply if it is ever changed to a definer', () => {
    assert.match(sql, /request_order_document_generation must be SECURITY INVOKER/)
  })

  test('it never selects or returns `*`, because claim_token is not readable', () => {
    // `select *` / `returning *` need SELECT on EVERY column, claim_token
    // included — under the caller's own privileges the statement is refused.
    assert.ok(!/select \* into/i.test(body), 'a rowtype fetch would be refused')
    assert.ok(!/returning \* into/i.test(body), 'a rowtype return would be refused')
  })

  test('it inserts EXACTLY the two columns a client may write', () => {
    assert.match(body, /insert into public\.order_document_versions \(order_id, version\)/i)
  })

  test('the two write policies both ask BOTH questions', () => {
    for (const policy of [
      'order_document_versions_request_insert',
      'order_document_versions_retry_update',
    ]) {
      const at = code.indexOf(`create policy "${policy}"`)
      assert.ok(at >= 0, `${policy} is missing`)
      const decl = code.slice(at, code.indexOf('comment on policy', at))
      assert.match(decl, /actor_has_module_permission\('orders', 'approve_order'\)/, policy)
      assert.match(decl, /can_view_order\(order_id\)/, policy)
    }
  })

  test('the retry policy admits ONLY a failed version, and only back to pending', () => {
    const at = code.indexOf('create policy "order_document_versions_retry_update"')
    const decl = code.slice(at, code.indexOf('comment on policy', at))
    assert.match(decl, /using \(?[\s\S]*?status = 'failed'/i)
    assert.match(decl, /with check \(?[\s\S]*?status = 'pending'/i)
    assert.match(decl, /last_error_code is null/)
  })

  test('the client-writable surface is five columns and no more', () => {
    assert.match(code, /grant insert \(order_id, version\) on public\.order_document_versions to authenticated/i)
    assert.match(code, /grant update \(status, last_error_code, last_error_message\) on public\.order_document_versions to authenticated/i)
    // No table-wide write, and no DELETE anywhere.
    assert.ok(!/grant (insert|update|delete)\s+on public\.order_document_versions/i.test(code))
    assert.ok(!/grant delete/i.test(code))
    assert.ok(!/for delete/i.test(code))
  })

  test('and the migration asserts that surface at apply time', () => {
    assert.match(sql, /the client-writable surface of order_document_versions is not the intended five columns/)
    assert.match(sql, /the write policies on order_document_versions are not the intended two/)
  })
})

// ── 5. The worker half ────────────────────────────────────────────────────────

describe('claim, complete and fail are the server\'s alone', () => {
  for (const fn of [
    'claim_order_document_generation',
    'complete_order_document_generation',
    'fail_order_document_generation',
  ]) {
    test(`${fn} is revoked from every client role`, () => {
      assert.match(code, new RegExp(`revoke execute on function public\\.${fn}\\([^)]*\\)\\s*\\n?\\s*from public, anon, authenticated`, 'i'))
      assert.ok(!new RegExp(`grant\\s+execute\\s+on\\s+function\\s+public\\.${fn}`, 'i').test(code),
        `${fn} must not be granted to anybody`)
    })
  }

  test('the claim is ONE atomic UPDATE, never a read then a write', () => {
    const body = fnBody('claim_order_document_generation')
    assert.ok(!/select[\s\S]{0,200}into[\s\S]{0,200}update/i.test(body),
      'a read-then-write claim has a window two workers can both pass through')
    assert.match(body, /update public\.order_document_versions d\s*\n?\s*set status\s*=\s*'claimed'/i)
    assert.match(body, /returning \* into v_row/i)
    assert.equal((body.match(/\bupdate\b/gi) ?? []).length, 1, 'exactly one UPDATE')
  })

  test('the eligibility test is IN the WHERE clause, which is what makes it atomic', () => {
    const body = fnBody('claim_order_document_generation')
    assert.match(body, /where[\s\S]*?d\.status = 'pending'/i)
    assert.match(body, /d\.status = 'claimed' and d\.claimed_at < now\(\) - public\.order_document_claim_ttl\(\)/i)
  })

  test('a takeover counts as an attempt, exactly as a fresh claim does', () => {
    assert.match(fnBody('claim_order_document_generation'), /attempt_count = d\.attempt_count \+ 1/i)
  })

  test('completing requires the MATCHING token and both files', () => {
    const body = fnBody('complete_order_document_generation')
    assert.match(body, /d\.claim_token = p_claim_token/)
    assert.match(body, /d\.status = 'claimed'/)
    assert.match(body, /ORDER_DOCUMENT_INCOMPLETE/)
    assert.match(body, /ORDER_DOCUMENT_NO_CLAIM/)
  })

  test('failing clears every file reference, so a partial upload stays unnamed', () => {
    const body = fnBody('fail_order_document_generation')
    for (const column of ['excel_path', 'pdf_path', 'excel_sha256', 'pdf_sha256', 'excel_bytes', 'pdf_bytes']) {
      assert.match(body, new RegExp(`${column}\\s*=\\s*null`), column)
    }
    assert.match(body, /d\.claim_token = p_claim_token/)
  })

  test('a superseded worker is refused without being told which way', () => {
    // "wrong token", "already released" and "taken over" are one answer to the
    // worker: this run does not own this version.
    for (const fn of ['complete_order_document_generation', 'fail_order_document_generation']) {
      assert.match(fnBody(fn), /if not found then[\s\S]{0,400}return jsonb_build_object/i, fn)
    }
  })
})

// ── 6. Nothing here moves an Order, a number or money ─────────────────────────

describe('generation is separate from approval, and stays separate', () => {
  test('no function in this migration writes public.orders', () => {
    assert.ok(!/(insert\s+into|update|delete\s+from)\s+(only\s+)?(public\.)?orders\b/i.test(code))
  })

  test('none of them touches a payment or an allocation', () => {
    for (const table of ['finance_payment_requests', 'finance_payment_allocations', 'payment_proof_attachments']) {
      assert.ok(!code.includes(table), `${table} must not appear in this migration`)
    }
  })

  test('none of them can allocate an Order number', () => {
    assert.ok(!/display_number/i.test(code))
    // The two allocator names DO appear — inside §8g, which is the assertion
    // that REFUSES to apply the migration if any of these functions ever
    // mentions them. So the property is "they appear only as a prohibition".
    for (const name of ['allocate_confirmed_order_number', 'confirmed_order_number_cycle']) {
      for (const at of [...code.matchAll(new RegExp(name, 'g'))].map(m => m.index ?? 0)) {
        const line = code.slice(code.lastIndexOf('\n', at) + 1, code.indexOf('\n', at))
        assert.match(line, /position\('.*' in v_def\)/,
          `${name} appears somewhere other than the §8 prohibition: ${line.trim()}`)
      }
    }
  })

  test('and the migration asserts all of that at apply time', () => {
    assert.match(sql, /writes an Order, a number or a payment; document generation must do none of those/)
  })
})

// ── 7. Publication, not location ──────────────────────────────────────────────

describe('what makes a stored object downloadable', () => {
  test('the predicate is "a READY version names it"', () => {
    const body = fnBody('can_view_order_document_object')
    assert.match(body, /from public\.order_document_versions d/i)
    assert.match(body, /d\.status = 'ready'/)
    assert.match(body, /d\.excel_path = p_object_name or d\.pdf_path = p_object_name/)
  })

  test('and it is SECURITY INVOKER, so the register\'s own RLS decides', () => {
    const body = fnBody('can_view_order_document_object')
    assert.match(body, /security\s+invoker/i)
    assert.ok(!/security\s+definer/i.test(body))
  })

  test('the storage rule no longer authorizes the orders/ prefix by location', () => {
    const at = code.indexOf('create policy "order_files_confirmed_order_select"')
    assert.ok(at >= 0)
    const decl = code.slice(at, code.indexOf('comment on policy', at))
    assert.match(decl, /can_view_order_document_object\(name\)/)
    assert.ok(!/order_file_order_id/.test(decl),
      'authorizing by path alone would make a failed attempt\'s half-upload downloadable')
  })

  test('and the PI branch is carried over verbatim', () => {
    const at = code.indexOf('create policy "order_files_confirmed_order_select"')
    const decl = code.slice(at, code.indexOf('comment on policy', at))
    assert.match(decl, /can_view_order_submission_via_order\(public\.order_file_submission_id\(name\)\)/)
    assert.match(decl, /bucket_id = 'order-files'/)
    assert.match(decl, /public\.module_entry_open\('orders'\)/)
  })

  test('order-files gains no client write and still has no UPDATE policy', () => {
    assert.ok(!/create policy[\s\S]{0,300}?on storage\.objects[\s\S]{0,120}?for\s+(insert|update|delete)/i.test(code))
    assert.match(sql, /An UPDATE policy exists on order-files; stored files would not be immutable/)
    assert.ok(!/insert\s+into\s+storage\.buckets/i.test(code), 'the bucket is not recreated')
    assert.ok(!/public\s*=\s*true/i.test(code), 'and is never made public')
  })

  test('the reserved prefix is still the one 20260908000000 named', () => {
    assert.match(read(SUBMISSIONS), /orders\/\{order_id\}\/versions\/\{version\}\/approved\.xlsx/)
  })
})

// ── 8. The two path implementations agree ─────────────────────────────────────

describe('SQL and TypeScript build the same key', () => {
  const ORDER = '11111111-1111-1111-1111-111111111111'

  test('the SQL prefix helper is the shape TypeScript builds', () => {
    const body = fnBody('order_document_version_prefix')
    assert.match(body, /'orders\/' \|\| p_order_id::text \|\| '\/versions\/' \|\| p_version::text/)
    assert.equal(orderDocumentVersionPrefix(ORDER, 1), `orders/${ORDER}/versions/1`)
  })

  test('the SQL attempt helper is the shape TypeScript builds', () => {
    const body = fnBody('order_document_attempt_path')
    assert.match(body, /'\/attempts\/' \|\| p_attempt::text \|\| '\/approved\.' \|\| p_kind/)
    assert.equal(
      orderDocumentAttemptPath(ORDER, 2, 3, 'xlsx'),
      `orders/${ORDER}/versions/2/attempts/3/approved.xlsx`)
  })

  test('both refuse an unknown kind and an impossible counter', () => {
    const body = fnBody('order_document_attempt_path')
    assert.match(body, /p_kind not in \('xlsx', 'pdf'\)/)
    assert.match(body, /p_version < 1 or p_attempt < 1/)
    assert.equal(orderDocumentAttemptPath(ORDER, 0, 1, 'pdf'), null)
    // @ts-expect-error — the type forbids it; the runtime must too.
    assert.equal(orderDocumentAttemptPath(ORDER, 1, 1, 'docx'), null)
  })

  test('the migration exercises both helpers at apply time', () => {
    assert.match(sql, /order_document_attempt_path does not build the attempt key/)
    assert.match(sql, /an attempt key no longer decodes to its Order/)
    assert.match(sql, /version prefixes are ambiguous/)
  })
})

// ── 9. The activity trail cannot be forged ────────────────────────────────────

describe('the four generation events', () => {
  test('are written by a TRIGGER, from the transition itself', () => {
    assert.match(code, /create trigger order_document_versions_log_trg\s*\n?\s*after insert or update on public\.order_document_versions/i)
  })

  test('and the writer is revoked from everybody, service role included', () => {
    assert.match(code, /revoke execute on function public\.log_order_document_event\(uuid, uuid, text, jsonb\)\s*\n?\s*from public, anon, authenticated, service_role/i)
    assert.match(code, /revoke execute on function public\.order_document_versions_log\(\)\s*\n?\s*from public, anon, authenticated, service_role/i)
  })

  test('the event names are a closed set, checked by the writer itself', () => {
    const body = fnBody('log_order_document_event')
    for (const event of [
      'document_generation_started', 'document_generation_ready',
      'document_generation_failed', 'document_generation_retried',
    ]) {
      assert.ok(body.includes(`'${event}'`), event)
    }
    assert.match(body, /ORDER_DOCUMENT_UNKNOWN_EVENT/)
  })

  test('a claim is deliberately NOT an event — a lease is not a business fact', () => {
    const body = fnBody('order_document_versions_log')
    assert.match(body, /return null;\s*\n?\s*end if;/)
    assert.ok(!body.includes("'claimed'") || /else\s*\n\s*return null/.test(body))
  })
})

// ── 10. The behavioural script exists and covers the audiences ────────────────

describe('the assertions script', () => {
  const script = lf(readFileSync(join(process.cwd(), 'supabase', 'tests', 'order_document_generation_assertions.sql'), 'utf8'))

  test('exists and rolls back', () => {
    assert.match(script, /^\\set ON_ERROR_STOP on/m)
    assert.match(script, /\nrollback;\s*$/)
    assert.match(script, /ALL ASSERTIONS PASSED/)
  })

  test('runs the client half under the authenticated role, not as postgres', () => {
    // The single most important thing about how this script is run: as
    // `postgres` the RLS that authorizes the request is bypassed entirely.
    assert.match(script, /set local role authenticated/)
    assert.match(script, /`postgres` bypasses\s*\n?--\s*row security/i)
  })

  test('covers every audience the Order predicate admits or refuses', () => {
    for (const claim of [
      'an admin may view the Order',
      'the requester may view the Order',
      'the assigned user may view the Order',
      'an orders.view_all holder may view the Order',
      'the operations team may view the Order',
      'orders.approve_order alone must NOT confer Order visibility',
    ]) {
      assert.ok(script.includes(claim), `the script must prove: ${claim}`)
    }
  })

  test('covers the guarantee that a partial upload is not downloadable', () => {
    assert.ok(script.includes('CANNOT read the half-upload of a failed attempt'))
    assert.ok(script.includes("PI-review access alone must NOT reach a Confirmed Order''s documents"))
  })

  test('covers the claim, the takeover and the superseded worker', () => {
    for (const claim of [
      'a second worker cannot take a live claim',
      'a claim older than the ttl may be taken over',
      // Doubled apostrophes: these are SQL string literals in the script.
      "a superseded worker''s completion is refused",
      'a version cannot become ready with only the workbook',
    ]) {
      assert.ok(script.includes(claim), `the script must prove: ${claim}`)
    }
  })

  test('covers that a retry moves no Order, no number and no money', () => {
    for (const claim of [
      'no Order was created by requesting, claiming, failing or retrying',
      'and no Order number was allocated',
      'and no payment allocation was created or moved',
      'a retry does NOT advance the user-facing version',
    ]) {
      assert.ok(script.includes(claim), `the script must prove: ${claim}`)
    }
  })
})
