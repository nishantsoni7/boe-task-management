// The size a price depends on is the footprint (length × breadth). These are the sizes as the owner's real PIs write them
// (the first blind test, 14 Nov 2026, read "Length - 72 Breadth - 24 Height - 30" as 72 × 30 and a seat height as a depth),
// plus the unit and typo cases. Plus the wording of the reason for a finish the model has not seen.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { dimensionsInches, lineFeatures, planAreaOf } from './features'
import { fitType, predict, type ModelPoint } from './model'

const near = (a: number | null, b: number) => assert.ok(a !== null && Math.abs(a - b) < 1, `${a} is not ${b}`)

describe('the footprint of a size as PIs write it', () => {
  test('labelled sizes use length × breadth and never the height', () => {
    near(planAreaOf('Length - 72 Breadth - 24 Height - 30'), 72 * 24)
    near(planAreaOf('Length - 78 Breadth - 28 Height - 30'), 78 * 28)
    near(planAreaOf('Length-30" Width- 18" Height- 32"'), 30 * 18)
    near(planAreaOf('L 60 D 30 H 18'), 60 * 30)
    near(planAreaOf('Length: 48, Depth: 20, Height: 30'), 48 * 20)
  })

  test('typos seen in real PIs are read', () => {
    near(planAreaOf('Lenght - 60 Bredth - 30 Hight - 30'), 60 * 30)
    near(planAreaOf('Lentdh - 60 Widht - 30'), 60 * 30)
  })

  test('a seat height is not a depth: a sofa given only a length and a seating height has no footprint', () => {
    assert.equal(planAreaOf('Length - 56 Standard Seating Height - 18'), null)
    assert.equal(planAreaOf('Length - 60 Seating Height 18'), null)
    assert.equal(planAreaOf(`60" Lentdh Standard Diamension (Seating Height 18")`), null)
    assert.equal(planAreaOf('Standard dimensions'), null)
    assert.equal(planAreaOf('as per ref image'), null)
  })

  test('heights alone are not a footprint; a marked height beside two plain numbers still leaves the footprint', () => {
    assert.equal(planAreaOf('Seat height 18, arm height 24'), null)
    assert.equal(planAreaOf('Height - 30, Seating Height - 18'), null)
    assert.equal(planAreaOf('18h 24h'), null)
    assert.equal(planAreaOf(`Seat height 1'6", back height 3'`), null)
    near(planAreaOf('24 x 18 x 30h'), 24 * 18)
    near(planAreaOf('20 x 22, Seat Height 18'), 20 * 22)
  })

  test('a labelled size in feet is read like one in inches', () => {
    near(planAreaOf('Length 6 ft Width 3 ft'), 72 * 36)
    near(planAreaOf('Length - 6 feet, Breadth - 2.5 feet, Height - 3 ft'), 72 * 30)
    near(planAreaOf(`Length 6'6" Width 3' Height 2'6"`), 78 * 36)
    near(planAreaOf(`L 6' x W 3' x H 2.5'`), 72 * 36)
    near(planAreaOf('Length 6 ft 6 in Width 3 ft'), 78 * 36)
    near(planAreaOf('Diameter 3 ft'), 36 * 36)
    near(planAreaOf('Length 30 ft Width 2 ft'), 360 * 24) // 360 inches stays inches, not millimetres
    assert.equal(planAreaOf('Length 6 ft, Seating Height 18'), null)
    near(planAreaOf(`6'0" x 6'6"`), 72 * 78) // feet with no label: the plain reading, as before
    near(planAreaOf(`6'0" x 6'6" x 1'6"`), 72 * 78)
    near(planAreaOf('6 ft x 3 ft'), 72 * 36)
  })

  test('feet as the real PIs write them: a hyphen or dot between feet and inches, and a lone length in feet is no footprint', () => {
    near(planAreaOf(`size -7'L*4'W*3'H`), 84 * 48)
    near(planAreaOf(`L-6'-10" D -2'-6"`), 82 * 30)
    near(planAreaOf(`4 seater 3'-6"dia *2'-6"H`), 42 * 42)
    near(planAreaOf(`3'6" Dia*2'6" Height`), 42 * 42)
    near(planAreaOf(`Size -2'-2"dia *1'6"H backrest height -3'-0"`), 26 * 26)
    near(planAreaOf('Standard Dimensions 16"H 3 ft dia'), 36 * 36)
    assert.equal(planAreaOf(`7'.6" Length Should Be divided -3'+4'.6"`), null)
    near(planAreaOf('24 x 24 inch height 30 inch'), 24 * 30) // not every number is a height: the plain reading, as before
  })

  test('shapes seen in the owner\'s real PIs: a lone height mark, W / D / H in millimetres, an "L" in front of plain numbers, a mattress, a seater count', () => {
    near(planAreaOf('24 x 18x30h'), 24 * 18)
    near(planAreaOf('size -24 x 18x30h'), 24 * 18)
    near(planAreaOf('W-600 mm D-450 mm H-750 mm'), (600 / 25.4) * (450 / 25.4))
    near(planAreaOf('L 72*24*30'), 72 * 24)
    near(planAreaOf('mattress size 78 length 60 width'), 78 * 60)
    assert.equal(planAreaOf('standard dimension length-56 (3 seater sofa)'), null, 'a seater count is not a width')
    assert.equal(planAreaOf('length - 30 inches seating height - 18 inches'), null)
  })

  test('a diameter is a footprint of its own', () => {
    near(planAreaOf('Dia - 30 Height - 18'), 30 * 30)
    near(planAreaOf('Diameter 36 in'), 36 * 36)
  })

  test('units: millimetres and centimetres written with labels', () => {
    near(planAreaOf('Length 1800 Width 900 Height 750 mm'), (1800 / 25.4) * (900 / 25.4))
    near(planAreaOf('Length 180 Width 90 Height 75 cm'), (180 / 2.54) * (90 / 2.54))
  })

  test('a unit glued to its number is still the unit ("180cm" is not 180 inches)', () => {
    const cm = (180 / 2.54) * (90 / 2.54)
    near(planAreaOf('L 180cm W 90cm H 75cm'), cm)
    near(planAreaOf('Length - 180cm, Breadth - 90cm'), cm)
    near(planAreaOf('180cm x 90cm x 75cm'), (180 / 2.54) * (90 / 2.54))
    near(planAreaOf('L 250mm W 200mm'), (250 / 25.4) * (200 / 25.4))
    near(planAreaOf('250mm x 200mm'), (250 / 25.4) * (200 / 25.4))
    near(planAreaOf('Dia 60cm'), (60 / 2.54) ** 2)
    assert.deepEqual(dimensionsInches('180cm x 200cm'), [70.87, 78.74])
    near(planAreaOf('Comm 30 x 40'), 30 * 40) // a word ending in "mm" is not a unit
  })

  test('plain numbers keep the old rule, the two largest (tried as "first two of W x D x H" on 4,874 real lines: no better)', () => {
    near(planAreaOf('72 x 24 x 96'), 96 * 72)
    near(planAreaOf('78 x 84 x 42'), 78 * 84)
    near(planAreaOf('20 x 16 x 22'), 22 * 20)
    near(planAreaOf('72 x 78'), 72 * 78)
    near(planAreaOf('1800 x 2000 mm'), (1800 / 25.4) * (2000 / 25.4))
  })

  test('a number marked (H) is the height wherever it stands', () => {
    near(planAreaOf('36 × 36 × 30(H)'), 36 * 36)
    near(planAreaOf('36 × 24 × 30(H)'), 36 * 24)
    near(planAreaOf('30(H) x 36 x 24'), 36 * 24)
  })

  test('feet and inches are read as before', () => {
    near(planAreaOf(`6'0" x 6'6"`), 72 * 78)
    near(planAreaOf(`6'0" x 6'6" x 1'6"`), 72 * 78)
  })

  test('a word that only looks like a label is not one, and empty or number-less text gives nothing', () => {
    near(planAreaOf('Brass 30 x 40 x 20'), 30 * 40) // "Brass" is not read as a breadth; the plain rule applies
    assert.equal(planAreaOf(''), null)
    assert.equal(planAreaOf(null), null)
    assert.equal(planAreaOf('Standard'), null)
  })

  test('the line the model reads uses it', () => {
    assert.equal(lineFeatures({ name: 'Reception Table', size: 'Length - 72 Breadth - 24 Height - 30' }).area, 72 * 24)
    assert.equal(lineFeatures({ name: 'Sofa', size: 'Length - 56 Standard Seating Height - 18' }).area, null)
  })
})

