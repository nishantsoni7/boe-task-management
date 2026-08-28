/**
 * The migration, audited against the SQL text.
 *
 * WHY A TEXT AUDIT. This migration is not applied to production, and CI has no
 * database to introspect, so what this file can prove is that the SQL says what
 * it must say: RLS on every table, no unconditional policy, an append-only
 * trail, a column grant that cannot reach `status`, storage policies keyed on
 * the request id, and a transition table identical to the browser's copy in
 * ./status.ts.
 *
 * AND WHY A TEXT AUDIT IS NOT ENOUGH. Everything here passed while the module's
 * create button was impossible: the request SELECT policy re-read its own
 * table, so `INSERT ... RETURNING` could never satisfy it. Reading the SQL did
 * not reveal that; executing it did, immediately. The behavioural counterpart
 * is supabase/tests/customer_review_request_visibility_assertions.sql, and the
 * two are meant to be run together.
 *
 * That last one is the point of the whole file. The UI's transition table and
 * the database's are two copies of one rule, and a divergence would mean either
 * a button that gets refused or — far worse — a move the screen forbids and the
 * database permits.
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
import { CUSTOMER_REVIEW_TRANSITIONS } from './status'
import { CUSTOMER_REVIEW_STATUSES, INTERACTION_TYPES } from './types'

const ROOT = process.cwd()
const MIGRATIONS = join(ROOT, 'supabase/migrations')
const FILE = '20261017000000_customer_review_outreach.sql'

const lf = (s: string) => s.replace(/\r\n/g, '\n')
const sql = lf(readFileSync(join(MIGRATIONS, FILE), 'utf8'))
/** Executable SQL only — comments explain, they do not run. */
const code = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')

function fnBody(name: string): string {
  const start = code.indexOf(`create or replace function public.${name}`)
  assert.notEqual(start, -1, `${name} is missing`)
  const tag = /\$[A-Za-z_]*\$/.exec(code.slice(start))![0]
  const open = code.indexOf(tag, start)
  const close = code.indexOf(tag, open + tag.length)
  return code.slice(start, close + tag.length)
}

function statement(startsWith: string): string {
  const start = code.indexOf(startsWith)
  assert.notEqual(start, -1, `missing statement: ${startsWith}`)
  return code.slice(start, code.indexOf(';', start))
}

describe('the file is the newest migration and touches no earlier one', () => {
  test('its timestamp sorts last', () => {
    const files = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()
    assert.equal(files[files.length - 1], FILE)
  })

  test('it creates its own objects and alters nothing that existed before', () => {
    // The only pre-existing tables it writes to are the permission registry and
    // storage.buckets, both by INSERT. No ALTER, DROP or CREATE OR REPLACE
    // against another module's object.
    for (const forbidden of [
      /alter table public\.(?!customer_review)/,
      /drop table/i,
      /drop policy/i,
      // A REVOKE ... TRUNCATE is protective; an actual TRUNCATE statement is
      // the thing that must never appear.
      /\btruncate\s+(table\s+)?public\./i,
      // A DELETE against somebody else's table. The module's own removal
      // function deletes from customer_review_request_photos, which is the
      // point of it.
      /delete from public\.(?!customer_review)/i,
      /drop function public\.(?!customer_review)/,
    ]) {
      assert.equal(forbidden.test(code), false, `the migration contains ${forbidden}`)
    }
  })

  test('nothing in it is destructive', () => {
    assert.equal(/\bdrop\s+(table|column|schema|database|role)\b/i.test(code), false)
    assert.equal(/\bgrant\s+all\b/i.test(code), false)
    assert.equal(/\bto\s+public\b/i.test(code.replace(/from public, anon/g, '')), false)
  })
})

