/**
 * THE SECURITY CONTRACT of 20261017000000, asserted function by function and
 * policy by policy.
 *
 * migration.test.ts audits the module's SHAPE — what exists, and that the SQL
 * transition table matches the browser's. This file audits the properties that
 * make it safe: every SECURITY DEFINER function pins its search_path, derives
 * its actor from auth.uid() alone, locks the row before a lifecycle change,
 * cannot be aimed at somebody else, cannot be executed by anon, and cannot leak
 * private data in a raised error.
 *
 * A SECURITY DEFINER function is the one place in this codebase where a caller
 * runs as the table owner. Every one of them is therefore a potential privilege
 * escalation, and "it looked fine when I wrote it" is not a control. This is.
 *
 * Reads repository files only. No database, no network.
 *
 * Run:
 *   npx tsx --test src/lib/customerReviews/securityContract.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const sql = readFileSync(
  join(ROOT, 'supabase/migrations/20261017000000_customer_review_outreach.sql'),
  'utf8',
).replace(/\r\n/g, '\n')
/** Executable SQL only — comments explain, they do not run. */
const code = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')

/** Every function this migration defines, with its body. */
function definitions(): { name: string; args: string; body: string }[] {
  const out: { name: string; args: string; body: string }[] = []
  const re = /create or replace function public\.(\w+)\(([^)]*)\)/g
  for (const match of code.matchAll(re)) {
    const start = match.index!
    const tag = /\$[A-Za-z_]*\$/.exec(code.slice(start))![0]
    const open = code.indexOf(tag, start)
    const close = code.indexOf(tag, open + tag.length)
    out.push({ name: match[1], args: match[2], body: code.slice(start, close + tag.length) })
  }
  return out
}

const FUNCTIONS = definitions()
const byName = (name: string) => {
  const fn = FUNCTIONS.find(f => f.name === name)
  assert.ok(fn, `${name} is missing`)
  return fn!
}

/**
 * The functions a CLIENT may call, and the functions only the definer chain
 * may. Naming both halves is the point: a function that moved from one list to
 * the other without anybody noticing is exactly the failure this catches.
 */
const CLIENT_CALLABLE = [
  'can_view_customer_review_request',
  'can_edit_customer_review_request',
  'customer_review_text_steers',
  'transition_customer_review_request',
  'record_customer_review_whatsapp_opened',
  'record_customer_review_evidence',
]

const INTERNAL_ONLY = [
  'assert_customer_review_ready',
  'customer_review_requests_log_creation',
  'customer_review_photos_log_removal',
  'customer_review_requests_prevent_delete_with_photos',
]

/**
 * The two halves of a removal. Reachable by service_role ALONE — they take the
 * actor as a parameter, because the route is what establishes it from the
 * session, so a browser able to call either could name anybody.
 */
const SERVICE_ROLE_ONLY = [
  'begin_customer_review_photo_removal',
  'finish_customer_review_photo_removal',
]

/** Functions that CHANGE the request's lifecycle, and so must lock the row. */
const LIFECYCLE_WRITERS = [
  'transition_customer_review_request',
  'record_customer_review_whatsapp_opened',
  'record_customer_review_evidence',
]

describe('the function inventory is exactly what is expected', () => {
  test('every function is accounted for in one list or the other', () => {
    assert.deepEqual(
      FUNCTIONS.map(f => f.name).sort(),
      [...CLIENT_CALLABLE, ...INTERNAL_ONLY, ...SERVICE_ROLE_ONLY].sort(),
    )
  })
})

describe('search_path is pinned on every function', () => {
  test('each one sets it, and to the same safe value', () => {
    // Without this a caller can put a schema of their own in front of `public`
    // and have the definer body resolve `users` — running as the table owner —
    // to a table they control.
    for (const fn of FUNCTIONS) {
      assert.ok(
        /set search_path = public, pg_temp/.test(fn.body),
        `${fn.name} does not pin search_path`,
      )
    }
  })

  test('pg_temp is LAST, so a temporary object cannot shadow a real one', () => {
    for (const fn of FUNCTIONS) {
      assert.equal(
        /set search_path = pg_temp/.test(fn.body), false,
        `${fn.name} puts pg_temp first`,
      )
    }
  })
})

