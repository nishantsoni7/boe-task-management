/**
 * Fill the image hash of custom reviews submitted BEFORE duplicate detection, so
 * their screenshots can be matched visually (an identical screenshot is matched
 * without it, by the SHA-256 the row already carries).
 *
 *   npx tsx scripts/backfill-review-image-hashes.ts            # dry run: counts only
 *   npx tsx scripts/backfill-review-image-hashes.ts --apply    # write the hashes
 *
 * Needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local. Run
 * it once, after 20270224000000 is applied AND the application code is live.
 *
 * WHAT IT DOES
 *   for every review whose proof_phash is null (deleted ones included — they are
 *   comparison evidence): download the stored proof, compute the difference hash
 *   (src/lib/customerReviews/imageHash.ts), and store it through the service-role
 *   function backfill_customer_review_custom_proof_phash(), which fills a NULL
 *   hash and changes nothing else.
 *
 * WHAT IT WILL NOT DO
 *   It changes no status, no credit, no name, no text, no file. It never deletes
 *   or uploads anything. It prints counts and review references, never review
 *   content, never a key. Re-running is safe: only null hashes are ever filled.
 *   A proof it cannot read or decode is reported and skipped.
 *
 * Exit 0: finished. Exit 2: configuration or a read failed before any work.
 */

import { createClient } from '@supabase/supabase-js'

import { differenceHash } from '../src/lib/customerReviews/imageHash'

const BUCKET = 'customer-review-custom-proofs'
const apply = process.argv.includes('--apply')

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error('Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local first.')
    process.exit(2)
  }
  const supabase = createClient(url, key, { auth: { persistSession: false } })

  const { data, error } = await supabase
    .from('customer_review_custom_submissions')
    .select('id, submission_ref, proof_storage_path')
    .is('proof_phash', null)
    .order('submitted_at', { ascending: true })
    .limit(5000)
  if (error) {
    console.error('Could not list the reviews without an image hash:', error.message)
    process.exit(2)
  }
  const rows = (data ?? []) as { id: string; submission_ref: string; proof_storage_path: string }[]
  console.log(`${rows.length} review(s) have no image hash.${apply ? '' : ' (dry run — nothing will be written; pass --apply)'}`)

  let hashed = 0
  let skipped = 0
  for (const row of rows) {
    try {
      const { data: file, error: downloadError } = await supabase.storage.from(BUCKET).download(row.proof_storage_path)
      if (downloadError || !file) throw new Error(downloadError?.message ?? 'no file')
      const phash = await differenceHash(new Uint8Array(await file.arrayBuffer()))
      if (apply) {
        const { error: rpcError } = await supabase.rpc('backfill_customer_review_custom_proof_phash', {
          p_submission_id: row.id,
          p_phash: phash,
        })
        if (rpcError) throw new Error(rpcError.message)
      }
      hashed++
    } catch (e) {
      skipped++
      console.warn(`  skipped ${row.submission_ref}: ${e instanceof Error ? e.message : 'unreadable'}`)
    }
  }
  console.log(`${apply ? 'Hashed' : 'Would hash'} ${hashed}; skipped ${skipped}.`)
}

void main()