describe('row-level security', () => {
  const tables = [
    'customer_review_requests',
    'customer_review_request_photos',
    'customer_review_request_events',
  ]

  test('every table has it enabled', () => {
    for (const table of tables) {
      assert.ok(
        code.includes(`alter table public.${table} enable row level security`)
        || new RegExp(`alter table public\\.${table}\\s+enable row level security`).test(code),
        `${table} does not enable RLS`,
      )
    }
  })

  test('NO POLICY IS UNCONDITIONAL', () => {
    // `USING (true)` is how five payroll tables became world-readable
    // (see 20260812000000). It must not reappear.
    for (const match of code.matchAll(/create policy "([^"]+)"[\s\S]*?;/g)) {
      const body = match[0]
      assert.equal(/using\s*\(\s*true\s*\)/i.test(body), false, `${match[1]} is USING (true)`)
      assert.equal(/with check\s*\(\s*true\s*\)/i.test(body), false, `${match[1]} is WITH CHECK (true)`)
    }
  })

  test('every policy is scoped to the authenticated role', () => {
    const policies = [...code.matchAll(/create policy "([^"]+)"[\s\S]*?for (\w+)([\s\S]*?);/g)]
    assert.ok(policies.length >= 5)
    for (const match of policies) {
      assert.ok(/to authenticated/.test(match[0]), `${match[1]} is not scoped to authenticated`)
    }
  })

  test('the trail has a SELECT policy and no other', () => {
    const trailPolicies = [...code.matchAll(/create policy "([^"]+)" on public\.customer_review_request_events\s+for (\w+)/g)]
    assert.deepEqual(trailPolicies.map(m => m[2]), ['select'])
  })

  test('the trail is unwritable by grant as well as by policy', () => {
    assert.ok(code.includes(
      'revoke insert, update, delete, truncate on public.customer_review_request_events from authenticated, anon',
    ))
  })

  test('the row predicate still admits exactly owner, admin and verifier', () => {
    // The predicate moved out of the policy and into a function; it must not
    // have changed on the way.
    const body = fnBody('can_view_customer_review_request_row')
    assert.ok(body.includes('p_created_by = p_user_id'), 'owner branch')
    assert.ok(body.includes("u.role = 'admin'"), 'admin branch')
    assert.ok(
      body.includes("resolve_permission(p_user_id, 'customer_review_requests', 'verify')"),
      'verifier branch',
    )
    // `use` opens the module; it does not disclose a colleague's customer.
    assert.equal(body.includes("'customer_review_requests', 'use'"), false)
    // And the active-user requirement gates all three, not one of them.
    assert.ok(body.includes('u.is_active'), 'must require an active user')
    assert.ok(body.indexOf('u.is_active') < body.indexOf('and ('),
      'is_active must sit outside the three-way or')
    // It decides from its arguments; it never reads the table it guards.
    assert.equal(
      /(from|join)\s+(public\.)?customer_review_requests\b/i.test(body), false,
      'the row predicate must not query customer_review_requests',
    )
  })

  test('the CHILD tables read through the shared predicate', () => {
    // They ask about another table's row, which is what the helper is for.
    for (const policy of [
      'customer_review_photos_select',
      'customer_review_events_select',
    ]) {
      assert.ok(
        statement(`create policy "${policy}"`).includes('public.can_view_customer_review_request('),
        `${policy} does not use the shared predicate`,
      )
    }
  })

  test('the request table decides on the row it is given, not on a second lookup', () => {
    // THE ONE THAT WAS WRONG, TWICE. First it resolved the request by
    // SELECTing it: the request-id helper is STABLE and re-reads this very
    // table, so the row an `INSERT ... RETURNING` is about to return is not in
    // its snapshot — policy false, insert refused 42501, every create in the
    // UI broken. Then the fix for that read public.users inline, which runs as
    // the CALLER and quietly tied this module's visibility to another table's
    // grants and row security.
    //
    // Both are avoided the same way: delegate to a SECURITY DEFINER predicate
    // that takes created_by as a value and queries only users.
    const policy = statement('create policy "customer_review_requests_select"')

    // Not the request-id helper. Matched with the open paren so the _row
    // variant does not satisfy it.
    assert.equal(
      /can_view_customer_review_request\(/.test(policy), false,
      'the request SELECT policy must not re-query the table it guards',
    )
    // Not an inline read of users either.
    assert.equal(
      /\bfrom\s+(public\.)?users\b/i.test(policy), false,
      'the request SELECT policy must not read public.users as the caller',
    )
    // The delegation itself, with the candidate row's column named in full so
    // nothing else in scope can rebind it.
    assert.ok(policy.includes('can_view_customer_review_request_row('), 'delegates to the row predicate')
    assert.ok(
      policy.includes('customer_review_requests.created_by'),
      'created_by must be qualified, not left to scope resolution',
    )
    assert.equal(/\btrue\b/.test(policy), false, 'no unconditional branch')
  })

  test('the migration asserts that mistake cannot come back', () => {
    // Belt and braces: the file re-checks its own policy at apply time, so a
    // future edit that reinstates either mistake fails the migration rather
    // than shipping a module whose create button never works — or one whose
    // visibility depends on a neighbouring table's grants.
    assert.ok(code.includes(
      "raise exception 'customer_review_requests_select re-queries its own table",
    ))
    assert.ok(code.includes(
      "raise exception 'customer_review_requests_select reads public.users as the caller",
    ))
  })
})

