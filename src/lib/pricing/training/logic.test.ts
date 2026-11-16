import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { logicRows } from './logic'
import type { TaughtCase } from './match'

const base = { variant: null, image_path: null, wood: null, wood_amount: null, in_wood: {} }
const line = (element: string, kind: string, amount: number) => ({ element, kind, amount, material: null })
const A: TaughtCase = { ...base, id: 'a', case_no: 1, name: 'Arm chair', total: 6200, lines: [line('Back weaving', 'material', 1000), line('Wooden structure', 'structure', 4500), line('Margin', 'margin', 700)] }
const B: TaughtCase = { ...base, id: 'b', case_no: 2, name: 'Side chair', total: 5350, lines: [line('Wooden structure', 'structure', 4000), line('back WEAVING', 'material', 600), line('Brass caps', 'material', 150), line('Brass caps', 'material', 100), line('Margin', 'margin', 500)] }

describe('price logic: taught cases side by side', () => {
  it('makes one row per element name, in the order of the Training kinds, with an empty cell where a case lacks it', () => {
    const rows = logicRows([A, B])
    assert.deepEqual(rows.map(r => [r.element, r.cells]), [
      ['Wooden structure', [4500, 4000]],
      ['Back weaving', [1000, 600]],
      ['Brass caps', [null, 250]],
      ['Margin', [700, 500]],
    ])
  })

  it('marks an element whose highest amount is more than 20% above its lowest, and never one that is on a single case', () => {
    const v = Object.fromEntries(logicRows([A, B]).map(r => [r.element, r.varies]))
    assert.deepEqual(v, { 'Wooden structure': false, 'Back weaving': true, 'Brass caps': false, 'Margin': true })
  })

  it('has no rows when the cases came without their elements', () => {
    assert.deepEqual(logicRows([{ ...A, lines: undefined }]), [])
  })
})
