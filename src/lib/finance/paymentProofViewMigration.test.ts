/**
 * A PAYMENT'S PROOF OPENS FOR THE PEOPLE WHO REVIEW THAT PAYMENT (20270118120000),
 * read as text.
 *
 * Executed against a disposable local stack with production's permissions: a
 * proof Sales uploaded opens for Sales, Nishant (admin), Nitish (finance.approve
 * + view_all) and a finance.approve verifier, and is refused to an unrelated
 * Sales user, an Operations-only user and an anonymous caller — through the app
 * and by signing the real path directly. Guessed and unrecorded paths open for
 * nobody else; the uploader and an admin can still remove an unrecorded upload.
 * This file holds the migration to those promises without a database.
 *
 *   npx tsx --test src/lib/finance/paymentProofViewMigration.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const NAME = '20270118120000_finance_payment_proof_opens_for_its_reviewers.sql'
const MIGRATION = readFileSync(join(process.cwd(), 'supabase', 'migrations', NAME), 'utf8').replace(/\r\n/g, '\n')
const SQL = MIGRATION.split('\n').map(l => l.replace(/--.*$/, '')).join('\n')

/** The dollar-quoted body of public.<name>(…). */
function body(name: string): string {
  const at = SQL.indexOf(`create or replace function public.${name}(`)
  assert.ok(at >= 0, `${name} is defined`)
  const open = SQL.indexOf('$fn$', at) + 4
  return SQL.slice(open, SQL.indexOf('$fn$', open))
}

describe('where it sits', () => {
  test('after the proof-upload fix (20270117000000) and before #226 (20270120000000)', () => {
    assert.ok(NAME > '20270117000000_order_finance_guards_run_as_owner.sql')
    assert.ok(NAME < '20270120000000_order_submission_admin_decisions_ask_permissions.sql')
  })
})

describe('who may open a payment\'s proof', () => {
  const who = body('can_open_payment_proof')

  test('the person who recorded that payment', () => {
    assert.match(who, /p\.submitted_by = u\.id/)
  })

  test('a reviewer of payments: admin or finance.approve, or finance.view_all — with Finance entry', () => {
    assert.match(who, /public\.module_entry_open\('finance'\)\s+and \(public\.actor_has_module_permission\('finance', 'approve'\)\s+or public\.actor_has_permission\('finance', 'view_all'\)\)/)
  })

  test('only an active, non-deleted caller, and only for a payment that exists', () => {
    assert.match(who, /from public\.finance_payment_requests p\s+join public\.users u on u\.id = auth\.uid\(\)\s+where p\.id = p_payment_id\s+and u\.is_active\s+and coalesce\(u\.is_deleted, false\) = false/)
  })

  test('participants of the PI/Order (e.g. Operations) are NOT reviewers', () => {
    assert.doesNotMatch(who, /can_read_payment_as_participant/)
    assert.ok(MIGRATION.includes("can_open_payment_proof must not admit participants"), 'asserted at apply time too')
  })
})

describe('the file is bound to the proof on record', () => {
  const file = body('payment_proof_object_readable')

  test('a file opens only when a proof row names exactly that path under that payment\'s folder', () => {
    assert.match(file, /where a\.storage_path = p_name\s+and a\.payment_request_id::text = split_part\(p_name, '\/', 1\)/)
    assert.match(file, /if v_recorded then\s+return public\.can_open_payment_proof\(v_payment\);/)
  })

  test('an unrecorded upload opens only for its own uploader (so a failed attach can remove it)', () => {
    assert.match(file, /return not exists \(select 1 from public\.payment_proof_attachments a where a\.storage_path = p_name\)\s+and p_owner_id is not null\s+and p_owner_id = auth\.uid\(\)::text;/)
  })

  test('no session opens nothing', () => {
    assert.match(file, /if auth\.uid\(\) is null or p_name is null then\s+return false;/)
  })

  test('the storage SELECT policy asks it, for authenticated only, on this bucket only', () => {
    assert.match(SQL, /drop policy if exists payment_proofs_select on storage\.objects;\s+create policy payment_proofs_select on storage\.objects\s+for select to authenticated\s+using \(bucket_id = 'payment-proofs'\s+and public\.payment_proof_object_readable\(name, owner_id\)\);/)
  })
})

describe('nothing else moves', () => {
  test('write rules are untouched: no insert/delete policy on storage or on proof rows is changed', () => {
    assert.doesNotMatch(SQL, /policy\s+payment_proofs_(insert|delete)/i)
    assert.doesNotMatch(SQL, /policy\s+payment_proof_attachments_(insert|delete)/i)
  })

  test('reviewers can find the proof row; the module-entry gate still applies', () => {
    assert.match(SQL, /create policy payment_proof_attachments_reviewer_select on public\.payment_proof_attachments\s+for select to authenticated\s+using \(public\.can_open_payment_proof\(payment_request_id\)\);/)
  })

  test('no grant to anon, no data change, the bucket stays private', () => {
    assert.match(SQL, /revoke execute on function public\.can_open_payment_proof\(uuid\) from public, anon;/)
    assert.match(SQL, /revoke execute on function public\.payment_proof_object_readable\(text, text\) from public, anon;/)
    assert.doesNotMatch(SQL, /\b(insert\s+into|update\s+\w+\s+set|delete\s+from)\b/i)
    assert.ok(MIGRATION.includes("the payment-proofs bucket is public"), 'asserted at apply time')
  })

  test('the app reads a proof by its row, then signs that path — the path the rule is bound to', () => {
    const helper = readFileSync(join(process.cwd(), 'src/lib/finance/paymentProof.ts'), 'utf8').replace(/\r\n/g, '\n')
    assert.ok(helper.includes(".from('payment_proof_attachments')\n    .select('storage_path')"))
    assert.ok(helper.includes('createSignedUrl(path, expiresInSeconds)'))
  })
})