describe('who can see what', () => {
  test('a `use` holder sees their OWN requests — module entry is not company-wide sight', () => {
    const body = fnBody('can_view_customer_review_request')
    assert.ok(body.includes('r.created_by = p_user_id'))
    assert.ok(body.includes("resolve_permission(p_user_id, 'customer_review_requests', 'verify')"))
    assert.ok(body.includes("u.role = 'admin'"))
    // `use` deliberately does NOT appear: holding it opens the module, not
    // everybody else's customer contacts.
    assert.equal(body.includes("'customer_review_requests', 'use'"), false)
  })

  test('an inactive employee sees nothing, whatever their grants say', () => {
    for (const name of [
      'can_view_customer_review_request',
      'can_edit_customer_review_request',
    ]) {
      assert.ok(fnBody(name).includes('u.is_active'), `${name} does not check is_active`)
    }
  })

  test('editing is narrower than reading, in both directions', () => {
    const body = fnBody('can_edit_customer_review_request')
    // Only while it is still being prepared.
    assert.ok(body.includes("r.status in ('draft', 'ready_to_send')"))
    // Owner + `use`, or an admin. A verifier is absent on purpose.
    assert.ok(body.includes('r.created_by = p_user_id'))
    assert.ok(body.includes("resolve_permission(p_user_id, 'customer_review_requests', 'use')"))
    assert.equal(body.includes("'verify'"), false)
  })

  test('the predicates cannot be aimed at another user by a client', () => {
    // They take a user id (policies pass auth.uid()), but they are never granted
    // in a way that lets anon call them, and every policy passes auth.uid().
    for (const name of [
      'can_view_customer_review_request',
      'can_edit_customer_review_request',
    ]) {
      assert.ok(code.includes(`revoke execute on function public.${name}(`), `${name} is not revoked from public/anon`)
    }
    for (const match of code.matchAll(/can_(view|edit)_customer_review_request\(([^)]*)\)/g)) {
      // Skip the definition and the REVOKE/GRANT statements, which name the
      // function by its argument TYPES rather than calling it.
      if (match[2].includes('p_request_id') || /uuid/.test(match[2])) continue
      assert.ok(
        match[2].includes('auth.uid('),
        `a call site passes something other than auth.uid(): ${match[0]}`,
      )
    }
  })
})

describe('the transition table matches the browser copy exactly', () => {
  const body = fnBody('transition_customer_review_request')

  test('every status the UI knows about is decided identically in SQL', () => {
    for (const [from, targets] of Object.entries(CUSTOMER_REVIEW_TRANSITIONS)) {
      if (targets.length === 0) {
        // Terminal states fall through to `else false`.
        assert.equal(body.includes(`when '${from}'`), false, `${from} must be terminal in SQL too`)
        continue
      }
      const line = body.split('\n').find(l => l.includes(`when '${from}'`))
      assert.ok(line, `SQL has no branch for ${from}`)
      for (const to of targets) {
        assert.ok(line!.includes(`'${to}'`), `SQL branch for ${from} is missing ${to}`)
      }
      // And nothing extra: count the quoted statuses on the branch's right side.
      const offered = [...line!.slice(line!.indexOf('in (')).matchAll(/'([a-z_]+)'/g)].map(m => m[1])
      assert.deepEqual(offered.sort(), [...targets].sort(), `SQL branch for ${from} differs`)
    }
  })

  test('the else branch refuses everything, so a terminal status is truly terminal', () => {
    assert.ok(/else false/.test(body))
  })

  test('an illegal move raises rather than silently doing nothing', () => {
    assert.ok(body.includes('CUSTOMER_REVIEW_BAD_TRANSITION'))
    assert.ok(body.includes("errcode = '23514'"))
  })
})

