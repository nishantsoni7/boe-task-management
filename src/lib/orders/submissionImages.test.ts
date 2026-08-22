/**
 * Repository check: the phase 3B migration keeps what phase 3B exists to
 * establish, and takes nothing away from phase 2.
 *
 * WHY A REPO CHECK. Every promise below lives only in SQL and every one of them
 * fails SILENTLY if a later change relaxes it:
 *
 *   1. An image row cannot name another submission or another product line. The
 *      control is a composite foreign key plus a derived-path CHECK — not RPC
 *      correctness — because one bug in a server route would otherwise be
 *      enough to attach a product's photograph to somebody else's order.
 *   2. At most one representative image per line, always at position 0.
 *      Customization images are optional and unlimited.
 *   3. A cost's number, meaning and wording cannot contradict each other, and
 *      "included" is never stored as "not applicable".
 *   4. replace_order_submission_parse is STILL service-role only after being
 *      restated. Restating a function is exactly how a grant gets lost.
 *   5. The new table is readable by the people who may already see the
 *      submission and writable by no client role at all.
 *   6. Storage is not widened. Nested image keys work because the existing
 *      policies decode segment 2 — not because a new policy was added.
 *
 * TypeScript sees none of this. These tests read the migrations themselves.
 *
 * Reads repository files only. No database, no network.
 *
 * Run:
 *   npx tsx --test src/lib/orders/submissionImages.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations')

/** Normalised to LF: a Windows checkout stores CRLF and every `\n` below would
 *  otherwise silently match nothing. */
const lf = (s: string) => s.replace(/\r\n/g, '\n')

function migrationByContent(pattern: RegExp, what: string): { file: string; sql: string } {
  const candidates = readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .map(file => ({ file, sql: lf(readFileSync(join(MIGRATIONS_DIR, file), 'utf8')) }))
    .filter(({ sql }) => pattern.test(sql))

  assert.equal(candidates.length, 1, `expected exactly one migration ${what}`)
  return candidates[0]
}

const phase3b = migrationByContent(
  /create table public\.order_submission_item_images\b/i,
  'creating public.order_submission_item_images',
)
/** The one migration allowed to restate the lease. See the exception below. */
const CHANGE_PI = '20261003000000_order_submission_change_pi.sql'

const phase2 = migrationByContent(
  /create table public\.order_submissions\b/i,
  'creating public.order_submissions',
)

/** The migration with `--` comments removed: the prose deliberately names the
 *  things this phase must not do in order to explain why it does not do them. */
const code = phase3b.sql.replace(/--[^\n]*/g, '')

// ══ 1. Ordering and additivity ═══════════════════════════════════════════════

