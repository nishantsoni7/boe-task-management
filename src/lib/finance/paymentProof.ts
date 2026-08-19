// ── Payment proof attach/open, in one place ───────────────────────────────────
//
// The proof flow is two coupled writes — a storage object and its metadata row —
// plus a compensating delete when the second fails. It existed inline on the
// Finance page; the PI payment card needs exactly the same flow, and a second
// copy of a compensating write is how the two come to differ.
//
// It lives in a library rather than on a screen for a second reason: the PI
// screens are held to a rule (draftsAccess.test.ts) that they write no table and
// no file directly — every write goes through a reviewed database function or,
// as here, a reviewed shared helper. That rule is what keeps a page from quietly
// acquiring its own persistence layer.
//
// SECURITY. Nothing here decides authority. The storage policies (20260672) admit
// the upload only when the caller SUBMITTED the payment and it is still
// pending_approval, and payment_proof_attachments has its own policies. This
// helper can therefore be called from anywhere without widening anything.

import { PROOF_BUCKET, buildProofPath, proofContentType, validateProofFile } from '@/lib/paymentProof'

// Structural rather than supabase-typed, so this module stays testable and does
// not drag a client type into callers that only need the contract.
type ProofClient = {
  storage: {
    from(bucket: string): {
      upload(path: string, file: File, opts: { upsert: boolean; contentType: string }): Promise<{ error: unknown }>
      remove(paths: string[]): Promise<unknown>
      createSignedUrl(path: string, expiresIn: number): Promise<{ data: { signedUrl: string } | null }>
    }
  }
  from(table: string): {
    insert(row: Record<string, unknown>): Promise<{ error: unknown }>
    select(columns: string): {
      eq(column: string, value: string): {
        order(column: string, opts: { ascending: boolean }): {
          limit(n: number): Promise<{ data: { storage_path: string }[] | null }>
        }
      }
    }
  }
}

export const PROOF_UPLOAD_FAILED = 'Could not upload the payment proof. Please try again.'
export const PROOF_TYPE_REJECTED = 'Only images (JPG, PNG, WEBP, GIF) or PDF files are allowed.'

/**
 * Attaches one proof file to an existing payment.
 *
 * Returns null on success, or a message to show. It NEVER throws and never
 * removes the payment: by the time this runs the payment is already recorded,
 * and losing a recorded payment because a file failed to upload would discard
 * the fact that matters.
 *
 * `prepare` is injected so the Finance page can pass its image compressor while
 * a caller that has none passes the file through unchanged.
 */
export async function attachPaymentProof(
  client: ProofClient,
  input: {
    paymentRequestId: string
    file: File
    userId: string | null
    prepare?: (file: File) => Promise<File>
  },
): Promise<string | null> {
  const prepared = input.prepare ? await input.prepare(input.file) : input.file

  // Re-validated AFTER preparation: compression can change both size and type.
  const invalid = validateProofFile(prepared)
  if (invalid) return invalid

  // Upload under the type the bucket will actually accept, rather than letting
  // it land as octet-stream and be rejected mid-flight.
  const contentType = proofContentType(prepared)
  if (!contentType) return PROOF_TYPE_REJECTED

  const path = buildProofPath(input.paymentRequestId, prepared.name)
  const { error: upErr } = await client.storage
    .from(PROOF_BUCKET)
    .upload(path, prepared, { upsert: false, contentType })
  if (upErr) return PROOF_UPLOAD_FAILED

  const { error: metaErr } = await client.from('payment_proof_attachments').insert({
    payment_request_id: input.paymentRequestId,
    storage_path:       path,
    file_name:          input.file.name,
    file_type:          contentType,
    file_size:          prepared.size,
    created_by:         input.userId,
  })

  if (metaErr) {
    // The object exists with no row naming it, which nothing would ever find
    // again. Removed here; the payment still exists, so the storage delete
    // policy authorizes this.
    await client.storage.from(PROOF_BUCKET).remove([path])
    return PROOF_UPLOAD_FAILED
  }
  return null
}

/**
 * A short-lived signed URL for a payment's most recent proof, or null.
 *
 * Returns null rather than throwing when there is nothing to open or the caller
 * may not open it — the storage policy is the authority and a refusal is a
 * legitimate answer, not an error to surface.
 */
export async function paymentProofSignedUrl(
  client: ProofClient,
  paymentRequestId: string,
  expiresInSeconds = 60,
): Promise<string | null> {
  const { data: rows } = await client
    .from('payment_proof_attachments')
    .select('storage_path')
    .eq('payment_request_id', paymentRequestId)
    .order('created_at', { ascending: false })
    .limit(1)

  const path = rows?.[0]?.storage_path
  if (!path) return null

  const { data: signed } = await client.storage.from(PROOF_BUCKET).createSignedUrl(path, expiresInSeconds)
  return signed?.signedUrl ?? null
}
