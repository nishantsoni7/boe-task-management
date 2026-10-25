/**
 * Customize image (Edit PI on a draft) — the pure rules and the routes' guards.
 *
 * Run:
 *   npx tsx --test src/lib/orders/customizationImage.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  CUSTOMIZATION_CHIPS,
  INTERPRET_SYSTEM_PROMPT,
  MAX_INSTRUCTION_LENGTH,
  MAX_REFERENCES,
  addChipToInstruction,
  buildEditPrompt,
  buildInterpretRequest,
  instructionProblem,
  parseReferences,
  readInterpretation,
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
  test('there is a chip for one floor plate shared by two bases', () => {
    assert.ok(CUSTOMIZATION_CHIPS.some(c => /single continuous floor plate/.test(c.text)))
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

describe('reference pictures', () => {
  const jpeg = 'data:image/jpeg;base64,' + 'A'.repeat(400)
  test('none is an empty list', () => {
    assert.deepEqual(parseReferences(undefined), [])
  })
  test('JPEG, PNG and WebP data URLs are read', () => {
    const refs = parseReferences([jpeg, 'data:image/png;base64,AAAA'])
    assert.equal(refs?.length, 2)
    assert.equal(refs?.[0].mimeType, 'image/jpeg')
  })
  test(`more than ${MAX_REFERENCES} is refused`, () => {
    assert.equal(parseReferences([jpeg, jpeg, jpeg]), null)
  })
  test('anything that is not an image data URL is refused', () => {
    assert.equal(parseReferences(['https://example.com/a.jpg']), null)
    assert.equal(parseReferences(['data:image/svg+xml;base64,AAAA']), null)
    assert.equal(parseReferences(['data:image/jpeg;base64,']), null)
  })
  test('an oversized picture is refused', () => {
    assert.equal(parseReferences(['data:image/jpeg;base64,' + 'A'.repeat(3 * 1024 * 1024)]), null)
  })
})

describe('understanding the customization', () => {
  test('the system prompt teaches shared parts and engineering sense', () => {
    assert.match(INTERPRET_SYSTEM_PROMPT, /single continuous piece/)
    assert.match(INTERPRET_SYSTEM_PROMPT, /ONE continuous flat rectangular metal plate/)
    assert.match(INTERPRET_SYSTEM_PROMPT, /cannot measure/)
  })
  test('the request carries the words and the PI facts, and names the reference pictures', () => {
    const r = buildInterpretRequest({ comment: 'bottom plate combined', productName: 'Lyon table', dimensions: '2400 x 900', material: '', referenceCount: 1 })
    assert.match(r, /bottom plate combined/)
    assert.match(r, /Product name: Lyon table/)
    assert.match(r, /2400 x 900/)
    assert.doesNotMatch(r, /Material on the PI/)
    assert.match(r, /next image is a reference picture/)
  })
  test('an answer is trimmed and its guesses kept', () => {
    assert.deepEqual(readInterpretation({ instruction: '  Make the top round. ', assumptions: [' Same wood ', ''] }),
      { instruction: 'Make the top round.', assumptions: ['Same wood'] })
  })
  test('an unusable answer is null', () => {
    assert.equal(readInterpretation(null), null)
    assert.equal(readInterpretation({ instruction: '' }), null)
    assert.equal(readInterpretation({ assumptions: [] }), null)
  })
})

describe('the image prompt', () => {
  test('carries the change and keeps everything else the same', () => {
    const p = buildEditPrompt('  round   top ')
    assert.match(p, /Required change: round top/)
    assert.match(p, /Keep everything not mentioned in the change identical/)
    assert.match(p, /which parts are joined into one piece/)
  })
  test('names the reference pictures when there are some', () => {
    assert.match(buildEditPrompt('x top', 2), /Images 2 to 3 are reference pictures/)
    assert.doesNotMatch(buildEditPrompt('x top', 0), /reference/)
  })
})

describe('the regenerate route', () => {
  const src = readFileSync('src/app/api/orders/pi-edits/regenerate-image/route.ts', 'utf8')
  test('reads the source only from this PI’s own canonical keys', () => {
    assert.match(src, /isCanonicalPiImageKey\(sourcePath, \{ submissionId \}\)/)
  })
  test('asks who may change photos before spending', () => {
    const permissionAt = src.indexOf('await mayChangePiPhotos(')
    const paidAt = src.indexOf('await callFal(')
    assert.ok(permissionAt > 0 && paidAt > permissionAt)
  })
  test('one provider request per press, through the no-retry adapter', () => {
    assert.equal(src.match(/callFal\(/g)?.length, 1)
    assert.doesNotMatch(src, /@fal-ai\/client/)
  })
  test('sends the product photo first, then the references', () => {
    assert.match(src, /image_urls: \[\s*toDataUrl\(source\.jpeg/)
  })
  test('stores under the line’s representative key, like a photo upload', () => {
    assert.match(src, /images\/\$\{itemId\}\/representative\/0-\$\{sha256\}/)
  })
})

describe('the interpret route', () => {
  const src = readFileSync('src/app/api/orders/pi-edits/interpret-customization/route.ts', 'utf8')
  test('reads the source only from this PI’s own canonical keys', () => {
    assert.match(src, /isCanonicalPiImageKey\(sourcePath, \{ submissionId \}\)/)
  })
  test('asks who may change photos before calling Claude', () => {
    const permissionAt = src.indexOf('await mayChangePiPhotos(')
    const callAt = src.indexOf("await fetch('https://api.anthropic.com/v1/messages'")
    assert.ok(permissionAt > 0 && callAt > permissionAt)
  })
  test('one attempt, structured output, refusals handled', () => {
    assert.equal(src.match(/await fetch\(/g)?.length, 1)
    assert.match(src, /format: \{ type: 'json_schema'/)
    assert.match(src, /'anthropic-beta': 'server-side-fallback-2026-07-01'/)
    assert.match(src, /stop_reason === 'refusal'/)
    assert.match(src, /fallbacks: 'default'/)
  })
  test('stores nothing', () => {
    assert.doesNotMatch(src, /\.upload\(/)
  })
})

test('the editor offers Customize image on a draft only', () => {
  const editor = readFileSync('src/components/orders/PiEditor.tsx', 'utf8')
  assert.match(editor, /\{mode === 'apply' && \(\s*<PiImageRegenerate/)
})

test('both routes ship libvips (they load sharp)', () => {
  const config = readFileSync('next.config.ts', 'utf8')
  assert.match(config, /'\/api\/orders\/pi-edits\/regenerate-image'/)
  assert.match(config, /'\/api\/orders\/pi-edits\/interpret-customization'/)
})
