/**
 * Storing what a workbook's side sheets said, pictures included (owner,
 * 2026-10-30). A fake service client records every upload and the one save, so
 * the key shape the save function checks and the "a lost picture never loses
 * the text" rule are exercised without a database.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import type { AdminSupabaseClient } from '@/lib/supabase/admin'
import type { PiCellPicture } from '@/lib/pi/drawingAnchors'
import { saveFabricFinishSheets, sheetLinesFor, type SheetLine } from './fabricFinishServer'

const SUB = '11111111-1111-4111-8111-111111111111'
const SHA = 'a'.repeat(64)
const picture = (over: Partial<PiCellPicture> = {}): PiCellPicture => ({
  bytes: new Uint8Array([1, 2, 3]), format: 'png', mimeType: 'image/png', extension: 'png', ...over,
})

function fake(failUploads = false) {
  const uploads: { path: string; upsert: unknown }[] = []
  const saves: { name: string; args: { p_submission_id: string; p_workbook_sha256: string; p_lines: SheetLine[] } }[] = []
  const service = {
    storage: { from: () => ({
      upload: async (path: string, _bytes: Uint8Array, options: { upsert: unknown }) => {
        uploads.push({ path, upsert: options.upsert })
        return { error: failUploads ? { message: 'no' } : null }
      },
    }) },
    rpc: async (name: string, args: (typeof saves)[number]['args']) => { saves.push({ name, args }); return { error: null } },
  } as unknown as AdminSupabaseClient
  return { service, uploads, saves }
}

const sheetLine = (over: Partial<SheetLine> = {}): SheetLine => ({
  item_sequence: 'BE0001', fabric_metres_per_piece: 1.5, fabric_price_per_metre: 600, packing_cost_per_piece: 350,
  packing_type: 'BCF', finish: [], ...over,
})

describe('saving a workbook’s side sheets', () => {
  test('a picture is stored under the key the save function checks, and travels with its text', async () => {
    const { service, uploads, saves } = fake()
    const result = await saveFabricFinishSheets(service, SUB, SHA, [
      sheetLine({ finish: [{ heading: 'Fabric Approval', value: 'Tony 115', picture: picture() }] }),
    ])
    assert.deepEqual(result, { saved: true, pictures: 1 })
    assert.match(uploads[0].path, new RegExp(`^submissions/${SUB}/fabric-finish/BE0001/[0-9a-f]{64}\\.png$`))
    const [entry] = saves[0].args.p_lines[0].finish
    assert.equal(entry.image_path, uploads[0].path)
    assert.match(entry.image_sha256 as string, /^[0-9a-f]{64}$/)
    assert.ok(!('picture' in entry), 'bytes never reach the database call')
    assert.equal(saves[0].name, 'order_submission_fabric_finish_save_sheet')
    assert.equal(saves[0].args.p_workbook_sha256, SHA)
  })

  test('the same picture on two lines is stored once per line', async () => {
    const { service, uploads } = fake()
    const shared = picture()
    await saveFabricFinishSheets(service, SUB, SHA, [
      sheetLine({ item_sequence: 'BE0001', finish: [{ heading: 'Metal Finish', value: 'VW-011', picture: shared }] }),
      sheetLine({ item_sequence: 'BE0002', finish: [{ heading: 'Metal Finish', value: 'VW-011', picture: shared }] }),
    ])
    assert.deepEqual(uploads.map(u => u.path.split('/')[3]), ['BE0001', 'BE0002'])
  })

  test('a picture that cannot be stored loses nothing else', async () => {
    const { service, saves } = fake(true)
    const result = await saveFabricFinishSheets(service, SUB, SHA, [
      sheetLine({ finish: [
        { heading: 'Fabric Approval', value: 'Tony 115', picture: picture() },
        { heading: 'Metal Finish', value: '', picture: picture() },
      ] }),
    ])
    assert.deepEqual(result, { saved: true, pictures: 0 })
    assert.deepEqual(saves[0].args.p_lines[0].finish.map(f => f.heading), ['Fabric Approval'],
      'the text stays; a cell that held only the lost picture has nothing left to save')
  })

  test('a line whose number cannot be part of a key keeps its text and stores no picture', async () => {
    const { service, uploads } = fake()
    await saveFabricFinishSheets(service, SUB, SHA, [
      sheetLine({ item_sequence: 'BE 0001', finish: [{ heading: 'Fabric Approval', value: 'Tony 115', picture: picture() }] }),
    ])
    assert.equal(uploads.length, 0)
  })

  test('a picture above the size limit is left out', async () => {
    const { service, uploads } = fake()
    await saveFabricFinishSheets(service, SUB, SHA, [
      sheetLine({ finish: [{ heading: 'Fabric Approval', value: 'Tony 115', picture: picture({ bytes: new Uint8Array(11 * 1024 * 1024) }) }] }),
    ])
    assert.equal(uploads.length, 0)
  })
})

describe('turning a match into lines', () => {
  const finish = { sheetRow: 2, code: 'B1', quantity: 1, specs: [{ heading: 'Fabric Approval', value: 'NA' }] }
  const match = { unmatched: [], products: [
    { productRow: 32, itemSequence: 'B1', code: 'B1', cost: null, finish },
    { productRow: 33, itemSequence: 'B2', code: 'B2', cost: null, finish: null },
    { productRow: 34, itemSequence: 'B3', code: 'B3', cost: null, finish },
  ] }

  test('a product with no stored line, or no row on either sheet, is left out', () => {
    const lines = sheetLinesFor(match, p => (p.productRow === 34 ? null : `line-${p.productRow}`))
    assert.deepEqual(lines.map(l => l.item_sequence), ['line-32'])
    assert.deepEqual(lines[0].finish.map(f => [f.heading, f.value]), [['Fabric Approval', 'NA']])
  })
})