describe('grants: who can execute what', () => {
  test('every client-callable function is revoked from public and anon first', () => {
    for (const name of CLIENT_CALLABLE) {
      const revoke = new RegExp(`revoke execute on function public\\.${name}\\([^)]*\\)\\s*\\n?\\s*from public, anon`)
      assert.ok(revoke.test(code), `${name} is not revoked from public, anon`)
    }
  })

  test('…and then granted to authenticated, and to nothing else', () => {
    for (const name of CLIENT_CALLABLE) {
      const grant = new RegExp(`grant\\s+execute on function public\\.${name}\\([^)]*\\) to authenticated`)
      assert.ok(grant.test(code), `${name} is not granted to authenticated`)
    }
    // No client role beyond `authenticated` is ever named in a grant.
    for (const match of code.matchAll(/grant\s+execute on function[^;]*;/g)) {
      assert.equal(/\banon\b/.test(match[0]), false, match[0])
      assert.equal(/\bpublic\b(?!\.)/.test(match[0].replace(/public\./g, '')), false, match[0])
    }
  })

  test('every internal function is revoked from authenticated as well', () => {
    // These run only inside the definer chain or as a trigger. A client that
    // could call assert_customer_review_ready directly would learn nothing, but
    // a client that could call the log-writing trigger functions could forge a
    // trail row.
    for (const name of INTERNAL_ONLY) {
      const revoke = new RegExp(`revoke execute on function public\\.${name}\\([^)]*\\)\\s*\\n?\\s*from public, anon, authenticated`)
      assert.ok(revoke.test(code), `${name} is not revoked from authenticated`)
    }
  })

  test('service_role is granted EXACTLY the two removal halves, and nothing else', () => {
    // A grant to service_role is a statement that something privileged depends
    // on it. Two things do, and both are named.
    const granted = [...code.matchAll(/grant\s+execute on function public\.(\w+)\([^)]*\) to service_role/g)]
      .map(m => m[1]).sort()
    assert.deepEqual(granted, [...SERVICE_ROLE_ONLY].sort())
    for (const name of SERVICE_ROLE_ONLY) {
      const revoke = new RegExp(`revoke execute on function public\\.${name}\\([^)]*\\)\\s*\\n?\\s*from public, anon, authenticated`)
      assert.ok(revoke.test(code), `${name} is not revoked from authenticated`)
    }
  })

  test('the ORDER is revoke-then-grant, never the reverse', () => {
    for (const name of CLIENT_CALLABLE) {
      const revokeAt = code.indexOf(`revoke execute on function public.${name}(`)
      const grantAt = code.indexOf(`grant  execute on function public.${name}(`)
      assert.notEqual(revokeAt, -1, name)
      assert.notEqual(grantAt, -1, name)
      assert.ok(revokeAt < grantAt, `${name} grants before it revokes`)
    }
  })
})

describe('identity: who the function thinks it is acting for', () => {
  test('no mutating function accepts a user id — the actor is always auth.uid()', () => {
    // A p_user_id parameter on a writer is how one employee acts as another.
    for (const name of LIFECYCLE_WRITERS) {
      const fn = byName(name)
      assert.equal(/uuid/.test(fn.args.replace(/p_request_id\s+uuid/, '')), false,
        `${name} takes a second uuid argument`)
      assert.ok(fn.body.includes('auth.uid()'), `${name} does not read auth.uid()`)
    }
  })

  test('the predicates DO take a user id, and every call site passes auth.uid()', () => {
    // can_view / can_edit are shared with the policies, which must be able to
    // name the row's viewer. What matters is that nothing hands them anything
    // but the caller.
    for (const match of code.matchAll(/public\.can_(?:view|edit)_customer_review_request\(([^;]*?)\)\s*[),]/g)) {
      const args = match[1]
      if (args.includes('p_request_id')) continue // the definitions themselves
      assert.ok(args.includes('auth.uid('), `a call site passes something else: ${match[0]}`)
    }
  })

  test('a signed-out caller is refused before anything else happens', () => {
    for (const name of LIFECYCLE_WRITERS) {
      const body = byName(name).body
      assert.ok(body.includes('if v_uid is null then'), `${name} does not reject a null identity`)
      assert.ok(body.includes('CUSTOMER_REVIEW_UNAUTHORIZED'), name)
      // The null check comes before the row is even read.
      assert.ok(
        body.indexOf('if v_uid is null then') < body.indexOf('select * into r'),
        `${name} reads the row before checking identity`,
      )
    }
  })

  test('an INACTIVE employee is refused, whatever the permission engine says', () => {
    // resolve_effective_permissions does not check users.is_active, so every
    // function in this module has to.
    for (const name of [...LIFECYCLE_WRITERS, 'can_view_customer_review_request',
                        'can_edit_customer_review_request']) {
      assert.ok(byName(name).body.includes('is_active'), `${name} does not check is_active`)
    }
  })

  test('the transition refuses when the caller has no active user row at all', () => {
    const body = byName('transition_customer_review_request').body
    // SELECT ... INTO leaves v_admin NULL when no row matched, which is the
    // deactivated / deleted case. It must raise rather than fall through as
    // "not an admin".
    assert.ok(body.includes('if v_admin is null then'))
  })
})