describe('the migration itself', () => {
  test('comes after phase 2, and anything later is additive', () => {
    const all = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort()
    assert.ok(phase3b.file > phase2.file, 'must sort after the phase 2 migration')

    // Later migrations are allowed — Phase A review is one — but none of them
    // may take over what this file owns. The image table, its constraints and
    // the lease functions are defined HERE and nowhere else.
    for (const file of all.filter(f => f > phase3b.file)) {
      const later = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
      assert.ok(!/create table public\.order_submission_item_images\b/.test(later),
        `${file} must not redefine the image table`)
      // THE ONE DOCUMENTED EXCEPTION, and it is narrower than it looks.
      //
      // 20261003000000 re-emits the lease so an ACTIVE ADMIN can take one on a
      // PI that has left draft — without that, the Change PI authority it adds
      // would be unreachable, because the lease refused first. It changes ONE
      // line: which assert it calls. changePiContinuity.test.ts holds the two
      // texts together by undoing that swap and requiring this file's version
      // back, so the TTL, the takeover rule and the 55P03 busy signal cannot
      // drift here without failing there.
      //
      // The exception is by NAME. A second file redefining the lease still
      // fails, which is what this assertion was written to catch.
      if (file !== CHANGE_PI) {
        assert.ok(!later.includes('begin_order_submission_processing('),
          `${file} must not redefine the processing lease`)
      }
    }
  })

  test('does not edit the phase 2 file', () => {
    assert.notEqual(phase3b.file, phase2.file)
    // Phase 2 still contains its own original definitions.
    assert.ok(/create table public\.order_submission_items\b/.test(phase2.sql))
  })

  test('drops nothing', () => {
    const drops = [...code.matchAll(/drop\s+(table|column|constraint|policy|function|index)\s+/gi)]
      .map(m => m[0].trim().toLowerCase())
    assert.deepEqual(drops, [], 'phase 3B is additive; the legacy image columns stay')
  })

  test('keeps the legacy representative-image columns on items', () => {
    assert.ok(!/drop column\s+image_storage_path/i.test(code))
    // …and keeps writing them, so anything still reading them sees the truth.
    assert.ok(/image_storage_path/.test(code), 'the legacy column is still populated')
  })

  test('creates no order and allocates no number', () => {
    for (const forbidden of [
      /insert\s+into\s+public\.orders\b/i,
      /display_number/i,
      /allocate_confirmed_order_number/i,
      /nextval/i,
    ]) {
      assert.ok(!forbidden.test(code), `phase 3B must not touch order numbering: ${forbidden}`)
    }
  })

  test('performs no approval, rejection or payment', () => {
    assert.ok(!/status\s*=\s*'approved'/.test(code))
    assert.ok(!/status\s*=\s*'rejected'/.test(code))
    assert.ok(!/finance_payment/i.test(code))
  })
})

// ══ 2. The normalized image table ════════════════════════════════════════════