describe('VERIFICATION CANNOT BE SELF-SERVICE', () => {
  const body = fnBody('transition_customer_review_request')

  test('verified and closed require the verify permission, in the database', () => {
    assert.ok(body.includes("if p_next_status in ('verified', 'closed') then"))
    assert.ok(body.includes('if not v_verify then'))
    assert.ok(body.includes("resolve_permission(v_uid, 'customer_review_requests', 'verify')"))
  })

  test('every other move requires the OWNER (or an admin), not merely the module', () => {
    assert.ok(body.includes('if not (v_admin or (v_owner and v_use)) then'))
    assert.ok(body.includes('v_owner  := (r.created_by = v_uid)'))
  })

  test('a refusal is a raise with 42501, never a quiet no-op', () => {
    assert.ok(body.includes('CUSTOMER_REVIEW_UNAUTHORIZED'))
    assert.ok(body.includes("errcode = '42501'"))
  })

  test('the acting identity is always auth.uid(), never a parameter', () => {
    assert.ok(body.includes('v_uid    uuid := auth.uid()'))
    const args = code.slice(
      code.indexOf('create or replace function public.transition_customer_review_request('),
      code.indexOf(')\nreturns public.customer_review_requests'),
    )
    assert.equal(/uuid/.test(args.replace('p_request_id  uuid', '')), false, 'the function accepts a second uuid')
  })
})

describe('opening WhatsApp is never delivery', () => {
  const body = fnBody('record_customer_review_whatsapp_opened')

  test('it writes the opened timestamp and counter, and nothing else', () => {
    assert.ok(body.includes('whatsapp_opened_at    = now()'))
    assert.ok(body.includes('whatsapp_opened_count = whatsapp_opened_count + 1'))
  })

  test('IT NEVER TOUCHES status OR sent_at', () => {
    const update = body.slice(body.indexOf('update public.customer_review_requests'))
    assert.equal(/set[\s\S]*?\bstatus\b\s*=/.test(update.slice(0, update.indexOf('where'))), false)
    assert.equal(update.slice(0, update.indexOf('where')).includes('sent_at'), false)
  })

  test('it refuses unless the request is Ready to Send and still complete', () => {
    assert.ok(body.includes("if r.status <> 'ready_to_send' then"))
    assert.ok(body.includes('perform public.assert_customer_review_ready(p_request_id)'))
  })

  test('the trail row says in words that this is not a delivery receipt', () => {
    assert.ok(body.includes('This does not confirm the message was sent.'))
  })
})

describe('no status claims a review exists', () => {
  test('recording an evidence link can only move sent → customer_responded', () => {
    const body = fnBody('record_customer_review_evidence')
    const update = body.slice(body.indexOf('update public.customer_review_requests'))
    const setClause = update.slice(0, update.indexOf('where'))

    assert.ok(setClause.includes('set review_public_url = v_url'))
    // The ONE status it may write, and the one source status it may write it
    // from. A published review is a customer response; it is not a verification.
    assert.ok(setClause.includes("when r.status = 'sent' then 'customer_responded'"))
    assert.equal(/'verified'/.test(setClause), false, 'evidence must never reach verified')
    assert.equal(setClause.includes('verified_at'), false)
    assert.equal(setClause.includes('verified_by'), false)
    assert.equal(setClause.includes('closed'), false)
    assert.ok(body.includes('It has not been verified.'))
  })

  test('that move writes its own status_changed row, so the trail is complete', () => {
    const body = fnBody('record_customer_review_evidence')
    assert.ok(body.includes("'status_changed', 'sent', 'customer_responded'"))
  })

  test('NOTHING ANYWHERE SETS verified_at EXCEPT the verify branch of the transition', () => {
    // The single most important claim in the module: only a verify holder,
    // through one branch of one function, can say a review was checked.
    const writers = [...code.matchAll(/verified_at\s*=\s*case[\s\S]{0,120}/g)].map(m => m[0])
    assert.equal(writers.length, 1, 'more than one statement writes verified_at')
    assert.ok(writers[0].includes("when p_next_status = 'verified' then now()"))
  })

  test('the evidence URL is https-only wherever it can be written', () => {
    assert.ok(fnBody('record_customer_review_evidence').includes("v_url not like 'https://%'"))
    assert.ok(fnBody('transition_customer_review_request').includes("p_review_url like 'https://%'"))
    assert.ok(code.includes("review_public_url like 'https://%'"))
  })

  test('a closed request was verified first — as a CHECK, not a convention', () => {
    assert.ok(code.includes('constraint customer_review_requests_verified_before_closed check ('))
    assert.ok(code.includes('closed_at is null or verified_at is not null'))
    assert.ok(code.includes("status not in ('verified', 'closed') or verified_at is not null"))
  })
})

