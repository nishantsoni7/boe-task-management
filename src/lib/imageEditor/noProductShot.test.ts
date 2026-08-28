/**
 * Product Shot is gone, and this is what keeps it gone.
 *
 * Two paid results settled it. The first invented a circular decorative
 * backdrop nobody asked for; the second removed the circle and shrank the chair
 * to about a fifth of the frame. Neither followed the composition, and no
 * wording of the request changed that — so the model was taken out of the
 * composition entirely. It segments; the framing is arithmetic.
 *
 * The risk this guards is not that somebody argues for it again. It is that a
 * merge, a revert, or a copied line quietly reintroduces the endpoint, and the
 * next thing anyone notices is a bill and a wrong picture. So this walks the
 * whole runtime tree rather than trusting any single file.
 *
 * Run:
 *   npx tsx --test src/lib/imageEditor/noProductShot.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { MODEL_ID } from './briaBackgroundRemove'

const ROOTS = ['src', 'scripts']
const CODE = /\.(ts|tsx|mts|mjs|js|jsx)$/

/** Every source file that ships or runs, tests excluded — a test is allowed to
 *  name the thing it forbids, and this file is the proof of that. */
function runtimeFiles(): string[] {
  const found: string[] = []

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) { walk(path); continue }
      if (!CODE.test(entry)) continue
      if (/\.test\.(ts|tsx|mts|mjs)$/.test(entry)) continue
      found.push(path)
    }
  }

  for (const root of ROOTS) walk(join(process.cwd(), root))
  return found
}

const FILES = runtimeFiles()

describe('the generative endpoint is not in the runtime path', () => {
  test('there is a runtime path to check at all', () => {
    // Without this the suite would pass by finding nothing.
    assert.ok(FILES.length > 50, `only ${FILES.length} runtime files were walked`)
    assert.ok(FILES.some(f => f.includes('composeStudioImage')))
    assert.ok(FILES.some(f => f.includes('image-editor')))
  })

  test('no file names fal-ai/bria/product-shot', () => {
    const offenders = FILES.filter(f => readFileSync(f, 'utf8').includes('fal-ai/bria/product-shot'))
    assert.deepEqual(offenders, [], `Product Shot is back in: ${offenders.join(', ')}`)
  })

  test('no file names it in any spelling, nor the adapter that called it', () => {
    const spellings = ['product-shot', 'product_shot', 'productShot', 'ProductShot', 'briaProductShot']
    const offenders: string[] = []

    for (const file of FILES) {
      const source = readFileSync(file, 'utf8')
      for (const spelling of spellings) {
        if (source.includes(spelling)) offenders.push(`${file} (${spelling})`)
      }
    }
    assert.deepEqual(offenders, [], offenders.join('\n'))
  })

  test('the deleted adapter cannot be imported, because it is not there', async () => {
    await assert.rejects(
      () => import('./briaProductShot.js' as string),
      'briaProductShot must stay deleted',
    )
  })

  test('the only fal endpoint anywhere is background removal', () => {
    // Any `fal.run/<something>` in the tree has to be this one.
    const pattern = /fal\.run\/([\w./-]+)/g
    const seen = new Set<string>()

    for (const file of FILES) {
      for (const match of readFileSync(file, 'utf8').matchAll(pattern)) seen.add(match[1])
    }

    for (const endpoint of seen) {
      assert.ok(endpoint.startsWith('${MODEL_ID}') || endpoint === MODEL_ID,
        `an unexpected fal endpoint is reachable: ${endpoint}`)
    }
  })

  test('the model that is used is a removal model, by its own id', () => {
    assert.equal(MODEL_ID, 'fal-ai/bria/background/remove')
    assert.ok(!MODEL_ID.includes('shot'))
  })
})

describe('nothing generative is described to the provider', () => {
  test('no scene description, prompt or placement instruction survives', () => {
    // Product Shot took a scene description and a placement, and honoured
    // neither. Background removal takes an image. A file still carrying that
    // vocabulary is a file that has drifted back toward asking a model to
    // compose, which is the thing that failed.
    const banned = [
      'manual_placement', 'placement_type', 'shot_size', 'optimize_description',
      'num_results', 'scene_description', 'SCENE_DESCRIPTION',
    ]
    const offenders: string[] = []

    for (const file of FILES) {
      const source = readFileSync(file, 'utf8')
      for (const phrase of banned) {
        if (source.includes(phrase)) offenders.push(`${file} (${phrase})`)
      }
    }
    assert.deepEqual(offenders, [], offenders.join('\n'))
  })
})
