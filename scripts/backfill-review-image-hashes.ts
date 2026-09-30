/**
 * Fill the image hash of custom reviews submitted BEFORE duplicate detection, so a NEW
 * submission can be compared with their screenshots. An identical screenshot is matched
 * without it, by the SHA-256 every row already carries.
 *
 *   npx tsx scripts/backfill-review-image-hashes.ts                    # dry run: counts + a sample of references
 *   npx tsx scripts/backfill-review-image-hashes.ts --apply --limit=200  # hash the next 200, then stop
 *   npx tsx scripts/backfill-review-image-hashes.ts --apply            # hash everything left
 *   npx tsx scripts/backfill-review-image-hashes.ts --verify           # read-only: coverage + look-alike pairs
 *
 * Needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local. Run it after
 * 20270224000000 is applied AND the application code is live. It is NOT run by CI or by
 * the migrations; nobody has run it on production.
 *
 * WHAT IT PROVIDES
 *   Only proof_phash (the picture's difference hash). It does NOT fill the reviewer name,
 *   the review text or their fingerprints — those cannot be recovered from a hash, and
 *   older reviews have none. So an older review can only ever match a new one by its
 *   SCREENSHOT (same file, or a look-alike of it). Older reviews are CANDIDATES for new
 *   submissions; they are not flagged retroactively — flags are written only when a review
 *   is submitted, edited or reapplied. --verify lists which older reviews already look
 *   alike, for an administrator to look at; it writes nothing.
 *
 * RESUMABLE
 *   Only rows with a NULL hash are selected, oldest first, and the write function fills a
 *   NULL and nothing else, so stopping (Ctrl+C, an error, --limit) and running again
 *   continues where it stopped. Running it twice does nothing the second time.
 *
 * WHAT IT WILL NOT DO
 *   It changes no status, no credit, no name, no text, no file, and creates no flag. It
 *   never deletes or uploads anything. It prints counts and review references, never
 *   review content, never a key. A proof it cannot read or decode is reported and skipped.
 *
 * Exit 0: finished. Exit 1: some proofs were skipped. Exit 2: configuration or a read
 * failed before any work, or --verify was refused (too many rows).
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

import { differenceHash } from '../src/lib/customerReviews/imageHash'
import { findHistoricalPairs, type HistoricalReview } from '../src/lib/customerReviews/historicalPairs'

const BUCKET = 'customer-review-custom-proofs'
const VERIFY_MAX_ROWS = 3000
const PAGE = 1000

const apply = process.argv.includes('--apply')
const verify = process.argv.includes('--verify')
const limitArg = process.argv.find(a => a.startsWith('--limit='))
const limit = limitArg ? Number(limitArg.slice('--limit='.length)) : Infinity

async function verifyCoverage(supabase: SupabaseClient) {
  const rows: HistoricalReview[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('customer_review_custom_submissions')
      .select('id, submission_ref, submitted_by, proof_content_sha256, proof_phash, deleted_at')
      .order('submitted_at', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) { console.error('Could not read the reviews:', error.message); process.exit(2) }
    for (const r of (data ?? []) as { id: string; submission_ref: string; submitted_by: string; proof_content_sha256: string; proof_phash: string | null; deleted_at: string | null }[]) {
      rows.push({ id: r.id, ref: r.submission_ref, submittedBy: r.submitted_by, sha256: r.proof_content_sha256, phash: r.proof_phash, deleted: r.deleted_at !== null })
    }
    if (!data || data.length < PAGE) break
    if (rows.length > VERIFY_MAX_ROWS) break
  }
  if (rows.length > VERIFY_MAX_ROWS) {
    console.error(`${rows.length}+ reviews: --verify compares every pair in memory and refuses above ${VERIFY_MAX_ROWS}. Nothing was read further.`)
    process.exit(2)
  }
  const hashed = rows.filter(r => r.phash).length
  console.log(`Coverage: ${hashed} of ${rows.length} review(s) have an image hash (${rows.length - hashed} still to do${rows.length - hashed ? ' — run --apply' : ''}).`)
  const pairs = findHistoricalPairs(rows)
  const same = pairs.filter(p => p.sameEmployee).length
  console.log(`Look-alike pairs among existing reviews: ${pairs.length} (${same} by the same employee, ${pairs.length - same} across employees).`)
  for (const p of pairs.slice(0, 50)) {
    console.log(`  ${p.a}  ${p.b}  ${p.kind}${p.kind === 'similar' ? ` ${Math.round(p.ratio * 100)}%` : ''}  ${p.strength}${p.sameEmployee ? '  same employee' : ''}`)
  }
  if (pairs.length > 50) console.log(`  … and ${pairs.length - 50} more`)
  console.log('Nothing was written. These older reviews are NOT flagged; they are candidates for new submissions.')
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error('Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local first.')
    process.exit(2)
  }
  if (apply && verify) { console.error('--verify is read-only; do not combine it with --apply.'); process.exit(2) }
  if (!(limit > 0)) { console.error('--limit must be a positive number.'); process.exit(2) }
  const supabase = createClient(url, key, { auth: { persistSession: false } })

  if (verify) return verifyCoverage(supabase)

  const { count, error: countError } = await supabase
    .from('customer_review_custom_submissions')
    .select('id', { count: 'exact', head: true })
    .is('proof_phash', null)
  if (countError) { console.error('Could not count the reviews without an image hash:', countError.message); process.exit(2) }

  const { data, error } = await supabase
    .from('customer_review_custom_submissions')
    .select('id, submission_ref, proof_storage_path')
    .is('proof_phash', null)
    .order('submitted_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(Number.isFinite(limit) ? limit : 5000)
  if (error) { console.error('Could not list the reviews without an image hash:', error.message); process.exit(2) }
  const rows = (data ?? []) as { id: string; submission_ref: string; proof_storage_path: string }[]
  console.log(`${count ?? rows.length} review(s) have no image hash; this run covers ${rows.length}.${apply ? '' : ' (dry run — nothing will be written; pass --apply)'}`)
  if (!apply) {
    for (const r of rows.slice(0, 20)) console.log(`  would hash ${r.submission_ref}`)
    if (rows.length > 20) console.log(`  … and ${rows.length - 20} more`)
  }

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
  const remaining = Math.max(0, (count ?? rows.length) - (apply ? hashed : 0))
  console.log(`${apply ? 'Hashed' : 'Would hash'} ${hashed}; skipped ${skipped}.${apply ? ` ${remaining} still without a hash${remaining ? ' — run again to continue' : ''}.` : ''}`)
  if (skipped) process.exitCode = 1
}

void main()
