// Phase 4, Image studio: the rules the picture route checks before anything is paid for, and the route's own
// safety (pinned on its source, as the vendor and Edit PI image routes are).

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { CLEAN_UP_PROMPT, readReference, studioProblem, studioPrompt } from './pictureStudio'

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
    assert.ok(route.indexOf("rpc('quotation_my_access')") < route.indexOf('callFal('))
  })
})