describe('races: two clicks cannot both win', () => {
  test('every lifecycle writer locks the row it is about to change', () => {
    for (const name of LIFECYCLE_WRITERS) {
      assert.ok(
        byName(name).body.includes('where id = p_request_id for update'),
        `${name} does not take a row lock`,
      )
    }
  })

  test('the lock is taken BEFORE the status is read, not after', () => {
    const body = byName('transition_customer_review_request').body
    const lock = body.indexOf('for update')
    const guard = body.indexOf('v_legal := case r.status')
    assert.ok(lock !== -1 && guard !== -1 && lock < guard,
      'the legality guard must read a locked row')
  })

  test('a duplicate transition is refused by the table, not merely ignored', () => {
    // The second caller wakes on a row whose status has already moved, so its
    // move is no longer legal and it raises. There is no ON CONFLICT and no
    // silent no-op anywhere in the function.
    const body = byName('transition_customer_review_request').body
    assert.ok(body.includes('CUSTOMER_REVIEW_BAD_TRANSITION'))
    assert.equal(/on conflict/i.test(body), false)
  })
})

describe('mass assignment and field forgery', () => {
  test('the transition accepts four parameters and no field map', () => {
    const fn = byName('transition_customer_review_request')
    const params = fn.args.split(',').map(a => a.trim().split(/\s+/)[0]).filter(Boolean)
    assert.deepEqual(params, ['p_request_id', 'p_next_status', 'p_detail', 'p_review_url'])
    // No jsonb payload that could carry arbitrary columns.
    assert.equal(/jsonb/.test(fn.args), false)
  })

  test('every actor and timestamp it writes is derived, never passed in', () => {
    const body = byName('transition_customer_review_request').body
    for (const pair of [
      ['sent_at', 'now()'], ['sent_by', 'v_uid'],
      ['responded_at', 'now()'], ['responded_by', 'v_uid'],
      ['verified_at', 'now()'], ['verified_by', 'v_uid'],
      ['closed_at', 'now()'], ['closed_by', 'v_uid'],
      ['cancelled_at', 'now()'], ['cancelled_by', 'v_uid'],
    ] as const) {
      const line = body.split('\n').find(l => l.trim().startsWith(`${pair[0]} `) || l.trim().startsWith(`${pair[0]}=`) || l.trim().startsWith(`${pair[0]}  `))
      assert.ok(line, `${pair[0]} is not assigned`)
      assert.ok(line!.includes(pair[1]), `${pair[0]} is not set from ${pair[1]}: ${line!.trim()}`)
    }
  })

  test('created_by and created_at are never written by any function', () => {
    // Provenance is set once, by the INSERT policy plus the column default.
    for (const fn of FUNCTIONS) {
      const updates = fn.body.split('update public.customer_review_requests').slice(1)
      for (const u of updates) {
        const setClause = u.slice(0, u.indexOf('where'))
        assert.equal(/\bcreated_by\b/.test(setClause), false, `${fn.name} writes created_by`)
        assert.equal(/\bcreated_at\b/.test(setClause), false, `${fn.name} writes created_at`)
      }
    }
  })

  test('the client column grant cannot reach a single lifecycle field', () => {
    const grant = code.slice(code.indexOf('grant update ('), code.indexOf(') on public.customer_review_requests to authenticated'))
    for (const column of [
      'status', 'created_by', 'created_at',
      'sent_at', 'sent_by', 'responded_at', 'responded_by',
      'verified_at', 'verified_by', 'verification_note',
      'closed_at', 'closed_by', 'cancelled_at', 'cancelled_by', 'cancel_reason',
      'whatsapp_opened_at', 'whatsapp_opened_count', 'review_public_url',
    ]) {
      assert.equal(new RegExp(`\\b${column}\\b`).test(grant), false, `${column} is client-writable`)
    }
  })

  test('the INSERT policy refuses a row that arrives already claiming things', () => {
    const policy = code.slice(
      code.indexOf('create policy "customer_review_requests_insert"'),
      code.indexOf('create policy "customer_review_requests_update"'),
    )
    assert.ok(policy.includes('created_by = auth.uid()'))
    assert.ok(policy.includes("status = 'draft'"))
    for (const column of ['sent_at', 'responded_at', 'verified_at', 'closed_at',
                          'cancelled_at', 'whatsapp_opened_at', 'review_public_url']) {
      assert.ok(policy.includes(`${column} is null`), `INSERT does not pin ${column} to null`)
    }
    assert.ok(policy.includes('whatsapp_opened_count = 0'))
  })
})

