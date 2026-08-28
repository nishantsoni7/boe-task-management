/**
 * The trusted upload route, and the boundary it creates.
 *
 * WHY SOURCE-SHAPE ASSERTIONS. This route is where a browser stops being
 * trusted, and most of what it guarantees is a guarantee about ORDER or about
 * ABSENCE:
 *
 *   * the caller is authenticated and permission-checked BEFORE anything is read;
 *   * the request is read through the CALLER's RLS, not the server's;
 *   * the bytes are inspected BEFORE anything is stored;
 *   * the object key is generated here and never taken from the body;
 *   * the stored mime_type and byte_size come from the inspection;
 *   * the object is removed again if the metadata insert fails;
 *   * the service-role credential exists only on this side.
 *
 * Reaching those behaviourally would need a live Supabase project, a real
 * bucket and a signed-in session, which this phase may not touch. The pure logic
 * underneath — the byte inspector and the filename sanitiser — is unit-tested
 * for real in imageBytes.test.ts and below.
 *
 * Reads repository files only. No database, no network, no storage.
 *
 * Run:
 *   npx tsx --test src/lib/customerReviews/uploadRoute.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { sanitizeDisplayName } from '@/app/api/customer-reviews/photos/route'

const ROOT = process.cwd()

/** Source with its comments removed — the route DOCUMENTS what it refuses, and
 *  a search over raw text would match the prose promising the very property it
 *  is meant to verify. */
const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter(line => !line.trim().startsWith('//'))
    .join('\n')

const ROUTE_PATH = 'src/app/api/customer-reviews/photos/route.ts'
const raw = readFileSync(join(ROOT, ROUTE_PATH), 'utf8')
const route = stripComments(raw)

const manager = stripComments(
  readFileSync(join(ROOT, 'src/components/customerReviews/PhotoManager.tsx'), 'utf8'),
)

const migration = readFileSync(
  join(ROOT, 'supabase/migrations/20261017000000_customer_review_outreach.sql'), 'utf8',
).replace(/\r\n/g, '\n')
const sql = migration.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')

// ── 1. It exists where the client calls it ──────────────────────────────────

describe('the endpoint', () => {
  test('is a POST route at /api/customer-reviews/photos', () => {
    assert.ok(existsSync(join(ROOT, ROUTE_PATH)))
    assert.ok(route.includes('export async function POST'))
  })

  test('runs on Node, because it reads and hashes bytes', () => {
    assert.ok(route.includes("export const runtime = 'nodejs'"))
  })

  test('it is the ONLY route this module adds', () => {
    const apiDir = join(ROOT, 'src/app/api/customer-reviews')
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) walk(path, out)
        else if (entry.name === 'route.ts') out.push(path)
      }
      return out
    }
    assert.equal(walk(apiDir).length, 1, 'this is an upload route, not a media service')
  })

  test('and it is the only place the client posts a file', () => {
    assert.ok(manager.includes("fetch('/api/customer-reviews/photos', { method: 'POST', body })"))
    // The browser no longer writes an object or a row itself.
    assert.equal(manager.includes('.storage'), true, 'reading is still direct')
    assert.equal(/\.storage[\s\S]{0,60}\.upload\(/.test(manager), false, 'the browser must not upload')
    assert.equal(
      /from\('customer_review_request_photos'\)[\s\S]{0,40}\.insert\(/.test(manager), false,
      'the browser must not insert metadata',
    )
  })
})

// ── 2. Authentication and permission, before anything else ──────────────────

describe('who may call it', () => {
  test('the caller is identified from their own session, not from a header token', () => {
    assert.ok(route.includes("const caller = await createClient()"))
    assert.ok(route.includes('await caller.auth.getUser()'))
    assert.ok(route.includes('if (authError || !user) return fail(401'))
  })

  test('an inactive employee is refused', () => {
    assert.ok(route.includes("if (!profile || profile.is_active !== true) return fail(403"))
  })

  test('customer_review_requests.use is resolved for them', () => {
    assert.ok(route.includes("p_module_key: 'customer_review_requests'"))
    assert.ok(route.includes("p_action_key: 'use'"))
    assert.ok(route.includes('if (allowed !== true) return fail(403'))
  })

  test('THE PERMISSION CHECK COMES BEFORE THE BODY IS READ', () => {
    // Otherwise an unauthorized caller could make the server buffer a 5 MB
    // upload before being told no.
    assert.ok(route.indexOf("p_action_key: 'use'") < route.indexOf('await req.formData()'))
  })

  test('the request is read through the CALLER, so RLS decides visibility', () => {
    // Reading it with the service role would answer "does this row exist"
    // instead of "may this person see it".
    assert.ok(route.includes("await caller\n    .from('customer_review_requests')")
      || route.includes("caller\n    .from('customer_review_requests')"))
    assert.ok(route.includes('if (!request) return fail(404'))
  })

  test('a non-owner who is not an admin is refused', () => {
    assert.ok(route.includes('if (!isOwner && !isAdmin) return fail(403'))
  })

  test('the kind decides which statuses are allowed', () => {
    assert.ok(route.includes("if (kind === 'project_photo')"))
    assert.ok(route.includes("request.status !== 'draft' && request.status !== 'ready_to_send'"))
    assert.ok(route.includes("request.status !== 'sent' && request.status !== 'customer_responded'"))
  })
})

