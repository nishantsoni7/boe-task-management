/**
 * Repository check: the rules the Image Editor screen must not regress on.
 *
 * These are asserted against the source because they are structural — the shape
 * of the code, not the value it computes. The browser suite exercises the
 * behaviour; this catches the edit that would quietly reintroduce a defect
 * somebody already paid for:
 *
 *   * Generate must start the run directly. An extra confirmation step was
 *     removed on purpose and must not come back.
 *   * The screen must say nothing about providers, requests, credits or cost.
 *   * The run must stay sequential, awaited one image at a time.
 *   * Nothing may retry on its own.
 *   * The guard against a double click must stay a ref, not state.
 *
 * Run:
 *   npx tsx --test src/app/image-editor/page.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const PAGE = readFileSync(join(ROOT, 'src/app/image-editor/page.tsx'), 'utf8')
const CARD = readFileSync(join(ROOT, 'src/app/image-editor/ResultCard.tsx'), 'utf8')
const LIST = readFileSync(join(ROOT, 'src/app/image-editor/QueueList.tsx'), 'utf8')

/** Every string literal in a file: what a person could actually read. */
function literals(source: string): string[] {
  return [
    ...(source.match(/'[^'\n]*'/g) ?? []),
    ...(source.match(/`[^`]*`/g) ?? []),
    ...(source.match(/>\s*[A-Z][^<{}]{3,}/g) ?? []),
  ]
}

describe('Generate starts the run', () => {
  test('there is no confirmation step between pressing Generate and generating', () => {
    // The button calls run() directly. A phase that waits for a second press,
    // or a "confirm" control, is the regression this guards.
    assert.match(PAGE, /onClick=\{\(\) => \{ void run\(\) \}\}/)
    assert.ok(!PAGE.includes("'confirming'"), 'no confirming phase')
    assert.ok(!/Confirm and generate/i.test(PAGE), 'no confirmation button')
  })

  test('the button names the work, not the provider', () => {
    assert.ok(PAGE.includes("'Generate Studio Image'"), 'single-image label')
    assert.ok(PAGE.includes('Generate ${pending} Studio Images'), 'multi-image label')
  })
})

describe('nothing on this screen mentions cost or the provider', () => {
  test('no user-visible string names a provider, a request, credit or a charge', () => {
    const banned = /\b(fal|fal\.ai|bria|provider|api|request|requests|credit|credits|charge|charged|billing|paid|cost|generation cost)\b/i

    for (const [name, source] of [['page', PAGE], ['ResultCard', CARD], ['QueueList', LIST]] as const) {
      for (const literal of literals(source)) {
        // Code identifiers and comments are not user-visible; JSX text and
        // quoted copy are.
        if (!/[a-z]\s[a-z]/i.test(literal)) continue
        if (literal.includes('http') || literal.includes('/api/')) continue
        assert.ok(!banned.test(literal),
          `${name} shows the employee: ${literal.trim().slice(0, 80)}`)
      }
    }
  })
})

describe('the run', () => {
  test('is sequential: one image is awaited before the next begins', () => {
    // A for-loop over nextWaiting with an await inside. Promise.all over the
    // queue would be the regression — five at once, five results racing.
    assert.match(PAGE, /for \(;;\)/)
    assert.match(PAGE, /const outcome = await generateOne\(next\)/)
    assert.ok(!/Promise\.all\([^)]*items/.test(PAGE), 'the queue must not be launched in parallel')
    assert.ok(!/items\.map\([^)]*generateOne/.test(PAGE), 'no fan-out over the queue')
  })

  test('is guarded by a ref, not by state', () => {
    // State updates on the next render; two clicks in one frame would both see
    // the old value and both start a run.
    assert.match(PAGE, /const runningRef = useRef\(false\)/)
    assert.match(PAGE, /if \(runningRef\.current\) return/)
    assert.match(PAGE, /runningRef\.current = true/)
    // And released on every exit path.
    assert.match(PAGE, /finally \{\s*\n\s*runningRef\.current = false/)
  })

  test('never retries on its own', () => {
    assert.ok(!/setTimeout\([^)]*generateOne/.test(PAGE), 'no delayed re-send')
    assert.ok(!/attempt|retryCount|maxRetries|backoff/i.test(PAGE), 'no retry bookkeeping')
    // The only retry is a person pressing a button.
    assert.match(PAGE, /const retry = useCallback\(\(id: string\) => \{/)
    assert.match(CARD, /onClick=\{\(\) => onRetry\(item\.id\)\}/)
  })

  test('a failed image is not put back in the queue by the runner', () => {
    // retry() moves the item to 'waiting' — and it is called from the card's
    // button, never from the loop.
    const runBody = PAGE.slice(PAGE.indexOf('const run = useCallback'), PAGE.indexOf('const retry = useCallback'))
    assert.ok(!runBody.includes("status: 'waiting'"), 'the runner must not requeue anything')
  })
})

describe('what the browser gets to decide', () => {
  test('the browser sends the photograph and nothing else', () => {
    // There is no output shape to choose any more: the master is square, and a
    // landscape or portrait crop of it is made later by somebody who can see
    // the picture. So the form has one field, and nothing the page sends can
    // change what a request costs or what canvas comes back.
    // Scoped to the generation call: the download menu builds its own form for
    // the conversion route, which never touches a provider.
    const generate = PAGE.slice(PAGE.indexOf('const generateOne'), PAGE.indexOf('const run ='))
    const appends = generate.match(/form\.append\([^)]*\)/g) ?? []
    assert.deepEqual(appends, ["form.append('image', item.file)"])
    assert.ok(!PAGE.includes("'preset'"), 'no output shape is sent any more')
  })

  test('the page knows no dimension, no placement and no model', () => {
    const code = PAGE.replace(/\/\/.*$/gm, '')
    for (const leak of [
      'shot_size', 'padding_values', 'placement_type', 'num_results',
      // Real identifiers, not bare "fal" — that is a substring of "false".
      'fal.run', 'fal.ai', 'fal-ai', 'FAL_KEY', 'bria', 'product-shot', 'scene_description',
    ]) {
      assert.ok(!code.toLowerCase().includes(leak.toLowerCase()),
        `the page must not know about ${leak}`)
    }
    assert.ok(!/\b(1000|1200|800|1125)\b/.test(code), 'no canvas dimensions in the page')
  })
})