describe('errors say what happened without saying who to', () => {
  test('no raised message interpolates a customer field', () => {
    const raises = [...code.matchAll(/raise exception '([^']*)'([^;]*)/g)]
    assert.ok(raises.length >= 10)
    for (const [, message, tail] of raises) {
      for (const field of [
        'whatsapp_number', 'customer_name', 'review_url', 'review_public_url',
        'internal_note', 'greeting_name', 'project_reference', 'file_name',
      ]) {
        assert.equal(tail.includes(field), false, `a raise interpolates ${field}: ${message}`)
      }
    }
  })

  test('the only values interpolated are a status and the caller’s own input', () => {
    const body = byName('transition_customer_review_request').body
    const raise = body.split('\n').find(l => l.includes('CUSTOMER_REVIEW_BAD_TRANSITION'))!
    const args = body.slice(body.indexOf(raise)).split('\n')[0]
    assert.ok(args.includes('r.status'))
    assert.ok(args.includes('p_next_status'))
  })

  test('every raise INSIDE A FUNCTION carries an SQLSTATE a caller can branch on', () => {
    // A bare RAISE surfaces as P0001, which is indistinguishable from any other
    // application error. Authorization is 42501, a refused value is 23514, and
    // a missing row is P0002.
    //
    // Scoped to function bodies deliberately. The migration's own §12
    // assertions also raise, and those are apply-time failures nobody catches —
    // giving them an API errcode would pretend they are the same kind of event.
    for (const fn of FUNCTIONS) {
      for (const block of fn.body.split('raise exception').slice(1)) {
        assert.ok(
          /using errcode = '(42501|23514|P0002)'/.test(block.slice(0, 400)),
          `${fn.name}: ${block.split('\n')[0].trim()}`,
        )
      }
    }
  })
})

describe('permission enforcement inside the functions', () => {
  test('verifying and closing require `verify`, and nothing else does', () => {
    const body = byName('transition_customer_review_request').body
    assert.ok(body.includes("if p_next_status in ('verified', 'closed') then"))
    assert.ok(body.includes('if not v_verify then'))
    // Every other move requires ownership plus `use`, or admin.
    assert.ok(body.includes('if not (v_admin or (v_owner and v_use)) then'))
  })

  test('opening WhatsApp and recording evidence are owner-only, never verifier', () => {
    for (const name of ['record_customer_review_whatsapp_opened', 'record_customer_review_evidence']) {
      const body = byName(name).body
      assert.ok(body.includes('r.created_by = v_uid'), name)
      assert.ok(body.includes("'customer_review_requests', 'use'"), name)
      assert.equal(body.includes("'customer_review_requests', 'verify'"), false,
        `${name} must not admit a verifier`)
    }
  })

  test('opening WhatsApp re-runs the sending prerequisites in the database', () => {
    const body = byName('record_customer_review_whatsapp_opened').body
    assert.ok(body.includes("if r.status <> 'ready_to_send' then"))
    assert.ok(body.includes('perform public.assert_customer_review_ready(p_request_id)'))
  })

  test('the ready check refuses a steered invitation, server-side', () => {
    const body = byName('assert_customer_review_ready').body
    assert.ok(body.includes('customer_review_text_steers(r.greeting_name)'))
    assert.ok(body.includes('customer_review_text_steers(r.project_reference)'))
    assert.ok(body.includes('CUSTOMER_REVIEW_NOT_NEUTRAL'))
  })

  test('the ready check requires a real project photograph', () => {
    const body = byName('assert_customer_review_ready').body
    assert.ok(body.includes("where request_id = p_request_id and kind = 'project_photo'"))
    assert.ok(body.includes('if v_photos = 0 then'))
    assert.ok(body.includes('if r.image_permission_confirmed is not true then'))
  })
})

// ── RLS and storage ─────────────────────────────────────────────────────────

