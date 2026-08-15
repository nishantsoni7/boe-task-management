/**
 * Task attachment storage — behavioural tests, plus repository and migration
 * assertions.
 *
 * `task-attachments` was the only PUBLIC bucket in the project, and its
 * storage.objects SELECT policy was `bucket_id = 'task-attachments'` to PUBLIC,
 * with no task, ownership or role check. 519 attachment rows across three
 * surfaces were readable by anyone holding a URL, without a session.
 *
 * Reads files only. No DB, no network, no writes.
 *
 * Run:
 *   npx tsx --test src/lib/tasks/attachmentStorage.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SIGNED_URL_TTL_SECONDS,
  storagePathFromUrl,
  resolveAttachmentPath,
  buildTaskAttachmentPath,
} from './attachmentStorage'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const SCHEMA  = read('supabase/migrations/20260906000000_task_attachment_storage_path.sql')
const PRIVATE = read('supabase/migrations/20260907000000_task_attachments_private_bucket.sql')
const GATES   = read('supabase/migrations/20260905000000_module_view_parent_gates.sql')

// The two real path shapes in production: 215 rows under tasks/, 254 under
// updates/.
const REF = 'https://albnsrohngkljfsrrrhf.supabase.co'
const publicUrl = (p: string) => `${REF}/storage/v1/object/public/task-attachments/${p}`

// ── Backfill parsing ────────────────────────────────────────────────────────

describe('legacy URL parsing matches what the migration backfills', () => {
  test('both production path shapes parse', () => {
    assert.equal(
      storagePathFromUrl(publicUrl('tasks/006b0b54-878f-498e-a36c-212b32b/photo.png')),
      'tasks/006b0b54-878f-498e-a36c-212b32b/photo.png',
    )
    assert.equal(
      storagePathFromUrl(publicUrl('updates/abc-123/1723713600000_k3j.pdf')),
      'updates/abc-123/1723713600000_k3j.pdf',
    )
  })

  test('a query string is stripped, matching split_part on the marker', () => {
    assert.equal(storagePathFromUrl(publicUrl('tasks/a/b.png?t=1')), 'tasks/a/b.png')
  })

  test('anything that is not a task-attachments public URL yields null', () => {
    assert.equal(storagePathFromUrl(null), null)
    assert.equal(storagePathFromUrl(undefined), null)
    assert.equal(storagePathFromUrl(''), null)
    assert.equal(storagePathFromUrl('https://example.com/x.png'), null)
    assert.equal(storagePathFromUrl(`${REF}/storage/v1/object/public/payment-proofs/x.png`), null)
    assert.equal(storagePathFromUrl(publicUrl('')), null)
  })

  test('a signed URL is not mistaken for a public one', () => {
    const signed = `${REF}/storage/v1/object/sign/task-attachments/tasks/a/b.png?token=xyz`
    assert.equal(storagePathFromUrl(signed), null)
  })
})

describe('resolveAttachmentPath prefers the stored path', () => {
  test('storage_path wins over a legacy url', () => {
    assert.equal(
      resolveAttachmentPath({ storage_path: 'tasks/a/new.png', url: publicUrl('tasks/a/old.png') }),
      'tasks/a/new.png',
    )
  })

  test('the two legacy columns are both understood', () => {
    assert.equal(
      resolveAttachmentPath({ attachment_storage_path: 'tasks/a/x.png' }),
      'tasks/a/x.png',
    )
    assert.equal(
      resolveAttachmentPath({ attachment_url: publicUrl('tasks/a/y.png') }),
      'tasks/a/y.png',
    )
  })

  test('falls back to parsing only when no path is stored', () => {
    assert.equal(resolveAttachmentPath({ url: publicUrl('updates/t/z.pdf') }), 'updates/t/z.pdf')
  })

  test('nothing resolvable yields null rather than a guess', () => {
    assert.equal(resolveAttachmentPath(null), null)
    assert.equal(resolveAttachmentPath({}), null)
    assert.equal(resolveAttachmentPath({ url: 'https://elsewhere/x.png' }), null)
  })
})

describe('new uploads never mint a permanent public URL', () => {
  test('the module exports no public-URL builder', () => {
    const lib = read('src/lib/tasks/attachmentStorage.ts')
    assert.equal(lib.includes('getPublicUrl'), false, 'nothing here may build a public URL')
    assert.ok(lib.includes('createSignedUrl'))
    assert.ok(lib.includes('createSignedUrls'))
  })

  test('uploadTaskAttachment returns a path and no URL', () => {
    const lib = read('src/lib/tasks/attachmentStorage.ts')
    const fn = lib.slice(lib.indexOf('export async function uploadTaskAttachment'))
    assert.ok(fn.includes('{ ok: true; path: string }'))
    assert.equal(/return\s*\{\s*ok:\s*true[^}]*url/.test(fn), false, 'must not return a URL')
  })

  test('signed URLs are short-lived', () => {
    assert.ok(SIGNED_URL_TTL_SECONDS <= 900, 'a signed URL must expire quickly')
    assert.ok(SIGNED_URL_TTL_SECONDS >= 60)
  })

  test('paths are namespaced by task, so one task cannot collide with another', () => {
    const p = buildTaskAttachmentPath('task-1', 'a.png', () => 'rr', () => 1000)
    assert.equal(p, 'tasks/task-1/1000_rr.png')
    assert.ok(buildTaskAttachmentPath('t', 'noext').endsWith('.bin'))
  })

  test('every upload call site records storage_path', () => {
    for (const f of [
      'src/app/tasks/create/page.tsx',
      'src/app/tasks/create-self/page.tsx',
      'src/app/tasks/my/page.tsx',
      'src/app/tasks/assigned-by-me/page.tsx',
      'src/app/tasks/quotation-requests/new/page.tsx',
    ]) {
      const src = read(f)
      assert.ok(src.includes('storage_path: path,'), `${f} must record the object path`)
    }
  })

  test('comment attachments carry their path into the row', () => {
    const lib = read('src/lib/tasks/commentAttachments.ts')
    assert.ok(lib.includes('storage_path:    a.path as string'))
    assert.ok(
      lib.includes("a.status === 'uploaded' && a.url && a.path"),
      'a row without an object key must not be written',
    )
  })

  test('deletion uses the stored path, never a URL', () => {
    const lib = read('src/lib/tasks/attachmentStorage.ts')
    const fn = lib.slice(lib.indexOf('export async function removeTaskAttachment'))
    assert.ok(fn.includes('.remove([path])'))
  })
})

// ── The migrations ──────────────────────────────────────────────────────────

describe('the schema + backfill migration', () => {
  test('all three URL-bearing surfaces get a path column', () => {
    assert.ok(SCHEMA.includes('public.task_attachments\n  ADD COLUMN IF NOT EXISTS storage_path'))
    assert.ok(SCHEMA.includes('public.tasks\n  ADD COLUMN IF NOT EXISTS attachment_storage_path'))
    assert.ok(SCHEMA.includes('public.task_activity_log\n  ADD COLUMN IF NOT EXISTS attachment_storage_path'))
  })

  test('all three are backfilled and all three are asserted', () => {
    assert.equal((SCHEMA.match(/split_part\(/g) ?? []).length >= 3, true)
    for (const t of ['public.task_attachments', 'public.tasks', 'public.task_activity_log']) {
      assert.ok(SCHEMA.includes(t), `${t} must be backfilled`)
    }
    assert.ok(SCHEMA.includes('could not be mapped to a storage path'))
    assert.ok(SCHEMA.includes('RAISE EXCEPTION'))
  })

  test('the unrestricted public read is dropped and replaced task-aware', () => {
    assert.ok(SCHEMA.includes('DROP POLICY IF EXISTS "public_read" ON storage.objects'))
    assert.ok(SCHEMA.includes('CREATE POLICY "task_attachments_storage_select"'))
    assert.ok(SCHEMA.includes("IF EXISTS (\n    SELECT 1 FROM pg_policy p"))
  })

  test('storage access requires the parent module gate AND parent-task access', () => {
    const sel = SCHEMA.slice(
      SCHEMA.indexOf('CREATE POLICY "task_attachments_storage_select"'),
      SCHEMA.indexOf('DROP POLICY IF EXISTS "auth_delete"'),
    )
    assert.ok(sel.includes("module_entry_open('task_management')"), 'disabled users must be blocked')
    assert.ok(sel.includes('t.created_by'))
    assert.ok(sel.includes('t.assigned_to'))
    assert.ok(sel.includes('t.delegated_by'))
    assert.ok(sel.includes("u.role = 'admin'"), 'System Admin stays authorized')
    assert.ok(sel.includes('owner = auth.uid()'), 'the uploader can reach a not-yet-referenced object')
  })

  test('knowing a path is not enough — the row must join to a task you can see', () => {
    const sel = SCHEMA.slice(
      SCHEMA.indexOf('CREATE POLICY "task_attachments_storage_select"'),
      SCHEMA.indexOf('DROP POLICY IF EXISTS "auth_delete"'),
    )
    // The only path-keyed branches are joined to tasks and filtered by identity.
    assert.ok(sel.includes('a.storage_path = storage.objects.name'))
    assert.ok(sel.includes('JOIN public.tasks t ON t.id = a.task_id'))
    assert.equal(
      /name\s*=\s*name|USING \(\s*bucket_id = 'task-attachments'\s*\)/.test(sel),
      false,
      'there must be no unconditional branch',
    )
  })

  test('no other bucket is touched, and that is asserted', () => {
    for (const other of ['asset-documents', 'payment-proofs', 'order-request-attachments', 'meeting-product-images']) {
      assert.equal(
        SCHEMA.includes(`bucket_id = '${other}'`), false,
        `${other} must not be re-policied here`,
      )
    }
    assert.ok(SCHEMA.includes('Other buckets must be untouched'))
  })

  test('the bucket is still public after this step — the break comes later', () => {
    assert.equal(SCHEMA.includes('SET public = false'), false)
  })
})

describe('the private-bucket migration is separate and guarded', () => {
  test('it flips only task-attachments', () => {
    assert.ok(PRIVATE.includes('SET public = false'))
    assert.ok(PRIVATE.includes("WHERE id = 'task-attachments'"))
    assert.equal((PRIVATE.match(/UPDATE storage\.buckets/g) ?? []).length, 1)
  })

  test('it refuses to run before the backfill, across all three surfaces', () => {
    assert.ok(PRIVATE.includes('Refusing to make the bucket private'))
    for (const t of ['public.task_attachments', 'public.tasks', 'public.task_activity_log']) {
      assert.ok(PRIVATE.includes(t), `${t} must be checked before the flip`)
    }
  })

  test('it refuses to run before the task-aware policy exists', () => {
    assert.ok(PRIVATE.includes("p.polname = 'task_attachments_storage_select'"))
    assert.ok(PRIVATE.includes('apply 20260906000000 first'))
  })

  test('it grants nothing and alters no permission', () => {
    assert.equal(/insert\s+into/i.test(PRIVATE), false)
    for (const t of ['employee_permission_overrides', 'role_permissions', 'department_permissions']) {
      assert.equal(PRIVATE.includes(t), false, `must not touch ${t}`)
    }
  })
})

// ── Phase A gates ───────────────────────────────────────────────────────────

describe('module view parent gates', () => {
  test('the gate is admin-or-view and cannot write', () => {
    assert.ok(GATES.includes('CREATE OR REPLACE FUNCTION public.module_entry_open(p_module_key text)'))
    assert.ok(GATES.includes("resolve_permission(auth.uid(), p_module_key, 'view')"))
    assert.ok(GATES.includes("u.role = 'admin'"))
    const fn = GATES.slice(GATES.indexOf('CREATE OR REPLACE FUNCTION'), GATES.indexOf('COMMENT ON FUNCTION'))
    assert.ok(fn.includes('STABLE'))
  })

  test('gates are RESTRICTIVE, so no permissive rule can route around them', () => {
    assert.ok(GATES.includes('AS RESTRICTIVE FOR ALL TO authenticated'))
    assert.ok(GATES.includes('would grant access'), 'a permissive gate must fail the migration')
  })

  test('the five gated modules cover their data tables', () => {
    for (const t of [
      'tasks', 'task_attachments', 'task_activity_log', 'user_top_tasks',
      'assets', 'employee_assets', 'access_records',
      'meetings', 'meeting_attendees',
      'orders', 'order_requests', 'order_request_attachments',
      'finance_payment_requests', 'payment_proof_attachments',
    ]) {
      assert.ok(GATES.includes(`'${t}'`), `${t} must be gated`)
    }
  })

  test('the three unsafe modules are documented and asserted OUT', () => {
    for (const t of ['users', 'showroom_products', 'daily_work_logs', 'performance_app_opens']) {
      assert.ok(GATES.includes(`'${t}'`), `${t} must be named in the do-not-gate assertion`)
    }
    assert.ok(GATES.includes('must NOT be gated without a product decision'))
  })

  test('no existing policy is dropped or rewritten', () => {
    assert.equal(/DROP POLICY IF EXISTS "(?!.*_module_entry_gate)/.test(GATES), false)
    assert.equal(GATES.includes('employee_permission_overrides'), false)
  })

  test('view_all is never treated as a substitute for view', () => {
    assert.equal(GATES.includes("'view_all'"), false, 'the gate resolves view, and only view')
  })
})