describe('the column grant is what makes the RPC unavoidable', () => {
  const grant = statement('grant update (')

  test('the blanket UPDATE is revoked first', () => {
    assert.ok(code.includes(
      'revoke update, truncate, references, trigger on public.customer_review_requests from authenticated, anon',
    ))
    assert.ok(code.indexOf('revoke update, truncate, references, trigger') < code.indexOf('grant update ('))
  })

  test('the granted columns are exactly the form fields', () => {
    const columns = [...grant.matchAll(/^\s{2}(\w+),?$/gm)].map(m => m[1])
    assert.deepEqual(columns.sort(), [
      'customer_name',
      'genuine_customer_confirmed',
      'greeting_name',
      'image_permission_confirmed',
      'interaction_type',
      'internal_note',
      'project_reference',
      'review_url',
      'updated_at',
      'whatsapp_number',
    ])
  })

  test('NOT status, and not one lifecycle column', () => {
    for (const column of [
      'status',
      'sent_at', 'sent_by',
      'responded_at', 'responded_by',
      'verified_at', 'verified_by', 'verification_note',
      'closed_at', 'closed_by',
      'cancelled_at', 'cancelled_by', 'cancel_reason',
      'whatsapp_opened_at', 'whatsapp_opened_count',
      'review_public_url',
      'created_by', 'created_at',
    ]) {
      assert.equal(
        new RegExp(`^\\s{2}${column},?$`, 'm').test(grant),
        false,
        `${column} must not be client-writable`,
      )
    }
  })

  test('anon holds nothing anywhere in the module', () => {
    assert.ok(code.includes('revoke insert, update, delete, truncate on public.customer_review_requests from anon'))
    assert.ok(code.includes('revoke insert, update, delete, truncate on public.customer_review_request_photos from authenticated, anon'))
  })

  test('AUTHENTICATED CANNOT REGISTER AN IMAGE — the privilege is gone, not just the policy', () => {
    // The metadata INSERT policy was withdrawn so that only the trusted upload
    // route can create a photo row. Revoking the privilege as well means a
    // policy added back by mistake still could not write.
    assert.ok(code.includes(
      'revoke insert, update, delete, truncate on public.customer_review_request_photos from authenticated, anon',
    ))
  })
})

describe('storage', () => {
  test('THE BUCKET HAS EXACTLY ONE CLIENT POLICY, AND IT READS', () => {
    // Uploading and removing are both server operations now, so a client holds
    // no write policy on this bucket at all.
    const policies = [...code.matchAll(/create policy "(customer_review_photos[^"]*)"\s*\n?\s*on storage\.objects\s+for (\w+)/g)]
    assert.equal(policies.length, 1, policies.map(p => p[1]).join(', '))
    assert.equal(policies[0][2], 'select')
    assert.ok(
      statement('create policy "customer_review_photos_storage_select"')
        .includes("bucket_id = 'customer-review-photos'"),
    )
  })

  test('reading an object asks the same question as reading the request', () => {
    assert.ok(
      statement('create policy "customer_review_photos_storage_select"')
        .includes('public.can_view_customer_review_request(r.id, auth.uid())'),
    )
  })

  test('the select policy does not cast a path segment, so a stray object cannot error the query', () => {
    assert.equal(
      /split_part\(storage\.objects\.name, '\/', 1\)::uuid/.test(code),
      false,
      'casting the path segment would raise on a malformed object name',
    )
  })

  test('NO CLIENT MAY WRITE AN OBJECT — there is no storage INSERT policy at all', () => {
    // The half that actually stops the bytes. Without it a caller could upload
    // anything under a Content-Type of their choosing and simply never call the
    // route, leaving an unvalidated object in the bucket.
    assert.equal(code.includes('create policy "customer_review_photos_storage_insert"'), false)
    for (const match of code.matchAll(/create policy "(customer_review[^"]*)" *\n? *on storage\.objects\s+for (\w+)/g)) {
      assert.notEqual(match[2], 'insert', `${match[1]} writes objects`)
    }
  })

  test('NO CLIENT MAY DELETE AN OBJECT OR A ROW — removal is one server operation', () => {
    // Deleting spans the bucket and the metadata table. A client holding either
    // half would eventually perform exactly one of them, leaving an orphaned
    // object or a record pointing at nothing.
    assert.equal(code.includes('create policy "customer_review_photos_storage_delete"'), false)
    assert.equal(code.includes('create policy "customer_review_photos_delete"'), false)
    // The status and kind rules did not disappear — they moved into
    // begin_customer_review_photo_removal(), which no client can call.
    assert.ok(fnBody('begin_customer_review_photo_removal').includes("r.status not in ('draft', 'ready_to_send')"))
    assert.ok(fnBody('begin_customer_review_photo_removal').includes('r.verified_at is not null'))
  })
})