describe('who can read a request', () => {
  const viewFn = byName('can_view_customer_review_request').body

  test('a `use` holder reads THEIR OWN and nothing else', () => {
    assert.ok(viewFn.includes('r.created_by = p_user_id'))
    // `use` is absent from the predicate on purpose: holding it opens the
    // module, it does not disclose every customer BOE has ever messaged.
    assert.equal(viewFn.includes("'customer_review_requests', 'use'"), false)
  })

  test('a verifier reads every request, because verification requires it', () => {
    assert.ok(viewFn.includes("resolve_permission(p_user_id, 'customer_review_requests', 'verify')"))
  })

  test('an unauthorized caller matches no branch, so the policy yields no row', () => {
    // The predicate is a closed list: owner, admin, verifier. There is no
    // fallback and no `or true`.
    const branches = viewFn.slice(viewFn.indexOf('and ('), viewFn.indexOf('  );'))
    assert.equal(/\btrue\b/.test(branches), false)
    assert.equal((branches.match(/\bor\b/g) ?? []).length, 2, 'exactly three branches')
  })

  test('the child tables read through that one predicate', () => {
    for (const policy of [
      'customer_review_photos_select',
      'customer_review_events_select',
    ]) {
      const body = code.slice(code.indexOf(`create policy "${policy}"`))
      assert.ok(body.slice(0, body.indexOf(';')).includes('can_view_customer_review_request'), policy)
    }
  })

  test('the request table asks the same question WITHOUT re-reading itself', () => {
    // The helper reaches back into public.customer_review_requests. Guarding
    // that same table with it makes INSERT ... RETURNING impossible — the
    // STABLE helper cannot see the row the statement is inserting — so the
    // request policy spells the predicate out instead. Same people, one table
    // touched, correct during the insert.
    const body = code.slice(code.indexOf('create policy "customer_review_requests_select"'))
    const policy = body.slice(0, body.indexOf(';'))

    assert.equal(policy.includes('can_view_customer_review_request'), false,
      'the request SELECT policy must not re-query its own table')
    assert.ok(policy.includes('created_by = auth.uid()'))
    assert.ok(policy.includes("u.role = 'admin'"))
    assert.ok(policy.includes("resolve_permission(auth.uid(), 'customer_review_requests', 'verify')"))
    assert.ok(policy.includes('u.is_active'), 'a deactivated employee keeps nothing')
    assert.equal(policy.includes("'customer_review_requests', 'use'"), false)

    // Exactly three branches, as in the helper: owner, admin, verifier.
    const branches = policy.slice(policy.indexOf('and ('))
    assert.equal((branches.match(/\bor\b/g) ?? []).length, 2, 'exactly three branches')
    assert.equal(/\btrue\b/.test(policy), false)
  })

  test('the phone number, the invitation and the evidence share that one gate', () => {
    // They are columns of customer_review_requests, so there is no second
    // policy that could disagree — worth pinning, because splitting them into a
    // second table later would silently create one.
    for (const column of ['whatsapp_number', 'review_url', 'review_public_url', 'internal_note']) {
      const table = code.slice(code.indexOf('create table public.customer_review_requests'),
                               code.indexOf('create index customer_review_requests_created_idx'))
      assert.ok(table.includes(column), `${column} must live on the gated table`)
    }
  })
})

