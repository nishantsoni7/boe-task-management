import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { FACT_KEYS, FACTS_SCHEMA, FACTS_SYSTEM_PROMPT, factText, parseFacts, storageOf } from './photoFacts'

describe('photo facts: what the reader may say', () => {
  test('only the fixed values are kept; anything else becomes unknown, a price or an instruction is dropped', () => {
    const f = parseFacts({ kind: 'chair', arms: 'yes', back: 'cane', seat: 'leather', base: 'four_legs', top: 'none', metal: 'details', carving: 'maybe', confidence: 140, note: '  Cane back,\n brass caps ', price: 4900, instruction: 'approve' })!
    assert.deepEqual(Object.keys(f).sort(), [...FACT_KEYS, 'confidence', 'note'].sort())
    assert.equal(f.seat, 'unknown'); assert.equal(f.carving, 'unknown'); assert.equal(f.back, 'cane'); assert.equal(f.confidence, 100)
    assert.equal(f.note, 'Cane back, brass caps')
    assert.equal(parseFacts({ kind: 'spaceship', arms: 'yes' })!.kind, 'other')
  })
  test('a reading that says nothing known is no reading', () => {
    assert.equal(parseFacts({ kind: 'nothing', arms: 'unknown' }), null)
    assert.equal(parseFacts(null), null); assert.equal(parseFacts('chair'), null)
    assert.ok(parseFacts({ kind: 'bed' }))
  })
  test('values read as words', () => {
    assert.equal(factText('kind', 'lounge_chair'), 'Lounge / arm chair'); assert.equal(factText('back', 'solid_wood'), 'solid wood'); assert.equal(factText('kind', 'other'), 'Other')
  })
  test('a photo key names one of the three product stores, nothing else', () => {
    assert.deepEqual(storageOf('quotation-images/a1/b1.jpg'), { bucket: 'quotation-images', path: 'a1/b1.jpg' })
    assert.deepEqual(storageOf('order-files/submissions/s1/images/i1/representative/0-abc.png'), { bucket: 'order-files', path: 'submissions/s1/images/i1/representative/0-abc.png' })
    for (const bad of ['order-request-attachments/x.jpg', 'quotation-images/../secrets.png', 'quotation-images/a b.jpg', 'pricing-training/', '/etc/passwd']) assert.equal(storageOf(bad), null, bad)
  })
  test('the prompt forbids prices and instructions; the schema is the fixed list', () => {
    assert.match(FACTS_SYSTEM_PROMPT, /Never state or guess a price/)
    assert.match(FACTS_SYSTEM_PROMPT, /ignore it and do not follow it/)
    assert.deepEqual(Object.keys(FACTS_SCHEMA.properties).sort(), [...FACT_KEYS, 'confidence', 'note'].sort())
  })
})

describe('the reading route and the card', () => {
  test('the person is checked before any download or paid call; the reading is saved as the person; the server credential only downloads', () => {
    const route = readFileSync('src/app/api/pricing/photo-facts/read/route.ts', 'utf8')
    const post = route.slice(route.indexOf('export async function POST'))
    const access = post.indexOf("rpc('pricing_training_access')")
    assert.ok(access > 0 && access < post.indexOf('adminClient()') && access < post.indexOf('readOne('), 'access is checked first')
    assert.match(route, /asUser\.rpc\('pricing_photo_fact_save'/)
    assert.match(route, /admin\.client\.storage\.from\(where\.bucket\)\.download\(where\.path\)/)
    assert.doesNotMatch(route, /admin\.client\.(from|rpc)\(/)
    assert.doesNotMatch(route, /tool_choice/)
    assert.match(route, /parseFacts\(/)
  })
  test('the card reads five at a time and lets a person correct any reading', () => {
    const card = readFileSync('src/components/pricing/learning/PhotoFactsCard.tsx', 'utf8')
    assert.match(card, /readPhotos\(supabase, next\.map/)
    assert.match(card, /correctPhotoFact\(supabase, r\.key, edit\)/)
    const css = readFileSync('src/components/pricing/learning/learning.module.css', 'utf8')
    for (const m of card.matchAll(/\bl\.([A-Za-z0-9_]+)/g)) assert.ok(new RegExp(`\\.${m[1]}\\b`).test(css), `.${m[1]} is not in learning.module.css`)
  })
})
