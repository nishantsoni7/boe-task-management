// Phase 4, Image studio: the rules the picture route checks before anything is paid for, and the route's own
// safety (pinned on its source, as the vendor and Edit PI image routes are).

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { CLEAN_UP_PROMPT, MAX_DETAILS, lineDetails, readDetails, readReference, studioProblem, studioPrompt } from './pictureStudio'

const PATH = '00000000-0000-0000-0000-0000000000b2/0f8fad5b-d9cb-469f-a165-70867728950e.jpg'

describe('what the picture route accepts', () => {
  test('only a saved quotation picture, a known mode, and a real change for Change it', () => {
    assert.equal(studioProblem('clean', PATH, undefined), null)
    assert.equal(studioProblem('change', PATH, 'walnut finish'), null)
    assert.match(studioProblem('repaint', PATH, '')!, /Clean up or Change it/)
    assert.match(studioProblem('clean', '../order-files/x.jpg', '')!, /saved product picture/)
    assert.match(studioProblem('clean', `submissions/${PATH}`, '')!, /saved product picture/)
    assert.match(studioProblem('change', PATH, ' ')!, /Say what to change/)
    assert.match(studioProblem('change', PATH, 'x'.repeat(401))!, /under 400/)
  })
  test('a reference picture is an image data URL under 2 MB, or nothing', () => {
    assert.equal(readReference(undefined), null)
    assert.equal(readReference(''), null)
    assert.deepEqual(readReference('data:image/jpeg;base64,AAAA'), { mime: 'image/jpeg', base64: 'AAAA' })
    assert.equal(readReference('data:text/html;base64,AAAA'), false)
    assert.equal(readReference('https://example.com/x.jpg'), false)
    assert.equal(readReference(`data:image/png;base64,${'A'.repeat(3_000_000)}`), false)
  })
  test('Clean up keeps the design and only cleans; Change it uses Edit PI\'s prompt', () => {
    assert.match(CLEAN_UP_PROMPT, /exactly the same design/)
    assert.match(CLEAN_UP_PROMPT, /Do not redesign/)
    assert.match(CLEAN_UP_PROMPT, /white studio background/)
    assert.equal(studioPrompt('clean', 'ignored', false), CLEAN_UP_PROMPT)
    assert.match(studioPrompt('change', 'walnut finish', true), /Required change: walnut finish/)
    assert.match(studioPrompt('change', 'walnut finish', true), /Image 2 is a reference picture/)
  })
})

describe('the product details sent with a picture (owner, 23 Nov 2026)', () => {
  test('the line\'s name, size (with the quotation\'s unit) and material become the details; blanks are left out', () => {
    assert.equal(lineDetails({ name: 'Dining chair', size_text: '47 × 52 × 80', material: 'Ash\n wood' }, 'in'), 'Product: Dining chair. Size: 47 × 52 × 80 in. Material: Ash wood')
    assert.equal(lineDetails({ name: 'Bed', size_text: '', material: ' ' }, 'cm'), 'Product: Bed')
    assert.equal(lineDetails({ name: '', size_text: '6\'0" × 6\'6"', material: '' }, 'cm'), 'Size: 6\'0" × 6\'6"') // already carries its unit
    assert.ok(lineDetails({ name: 'x'.repeat(500), size_text: '', material: '' }, 'in').length <= MAX_DETAILS)
  })
  test('they guide size and material but are never drawn; none leaves the prompt exactly as it was', () => {
    assert.equal(studioPrompt('clean', '', false, ''), CLEAN_UP_PROMPT)
    assert.equal(studioPrompt('clean', '', false), CLEAN_UP_PROMPT)
    const clean = studioPrompt('clean', '', false, 'Product: Chair. Size: 47 × 52 × 80 in')
    assert.ok(clean.startsWith(CLEAN_UP_PROMPT))
    assert.match(clean, /Product: Chair\. Size: 47 × 52 × 80 in/)
    assert.match(clean, /never write these words or numbers on the picture/)
    assert.doesNotMatch(clean, /required change/)
    const change = studioPrompt('change', 'walnut finish', false, 'Material: Ash wood')
    assert.match(change, /Required change: walnut finish/)
    assert.match(change, /Material: Ash wood/)
    assert.match(change, /If they differ from the required change, follow the change/)
    assert.equal(studioPrompt('change', 'walnut finish', false, '  '), studioPrompt('change', 'walnut finish', false))
  })
  test('a request carries text up to 300 characters, or nothing; anything else is refused before paying', () => {
    assert.equal(readDetails(undefined), '')
    assert.equal(readDetails(null), '')
    assert.equal(readDetails('  Product: Chair '), 'Product: Chair')
    assert.equal(readDetails('x'.repeat(MAX_DETAILS)), 'x'.repeat(MAX_DETAILS))
    assert.equal(readDetails('x'.repeat(MAX_DETAILS + 1)), false)
    assert.equal(readDetails(5), false)
  })
})

describe('the picture route', () => {
  const route = readFileSync('src/app/api/quotations/picture/route.ts', 'utf8')
  test('checks access as the caller, writes as the caller, makes one JPEG request with the server key', () => {
    assert.match(route, /rpc\('quotation_my_access'\)/)
    assert.doesNotMatch(route, /adminClient|service_role|SERVICE_ROLE/)
    assert.equal(route.match(/callFal\(/g)?.length, 1)
    assert.match(route, /output_format: 'jpeg'/)
    assert.match(route, /process\.env\.FAL_KEY/)
    assert.match(route, /\$\{user\.id\}\/\$\{crypto\.randomUUID\(\)\}\.jpg/)
    // refused before paying: the checks come before the provider call
    assert.ok(route.indexOf('studioProblem(') < route.indexOf('callFal('))
    assert.ok(route.indexOf('readDetails(') < route.indexOf('spendCredits('))
    assert.ok(route.indexOf("rpc('quotation_my_access')") < route.indexOf('callFal('))
  })
})