// ── 3. The bytes ────────────────────────────────────────────────────────────

describe('the file itself', () => {
  test('the declared size is refused first, and the REAL length checked after', () => {
    assert.ok(route.includes('(file as File).size > REVIEW_PHOTO_MAX_BYTES'))
    assert.ok(route.includes('inspectImageBytes(bytes, REVIEW_PHOTO_MAX_BYTES)'))
  })

  test('INSPECTION HAPPENS BEFORE ANYTHING IS STORED', () => {
    assert.ok(
      route.indexOf('inspectImageBytes(') < route.indexOf('.upload('),
      'the upload must not precede the inspection',
    )
  })

  test('a rejection returns the inspector’s prewritten sentence and nothing else', () => {
    assert.ok(route.includes('IMAGE_REJECTION_MESSAGES[inspection.reason]'))
  })

  test('the STORED type and size come from the inspection, never from the client', () => {
    assert.ok(route.includes('mime_type: inspection.mime'))
    assert.ok(route.includes('byte_size: bytes.length'))
    assert.equal(/mime_type:\s*file\.type|byte_size:\s*file\.size/.test(route), false)
  })

  test('the object is uploaded with the inspected content type', () => {
    assert.ok(route.includes('contentType: inspection.mime'))
    assert.ok(route.includes('upsert: false'))
  })
})

// ── 4. The path ─────────────────────────────────────────────────────────────

describe('where the bytes land is decided by the server', () => {
  test('the key is generated here, from the request id and a fresh uuid', () => {
    assert.ok(route.includes('const storagePath = `${requestId}/${kind}/${randomUUID()}.${extension}`'))
  })

  test('NO PATH, BUCKET OR KEY IS EVER TAKEN FROM THE BODY', () => {
    for (const field of ['storagePath', 'storage_path', 'path', 'bucket', 'key']) {
      assert.equal(
        route.includes(`form.get('${field}')`), false,
        `the body must not carry ${field}`,
      )
    }
    // The three things it does read, and nothing more.
    const reads = [...route.matchAll(/form\.get\('(\w+)'\)/g)].map(m => m[1]).sort()
    assert.deepEqual(reads, ['file', 'kind', 'requestId'])
  })

  test('the request id must be a uuid before it reaches a query or a path', () => {
    assert.ok(route.includes('!UUID_RE.test(rawId)'))
  })

  test('the kind is checked against a closed list', () => {
    assert.ok(route.includes("const KINDS = ['project_photo', 'review_proof'] as const"))
    assert.ok(route.includes('!(KINDS as readonly string[]).includes(rawKind)'))
  })

  test('uploaded_by is the authenticated user, not a field', () => {
    assert.ok(route.includes('uploaded_by: user.id'))
    assert.equal(route.includes("form.get('uploaded_by')"), false)
  })
})

// ── 5. Cleanup and duplicates ───────────────────────────────────────────────

describe('nothing is left behind', () => {
  test('a failed metadata insert removes the object again', () => {
    const failureBranch = route.slice(route.indexOf('if (rowError || !row)'))
    assert.ok(failureBranch.includes('.remove([storagePath])'))
    assert.ok(failureBranch.indexOf('.remove([storagePath])') < failureBranch.indexOf('return fail'))
  })

  test('a repeated upload is answered by CONTENT, not by a timer', () => {
    assert.ok(route.includes("createHash('sha256').update(bytes).digest('hex')"))
    assert.ok(route.includes('row.content_sha256 === digest'))
    assert.ok(route.includes('MESSAGES.duplicate'))
    // And the database refuses it too, whatever raced with what.
    assert.ok(sql.includes('constraint customer_review_photos_unique_content_per_request'))
  })

  test('the per-request count limit is enforced server-side', () => {
    assert.ok(route.includes('sameKind.length >= limit'))
    assert.ok(route.includes('MAX_PROJECT_PHOTOS'))
  })
})

// ── 6. What it says back ────────────────────────────────────────────────────