describe('the reason for a kind the model has not seen says what it was priced as', () => {
  const SIZES = ['60 x 78', '72 x 78', '72 x 84', '78 x 84']
  const pool: ModelPoint[] = Array.from({ length: 40 }, (_, i) => ({
    k: 'order', p: 40000 + (i % 4) * 4000 + (i % 3) * 2500, q: 5, at: '2026-01-01T00:00:00Z', name: 'King bed with headboard', dims: SIZES[i % 4],
    material: i % 3 ? 'Teak wood' : 'Mango wood', finish: i % 2 ? 'PU finish' : 'Natural finish', client_type: null,
  }))
  const fit = fitType(pool, 'bed', Date.parse('2026-11-14T06:00:00Z'))!
  const line = (over: Partial<Parameters<typeof lineFeatures>[0]>) => predict(fit, lineFeatures({ name: 'King bed with headboard', size: '78 x 84', material: 'Teak wood', finish: 'PU finish', ...over }))

  test('an unseen finish is priced as the usual finish, not as a material', () => {
    const r = line({ finish: 'Powder coat' }).reasons.filter(x => /not seen before/.test(x))
    assert.equal(r.length, 1)
    assert.match(r[0], /^Powder finish not seen before: priced as (Pu|Natural)$/)
    assert.doesNotMatch(r[0], /Teak|Mango|Acacia/)
  })

  test('an unseen material says so in its own sentence, and two unseen kinds give two sentences', () => {
    const one = line({ material: 'Walnut wood' }).reasons.filter(x => /not seen before/.test(x))
    assert.match(one[0], /^Walnut material not seen before: priced as (Teak|Mango)$/)
    const both = line({ material: 'Walnut wood', finish: 'Powder coat' }).reasons.filter(x => /not seen before/.test(x))
    assert.equal(both.length, 2)
  })

  test('a line the model has seen everything about adds no such sentence', () => {
    assert.equal(line({}).reasons.filter(x => /not seen before/.test(x)).length, 0)
  })
})