describe('registration in the permission engine', () => {
  test('both actions are registered, deny-by-default, and custom', () => {
    assert.ok(code.includes("('use',    'Use Customer Review Outreach',   false)"))
    assert.ok(code.includes("('verify', 'Verify & Close Review Requests', false)"))
    assert.ok(code.includes("join public.permission_actions pa on pa.action_key in ('use', 'verify')"))
    assert.ok(/select pm\.id, pa\.id, false/.test(code))
  })

  test('no `view` action is registered for this module', () => {
    const registration = code.slice(code.indexOf('insert into public.permission_modules'))
    assert.equal(registration.includes("'view'"), false)
  })

  test('only the admin role is granted anything', () => {
    const roleGrants = [...code.matchAll(/insert into public\.role_permissions[\s\S]*?;/g)]
    assert.equal(roleGrants.length, 1)
    assert.ok(roleGrants[0][0].includes("select 'admin'"))
    assert.equal(roleGrants[0][0].includes("'manager'"), false)
    assert.equal(roleGrants[0][0].includes("'member'"), false)
  })

  test('no employee override is created by the migration, and it asserts so', () => {
    assert.ok(code.includes('employee_permission_overrides'))
    assert.ok(code.includes('this migration must create none'))
  })

  test('no app_modules row is inserted', () => {
    // Entry is decided by the engine action `use`. An app_modules row would be
    // a Control Center control nothing reads.
    assert.equal(code.includes('app_modules'), false)
  })
})

describe('the domain values agree with the schema', () => {
  test('the seven statuses are the seven in the CHECK', () => {
    const check = code.slice(code.indexOf("status text not null default 'draft' check"))
      .slice(0, 400)
    for (const status of CUSTOMER_REVIEW_STATUSES) {
      assert.ok(check.includes(`'${status}'`), `${status} is missing from the status CHECK`)
    }
  })

  test('the eight interaction types are the eight in the CHECK', () => {
    const check = code.slice(code.indexOf('interaction_type text check')).slice(0, 500)
    for (const type of INTERACTION_TYPES) {
      assert.ok(check.includes(`'${type}'`), `${type} is missing from the interaction CHECK`)
    }
    assert.equal([...check.matchAll(/'[a-z_]+'/g)].length, INTERACTION_TYPES.length)
  })

  test('the number column only accepts E.164', () => {
    assert.ok(code.includes("whatsapp_number ~ '^\\+[1-9][0-9]{7,14}$'"))
  })

  test('there is NO message body column — the invitation is assembled, never stored', () => {
    for (const forbidden of ['message_body', 'message_text', 'invitation_text', 'custom_message']) {
      assert.equal(code.includes(forbidden), false, `${forbidden} must not exist`)
    }
  })

  test('nothing STORES a rating, a score or a sentiment', () => {
    // Scoped to column definitions on purpose. These words now appear in
    // customer_review_text_steers(), which exists to REFUSE them in the
    // invitation — a file-wide ban would forbid the guard along with the
    // thing it guards against.
    const tables = code.slice(code.indexOf('create table public.customer_review_requests'),
                             code.indexOf('create or replace function'))
    for (const forbidden of ['rating', 'stars', 'score', 'sentiment', 'reward', 'points']) {
      assert.equal(
        new RegExp(`^\s*${forbidden}\b`, 'mi').test(tables),
        false,
        `no column may be called ${forbidden}`,
      )
    }
  })
})

describe('the migration fails loudly rather than half-applying', () => {
  test('it asserts RLS, the append-only trail, the private bucket and the registration', () => {
    const assertions = code.slice(code.indexOf('do $$'))
    for (const fragment of [
      'row level security is not enabled',
      'it must be append-only',
      'are USING (true)',
      'bucket is missing or public',
      'deny-by-default',
    ]) {
      assert.ok(assertions.includes(fragment), `missing assertion: ${fragment}`)
    }
  })
})