describe('errors are safe', () => {
  test('every message is chosen from a closed list', () => {
    assert.ok(route.includes('const MESSAGES = {'))
    // fail() is only ever called with a MESSAGES member or an inspector message.
    // Every value fail() is handed must be a member of one of the two closed
    // maps. A ternary between two members is still two members; anything that
    // is not a member — a template, a concatenation, an error's own text — is
    // what this refuses.
    for (const match of route.matchAll(/fail\(\d+,([\s\S]*?)\)\s*$/gm)) {
      const tokens = match[1].split(/\?|:/).map(t => t.trim()).filter(Boolean)
      for (const token of tokens) {
        // The condition of a ternary is not a message.
        if (/^kind ===|^inspection\.reason ===/.test(token)) continue
        assert.ok(
          token.startsWith('MESSAGES.') || token.startsWith('IMAGE_REJECTION_MESSAGES'),
          `fail() called with something that is not a prewritten message: ${token}`,
        )
      }
    }
  })

  test('no response or log carries a filename, a path, a number or a token', () => {
    for (const leak of ['displayName', 'storagePath', 'whatsapp', 'customer_name', 'signedUrl', 'SUPABASE_SERVICE_ROLE_KEY']) {
      assert.equal(
        new RegExp(`fail\\([^)]*${leak}`).test(route), false,
        `a failure response mentions ${leak}`,
      )
    }
    // The one console line names ENV VARIABLE NAMES, never values or content.
    const logs = [...route.matchAll(/console\.\w+\(([^\n]*)/g)].map(m => m[1])
    assert.equal(logs.length, 1)
    assert.ok(logs[0].includes('admin.missing.join'))
  })

  test('private answers are never cached', () => {
    assert.ok(route.includes("'Cache-Control': 'no-store, private'"))
  })

  test('a missing service-role credential is a handled result, not a throw', () => {
    assert.ok(route.includes('const admin = adminClient()'))
    assert.ok(route.includes('if (!admin.ok)'))
    assert.ok(route.includes('MESSAGES.unavailable'))
  })

  test('THE SERVICE-ROLE KEY EXISTS ONLY ON THIS SIDE', () => {
    // adminClient() reads process.env.SUPABASE_SERVICE_ROLE_KEY, which Next does
    // not inline into a client bundle — and the route carries no 'use client'.
    assert.equal(raw.includes("'use client'"), false)
    assert.equal(manager.includes('adminClient'), false)
    assert.equal(manager.includes('SERVICE_ROLE'), false)
  })
})

// ── 7. The database half of the boundary ────────────────────────────────────

describe('a client cannot go around the route', () => {
  test('there is no storage INSERT policy for this bucket', () => {
    assert.equal(sql.includes('create policy "customer_review_photos_storage_insert"'), false)
  })

  test('there is no metadata INSERT policy either', () => {
    assert.equal(sql.includes('create policy "customer_review_photos_insert"'), false)
  })

  test('and the INSERT privilege is revoked, so a policy added later still fails', () => {
    assert.ok(sql.includes(
      'revoke insert, update, truncate on public.customer_review_request_photos from authenticated, anon',
    ))
  })

  test('the migration ASSERTS all of that at apply time', () => {
    const assertions = sql.slice(sql.indexOf('do $$'))
    assert.ok(assertions.includes('only the trusted upload route may register an image'))
    assert.ok(assertions.includes('a client INSERT policy exists on the customer-review-photos bucket'))
    assert.ok(assertions.includes("has_table_privilege('authenticated', 'public.customer_review_request_photos', 'INSERT')"))
  })

  test('reading is still the client’s, through short-lived signed URLs', () => {
    assert.ok(sql.includes('create policy "customer_review_photos_storage_select"'))
    assert.ok(manager.includes('createSignedUrls(paths, SIGNED_URL_TTL_SECONDS)'))
    assert.ok(manager.includes('const SIGNED_URL_TTL_SECONDS = 300'))
  })

  test('removing is still the client’s, so the compensation path needs no server', () => {
    assert.ok(sql.includes('create policy "customer_review_photos_delete"'))
    assert.ok(sql.includes('create policy "customer_review_photos_storage_delete"'))
  })
})

// ── 8. The one pure function the route exports ──────────────────────────────

describe('the stored filename', () => {
  test('path separators and traversal cannot survive it', () => {
    assert.equal(sanitizeDisplayName('../../../etc/passwd'), 'etc passwd')
    assert.equal(sanitizeDisplayName('a/b/c.jpg'), 'a b c.jpg')
    assert.equal(sanitizeDisplayName('..\\..\\windows\\system32'), 'windows system32')
  })

  test('control characters are removed entirely', () => {
    const nasty = `photo${String.fromCharCode(0)}${String.fromCharCode(27)}.jpg`
    const cleaned = sanitizeDisplayName(nasty)
    assert.equal(cleaned, 'photo.jpg')
    for (const ch of cleaned) {
      const code = ch.codePointAt(0) ?? 0
      assert.ok(code >= 0x20 && code !== 0x7f)
    }
  })

  test('it is bounded, so it cannot overflow the column after the object landed', () => {
    assert.equal(sanitizeDisplayName('x'.repeat(500)).length, 120)
  })

  test('a name that sanitises to nothing becomes a constant, never empty', () => {
    // file_name is NOT NULL with a non-blank CHECK; an empty value would fail
    // the insert after the object had already been stored.
    for (const input of ['', '   ', '///', String.fromCharCode(0)]) {
      assert.equal(sanitizeDisplayName(input), 'photo')
    }
  })

  test('an ordinary filename is left alone', () => {
    assert.equal(sanitizeDisplayName('café chairs 2026.jpg'), 'café chairs 2026.jpg')
  })
})