describe('order_submission_item_images', () => {
  test('is created with the columns the model needs', () => {
    for (const column of [
      'submission_id', 'item_id', 'role', 'position', 'storage_path',
      'mime_type', 'sha256', 'source_media_path', 'anchor_row', 'created_at',
    ]) {
      assert.ok(
        new RegExp(`\\n\\s+${column}\\s`).test(code),
        `${column} must exist on the new table`,
      )
    }
  })

  test('role is constrained to the two the business has', () => {
    assert.ok(/check \(role in \('representative', 'customization'\)\)/.test(code))
  })

  test('a representative image is always slot zero', () => {
    assert.ok(/role <> 'representative' or position = 0/.test(code))
  })

  test('at most one representative image per item, enforced by an index', () => {
    assert.ok(/create unique index order_submission_item_images_one_representative/.test(code))
    assert.ok(/on public\.order_submission_item_images \(item_id\)\s*\n\s*where role = 'representative'/.test(code))
  })

  test('customization images are unlimited but cannot collide in a slot', () => {
    assert.ok(/unique \(item_id, role, position\)/.test(code))
    // No rule anywhere caps the number of customization images.
    assert.ok(!/customization.*count.*<=|<=.*customization_count/i.test(code))
  })

  test('the item foreign key is COMPOSITE, so item and submission must agree', () => {
    assert.ok(/foreign key \(item_id, submission_id\)/.test(code))
    assert.ok(/references public\.order_submission_items\(id, submission_id\)/.test(code))
    // Which requires the composite unique key this migration adds.
    assert.ok(/add constraint order_submission_items_id_submission_key unique \(id, submission_id\)/.test(code))
  })

  test('both foreign keys cascade, so deleting a draft leaves no orphan rows', () => {
    const fks = [...code.matchAll(/references public\.order_submission[^\n]*on delete cascade/g)]
    assert.ok(fks.length >= 2, 'submission and item references must both cascade')
  })

  test('the storage path is DERIVED from the row, not merely conventional', () => {
    // submissions/{sid}/images/{item_id}/{role}/{position}-{sha256}.{ext}
    assert.ok(/storage_path ~ \(/.test(code))
    assert.ok(/'\^submissions\/' \|\| submission_id::text/.test(code))
    assert.ok(/'\/images\/'\s*\|\| item_id::text/.test(code))
    assert.ok(/\|\| role/.test(code))
    assert.ok(/\|\| position::text/.test(code))
    assert.ok(/\\\.\(png\|jpg\|jpeg\|webp\)\$/.test(code))
  })

  test('the path is CONTENT-ADDRESSED, so an object can hold only one set of bytes', () => {
    assert.ok(/\|\| '-'\s+\|\| sha256/.test(code),
      'the row’s own hash is part of the key it claims')
  })

  test('a row whose key names a different hash is refused', () => {
    // The constraint rebuilds the key from sha256, so key and bytes cannot
    // drift apart. Modelled here the way the database evaluates it.
    const sid = '11111111-2222-4333-8444-555555555555'
    const item = '0be5036e-96b6-8fbd-ba67-a83a8e46f5a9'
    const hash = 'a'.repeat(64)
    const other = 'b'.repeat(64)
    const pattern = (h: string) =>
      new RegExp(`^submissions/${sid}/images/${item}/representative/0-${h}\\.(png|jpg|jpeg|webp)$`)

    const key = `submissions/${sid}/images/${item}/representative/0-${hash}.png`
    assert.ok(pattern(hash).test(key), 'the honest row is accepted')
    assert.ok(!pattern(other).test(key), 'a row claiming other bytes is refused')
  })

  test('the hash column admits only lowercase hex, so no metacharacter reaches the pattern', () => {
    assert.ok(/sha256 ~ '\^\[0-9a-f\]\{64\}\$'/.test(code))
  })

  test('the submit-time path check re-derives the hash too', () => {
    assert.ok(/\|\| '-' \|\| m\.sha256/.test(code))
  })

  test('every stored path is unique across the whole table', () => {
    assert.ok(/storage_path\s+text\s+not null unique/.test(code))
  })

  test('the mime type and hash are constrained', () => {
    assert.ok(/mime_type in \('image\/png', 'image\/jpeg', 'image\/webp'\)/.test(code))
    assert.ok(/sha256 ~ '\^\[0-9a-f\]\{64\}\$'/.test(code))
  })

  test('source_media_path is provenance only and is nullable', () => {
    assert.ok(/source_media_path text,/.test(code), 'not NOT NULL — a shared media part is normal')
  })
})

// ══ 3. No client may write it ════════════════════════════════════════════════

describe('the new table is read-only to every client role', () => {
  test('RLS is enabled', () => {
    assert.ok(/alter table public\.order_submission_item_images enable row level security/.test(code))
  })

  test('write privileges are revoked, not merely unpoliced', () => {
    assert.ok(
      /revoke insert, update, delete, truncate, references, trigger\s*\n\s*on public\.order_submission_item_images from authenticated, anon/.test(code),
    )
  })

  test('only SELECT is granted', () => {
    assert.ok(/grant select on public\.order_submission_item_images to authenticated/.test(code))
    assert.ok(!/grant (insert|update|delete|all)[^\n]*order_submission_item_images/i.test(code))
  })

  test('there is exactly one permissive policy, and it is a SELECT', () => {
    const policies = [...code.matchAll(/create policy "([^"]+)" on public\.order_submission_item_images\s*\n\s*(as restrictive )?for (\w+)/g)]
    const permissive = policies.filter(m => !m[2])
    assert.equal(permissive.length, 1, 'one permissive policy')
    assert.equal(permissive[0][3], 'select')
  })

  test('visibility follows the submission, through the phase 2 predicate', () => {
    assert.ok(/using \(public\.can_view_order_submission\(submission_id\)\)/.test(code))
  })

  test('the module entry gate is RESTRICTIVE, so it ANDs rather than ORs', () => {
    assert.ok(
      /create policy "order_submission_item_images_module_entry_gate" on public\.order_submission_item_images\s*\n\s*as restrictive for all to authenticated/.test(code),
    )
  })

  test('the migration asserts all of this at apply time', () => {
    assert.ok(/RLS is not enabled on order_submission_item_images/.test(phase3b.sql))
    assert.ok(/Unexpected client write policies on order_submission_item_images/.test(phase3b.sql))
    assert.ok(/order_submission_item_images is writable by a client role/.test(phase3b.sql))
  })
})

// ══ 4. Commercial meaning ════════════════════════════════════════════════════

describe('fabric and packing cost meaning', () => {
  test('four meanings are stored, matching the parser', () => {
    for (const column of ['fabric_cost_meaning', 'packing_cost_meaning']) {
      assert.ok(
        new RegExp(`${column}\\s+text not null default 'numeric'`).test(code),
        `${column} must exist`,
      )
      assert.ok(
        new RegExp(`check \\(${column} in \\('numeric', 'not_applicable', 'included', 'text'\\)\\)`).test(code),
        `${column} must be constrained to the four parser meanings`,
      )
    }
  })

  test('the source wording is kept alongside', () => {
    assert.ok(/fabric_cost_text\s+text/.test(code))
    assert.ok(/packing_cost_text\s+text/.test(code))
  })

  test('number, meaning and text cannot contradict each other', () => {
    for (const cost of ['fabric', 'packing']) {
      const constraint = new RegExp(
        `constraint order_submissions_${cost}_cost_meaning_consistent check \\(\\s*\\n\\s*case ${cost}_cost_meaning`,
      )
      assert.ok(constraint.test(code), `${cost} needs a consistency constraint`)
    }
  })

  test('included keeps its wording; not_applicable does not require one', () => {
    assert.ok(/when 'included'       then fabric_cost = 0 and coalesce\(btrim\(fabric_cost_text\), ''\) <> ''/.test(code))
    assert.ok(/when 'not_applicable' then fabric_cost = 0 and fabric_cost_text is null/.test(code))
  })

  test('text means no amount could be inferred, and the words are required', () => {
    assert.ok(/when 'text'           then fabric_cost is null and coalesce\(btrim\(fabric_cost_text\), ''\) <> ''/.test(code))
  })

  test('included is never collapsed into not_applicable', () => {
    // Two distinct literals, and no expression maps one onto the other.
    assert.ok(code.includes("'included'"))
    assert.ok(code.includes("'not_applicable'"))
    assert.ok(!/included'\s*then[^\n]*not_applicable/.test(code))
  })

  test('only the two "as per actual" rows get a meaning', () => {
    for (const other of ['discount', 'subtotal', 'gst', 'grand_total', 'total_before_gst']) {
      assert.ok(
        !new RegExp(`${other}_meaning`).test(code),
        `${other} must not acquire a meaning column`,
      )
    }
  })

  test('transportation keeps its existing amount/text pair', () => {
    assert.ok(!/transportation_meaning/.test(code))
    assert.ok(/transportation_amount/.test(code) && /transportation_text/.test(code))
  })
})

// ══ 5. The service-role-only write path, after being restated ════════════════

describe('replace_order_submission_parse stays unreachable from a browser', () => {
  test('it is restated in this migration', () => {
    assert.ok(/create or replace function public\.replace_order_submission_parse\(/.test(code))
  })

  test('execute is revoked from every client role and granted to service_role', () => {
    assert.ok(
      /revoke execute on function public\.replace_order_submission_parse\(uuid, uuid, jsonb\)\s*\n\s*from public, anon, authenticated;/.test(code),
      'authenticated must be revoked alongside public and anon',
    )
    assert.ok(
      /grant  execute on function public\.replace_order_submission_parse\(uuid, uuid, jsonb\)\s*\n\s*to service_role;/.test(code),
    )
  })

  test('the migration asserts the grant at apply time, both directions', () => {
    assert.ok(/replace_order_submission_parse must not be executable by a client role/.test(phase3b.sql))
    assert.ok(/replace_order_submission_parse must be executable by service_role/.test(phase3b.sql))
  })

  test('the actor is still re-derived from the database, not trusted', () => {
    assert.ok(/perform public\.assert_order_submission_editor\(p_submission_id, p_actor_id\)/.test(code))
  })

  test('the submission row is locked before anything is written', () => {
    assert.ok(/from public\.order_submissions s\s*\n\s*where s\.id = p_submission_id\s*\n\s*for update/.test(code))
  })

  test('an image naming a foreign product line aborts the whole replacement', () => {
    assert.ok(/ORDER_SUBMISSION_IMAGE_ITEM_UNKNOWN/.test(code))
    assert.ok(/where i\.id = nullif\(img\.value ->> 'item_id', ''\)::uuid\s*\n\s*and i\.submission_id = p_submission_id/.test(code))
  })

  test('items are replaced wholesale, so a stale line cannot survive', () => {
    assert.ok(/delete from public\.order_submission_items where submission_id = p_submission_id/.test(code))
  })

  test('the status is never advanced by a parse replacement', () => {
    // v_status is read and written back unchanged into the activity log.
    assert.ok(/'parse_replaced', v_status, v_status/.test(code))
    assert.ok(!/update public\.order_submissions\s+set status/.test(
      code.slice(code.indexOf('replace_order_submission_parse'), code.indexOf('submit_order_submission')),
    ))
  })

  test('it logs what it did, in counts', () => {
    assert.ok(/'representative_image_count', v_rep_count/.test(code))
    assert.ok(/'customization_image_count',  v_cust_count/.test(code))
  })
})

// ══ 5a. Replay recognition ═══════════════════════════════════════════════════

describe('a replayed attempt writes no false history', () => {
  test('the last trusted payload is fingerprinted on the submission', () => {
    assert.ok(/add column parse_fingerprint text/.test(code))
    assert.ok(/parse_fingerprint is null or parse_fingerprint ~ '\^\[0-9a-f\]\{64\}\$'/.test(code))
  })

  test('the previous fingerprint is read under the same row lock as the status', () => {
    // Status, fingerprint and lease token all come from the one locked read.
    assert.ok(/select s\.status, s\.parse_fingerprint, s\.processing_token/.test(code))
    assert.ok(/into v_status, v_previous, v_held/.test(code))
    assert.ok(/for update/.test(code), 'two concurrent replays cannot both be "first"')
  })

  test('an unchanged payload logs nothing', () => {
    assert.ok(/if not v_unchanged then/.test(code))
    const logAt = code.indexOf('if not v_unchanged then')
    const block = code.slice(logAt, logAt + 700)
    assert.ok(block.includes('log_order_submission_activity'))
  })

  test('a genuinely different parse IS logged', () => {
    assert.ok(/'parse_replaced', v_status, v_status/.test(code))
  })

  test('the replacement itself still runs, so a replay is idempotent not skipped', () => {
    const unchangedAt = code.indexOf('v_unchanged := v_fingerprint is not null')
    const deleteAt = code.indexOf('delete from public.order_submission_items')
    assert.ok(deleteAt > unchangedAt, 'the write happens regardless; only the audit entry is suppressed')
  })

  test('the caller is told whether anything changed', () => {
    assert.ok(/'unchanged', v_unchanged/.test(code))
  })

  test('a missing fingerprint is never treated as a match', () => {
    assert.ok(/v_fingerprint is not null and v_previous is not null and v_fingerprint = v_previous/.test(code))
  })
})

// ══ 5b. The processing lease ═════════════════════════════════════════════════

describe('one processor at a time, per submission', () => {
  test('the lease columns exist and move together', () => {
    assert.ok(/add column processing_token\s+uuid/.test(code))
    assert.ok(/add column processing_started_at timestamptz/.test(code))
    assert.ok(/\(processing_token is null and processing_started_at is null\)/.test(code))
    assert.ok(/\(processing_token is not null and processing_started_at is not null\)/.test(code))
  })

  test('both lease functions exist with a fixed search_path', () => {
    for (const fn of ['begin_order_submission_processing', 'finish_order_submission_processing']) {
      assert.ok(new RegExp(`create or replace function public\\.${fn}\\(`).test(code), fn)
    }
    const definitions = code.match(/set search_path = public, pg_temp/g) ?? []
    assert.ok(definitions.length >= 4, 'every SECURITY DEFINER here pins its search_path')
  })

  test('neither is executable by a client role', () => {
    assert.ok(/revoke execute on function public\.begin_order_submission_processing\(uuid, uuid, uuid\)\s*\n\s*from public, anon, authenticated;/.test(code))
    assert.ok(/revoke execute on function public\.finish_order_submission_processing\(uuid, uuid\)\s*\n\s*from public, anon, authenticated;/.test(code))
  })

  test('both are granted to service_role alone', () => {
    assert.ok(/grant  execute on function public\.begin_order_submission_processing\(uuid, uuid, uuid\)\s*\n\s*to service_role;/.test(code))
    assert.ok(/grant  execute on function public\.finish_order_submission_processing\(uuid, uuid\)\s*\n\s*to service_role;/.test(code))
  })

  test('acquiring locks the row and re-derives the actor', () => {
    const begin = code.slice(code.indexOf('function public.begin_order_submission_processing'))
    assert.ok(begin.includes('for update'))
    assert.ok(begin.includes('perform public.assert_order_submission_editor(p_submission_id, p_actor_id)'),
      'active, not deleted, orders.create, owner, editable — all re-derived')
  })

  test('a second live processor is refused with a retryable busy error', () => {
    assert.ok(/ORDER_SUBMISSION_PROCESSING_BUSY/.test(code))
    assert.ok(/using errcode = '55P03'/.test(code), 'lock_not_available: busy, not broken')
  })

  test('takeover is possible only after the expiry', () => {
    assert.ok(/processing_started_at > now\(\) - public\.order_submission_processing_ttl\(\)/.test(code))
    assert.ok(/interval '15 minutes'/.test(code))
    assert.ok(/v_took_over := true/.test(code))
  })

  test('releasing requires the token that holds the lease', () => {
    const finish = code.slice(code.indexOf('function public.finish_order_submission_processing'))
    assert.ok(finish.includes("v_sub.processing_token <> p_token"))
    assert.ok(finish.includes("'reason', 'not_owner'"))
    assert.ok(finish.includes("'reason', 'not_held'"))
  })

  test('releasing returns rather than raises, so a finally cannot mask an error', () => {
    const start = code.indexOf('function public.finish_order_submission_processing')
    const finish = code.slice(start, code.indexOf('revoke execute on function public.finish_order_submission_processing', start))
    assert.ok(!finish.includes('raise exception'), 'a release problem must not replace the real failure')
    assert.ok(finish.includes("jsonb_build_object('released', false"))
  })

  test('a null token can neither acquire nor release', () => {
    assert.ok(/ORDER_SUBMISSION_PROCESSING_TOKEN_REQUIRED/.test(code))
    assert.ok(/if p_token is null or v_sub\.processing_token <> p_token then/.test(code))
  })

  test('no parse replacement happens outside the lease', () => {
    assert.ok(/ORDER_SUBMISSION_PROCESSING_NOT_HELD/.test(code))
    assert.ok(/if v_held is null or v_token is null or v_held <> v_token then/.test(code))
  })

  test('the held token is read under the SAME row lock as the status', () => {
    assert.ok(/select s\.status, s\.parse_fingerprint, s\.processing_token/.test(code))
    assert.ok(/into v_status, v_previous, v_held/.test(code))
  })

  test('the token travels in the payload, so no signature was forked', () => {
    assert.ok(/p_payload ->> 'processing_token'/.test(code))
    // Still the same three-argument function; no token-free overload exists.
    assert.ok(!/replace_order_submission_parse\(uuid, uuid, jsonb, uuid\)/.test(code))
  })

  test('the migration asserts the grants and the constraint at apply time', () => {
    assert.ok(/the processing lease functions must not be executable by a client role/.test(phase3b.sql))
    assert.ok(/the processing lease functions must be executable by service_role/.test(phase3b.sql))
    assert.ok(/the processing lease consistency constraint is missing/.test(phase3b.sql))
  })

  test('the lease grants no new authority — it only excludes a second processor', () => {
    const begin = code.slice(
      code.indexOf('function public.begin_order_submission_processing'),
      code.indexOf('function public.finish_order_submission_processing'),
    )
    assert.ok(!begin.includes('status ='), 'acquiring never advances a submission')
    assert.ok(!begin.includes('order_id'), 'and never links an order')
  })
})

// ══ 6. Submission validation now uses the normalized table ═══════════════════

describe('submit_order_submission validates against the child table', () => {
  test('it is restated here', () => {
    assert.ok(/create or replace function public\.submit_order_submission\(p_submission_id uuid\)/.test(code))
  })

  test('exactly one representative image per product line is required', () => {
    assert.ok(/from public\.order_submission_item_images m\s*\n\s*where m\.item_id = i\.id and m\.role = 'representative'\s*\n\s*\) <> 1/.test(code))
    assert.ok(/do not have exactly one representative image/.test(code))
  })

  test('customization images are NOT required', () => {
    assert.ok(!/customization[^\n]*required/i.test(code))
  })

  test('every recorded image must name this submission and its own item', () => {
    assert.ok(/m\.storage_path !~/.test(code))
    assert.ok(/'\^submissions\/' \|\| p_submission_id::text \|\| '\/images\/' \|\| m\.item_id::text/.test(code))
    assert.ok(/\|\| '\/' \|\| m\.role \|\| '\/' \|\| m\.position::text/.test(code))
  })

  test('every recorded image must exist in storage as a real image', () => {
    assert.ok(/from storage\.objects o\s*\n\s*where o\.bucket_id = 'order-files'\s*\n\s*and o\.name = m\.storage_path/.test(code))
    assert.ok(/o\.metadata ->> 'mimetype' in \('image\/png', 'image\/jpeg', 'image\/webp'\)/.test(code))
  })

  test('the workbook checks from phase 2 are all still there', () => {
    for (const check of [
      'ORDER_SUBMISSION_BAD_WORKBOOK_PATH',
      'ORDER_SUBMISSION_WORKBOOK_NOT_STORED',
      'ORDER_SUBMISSION_WORKBOOK_NOT_XLSX',
      'ORDER_SUBMISSION_BLOCKED',
    ]) {
      assert.ok(code.includes(check), `${check} must survive the restatement`)
    }
  })

  test('the authorization model is unchanged', () => {
    assert.ok(/v_actor      uuid := public\.assert_order_submission_actor\(\)/.test(code))
    assert.ok(/public\.actor_has_module_permission\('orders', 'create'\)/.test(code))
    assert.ok(/public\.can_edit_order_submission\(p_submission_id\)/.test(code))
  })

  test('it stays callable by authenticated, and not by anon', () => {
    assert.ok(/revoke execute on function public\.submit_order_submission\(uuid\) from public, anon;/.test(code))
    assert.ok(/grant  execute on function public\.submit_order_submission\(uuid\) to authenticated;/.test(code))
  })

  test('the item completeness check no longer demands the legacy column', () => {
    assert.ok(/and \(item_sequence is null or product_name is null\)/.test(code))
  })
})

// ══ 7. Storage is not widened ════════════════════════════════════════════════

describe('storage access is unchanged', () => {
  test('this migration creates no storage policy at all', () => {
    assert.ok(!/create policy[^\n]*on storage\.objects/i.test(code),
      'nested image keys already decode to the same submission id')
  })

  test('it does not alter the bucket', () => {
    assert.ok(!/insert into storage\.buckets/i.test(code))
    assert.ok(!/update storage\.buckets/i.test(code))
  })

  test('it does not redefine the path decoder the policies depend on', () => {
    assert.ok(!/create or replace function public\.order_file_submission_id/.test(code))
  })

  test('the phase 2 decoder reads only segment 2, so nested keys already work', () => {
    // submissions/{sid}/images/{item}/representative/0.png → segment 2 is still
    // the submission id, and the reserved orders/ prefix still decodes to null.
    assert.ok(/split_part\(p_object_name, '\/', 1\) <> 'submissions'/.test(phase2.sql))
    assert.ok(/split_part\(p_object_name, '\/', 2\)/.test(phase2.sql))
  })

  test('no client write predicate is loosened', () => {
    assert.ok(!/create or replace function public\.can_write_order_submission_file/.test(code))
    assert.ok(!/create or replace function public\.can_view_order_submission/.test(code))
  })
})
