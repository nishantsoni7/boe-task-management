/**
 * 20270323000000 — a role admin may attach a proof to an unverified payment.
 * Text pins on the migration; the SQL itself carries executed self-assertions.
 *
 * Run: npx tsx --test src/lib/finance/paymentProofAdminAttachMigration.test.ts
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const NAME = '20270323000000_finance_payment_proof_admin_attach.sql'
const sql = readFileSync(join(process.cwd(), 'supabase', 'migrations', NAME), 'utf8')

describe('who may attach, and when', () => {
  test('only an ACTIVE role admin, on a payment that is not deleted', () => {
    assert.match(sql, /u\.role = 'admin'/)
    assert.match(sql, /u\.is_active/)
    assert.match(sql, /p\.deleted_at is null/)
  })

  test('only while the payment is unverified', () => {
    assert.match(sql, /p\.status in \('pending_approval', 'needs_clarification', 'rejected'\)/)
    assert.equal(/status in \([^)]*approved_/.test(sql), false, 'a verified payment must not be in the rule')
  })

  test('the proof row must name the admin as its creator', () => {
    assert.match(sql, /created_by = auth\.uid\(\)\s+and public\.admin_may_attach_payment_proof\(payment_request_id::text\)/)
  })

  test('the file is bucket-scoped and bound to that payment\'s own folder, compared as text', () => {
    assert.match(sql, /bucket_id = 'payment-proofs'\s+and public\.admin_may_attach_payment_proof\(split_part\(name, '\/', 1\)\)/)
    assert.match(sql, /p\.id::text = p_payment_folder/)
  })
})

describe('what it leaves alone', () => {
  test('it adds policies; it never drops or replaces the submitter\'s', () => {
    assert.equal(/drop policy if exists (payment_proofs_insert|"payment_proofs_insert"|payment_proof_attachments_insert)/.test(sql), false)
    assert.match(sql, /drop policy if exists payment_proof_attachments_admin_insert/)
    assert.match(sql, /drop policy if exists payment_proofs_admin_insert/)
  })

  test('anon gets nothing, the function is definer with a pinned search_path', () => {
    assert.match(sql, /revoke execute on function public\.admin_may_attach_payment_proof\(text\) from public, anon/)
    assert.match(sql, /grant\s+execute on function public\.admin_may_attach_payment_proof\(text\) to authenticated/)
    assert.match(sql, /security definer\s+set search_path = public, pg_temp/)
  })

  test('it writes no data and touches no payment rule', () => {
    assert.equal(/\b(insert into|update public|delete from)\b/i.test(sql.replace(/--.*$/gm, '')), false)
  })

  test('it carries executed assertions on the deployed objects', () => {
    assert.match(sql, /do \$assert\$/)
    assert.match(sql, /ASSERTION FAILED/)
  })
})
