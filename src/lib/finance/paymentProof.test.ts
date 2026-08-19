/**
 * The shared payment-proof flow.
 *
 * WHY IT IS WORTH TESTING. It is two coupled writes with a compensating delete,
 * and the compensation is the part nobody exercises by hand: if the metadata row
 * fails after the object uploaded, the object must be removed, or Storage keeps a
 * file nothing will ever find again.
 *
 * The other property is the one that matters financially: this helper NEVER
 * removes or alters the payment. By the time it runs the payment is committed,
 * and losing a recorded payment because a file failed to upload would discard
 * the fact that matters.
 *
 * Pure, with a hand-written fake client. No DB, no network, no browser.
 *
 * Run:
 *   npx tsx --test src/lib/finance/paymentProof.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { attachPaymentProof, paymentProofSignedUrl, PROOF_UPLOAD_FAILED } from './paymentProof'

const PAYMENT = '11111111-1111-4111-8111-111111111111'

/** A PNG the validator accepts: non-empty, allowed type, under the ceiling. */
function pngFile(name = 'proof.png', size = 1024): File {
  return {
    name, size, type: 'image/png',
  } as unknown as File
}

type Calls = {
  uploads: { path: string; contentType: string }[]
  removes: string[][]
  inserts: Record<string, unknown>[]
  signed: [string, number][]
}

function fakeClient(opts: {
  uploadError?: unknown
  insertError?: unknown
  rows?: { storage_path: string }[] | null
} = {}) {
  const calls: Calls = { uploads: [], removes: [], inserts: [], signed: [] }
  const client = {
    storage: {
      from() {
        return {
          async upload(path: string, _f: File, o: { upsert: boolean; contentType: string }) {
            calls.uploads.push({ path, contentType: o.contentType })
            return { error: opts.uploadError ?? null }
          },
          async remove(paths: string[]) { calls.removes.push(paths); return {} },
          async createSignedUrl(path: string, expiresIn: number) {
            calls.signed.push([path, expiresIn])
            return { data: { signedUrl: `https://signed.example/${path}` } }
          },
        }
      },
    },
    from() {
      return {
        async insert(row: Record<string, unknown>) {
          calls.inserts.push(row)
          return { error: opts.insertError ?? null }
        },
        select() {
          return {
            eq() {
              return {
                order() {
                  return { async limit() { return { data: opts.rows ?? [] } } }
                },
              }
            },
          }
        },
      }
    },
  }
  return { client: client as never, calls }
}

describe('attaching a proof', () => {
  test('uploads under the payment folder and records the metadata', async () => {
    const { client, calls } = fakeClient()
    const err = await attachPaymentProof(client, {
      paymentRequestId: PAYMENT, file: pngFile(), userId: 'user-1',
    })

    assert.equal(err, null)
    assert.equal(calls.uploads.length, 1)
    // The FIRST path segment must be the payment id: the storage policies read
    // ownership out of it, so a different layout would silently lose authorization.
    assert.equal(calls.uploads[0].path.split('/')[0], PAYMENT)
    assert.equal(calls.uploads[0].contentType, 'image/png')
    assert.equal(calls.inserts.length, 1)
    assert.equal(calls.inserts[0].payment_request_id, PAYMENT)
    assert.equal(calls.inserts[0].created_by, 'user-1')
    assert.equal(calls.removes.length, 0)
  })

  test('a rejected file never reaches Storage', async () => {
    const { client, calls } = fakeClient()
    const err = await attachPaymentProof(client, {
      paymentRequestId: PAYMENT,
      file: { name: 'virus.exe', size: 10, type: 'application/x-msdownload' } as unknown as File,
      userId: 'user-1',
    })
    assert.ok(err)
    assert.equal(calls.uploads.length, 0, 'a disallowed type must not be uploaded')
    assert.equal(calls.inserts.length, 0)
  })

  test('an empty file is refused before upload', async () => {
    const { client, calls } = fakeClient()
    assert.ok(await attachPaymentProof(client, {
      paymentRequestId: PAYMENT, file: pngFile('empty.png', 0), userId: 'user-1',
    }))
    assert.equal(calls.uploads.length, 0)
  })

  test('an upload failure writes no metadata row', async () => {
    const { client, calls } = fakeClient({ uploadError: new Error('boom') })
    assert.equal(await attachPaymentProof(client, {
      paymentRequestId: PAYMENT, file: pngFile(), userId: 'user-1',
    }), PROOF_UPLOAD_FAILED)
    assert.equal(calls.inserts.length, 0, 'no row may name an object that does not exist')
    assert.equal(calls.removes.length, 0)
  })

  test('THE COMPENSATION: a metadata failure removes the uploaded object', async () => {
    const { client, calls } = fakeClient({ insertError: new Error('rls') })
    assert.equal(await attachPaymentProof(client, {
      paymentRequestId: PAYMENT, file: pngFile(), userId: 'user-1',
    }), PROOF_UPLOAD_FAILED)
    assert.equal(calls.removes.length, 1, 'the orphaned object must be removed')
    assert.deepEqual(calls.removes[0], [calls.uploads[0].path])
  })

  test('the prepare hook is applied and its result is what gets validated', async () => {
    const { client, calls } = fakeClient()
    const compressed = pngFile('compressed.png', 512)
    await attachPaymentProof(client, {
      paymentRequestId: PAYMENT, file: pngFile('original.png', 900000), userId: 'user-1',
      prepare: async () => compressed,
    })
    assert.equal(calls.inserts[0].file_size, 512, 'the stored size must be the prepared size')
    // The DISPLAY name stays the one the user chose.
    assert.equal(calls.inserts[0].file_name, 'original.png')
  })

  test('it never touches the payment itself', async () => {
    const source = readFileSync(join(process.cwd(), 'src/lib/finance/paymentProof.ts'), 'utf8')
    assert.ok(!source.includes('finance_payment_requests'),
      'the proof helper must never read or write the payment ledger')
    for (const forbidden of ['.delete(', 'record_pi_submission_payment', '.rpc(']) {
      assert.ok(!source.includes(forbidden), `the proof helper must not use ${forbidden}`)
    }
  })
})

describe('opening a proof', () => {
  test('signs the most recent object', async () => {
    const { client, calls } = fakeClient({ rows: [{ storage_path: `${PAYMENT}/abc.png` }] })
    const url = await paymentProofSignedUrl(client, PAYMENT)
    assert.equal(url, `https://signed.example/${PAYMENT}/abc.png`)
    assert.equal(calls.signed[0][1], 60, 'the link must be short-lived')
  })

  test('no proof, or no access, resolves to null rather than throwing', async () => {
    const { client } = fakeClient({ rows: [] })
    assert.equal(await paymentProofSignedUrl(client, PAYMENT), null)
    const { client: nulled } = fakeClient({ rows: null })
    assert.equal(await paymentProofSignedUrl(nulled, PAYMENT), null)
  })
})
