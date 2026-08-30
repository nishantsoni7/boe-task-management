/**
 * The invariants of the history routes, the cleanup route and the migration
 * that backs them.
 *
 * WHY A SOURCE CHECK
 * ------------------
 * Executing these needs a live Supabase (a bearer token is resolved
 * server-side) and a private bucket, so this takes the same approach
 * route.test.ts beside the studio route takes, for the same reason. The things
 * guarded here are the ones that would fail SILENTLY and expensively:
 *
 *   * a missing `.eq('user_id', ...)`. These routes use the SERVICE ROLE, which
 *     bypasses row-level security, so that filter — not the policy — is what
 *     keeps one employee out of another's pictures. Drop it and every test
 *     still passes and every employee sees everybody's work;
 *   * an admin branch creeping into a per-user history;
 *   * the cleanup endpoint becoming reachable without the secret;
 *   * the bucket being public;
 *   * a route reaching for FAL_KEY. Nothing in this feature may cost money.
 *
 * Run:
 *   npx tsx --test src/app/api/image-editor/resultsRoutes.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

const LIST = read('src/app/api/image-editor/results/route.ts')
const ITEM = read('src/app/api/image-editor/results/[id]/route.ts')
const CLEANUP = read('src/app/api/image-editor/cleanup/route.ts')
const AUTH = read('src/lib/imageEditor/historyServer.ts')
const MIGRATION = read('supabase/migrations/20261021000000_image_editor_result_history.sql')
const VERCEL = read('vercel.json')
const PURGE = read('src/app/api/permanently-delete-user/route.ts')

/** Code with comments stripped, so an assertion cannot be satisfied — or
 *  tripped — by a sentence explaining what the route does not do. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

describe('no route in this feature can spend money', () => {
  for (const [name, source] of [['list', LIST], ['item', ITEM], ['cleanup', CLEANUP]] as const) {
    test(`the ${name} route never touches the provider key`, () => {
      // Comments stripped: these files SAY they make no provider call, and a
      // check that read the prose would be satisfied by the sentence rather
      // than by the code.
      const body = code(source)
      assert.ok(!body.includes('FAL_KEY'), 'FAL_KEY must not be read here')
      assert.ok(!body.includes('fal.ai'), 'no provider host')
      assert.ok(!/generateProductShot|upscaleImage|falRequest/.test(body), 'no provider adapter')
    })
  }
})

describe('ownership is filtered in code, because the service role bypasses RLS', () => {
  test('the listing scopes to the caller', () => {
    assert.match(code(LIST), /\.eq\('user_id', userId\)/)
  })

  test('every statement in the item route scopes to the caller', () => {
    const body = code(ITEM)
    // Three: the PATCH update, the DELETE lookup, and the DELETE itself.
    assert.equal(
      (body.match(/\.eq\('user_id', (userId|ownerId)\)/g) ?? []).length, 3,
      'update, lookup and delete must each be scoped to the owner',
    )
  })

  test('no route accepts a user id from the request', () => {
    for (const source of [LIST, ITEM]) {
      assert.ok(!/searchParams\.get\('user/.test(source), 'a caller cannot name whose history to read')
      assert.ok(!/body\.user_id|\.userId\b\s*=/.test(code(source)))
    }
  })
})

describe('no admin back door', () => {
  test('the history routes have no admin branch at all', () => {
    for (const source of [LIST, ITEM]) {
      assert.ok(!/isAdminRole|role === 'admin'/.test(source),
        'an administrator sees their own results and nobody else\'s')
    }
  })

  test('the shared authorizer uses admin only for MODULE ENTRY, never for rows', () => {
    // isAdminRole appears once, deciding whether the module may be opened.
    // It must not appear in any query.
    assert.equal((AUTH.match(/isAdminRole/g) ?? []).length, 2, 'imported and used exactly once')
    assert.ok(!AUTH.includes('.from(\'image_editor_results\')'),
      'the authorizer never reads results — it only says who may ask')
  })

  test('every permissive policy in the migration is scoped to auth.uid()', () => {
    const permissive = MIGRATION.split('create policy').slice(1)
      .filter(block => !block.includes('as restrictive'))
    assert.ok(permissive.length >= 7, 'the table and storage policies are all present')
    for (const block of permissive) {
      assert.ok(
        block.includes('auth.uid()'),
        `a permissive policy without auth.uid() would open every row: ${block.slice(0, 60)}`,
      )
    }
  })
})

describe('module entry gates the history', () => {
  test('reading requires the view grant', () => {
    assert.match(AUTH, /IMAGE_EDITOR_MODULE_KEY, 'view'/)
  })

  // Deliberate: `create` authorizes SPENDING. Requiring it to read or DELETE
  // your own past work would mean losing Use access locks you out of removing
  // your own pictures.
  test('reading does NOT require the create grant', () => {
    assert.ok(!AUTH.includes("'create'"), 'create gates generation, not retention')
  })

  test('the table carries the restrictive module-entry gate', () => {
    assert.match(MIGRATION, /as restrictive for all to authenticated/)
    assert.match(MIGRATION, /module_entry_open\('image_editor'\)/)
  })
})

describe('the cleanup endpoint', () => {
  test('is GET, which is what Vercel Cron sends', () => {
    assert.match(CLEANUP, /export async function GET\(/)
    assert.ok(!/export async function POST\(/.test(CLEANUP))
  })

  test('refuses to run at all when the secret is unset', () => {
    const body = code(CLEANUP)
    assert.match(body, /if \(!expected\)/)
    assert.match(body, /status: 503/)
    // The refusal must come before anything reads or deletes. Anchored on the
    // TABLE read specifically — `.from(` alone also matches `Buffer.from` in
    // the constant-time compare above it, which would make this pass for the
    // wrong reason.
    assert.ok(
      body.indexOf('503') < body.indexOf("from('image_editor_results')"),
      'an unconfigured deployment must not expose an unauthenticated delete',
    )
  })

  test('compares the secret in constant time', () => {
    assert.match(CLEANUP, /timingSafeEqual/)
  })

  test('a secret of the wrong LENGTH is rejected, not thrown over', () => {
    // node:crypto's timingSafeEqual THROWS on buffers of unequal length. An
    // unguarded compare would turn a wrong-length header into a 500 from an
    // unhandled exception rather than a 401 — and a route that crashes on bad
    // input is a route somebody can probe.
    const body = code(CLEANUP)
    assert.match(body, /if \(a\.length !== b\.length\) return false/)
    assert.ok(
      body.indexOf('a.length !== b.length') < body.indexOf('return timingSafeEqual'),
      'the length check must come first',
    )
  })

  test('never sweeps a kept result', () => {
    assert.match(code(CLEANUP), /\.eq\('kept', false\)/)
  })

  test('is scheduled daily in vercel.json', () => {
    const config = JSON.parse(VERCEL)
    assert.equal(config.crons.length, 1)
    assert.equal(config.crons[0].path, '/api/image-editor/cleanup')
    // Once a day. A schedule with more fields than this would be a different
    // decision than the one that was made.
    assert.match(config.crons[0].schedule, /^\d+ \d+ \* \* \*$/)
  })

  test('vercel.json adds NOTHING else', () => {
    // This file did not exist before the sweep needed a schedule. A `functions`
    // block, a build override or a header rule smuggled in here would change how
    // every other route in the application is deployed.
    assert.deepEqual(Object.keys(JSON.parse(VERCEL)).sort(), ['$schema', 'crons'])
  })
})

describe('the bucket', () => {
  test('is private', () => {
    assert.match(MIGRATION, /'image-editor-results',\s*\n\s*false,/)
  })

  test('the migration refuses to finish if it is public', () => {
    assert.match(MIGRATION, /bucket is PUBLIC — refusing/)
  })

  test('accepts PNG only, which is all the route produces', () => {
    assert.match(MIGRATION, /array\['image\/png'\]/)
  })

  test('no storage path ever reaches the browser', () => {
    // toHistoryResult strips it; the listing must not add it back.
    assert.ok(!/storage_path:/.test(code(LIST)))
  })

  test('reads are signed and short-lived, never public URLs', () => {
    assert.match(LIST, /createSignedUrls\(paths, SIGNED_URL_TTL_SECONDS\)/)
    assert.ok(!LIST.includes('getPublicUrl'), 'a public URL of a private picture is the whole hazard')
  })
})

describe('retention cannot be extended by a caller', () => {
  test('the PATCH route writes only `kept`', () => {
    const body = code(ITEM)
    assert.match(body, /\.update\(\{ kept \}\)/)
    assert.ok(!/expires_at:/.test(body), 'an endpoint that could move expires_at grants unlimited retention')
  })

  test('the studio route never writes expires_at either', () => {
    const studio = read('src/app/api/image-editor/studio/route.ts')
    assert.ok(!studio.includes('expires_at'), 'the seven days are the database\'s to set')
  })
})

describe('an expired result cannot be read DIRECTLY either', () => {
  /** One `create policy` block from the migration, by name. */
  const policy = (name: string) => {
    const at = MIGRATION.indexOf(`create policy ${name}\n`)
    assert.ok(at >= 0, `${name} is not in the migration`)
    const end = MIGRATION.indexOf(';', at)
    return MIGRATION.slice(at, end)
  }

  test('the table SELECT policy requires kept OR a future expiry', () => {
    const p = policy('image_editor_results_select_own')
    assert.match(p, /for select/)
    assert.match(p, /user_id = auth\.uid\(\)/, 'ownership is still required')
    assert.match(p, /kept or expires_at > now\(\)/,
      'the owner must not be able to read a row whose seven days have passed')
  })

  test('the storage SELECT policy requires the same of the object', () => {
    const p = policy('image_editor_results_storage_select')
    assert.match(p, /for select/)
    assert.match(p, /split_part\(name, '\/', 1\) = auth\.uid\(\)::text/, 'ownership is still required')
    assert.match(p, /from public\.image_editor_results r/,
      'the object is authorized against the row that names it')
    assert.match(p, /r\.storage_path = storage\.objects\.name/)
    assert.match(p, /r\.kept or r\.expires_at > now\(\)/,
      'an expired object must not be downloadable with the owner\'s own token')
  })

  test('Keep, Unkeep and Delete are NOT narrowed by expiry', () => {
    // A retention rule on UPDATE or DELETE would strand the row it is meant to
    // remove: the owner could not unkeep or delete something already expired,
    // and neither could the sweep.
    for (const name of [
      'image_editor_results_update_own',
      'image_editor_results_delete_own',
      'image_editor_results_storage_delete',
      'image_editor_results_storage_insert',
    ]) {
      assert.ok(!/expires_at/.test(policy(name)),
        `${name} must stay on ownership alone or an expired result becomes undeletable`)
    }
  })

  test('the migration refuses to finish if either SELECT rule loses the condition', () => {
    assert.match(MIGRATION, /image_editor_results_select_own does not enforce/)
    assert.match(MIGRATION, /image_editor_results_storage_select does not enforce/)
  })

  test('the listing route applies the same predicate', () => {
    // Same rule in both places, written once in retention.ts.
    assert.match(code(LIST), /\.or\(visibleFilter\(nowIso\)\)/)
    const retention = read('src/lib/imageEditor/retention.ts')
    assert.match(retention, /kept\.eq\.true,expires_at\.gt\.\$\{nowIso\}/)
  })
})

