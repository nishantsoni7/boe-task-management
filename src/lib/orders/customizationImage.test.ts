/**
 * Customize image (Edit PI on a draft) — the pure rules and the route's guards.
 *
 * Run:
 *   npx tsx --test src/lib/orders/customizationImage.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  CUSTOMIZATION_CHIPS,
  MAX_INSTRUCTION_LENGTH,
  addChipToInstruction,
  buildEditPrompt,
  instructionProblem,
  suggestInstruction,
} from './customizationImage'

describe('the suggestion starts from what sales wrote', () => {
  test('the customization text, tidied', () => {
    assert.equal(suggestInstruction('  Marble top\n instead of   wood '), 'Marble top instead of wood')
  })
  test('nothing written, nothing suggested', () => {
    assert.equal(suggestInstruction('   '), '')
  })
  test('never longer than an instruction may be', () => {
    assert.ok(suggestInstruction('x'.repeat(5000)).length <= MAX_INSTRUCTION_LENGTH)
  })
})

describe('chips', () => {
  const marble = CUSTOMIZATION_CHIPS.find(c => c.label === 'Marble top')!.text
  test('a chip on an empty box is the chip', () => {
    assert.equal(addChipToInstruction('', marble), marble)
  })
  test('a chip after text becomes its own sentence', () => {
    assert.equal(addChipToInstruction('Make it 2400 mm long.', marble), `Make it 2400 mm long. ${marble}`)
  })
  test('the same chip twice adds it once', () => {
    const once = addChipToInstruction('', marble)
    assert.equal(addChipToInstruction(once, marble), once)
  })
})

describe('what an instruction may be', () => {
  test('blank or too short is refused', () => {
    assert.equal(instructionProblem(''), 'too_short')
    assert.equal(instructionProblem(' a '), 'too_short')
    assert.equal(instructionProblem(undefined), 'too_short')
  })
  test('too long is refused', () => {
    assert.equal(instructionProblem('x'.repeat(MAX_INSTRUCTION_LENGTH + 1)), 'too_long')
  })
  test('an ordinary change is fine', () => {
    assert.equal(instructionProblem('round top instead of square'), null)
  })
})

test('the prompt carries the change and keeps everything else the same', () => {
  const p = buildEditPrompt('  round   top ')
  assert.match(p, /Required change: round top/)
  assert.match(p, /Keep everything not mentioned in the change identical/)
  assert.match(p, /Do not add people, text, logos/)
})

describe('the regenerate route', () => {
  const src = readFileSync('src/app/api/orders/pi-edits/regenerate-image/route.ts', 'utf8')
  test('reads the source only from this PI’s own canonical keys', () => {
    assert.match(src, /isCanonicalPiImageKey\(sourcePath, \{ submissionId \}\)/)
  })
  test('asks the database who may change photos before spending', () => {
    const permissionAt = src.indexOf("rpc('can_edit_order_submission'")
    const paidAt = src.indexOf('await callFal(')
    assert.ok(permissionAt > 0 && paidAt > permissionAt)
  })
  test('one provider request per press, through the no-retry adapter', () => {
    assert.equal(src.match(/callFal\(/g)?.length, 1)
    assert.doesNotMatch(src, /@fal-ai\/client/)
  })
  test('stores under the line’s representative key, like a photo upload', () => {
    assert.match(src, /images\/\$\{itemId\}\/representative\/0-\$\{sha256\}/)
  })
  test('the key never reaches the response', () => {
    assert.doesNotMatch(src, /NextResponse\.json\([^)]*apiKey/)
  })
})

test('the editor offers Customize image on a draft only', () => {
  const editor = readFileSync('src/components/orders/PiEditor.tsx', 'utf8')
  assert.match(editor, /\{mode === 'apply' && \(\s*<PiImageRegenerate/)
})
