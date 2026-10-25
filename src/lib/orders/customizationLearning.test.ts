/**
 * Customize image learning (Phase 1) — the pure rules and the routes' guards.
 * The migration itself is proved by supabase/tests/customize_image_learning_pglite.mjs.
 *
 * Run:
 *   npx tsx --test src/lib/orders/customizationLearning.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  LEARNING_ACTION,
  attemptPatchFor,
  buildLearningContext,
  canTrainCustomizeImage,
  examplePicturePath,
  keywordsFrom,
  normaliseKeywords,
  rankExamples,
  ruleTextProblem,
  type LearningExample,
} from './customizationLearning'
import { buildInterpretRequest, INTERPRET_SYSTEM_PROMPT } from './customizationImage'
import { activeOrdersNav } from '@/lib/navigation/moduleNav'
import type { EffectivePermission } from '@/lib/permissions/types'

// CRLF → LF: CI checks the repository out with Windows line endings.
const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')

describe('who sees the Learning link', () => {
  const grant = (actionKey: string, allowed = true) => ({ actionKey, allowed } as EffectivePermission)
  test('an admin always', () => assert.equal(canTrainCustomizeImage('admin', []), true))
  test('someone granted Train Customize image', () => assert.equal(canTrainCustomizeImage('member', [grant(LEARNING_ACTION)]), true))
  test('not someone who can only edit Orders', () => assert.equal(canTrainCustomizeImage('member', [grant('edit'), grant(LEARNING_ACTION, false)]), false))
  test('not nobody', () => assert.equal(canTrainCustomizeImage(null, []), false))
})

describe('keywords', () => {
  test('content words, lower case, singular, no filler', () => {
    assert.deepEqual(keywordsFrom('Longer rectangular TABLE, 2 pedestals base; bottom plate combined please'),
      ['longer', 'rectangular', 'table', 'pedestal', 'base', 'bottom', 'plate', 'combined'])
  })
  test('Hinglish filler is ignored', () => {
    assert.deepEqual(keywordsFrom('marble top chahiye aur round karna hai'), ['marble', 'top', 'round'])
  })
  test('glass and boxes keep a sensible singular', () => {
    assert.deepEqual(keywordsFrom('glass boxes'), ['glass', 'box'])
  })
  test('typed keywords: commas or spaces', () => {
    assert.deepEqual(normaliseKeywords('Table, pedestals,  plate'), ['table', 'pedestal', 'plate'])
  })
})

describe('choosing similar examples', () => {
  const ex = (id: string, keywords: string[], created_at: string): LearningExample =>
    ({ id, comment: id, instruction: `instruction ${id}`, product_name: null, pi_dimensions: null, keywords, created_at })
  const all = [
    ex('plate', ['table', 'pedestal', 'plate'], '2026-10-01'),
    ex('round', ['table', 'round', 'top'], '2026-10-02'),
    ex('chair', ['chair', 'fabric'], '2026-10-03'),
    ex('plate-newer', ['table', 'pedestal', 'plate'], '2026-10-04'),
  ]
  test('most shared words first, newest first among equals', () => {
    assert.deepEqual(rankExamples(all, ['table', 'pedestal', 'plate', 'longer']).map(e => e.id), ['plate-newer', 'plate', 'round'])
  })
  test('nothing in common, nothing chosen', () => {
    assert.deepEqual(rankExamples(all, ['sofa']), [])
  })
  test('at most three', () => {
    assert.equal(rankExamples([...all, ex('x', ['table'], '2026-09-01')], ['table']).length, 3)
  })
})

describe('what Check understanding is given', () => {
  test('rules numbered, examples with the confirmed instruction', () => {
    const ctx = buildLearningContext(
      [{ id: 'r1', rule_text: 'Two pedestals share one floor plate.' }],
      [{ id: 'e1', comment: 'bottom plate combined', instruction: 'ONE continuous plate joins both columns.', product_name: 'Lyon table', pi_dimensions: '2400 x 900', keywords: [], created_at: '' }],
    )
    assert.match(ctx, /Company rules[^\n]*\n1\. Two pedestals share one floor plate\./)
    assert.match(ctx, /Example 1\. Product: Lyon table\. PI size: 2400 x 900\. Salesperson wrote: "bottom plate combined" Correct instruction: "ONE continuous plate joins both columns\."/)
  })
  test('nothing taught yet, nothing added — the request is exactly as before', () => {
    assert.equal(buildLearningContext([], []), '')
    const base = { comment: 'marble top', productName: '', dimensions: '', material: '', referenceCount: 0 }
    assert.equal(buildInterpretRequest({ ...base, learning: '' }), buildInterpretRequest(base))
  })
  test('the lessons come before the request', () => {
    const r = buildInterpretRequest({ comment: 'marble top', productName: '', dimensions: '', material: '', referenceCount: 0, learning: 'Company rules:\n1. X' })
    assert.ok(r.indexOf('Company rules') < r.indexOf("Salesperson's customization"))
  })
  test('the system prompt compares PI size with the photo by default, and follows the company rules', () => {
    assert.match(INTERPRET_SYSTEM_PROMPT, /Compare the dimensions on the PI with the shape in the photograph/)
    assert.match(INTERPRET_SYSTEM_PROMPT, /Follow the company rules/)
  })
})

describe('attempt events', () => {
  test('👍/👎 set feedback and keep the note', () => {
    assert.deepEqual(attemptPatchFor('wrong', '  separate plates  ', 'T'), { feedback: 'wrong', feedback_note: 'separate plates', feedback_at: 'T', updated_at: 'T' })
    assert.equal(attemptPatchFor('correct', '', 'T').feedback_note, null)
  })
  test('use / discard / refine set the outcome only', () => {
    assert.deepEqual(attemptPatchFor('used', 'ignored', 'T'), { outcome: 'used', updated_at: 'T' })
  })
})

test('an example’s picture path matches the table’s check', () => {
  const p = examplePicturePath('44444444-4444-4444-8444-444444444444', 'after', 'png')
  assert.match(p, /^customize-learning\/examples\/[0-9a-f-]{36}\/after\.(jpg|png|webp)$/)
})

test('rule length', () => {
  assert.equal(ruleTextProblem('ab'), 'A rule needs at least a few words.')
  assert.equal(ruleTextProblem('Keep the same edge.'), null)
  assert.match(ruleTextProblem('x'.repeat(501)) ?? '', /500/)
})

test('the Learning page lights no main sidebar entry', () => {
  assert.equal(activeOrdersNav('/orders/customize-learning'), null)
})

describe('the routes', () => {
  const guard = read('src/app/api/orders/customize-learning/guard.ts')
  test('every Learning route goes through the trainer door first', () => {
    for (const r of ['attempts', 'rules', 'examples']) {
      const src = read(`src/app/api/orders/customize-learning/${r}/route.ts`)
      const handlers = src.match(/export async function (GET|POST|PATCH)\([^)]*\) \{\n  const gate = await requireTrainer\(\)\n  if \(!gate\.ok\) return gate\.response/g) ?? []
      const exported = src.match(/export async function (GET|POST|PATCH)/g) ?? []
      assert.equal(handlers.length, exported.length, `${r}: a handler skips the door`)
    }
    assert.match(guard, /mayTrain\(authClient\)/)
  })
  test('the door asks the database as the person, and a missing migration says so', () => {
    const server = read('src/lib/orders/customizationLearningServer.ts')
    assert.match(server, /authClient\.rpc\('can_train_customize_image'\)/)
    assert.match(guard, /LEARNING_NOT_SET_UP/)
  })
  test('an example’s pictures are read from the attempt row, never from the request', () => {
    const src = read('src/app/api/orders/customize-learning/examples/route.ts')
    assert.match(src, /copyExamplePicture\(service, id, 'before', attempt\.source_path\)/)
    assert.doesNotMatch(src, /body\.(source|result|before|after)_?[pP]ath/)
  })
  test('feedback changes only the caller’s own attempt', () => {
    const server = read('src/lib/orders/customizationLearningServer.ts')
    assert.match(server, /\.eq\('id', attemptId\)\.eq\('created_by', owner\.userId\)/)
    assert.match(read('src/app/api/orders/pi-edits/customization-feedback/route.ts'), /updateOwnAttempt\(admin\.client, attemptId, \{ userId: user\.id \}/)
  })
  test('Check understanding records the attempt after answering, and never fails because of it', () => {
    const src = read('src/app/api/orders/pi-edits/interpret-customization/route.ts')
    assert.ok(src.indexOf('readInterpretation(parsed)') < src.indexOf('await recordAttempt('))
    assert.match(src, /learning: buildLearningContext\(learning\.rules, learning\.examples\)/)
  })
})
