// Puts the Best of Exports mark on every quotation picture already stored (owner, 18 Nov 2026).
//
//   npx tsx --env-file=.env.local scripts/quotations/mark-existing-pictures.ts --safety-dir <folder> [--dry-run]
//
// For each object in the public 'quotation-images' bucket:
//   1. if the private 'quotation-originals' bucket has no copy yet, the public file (still clean) is copied there, and
//      saved in --safety-dir on this computer as well;
//   2. the mark is put on the ORIGINAL and written over the public file at the same path.
// Step 2 always starts from the original, so running the script again is safe and never marks a picture twice. Run it
// once before the new code goes live and once after, which catches a picture uploaded in between.
//
// Needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the env file. The key is never printed.

import { createClient } from '@supabase/supabase-js'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { markPicture } from '../../src/lib/quotations/pictureMark'
import { ORIGINALS_BUCKET } from '../../src/lib/quotations/pictureStore'

const args = process.argv.slice(2)
const dry = args.includes('--dry-run')
const safetyDir = args.includes('--safety-dir') ? args[args.indexOf('--safety-dir') + 1] : null
const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) { console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are needed (use --env-file=.env.local).'); process.exit(1) }
if (!dry && !safetyDir) { console.error('Give --safety-dir <folder> (outside the repository) so a local copy of the clean pictures exists.'); process.exit(1) }

const s = createClient(url, key, { auth: { persistSession: false } })
const PUBLIC_BUCKET = 'quotation-images'

async function listAll(): Promise<string[]> {
  const out: string[] = []
  const folders = await s.storage.from(PUBLIC_BUCKET).list('', { limit: 1000 })
  if (folders.error) throw new Error(folders.error.message)
  for (const f of folders.data ?? []) {
    if (f.id) { out.push(f.name); continue } // a file in the root (none expected)
    for (let offset = 0; ; offset += 1000) {
      const page = await s.storage.from(PUBLIC_BUCKET).list(f.name, { limit: 1000, offset })
      if (page.error) throw new Error(page.error.message)
      for (const o of page.data ?? []) if (o.id && o.name.endsWith('.jpg')) out.push(`${f.name}/${o.name}`)
      if ((page.data ?? []).length < 1000) break
    }
  }
  return out
}

async function main() {
  const paths = await listAll()
  console.log(`${paths.length} pictures in ${PUBLIC_BUCKET}${dry ? ' (dry run: nothing is written)' : ''}`)
  if (dry) return
  let copied = 0, marked = 0
  const failed: string[] = []
  for (const path of paths) {
    try {
      let original = await s.storage.from(ORIGINALS_BUCKET).download(path)
      if (original.error || !original.data) {
        const clean = await s.storage.from(PUBLIC_BUCKET).download(path)
        if (clean.error || !clean.data) throw new Error('cannot read the public file')
        const bytes = Buffer.from(await clean.data.arrayBuffer())
        if (safetyDir) { mkdirSync(join(safetyDir, path.split('/')[0]), { recursive: true }); writeFileSync(join(safetyDir, path), bytes) }
        const up = await s.storage.from(ORIGINALS_BUCKET).upload(path, bytes, { contentType: 'image/jpeg', upsert: false, cacheControl: '31536000' })
        if (up.error) throw new Error(`cannot store the original: ${up.error.message}`)
        copied++
        original = await s.storage.from(ORIGINALS_BUCKET).download(path)
        if (original.error || !original.data) throw new Error('the original did not read back')
      }
      const out = await markPicture(Buffer.from(await original.data.arrayBuffer()))
      const put = await s.storage.from(PUBLIC_BUCKET).upload(path, out, { contentType: 'image/jpeg', upsert: true, cacheControl: '31536000' })
      if (put.error) throw new Error(`cannot write the marked copy: ${put.error.message}`)
      marked++
    } catch (e) {
      failed.push(path)
      console.error(`FAILED ${path}: ${e instanceof Error ? e.message : e}`)
    }
  }
  console.log(`done: ${copied} originals copied, ${marked} marked, ${failed.length} failed`)
  if (failed.length) process.exit(2)
}

main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
