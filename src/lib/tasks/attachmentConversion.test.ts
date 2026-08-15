/**
 * The signed-URL conversion, end to end.
 *
 * attachmentStorage.test.ts covers the pure helpers and the migrations. This
 * file covers the WIRING: that every surface which used to render a permanent
 * public URL now resolves a path and signs it, that nothing writes a public URL
 * any more, and that Meetings cannot create a task without Task Management.
 *
 * Repository files only. No DB, no network, no writes.
 *
 * Run:
 *   npx tsx --test src/lib/tasks/attachmentConversion.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  canonicalAttachmentRef,
  storagePathFromUrl,
  resolveAttachmentPath,
} from './attachmentStorage'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const SCHEMA  = read('supabase/migrations/20260906000000_task_attachment_storage_path.sql')
const PRIVATE = read('supabase/migrations/20260907000000_task_attachments_private_bucket.sql')

const UPLOAD_SITES = [
  'src/app/tasks/create/page.tsx',
  'src/app/tasks/create-self/page.tsx',
  'src/app/tasks/my/page.tsx',
  'src/app/tasks/assigned-by-me/page.tsx',
  'src/app/tasks/quotation-requests/new/page.tsx',
]

// ── The canonical reference for legacy NOT NULL columns ─────────────────────

describe('legacy columns never receive a public URL again', () => {
  test('the reference names the object without being fetchable', () => {
    const ref = canonicalAttachmentRef('tasks/t1/a.png')
    assert.equal(ref, 'storage://task-attachments/tasks/t1/a.png')
    assert.equal(ref.startsWith('http'), false, 'must not be a URL')
    assert.equal(ref.includes('/object/public/'), false)
  })

  test('it round-trips back to the path', () => {
    const p = 'updates/t2/17_x.pdf'
    assert.equal(storagePathFromUrl(canonicalAttachmentRef(p)), p)
    assert.equal(resolveAttachmentPath({ url: canonicalAttachmentRef(p) }), p)
  })

  test('every upload site writes the reference and never a public URL', () => {
    for (const f of UPLOAD_SITES) {
      const src = read(f)
      assert.ok(src.includes('canonicalAttachmentRef(path)'), `${f} must write a canonical ref`)
      assert.ok(src.includes('storage_path: path,'), `${f} must record the object path`)
      assert.equal(src.includes('getPublicUrl'), false, `${f} must not build a public URL`)
      assert.equal(src.includes('urlData.publicUrl'), false, `${f} must not store a public URL`)
    }
  })

  test('the comment queue mints a reference rather than a public URL', () => {
    const src = read('src/app/tasks/[id]/page.tsx')
    assert.ok(src.includes('publicUrl:    (path) => canonicalAttachmentRef(path),'))
    assert.equal(src.includes('getPublicUrl'), false)
  })
})

// ── Display, preview, download ──────────────────────────────────────────────

describe('every attachment surface renders from a signed URL', () => {
  const page = read('src/app/tasks/[id]/page.tsx')

  test('the preview modal is fed a signed URL, never a stored column', () => {
    assert.ok(page.includes('const [previewUrl, setPreviewUrl] = useState<string | null>(null)'))
    assert.ok(page.includes('signAttachmentUrl(supabase, previewAttachment.path)'))
    assert.ok(page.includes('{previewAttachment && previewUrl && ('))
    assert.ok(page.includes('url={previewUrl}'))
  })

  test('preview state carries a PATH, so a stored URL cannot reach the modal', () => {
    assert.ok(page.includes('useState<{ path: string; fileName?: string } | null>(null)'))
    assert.equal(page.includes('setPreviewAttachment({ url:'), false)
  })

  test('all three surfaces resolve through the shared resolver', () => {
    assert.ok(page.includes('const legacyTaskPath = resolveAttachmentPath(task)'))
    assert.ok(page.includes('resolveAttachmentPath(entry)'))
    assert.ok(page.includes('const p = resolveAttachmentPath(att)'))
  })

  test('de-duplication compares paths, not raw columns', () => {
    assert.equal(page.includes('a.url === task.attachment_url'), false)
    assert.equal(page.includes('a.url === entry.attachment_url'), false)
    assert.ok(page.includes('resolveAttachmentPath(a) === legacyTaskPath'))
  })

  test('an unauthorized signature yields no modal rather than a broken image', () => {
    const lib = read('src/lib/tasks/attachmentStorage.ts')
    assert.ok(lib.includes('if (error || !data?.signedUrl) return null'))
    assert.ok(page.includes('previewAttachment && previewUrl'))
  })

  test('no task page still renders an attachment from a stored URL', () => {
    for (const f of [
      'src/app/tasks/[id]/page.tsx',
      'src/app/tasks/my/page.tsx',
      'src/app/tasks/assigned-by-me/page.tsx',
    ]) {
      const src = read(f)
      assert.equal(
        /src=\{att\.url\}|src=\{task\.attachment_url|src=\{entry\.attachment_url/.test(src),
        false,
        f,
      )
    }
  })
})

// ── Copy ────────────────────────────────────────────────────────────────────

describe('copy carries paths and mints nothing public', () => {
  const route = read('src/app/api/tasks/[id]/copy/route.ts')

  test('it reads and writes storage_path on both surfaces', () => {
    assert.ok(route.includes("select('url, storage_path, file_name, file_type')"))
    assert.ok(route.includes('storage_path: path,'))
    assert.ok(route.includes('attachment_storage_path: copyLegacy ? legacyPath : null,'))
  })

  test('the copied legacy column is a canonical reference, not a URL', () => {
    assert.ok(route.includes('canonicalAttachmentRef(legacyPath!)'))
    assert.equal(route.includes('attachment_url:      legacyAttachmentUrl'), false)
  })

  test('de-duplication is by path', () => {
    assert.ok(route.includes('const attPaths = new Set('))
    assert.equal(route.includes('new Set((sourceAtts ?? []).map(a => a.url))'), false)
  })
})

describe('no service-role secret reaches client code', () => {
  test('the helper and the task pages hold no service key', () => {
    for (const f of [
      'src/lib/tasks/attachmentStorage.ts',
      'src/app/tasks/[id]/page.tsx',
      ...UPLOAD_SITES,
    ]) {
      assert.equal(read(f).includes('SERVICE_ROLE'), false, `${f} must not hold a service key`)
    }
  })

  test('signing uses the caller session, so Postgres is the authority', () => {
    const lib = read('src/lib/tasks/attachmentStorage.ts')
    assert.ok(lib.includes('supabase: SupabaseClient'))
    assert.equal(lib.includes('createClient('), false, 'no privileged client is constructed here')
  })
})

// ── Meetings → Task Management ──────────────────────────────────────────────

describe('Meetings Create Task requires task_management:view', () => {
  const screen = read('src/app/meetings/[id]/MeetingWorkScreen.tsx')

  test('the capability is resolved from the engine, deny-by-default', () => {
    assert.ok(screen.includes('const [canCreateTasks, setCanCreateTasks] = useState(false)'))
    assert.ok(screen.includes("hasPermission(supabase, profile.id, 'task_management', 'view')"))
    assert.ok(screen.includes("profile.role === 'admin'"))
    assert.ok(screen.includes('.catch(() => { if (active) setCanCreateTasks(false) })'))
  })

  test('the control is absent, not merely disabled, when unauthorized', () => {
    assert.ok(screen.includes('onCreateTask?: (item: MeetingOrderItem) => void'))
    assert.ok(screen.includes('{editable && !item.linked_task_id && onCreateTask && ('))
    assert.ok(screen.includes('onCreateTask={canCreateTasks ? (item => setModal('))
  })

  test('the modal cannot be opened without the grant either', () => {
    assert.ok(screen.includes("{modal.kind === 'create-task' && profile && canCreateTasks && ("))
  })

  test('the rest of Meetings is untouched', () => {
    for (const kind of ['add-order', 'item-update', 'complete', 'reopen', 'import']) {
      assert.ok(screen.includes(`'${kind}'`), `${kind} must still exist`)
    }
  })
})

// ── Deployment order ────────────────────────────────────────────────────────

describe('the release order is safe at every step', () => {
  test('906 is safe to apply BEFORE the new frontend is live', () => {
    assert.equal(SCHEMA.includes('SET public = false'), false)
    assert.ok(SCHEMA.includes('ADD COLUMN IF NOT EXISTS'))
    assert.equal(/DROP COLUMN|SET NOT NULL/.test(SCHEMA), false, 'nothing tightening may run yet')
  })

  test('907 re-runs the backfill, so rows created during the window still map', () => {
    assert.ok(PRIVATE.includes('Re-run the backfill'))
    assert.equal((PRIVATE.match(/SET storage_path = split_part/g) ?? []).length, 1)
    assert.equal((PRIVATE.match(/SET attachment_storage_path =/g) ?? []).length, 2)
  })

  test('907 still refuses if anything remains unmapped after that', () => {
    assert.ok(PRIVATE.includes('Refusing to make the bucket private'))
    assert.ok(PRIVATE.includes("p.polname = 'task_attachments_storage_select'"))
  })
})
