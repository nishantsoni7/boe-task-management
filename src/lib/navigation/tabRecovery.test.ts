import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  RECHECK_AFTER_HIDDEN_MS, decideFreshness, hasUnsavedWork, parseDeploymentId, shouldCheckOnReturn,
} from './tabRecovery'

const A = 'dpl_ERfEboEmxgUnGKNWDptiWFvwa4xk'
const B = 'dpl_3PpVa4CVXXquJwrP1WjcBqkCTC7i'

describe('decideFreshness', () => {
  test('same deployment: nothing to do', () => {
    assert.equal(decideFreshness({ own: A, live: A, hidden: true, hasUnsavedWork: false }), 'current')
  })
  test('new deployment, tab hidden, nothing unsaved: reload now, while nobody waits', () => {
    assert.equal(decideFreshness({ own: A, live: B, hidden: true, hasUnsavedWork: false }), 'reload-now')
  })
  test('new deployment but the person is looking: offer, never force', () => {
    assert.equal(decideFreshness({ own: A, live: B, hidden: false, hasUnsavedWork: false }), 'offer-refresh')
  })
  test('new deployment with unsaved work, even hidden: offer, never force', () => {
    assert.equal(decideFreshness({ own: A, live: B, hidden: true, hasUnsavedWork: true }), 'offer-refresh')
  })
  test('an unknown id on either side is never treated as a new deployment', () => {
    assert.equal(decideFreshness({ own: null, live: B, hidden: true, hasUnsavedWork: false }), 'current')
    assert.equal(decideFreshness({ own: A, live: null, hidden: true, hasUnsavedWork: false }), 'current')
  })
})

describe('when to check', () => {
  test('only after a real absence', () => {
    assert.equal(shouldCheckOnReturn(RECHECK_AFTER_HIDDEN_MS - 1), false)
    assert.equal(shouldCheckOnReturn(RECHECK_AFTER_HIDDEN_MS), true)
    assert.equal(shouldCheckOnReturn(Number.NaN), false)
  })
  test('deployment ids are validated', () => {
    assert.equal(parseDeploymentId(A), A)
    assert.equal(parseDeploymentId('dpl_x'), null)
    assert.equal(parseDeploymentId('<script>'), null)
    assert.equal(parseDeploymentId(undefined), null)
  })
})

describe('hasUnsavedWork is cautious', () => {
  const clean = { editedSinceArrival: false, openDialogs: 0, editableFocused: false }
  test('a page with nothing typed, no dialog and no focused field is safe to reload', () => {
    assert.equal(hasUnsavedWork(clean), false)
  })
  test('anything typed, an open dialog or a focused field is not', () => {
    assert.equal(hasUnsavedWork({ ...clean, editedSinceArrival: true }), true)
    assert.equal(hasUnsavedWork({ ...clean, openDialogs: 1 }), true)
    assert.equal(hasUnsavedWork({ ...clean, editableFocused: true }), true)
  })
  test('edits are detected from real input events, not value vs defaultValue (React keeps those equal)', () => {
    const src = readFileSync(join(__dirname, '../../components/layout/TabRecovery.tsx'), 'utf8').replace(/\r/g, '')
    assert.ok(src.includes("document.addEventListener('input', mark, true)"))
    assert.ok(src.includes("document.addEventListener('change', mark, true)"))
    assert.equal(src.includes('defaultValue'), false)
    assert.ok(/edited\.current = false\s*\n\s*\}, \[pathname\]\)/.test(src), 'a new page starts with nothing typed')
  })
})

describe('wiring', () => {
  const read = (p: string) => readFileSync(join(__dirname, p), 'utf8').replace(/\r/g, '')
  test('Providers mounts TabRecovery exactly once', () => {
    assert.equal((read('../../components/layout/Providers.tsx').match(/<TabRecovery \/>/g) ?? []).length, 1)
  })
  test('the only automatic reload goes through decideFreshness', () => {
    const src = read('../../components/layout/TabRecovery.tsx')
    assert.equal((src.match(/window\.location\.reload\(\)/g) ?? []).length, 2, 'one automatic (reload-now), one on the Refresh button')
    assert.ok(/if \(decision === 'reload-now'\) window\.location\.reload\(\)/.test(src))
  })
  test('/api/deployment reveals only the deployment id and is never cached', () => {
    const route = read('../../app/api/deployment/route.ts')
    assert.ok(route.includes("'cache-control': 'no-store'"))
    assert.equal(/cookies\(|getUser|getSession|supabase/i.test(route.replace(/\/\/.*$/gm, '')), false)
  })
})
