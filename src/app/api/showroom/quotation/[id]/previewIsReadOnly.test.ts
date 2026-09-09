/**
 * Repository check: previewing a quotation must not change anything.
 *
 * Why a source check
 * ------------------
 * Executing these handlers needs a live Supabase and a real bearer token, and
 * the invariant is about writes that DO NOT happen — the hardest kind of thing
 * to observe from outside. So the handler bodies are asserted directly.
 *
 * What went wrong twice, which is why every one of these exists
 * ------------------------------------------------------------
 *  1. GET set `status = 'quotation_sent'` and `quotation_status = 'sent'`.
 *     Merely LOOKING at the document recorded it as sent to the customer, and
 *     a GET with side effects is also unsafe for anything that prefetches or
 *     retries the URL.
 *  2. GET then still called `getOrCreateQuotationNo`. Despite the name that is
 *     a WRITE when the number is null: it increments showroom_quotation_seq and
 *     UPDATEs showroom_inquiries. Previewing consumed a number from the
 *     company's BOE-QTN-YYYY-NNNN sequence, so previewing twice and generating
 *     once left permanent gaps.
 *
 * Both were invisible to the type checker and to every rendering test.
 *
 * Run:
 *   npx tsx --test "src/app/api/showroom/quotation/[id]/previewIsReadOnly.test.ts"
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SOURCE = readFileSync(
  join(process.cwd(), 'src/app/api/showroom/quotation/[id]/route.ts'),
  'utf8',
)

function handler(name: 'GET' | 'POST'): string {
  const start = SOURCE.indexOf(`export async function ${name}(`)
  assert.ok(start > -1, `${name} handler must exist`)
  const rest = SOURCE.slice(start + 1)
  const end = rest.indexOf('\nexport async function ')
  return end === -1 ? rest : rest.slice(0, end)
}

/** Every call that could persist something, by name. */
const WRITE_CALL = /\.(update|insert|upsert|delete|rpc)\s*\(/g

describe('GET — preview', () => {
  const GET = handler('GET')

  test('performs no write of any kind', () => {
    const writes = GET.match(WRITE_CALL) ?? []
    assert.deepEqual(writes, [], `GET must not write; found: ${writes.join(', ')}`)
  })

  test('does not allocate a quotation number', () => {
    // get_or_create_quotation_no() UPDATEs showroom_inquiries and bumps
    // showroom_quotation_seq. Preview reads inquiry.quotation_no instead.
    assert.equal(GET.includes('getOrCreateQuotationNo'), false)
    assert.match(GET, /inquiry\.quotation_no/)
  })

  test('never names the columns that mark a quotation sent', () => {
    assert.equal(GET.includes('quotation_status:'), false)
    assert.equal(GET.includes('quotation_sent_at:'), false)
    assert.equal(/status:\s*'quotation_sent'/.test(GET), false)
  })

  test('still refuses a caller who does not own the inquiry', () => {
    // Read-only is not the same as unguarded.
    assert.match(GET, /caller\.role !== 'admin' && inquiry\.salesperson_id !== caller\.id/)
    assert.match(GET, /status: 403/)
    assert.match(GET, /status: 401/)
  })

  test('is served inline and uncached', () => {
    // A download would defeat the point, and a cached preview would show the
    // rate that was edited a minute ago.
    assert.match(GET, /'Content-Disposition':\s*`inline;/)
    assert.match(GET, /'Cache-Control':\s*'no-store'/)
  })
})

describe('POST — generate and send', () => {
  const POST = handler('POST')

  test('is still the handler that marks a quotation sent', () => {
    assert.match(POST, /quotation_status:\s*'sent'/)
    assert.match(POST, /quotation_sent_at:/)
    assert.match(POST, /status:\s*'quotation_sent'/)
  })

  test('still allocates the quotation number', () => {
    assert.match(POST, /getOrCreateQuotationNo\(/)
  })

  test('a converted or lost quotation is never dragged back to sent', () => {
    // Guarded twice: the branch, and a matching predicate on the update so a
    // concurrent conversion cannot be overwritten between read and write.
    assert.match(POST, /inquiry\.quotation_status === 'draft'/)
    assert.match(POST, /\.eq\('quotation_status', 'draft'\)/)
  })

  test('still refuses a caller who does not own the inquiry', () => {
    assert.match(POST, /caller\.role !== 'admin' && inquiry\.salesperson_id !== caller\.id/)
  })
})

describe('the salesperson named on the document', () => {
  test('is resolved from the inquiry, never from the caller', () => {
    // An admin downloading a colleague's quotation must not put their own name
    // in front of that colleague's customer.
    const lookups = SOURCE.match(/\.from\('users'\)\.select\('full_name'\)\.eq\('id', ([^)]+)\)/g) ?? []
    assert.equal(lookups.length, 2, 'GET and POST each resolve the name once')
    for (const lookup of lookups) assert.match(lookup, /inquiry\.salesperson_id/)
    assert.equal(SOURCE.includes('caller.full_name'), false)
    // `caller.id` is allowed only in the two ownership checks.
    assert.equal((SOURCE.match(/caller\.id/g) ?? []).length, 2)
  })
})