describe('deleting an employee cannot orphan their objects', () => {
  test('the owner reference RESTRICTS rather than cascades', () => {
    assert.match(MIGRATION, /references public\.users\(id\) on delete restrict/)
    assert.ok(!/references public\.users\(id\) on delete cascade/.test(MIGRATION),
      'a cascade would delete the only record of where each object lives')
    assert.match(MIGRATION, /does not RESTRICT on delete/, 'and the migration asserts it')
  })

  test('the permanent-delete route empties the history FIRST', () => {
    const body = code(PURGE)
    const purgeAt = body.indexOf('purgeUserResults')
    assert.ok(purgeAt >= 0, 'the one route that removes a member must empty their results')

    // Before every other destructive statement, not merely before the user row:
    // a half-deleted member is worse than one who is still here.
    for (const table of ['notifications', 'password_reset_log', 'tasks', 'task_activity_log', 'users']) {
      const deleteAt = body.indexOf(`from('${table}')`)
      if (deleteAt < 0) continue
      assert.ok(purgeAt < deleteAt,
        `the purge must run before anything touches ${table}`)
    }
  })

  test('a failed purge stops the deletion instead of reporting success', () => {
    const body = code(PURGE)
    assert.match(body, /if \(!purge\.ok\)/)
    const guardAt = body.indexOf('if (!purge.ok)')
    assert.ok(
      guardAt < body.indexOf("from('users')\n    .delete()"),
      'nothing may be deleted once the purge has failed',
    )
    assert.match(body, /status: 500/)
  })
})
