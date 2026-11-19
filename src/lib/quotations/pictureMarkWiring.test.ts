// Logo marks on quotation pictures (owner, 18 Nov 2026): who writes where, and who reads the clean original.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { storedPictureProblem } from './pictureStore'

const read = (p: string) => readFileSync(p, 'utf8')
const ME = '0370f30b-d0b8-43d1-999a-e2f6487e8213'
const FILE = '8c2d5b6e-1d3a-4f6b-9a77-2b1c9d0e4f11'

describe('storedPictureProblem', () => {
  test('accepts the caller’s own folder and a .jpg', () => {
    assert.equal(storedPictureProblem(`${ME}/${FILE}.jpg`, ME), null)
  })
  test('refuses another person’s folder, a wrong shape, and a path with ..', () => {
    assert.match(storedPictureProblem(`${FILE}/${FILE}.jpg`, ME) ?? '', /uploaded/)
    for (const bad of [`${ME}/${FILE}.png`, `${ME}/../${FILE}.jpg`, `${ME}/x.jpg`, '', null, 42, `/${ME}/${FILE}.jpg`]) {
      assert.match(storedPictureProblem(bad, ME) ?? '', /not valid/, String(bad))
    }
  })
})

describe('where pictures are written and read', () => {
  const api = read('src/lib/quotations/api.ts')
  const mark = read('src/app/api/quotations/picture-mark/route.ts')
  const studio = read('src/app/api/quotations/picture/route.ts')
  const pi = read('src/lib/quotations/toPiDraft.ts')
  test('an upload stores the clean picture in the private bucket, then asks the server for the marked copy', () => {
    const up = api.slice(api.indexOf('export async function uploadPicture'), api.indexOf('/** An absolute, public address'))
    const original = up.indexOf('storage.from(ORIGINALS_BUCKET).upload(')
    const ask = up.indexOf("fetch('/api/quotations/picture-mark'")
    assert.ok(original > 0 && ask > original)
    assert.ok(!up.includes('QUOTATION_BUCKET'), 'the browser never writes the public bucket')
  })
  test('the mark route reads the original as the caller and writes the marked copy at the same path', () => {
    assert.ok(mark.includes("s.storage.from('quotation-originals').download(path as string)"))
    assert.ok(mark.includes("s.storage.from('quotation-images').upload(path as string, marked,"))
    assert.ok(mark.includes('storedPictureProblem(path, user.id)'))
    assert.ok(mark.includes('quotation_my_access'))
  })
  test('the image studio reads the clean original and stores both copies', () => {
    assert.ok(studio.includes('storage.from(ORIGINALS_BUCKET).download(sourcePath)'))
    assert.ok(studio.includes('storage.from(ORIGINALS_BUCKET).upload(path, out,'))
    assert.ok(studio.includes('markPicture(out)'))
    assert.ok(!studio.includes("from('quotation-images').download"))
  })
  test('the PI draft takes the clean original, never the marked client copy', () => {
    assert.ok(pi.includes('s.storage.from(ORIGINALS_BUCKET).download(p)'))
    assert.ok(pi.includes('s.storage.from(ORIGINALS_BUCKET).download(path)'))
    assert.ok(!pi.includes('pictureUrl('))
  })
})

describe('the migration', () => {
  const sql = read('supabase/migrations/20270806000000_quotation_picture_originals.sql')
  test('a private bucket, insert like the public one, select for people who may enter Quotations, no delete', () => {
    assert.match(sql, /values \('quotation-originals', 'quotation-originals', false, 3145728, array\['image\/jpeg'\]\)/)
    assert.match(sql, /for insert to authenticated\s+with check \(bucket_id = 'quotation-originals' and public\.quotation_can_upload\(name\)\)/)
    assert.match(sql, /for select to authenticated\s+using \(bucket_id = 'quotation-originals' and public\.module_entry_open\('quotations'\)\)/)
    assert.ok(!/for (update|delete)/.test(sql))
    assert.ok(!/update public\.|delete from public\./i.test(sql), 'no table row changes')
  })
})

describe('the backfill script', () => {
  const script = read('scripts/quotations/mark-existing-pictures.ts')
  test('copies the original first, always marks from the original, and never prints the key', () => {
    assert.ok(script.indexOf('upload(path, bytes') < script.indexOf('markPicture(Buffer.from(await original.data.arrayBuffer()))'))
    assert.ok(script.includes('upsert: true'))
    // The variable's name may appear in a message; its value must never reach a console call.
    assert.ok(!/console\.(log|error)\([^)]*(\$\{key\}|, key\b)/.test(script))
    assert.ok(script.includes('--safety-dir'))
  })
})
