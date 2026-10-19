/**
 * HOW A PAYMENT PROOF ARRIVES — picker, drag-and-drop, pasted screenshot — and
 * what is done to it before it is stored.
 *
 * Run: npx tsx --test src/lib/finance/proofIntake.test.ts
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  PROOF_ACCEPT_ATTR,
  filesFromTransfer,
  isConvertibleProofImage,
  isGenericProofName,
  nameProofFile,
  prepareProofFile,
} from './proofIntake'

const file = (name: string, type: string, bytes = 10) => new File([new Uint8Array(bytes)], name, { type })
const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8')

describe('a pasted screenshot gets a name a reviewer can recognise', () => {
  const when = new Date(2026, 9, 19, 14, 32)

  test('the clipboard name image.png is replaced, the type is kept', () => {
    const named = nameProofFile(file('image.png', 'image/png'), when)
    assert.equal(named.name, 'payment-proof-2026-10-19-1432.png')
    assert.equal(named.type, 'image/png')
  })

  test('a real file name is never touched', () => {
    const f = file('HDFC UTR 4821.jpg', 'image/jpeg')
    assert.equal(nameProofFile(f, when), f)
  })

  test('which names count as generic', () => {
    for (const n of ['image.png', 'image.jpg', 'Image.PNG', 'blob', '.png', 'screenshot.png']) {
      assert.equal(isGenericProofName(n), true, n)
    }
    for (const n of ['Screenshot 2026-10-19 at 14.32.png', 'receipt.pdf', 'utr-4821.png']) {
      assert.equal(isGenericProofName(n), false, n)
    }
  })
})

describe('other image formats are converted, never uploaded as they are', () => {
  test('formats the bucket refuses but a browser can read are convertible', () => {
    for (const t of ['image/bmp', 'image/avif', 'image/tiff', 'image/heic']) {
      assert.equal(isConvertibleProofImage(file('a', t)), true, t)
    }
  })

  test('formats the bucket already admits are left alone', () => {
    for (const t of ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf']) {
      assert.equal(isConvertibleProofImage(file('a', t)), false, t)
    }
  })

  test('SVG is never converted or accepted: it can carry script', async () => {
    assert.equal(isConvertibleProofImage(file('a.svg', 'image/svg+xml')), false)
    const result = await prepareProofFile(file('a.svg', 'image/svg+xml'))
    assert.equal(result.file, null)
    assert.ok(result.error)
  })

  test('a convertible image the browser cannot read is refused in words (no browser here)', async () => {
    const result = await prepareProofFile(file('scan.bmp', 'image/bmp'))
    assert.equal(result.file, null)
    assert.match(result.error ?? '', /cannot be opened by your browser/)
  })
})

describe('the same gate applies to every way in', () => {
  test('an allowed file passes and keeps its type', async () => {
    const result = await prepareProofFile(file('receipt.pdf', 'application/pdf'))
    assert.equal(result.error, null)
    assert.equal(result.file?.type, 'application/pdf')
  })

  test('an empty file, an oversized file and a disallowed type are refused', async () => {
    assert.ok((await prepareProofFile(file('a.png', 'image/png', 0))).error)
    assert.ok((await prepareProofFile(file('a.png', 'image/png', 10 * 1024 * 1024 + 1))).error)
    assert.ok((await prepareProofFile(file('a.zip', 'application/zip'))).error)
  })

  test('clipboard and drag payloads yield only their files', () => {
    const f = file('a.png', 'image/png')
    const items = [
      { kind: 'string', getAsFile: () => null },
      { kind: 'file', getAsFile: () => f },
      { kind: 'file', getAsFile: () => null },
    ] as unknown as DataTransferItem[]
    assert.deepEqual(filesFromTransfer(items), [f])
    assert.deepEqual(filesFromTransfer(null), [])
  })

  test('the picker offers images and PDF', () => {
    assert.equal(PROOF_ACCEPT_ATTR, 'image/*,.pdf')
  })
})

describe('every payment form takes its proof through the one drop zone', () => {
  const forms = [
    'src/app/finance/paymentRequestsNew.tsx',
    'src/app/finance/paymentRequestsEdit.tsx',
    'src/app/finance/received/RecordSplitPaymentModal.tsx',
    'src/components/orders/PiPaymentCard.tsx',
  ]
  for (const rel of forms) {
    test(`${rel} uses ProofDropZone and has no private file input`, () => {
      const src = read(rel)
      assert.ok(src.includes('<ProofDropZone'))
      assert.equal(src.includes('type="file"'), false)
    })
  }

  test('the drop zone listens for drop and for paste, and ignores a paste with no file', () => {
    const src = read('src/app/finance/components/ProofDropZone.tsx')
    assert.ok(src.includes('onDrop={onDrop}'))
    assert.ok(src.includes("document.addEventListener('paste'"))
    assert.ok(src.includes('if (files.length === 0) return'))
  })

  test('the correction form saves first and uploads after, and retries only the proof', () => {
    const src = read('src/app/finance/paymentRequestsEdit.tsx')
    // handleSave's own upload comes after its RPC (the retry path, defined earlier, has no RPC).
    assert.ok(src.indexOf("rpc('edit_payment_request'") < src.lastIndexOf('await uploadProof()'))
    assert.ok(src.includes('if (recorded) { void retryProof(); return }'))
  })
})
