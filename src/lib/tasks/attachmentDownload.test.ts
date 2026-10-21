/**
 * Attachment preview — Download and Open in Tab keep the original filename.
 *
 * The Download button used to fetch the file, build a blob URL and revoke it in
 * the same tick as the click; on a large workbook that cancelled the save
 * without an error. And Open in Tab went straight to a signed URL, which storage
 * names by its generated key. Both now go through a signed URL that carries the
 * original filename.
 *
 * Reads files only. No DB, no network, no writes.
 *
 * Run:
 *   npx tsx --test src/lib/tasks/attachmentDownload.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import { signAttachmentUrl, SIGNED_URL_TTL_SECONDS } from './attachmentStorage'

const ROOT = join(__dirname, '..', '..', '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')

function fakeSupabase(calls: unknown[][]): SupabaseClient {
  return {
    storage: {
      from: () => ({
        createSignedUrl: async (...args: unknown[]) => {
          calls.push(args)
          return { data: { signedUrl: 'https://signed.example/x' }, error: null }
        },
      }),
    },
  } as unknown as SupabaseClient
}

describe('signAttachmentUrl', () => {
  test('without a filename it asks for a plain signed URL, as before', async () => {
    const calls: unknown[][] = []
    await signAttachmentUrl(fakeSupabase(calls), 'tasks/1/a.xlsx')
    assert.deepEqual(calls, [['tasks/1/a.xlsx', SIGNED_URL_TTL_SECONDS, undefined]])
  })

  test('with a filename it asks storage to send it as the download name', async () => {
    const calls: unknown[][] = []
    await signAttachmentUrl(fakeSupabase(calls), 'tasks/1/a.xlsx', SIGNED_URL_TTL_SECONDS, 'Mr. Mishra (x).xlsx')
    assert.deepEqual(calls, [['tasks/1/a.xlsx', SIGNED_URL_TTL_SECONDS, { download: 'Mr. Mishra (x).xlsx' }]])
  })
})

describe('the preview modal', () => {
  const modal = read('src/components/ui/AttachmentPreviewModal.tsx')
  const page  = read('src/app/tasks/[id]/page.tsx')

  test('Download prefers a fresh filename-bearing URL and never revokes in the click tick', () => {
    assert.ok(modal.includes('const fresh = getDownloadUrl ? await getDownloadUrl().catch(() => null) : null'))
    assert.ok(modal.includes('onClick={handleDownload}'))
    assert.equal(/a\.click\(\)\s*URL\.revokeObjectURL/.test(modal), false)
    assert.ok(modal.includes('setTimeout(() => URL.revokeObjectURL(blobUrl)'))
    assert.ok(modal.includes("if (!res.ok) throw new Error('Failed to fetch file')"))
  })

  test('the preview itself still renders from the plain URL', () => {
    assert.ok(modal.includes('src={url}'))
    assert.ok(modal.includes('encodeURIComponent(url)'))
    assert.ok(modal.includes('href={isImage || isPdf ? url : (downloadUrl ?? url)}'))
  })

  test('the task page signs a second URL carrying the filename and passes it down', () => {
    assert.ok(page.includes('signAttachmentUrl(supabase, previewAttachment.path)'))
    assert.ok(page.includes('previewAttachment.path, SIGNED_URL_TTL_SECONDS, previewAttachment.fileName'))
    assert.ok(page.includes('downloadUrl={previewDownloadUrl}'))
    assert.ok(page.includes('getDownloadUrl={() => signAttachmentUrl('))
  })
})
