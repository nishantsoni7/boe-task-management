/**
 * A PI's product-image key, and nothing that only looks like one (review H1).
 *
 * Offline. The key a proposal or a version's content names is read back with
 * the SERVICE ROLE when a PDF is rendered, and the storage client joins it
 * into a URL whose parser resolves "..". So the whole key must be canonical —
 * a prefix test let "submissions/<pi>/images/../../../x" through.
 *
 * Run:
 *   npx tsx --test src/lib/orders/piImageKey.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { isCanonicalPiImageKey, parsePiImageKey, proposalImagesAreCanonical } from './piImageKey'

const SUB = '11111111-1111-4111-8111-111111111111'
const ITEM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const SHA = 'e'.repeat(64)
const GOOD = `submissions/${SUB}/images/${ITEM}/representative/0-${SHA}.png`

describe('the canonical key', () => {
  test('is accepted, and parsed into its parts', () => {
    assert.equal(isCanonicalPiImageKey(GOOD, { submissionId: SUB, itemId: ITEM, role: 'representative', position: 0, sha256: SHA }), true)
    assert.deepEqual(parsePiImageKey(GOOD), { submissionId: SUB, itemId: ITEM, role: 'representative', position: 0, sha256: SHA })
    for (const ext of ['jpg', 'jpeg', 'webp']) {
      assert.equal(isCanonicalPiImageKey(GOOD.replace('.png', `.${ext}`), { submissionId: SUB }), true, ext)
    }
    assert.equal(isCanonicalPiImageKey(`submissions/${SUB}/images/${ITEM}/customization/3-${SHA}.png`, { submissionId: SUB, role: 'customization' }), true)
  })
})

describe('anything that only looks like it is refused', () => {
  const refused: [string, string][] = [
    ['dot segments after the folder', `submissions/${SUB}/images/../../../other-bucket/secret.png`],
    ['dot segments inside the key', `submissions/${SUB}/images/${ITEM}/representative/../../../../x/0-${SHA}.png`],
    ['dot segments after the file', `${GOOD}/../x.png`],
    ['encoded dot segments', `submissions/${SUB}/images/%2e%2e/%2e%2e/0-${SHA}.png`],
    ['encoded slash', `submissions/${SUB}/images/${ITEM}%2frepresentative/0-${SHA}.png`],
    ['backslashes', `submissions/${SUB}/images/${ITEM}\\representative\\0-${SHA}.png`],
    ['a doubled separator', `submissions/${SUB}/images//${ITEM}/representative/0-${SHA}.png`],
    ['a leading separator', `/${GOOD}`],
    ['a trailing space', `${GOOD} `],
    ['another PI', GOOD.replace(SUB, OTHER)],
    ['another folder of this PI', `submissions/${SUB}/original/${ITEM}.png`],
    ['a document, not an image', GOOD.replace('.png', '.pdf')],
    ['a short hash', `submissions/${SUB}/images/${ITEM}/representative/0-x.png`],
    ['an uppercase key', GOOD.toUpperCase()],
    ['not a string', 42 as unknown as string],
  ]
  for (const [why, path] of refused) {
    test(why, () => assert.equal(isCanonicalPiImageKey(path, { submissionId: SUB }), false, String(path)))
  }

  test('another line, role, slot or picture of this PI is refused when the caller names its own', () => {
    assert.equal(isCanonicalPiImageKey(GOOD, { submissionId: SUB, itemId: OTHER }), false)
    assert.equal(isCanonicalPiImageKey(GOOD, { submissionId: SUB, role: 'customization' }), false)
    assert.equal(isCanonicalPiImageKey(GOOD, { submissionId: SUB, position: 1 }), false)
    assert.equal(isCanonicalPiImageKey(GOOD, { submissionId: SUB, sha256: 'f'.repeat(64) }), false)
  })
})

describe('a built proposal', () => {
  const payload = (path: string, itemId = ITEM) => ({
    items: [{ id: itemId, image_storage_path: path }],
    item_images: [{ item_id: itemId, role: 'representative', position: 0, sha256: SHA, storage_path: path }],
  })
  test('naming only its own lines’ keys passes', () => {
    assert.equal(proposalImagesAreCanonical(payload(GOOD), SUB), true)
    assert.equal(proposalImagesAreCanonical({ items: [{ id: ITEM, image_storage_path: null }], item_images: [] }, SUB), true)
  })
  test('naming a traversal, another PI or another line’s key fails', () => {
    assert.equal(proposalImagesAreCanonical(payload(`submissions/${SUB}/images/../../../x/secret.png`), SUB), false)
    assert.equal(proposalImagesAreCanonical(payload(GOOD.replace(SUB, OTHER)), SUB), false)
    assert.equal(proposalImagesAreCanonical(payload(GOOD, OTHER), SUB), false)
  })

  test('the SAME refusals as the SQL twin: nothing is skipped (review R4)', () => {
    const base = payload(GOOD) as { items: Record<string, unknown>[]; item_images: Record<string, unknown>[] }
    const img = base.item_images[0]
    // An image row missing any part — even with this PI's own canonical key.
    for (const drop of ['item_id', 'role', 'position', 'sha256']) {
      const partial = { ...img }
      delete partial[drop]
      assert.equal(proposalImagesAreCanonical({ ...base, item_images: [partial] }, SUB), false, `missing ${drop}`)
    }
    assert.equal(proposalImagesAreCanonical({ ...base, item_images: [{ storage_path: GOOD }] }, SUB), false, 'a bare key')
    // A slot the SQL would not read as the same number.
    for (const position of ['00', '0.0', '', null, false, -1, 0.5]) {
      assert.equal(proposalImagesAreCanonical({ ...base, item_images: [{ ...img, position }] }, SUB), false, `position ${String(position)}`)
    }
    assert.equal(proposalImagesAreCanonical({ ...base, item_images: [{ ...img, position: '0' }] }, SUB), true, 'a digit string is what ->> reads')
    // Shapes the SQL refuses.
    assert.equal(proposalImagesAreCanonical({ ...base, item_images: {} }, SUB), false, 'item_images not an array')
    assert.equal(proposalImagesAreCanonical({ ...base, item_images: null }, SUB), false, 'item_images null')
    assert.equal(proposalImagesAreCanonical({ ...base, items: 'x' }, SUB), false, 'items not an array')
    assert.equal(proposalImagesAreCanonical({ ...base, item_images: ['x'] }, SUB), false, 'an image entry that is not an object')
    // A line picture with no line id.
    const noId = { ...base.items[0] }
    delete noId.id
    assert.equal(proposalImagesAreCanonical({ ...base, items: [noId] }, SUB), false, 'a line picture with no line')
  })
})

describe('every privileged reader uses it', () => {
  const read = (p: string) => readFileSync(p, 'utf8').replace(/\r/g, '')
  test('the Edit PI route checks the photo and the whole built proposal', () => {
    const route = read('src/app/api/orders/pi-edits/route.ts')
    assert.ok(route.includes('isCanonicalPiImageKey(photo.storage_path'))
    assert.ok(route.includes('proposalImagesAreCanonical(proposal.payload, submissionId)'))
    assert.ok(!route.includes(".startsWith(`submissions/${submissionId}/images/`)"), 'no prefix test is left')
  })
  test('the PDF route checks the live rows and again right before the service-role download', () => {
    const route = read('src/app/api/orders/[id]/pi-versions/[versionId]/pdf/route.ts')
    assert.ok(route.includes("isCanonicalPiImageKey(m.storage_path, { submissionId, itemId: m.item_id, role: 'representative' })"))
    const guard = route.indexOf('!isCanonicalPiImageKey(path, { submissionId })')
    const download = route.indexOf('.download(path)')
    assert.ok(guard > 0 && download > guard, 'the last check sits before the download')
    assert.ok(route.includes('version.submission_id !== submissionId'), 'the version must belong to this Order’s PI')
  })
  test('a version’s content is filtered the same way', () => {
    assert.ok(read('src/lib/orders/piVersionPdf.ts').includes("isCanonicalPiImageKey(path, { submissionId, itemId: item, role: 'representative' })"))
  })
  test('the Confirmed PDF checks each row and again right before its service-role read (review R3)', () => {
    const route = read('src/app/api/orders/[id]/documents/route.ts')
    assert.ok(route.includes('isCanonicalPiImageKey(image.storage_path, {'), 'each stored row is checked whole')
    assert.ok(!route.includes('.startsWith(`submissions/${submissionId}/`)'), 'no prefix test is left')
    const guard = route.indexOf('!isCanonicalPiImageKey(path, { submissionId })')
    const read_ = route.indexOf('return read(path)')
    assert.ok(guard > 0 && read_ > guard, 'the last check sits before the read')
  })
  test('a reused upload is checked whole before its bytes are fetched (review R3)', () => {
    const route = read('src/app/api/orders/import/process-draft/route.ts')
    const guard = route.indexOf('isCanonicalPiImageKey(image.storagePath, {')
    const download = route.indexOf(".download(image.storagePath)")
    assert.ok(guard > 0 && download > guard)
  })
  test('no service-role product-image read is left without it', () => {
    for (const file of ['src/app/api/orders/[id]/documents/route.ts', 'src/app/api/orders/[id]/pi-versions/[versionId]/pdf/route.ts',
                        'src/app/api/orders/import/process-draft/route.ts']) {
      assert.ok(read(file).includes('isCanonicalPiImageKey('), file)
    }
  })
})