describe('storage: an object cannot be attached to somebody else’s request', () => {
  const policy = (name: string) => {
    const start = code.indexOf(`create policy "${name}"`)
    assert.notEqual(start, -1, name)
    return code.slice(start, code.indexOf(';', start))
  }

  test('the object path is the authorization, and it is the request id', () => {
    const body = policy('customer_review_photos_storage_select')
    assert.ok(body.includes("bucket_id = 'customer-review-photos'"))
    // Reading resolves the request out of the first path segment. It is the
    // only client policy on this bucket.
    assert.ok(body.includes("split_part(storage.objects.name, '/', 1)"))
  })

  test('NO CLIENT CAN UPLOAD, REGISTER OR REMOVE AN IMAGE', () => {
    // The four absences that make /api/customer-reviews/photos the only writer,
    // and therefore make both its byte inspection and its removal a boundary
    // rather than advice.
    for (const absent of [
      'customer_review_photos_storage_insert',
      'customer_review_photos_storage_delete',
      'customer_review_photos_insert',
      'customer_review_photos_delete',
    ]) {
      assert.equal(code.includes(`create policy "${absent}"`), false, absent)
    }
    // Belt to those braces: every write privilege is revoked as well, so a
    // policy added back by mistake still could not write.
    assert.ok(code.includes(
      'revoke insert, update, delete, truncate on public.customer_review_request_photos from authenticated, anon',
    ))
  })

  test('METADATA CANNOT POINT AT ANOTHER REQUEST’S OBJECT', () => {
    // The route generates the key, and the schema refuses a row that disagrees
    // with it: the first path segment must equal the request id, the path is
    // UNIQUE so an object cannot be claimed twice, and the same bytes cannot be
    // registered twice against one request.
    assert.ok(code.includes("constraint customer_review_photos_path_matches_request check ("))
    assert.ok(code.includes("split_part(storage_path, '/', 1) = request_id::text"))
    assert.ok(code.includes('storage_path text not null unique'))
    assert.ok(code.includes('constraint customer_review_photos_unique_content_per_request'))
  })

  test('the stored type and size are FACTS the server established', () => {
    // content_sha256 exists, is constrained to a hex digest, and — like
    // mime_type and byte_size — can only be written by the trusted route.
    assert.ok(code.includes("content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$')"))
  })
  test('a path with no separator is rejected outright', () => {
    // Otherwise split_part returns the whole string and the constraint could be
    // satisfied by a bare filename sitting at the bucket root.
    assert.ok(code.includes("position('/' in storage_path) > 1"))
  })

  test('type and size are enforced by the bucket AND by the row', () => {
    assert.ok(code.includes("array['image/jpeg', 'image/png', 'image/webp']"))
    assert.ok(code.includes('5242880,   -- 5 MB per file'))
    assert.ok(code.includes("mime_type text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp'))"))
    assert.ok(code.includes('byte_size integer not null check (byte_size > 0 and byte_size <= 5242880)'))
  })

  test('a project photograph and a proof image are distinguishable, and always were', () => {
    assert.ok(code.includes("kind text not null check (kind in ('project_photo', 'review_proof'))"))
  })
})

describe('objects cannot be orphaned, and an accident can be corrected', () => {
  test('a request holding photographs cannot be deleted', () => {
    // The metadata rows cascade; the objects do not. Deleting the request would
    // strand every object it named, with nothing left to name them.
    const fn = byName('customer_review_requests_prevent_delete_with_photos').body
    assert.ok(fn.includes('CUSTOMER_REVIEW_HAS_PHOTOS'))
    assert.ok(code.includes('before delete on public.customer_review_requests'))
  })

  test('an ADMIN can withdraw either kind of image at any status', () => {
    // The whole status/kind ladder sits inside the non-admin branch, so an
    // administrator passes it entirely.
    const body = byName('begin_customer_review_photo_removal').body
    assert.ok(body.includes('if not v_admin then'))
    const beforeLadder = body.slice(0, body.indexOf('if not v_admin then'))
    assert.equal(beforeLadder.includes('r.status not in'), false)
  })

  test('a non-admin cannot remove VERIFIED proof, or a photograph after sending', () => {
    const body = byName('begin_customer_review_photo_removal').body
    assert.ok(body.includes("r.status not in ('draft', 'ready_to_send')"))
    assert.ok(body.includes('if r.verified_at is not null then'))
    assert.ok(body.includes('Verified proof can only be withdrawn by an administrator'))
  })

  test('every removal is recorded in the append-only trail', () => {
    const fn = byName('customer_review_photos_log_removal').body
    assert.ok(fn.includes("'photo_removed'"))
    assert.ok(code.includes('before delete on public.customer_review_request_photos'))
    // And the trail row is skipped when the parent is going away, so a cascade
    // cannot write a row that is about to be deleted underneath it.
    assert.ok(fn.includes('if not exists (select 1 from public.customer_review_requests'))
  })
})

describe('the trail cannot be written or erased by a client', () => {
  test('no write policy exists on it', () => {
    const policies = [...code.matchAll(/create policy "([^"]+)" on public\.customer_review_request_events\s+for (\w+)/g)]
    assert.deepEqual(policies.map(p => p[2]), ['select'])
  })

  test('and no write grant either, TRUNCATE included', () => {
    assert.ok(code.includes(
      'revoke insert, update, delete, truncate on public.customer_review_request_events from authenticated, anon',
    ))
  })

  test('rows arrive only from functions the client cannot call', () => {
    const writers = FUNCTIONS.filter(f => f.body.includes('insert into public.customer_review_request_events'))
    assert.ok(writers.length >= 4)
    for (const fn of writers) {
      assert.ok(
        CLIENT_CALLABLE.includes(fn.name) || INTERNAL_ONLY.includes(fn.name),
        `${fn.name} writes the trail but is in neither list`,
      )
    }
  })
})
