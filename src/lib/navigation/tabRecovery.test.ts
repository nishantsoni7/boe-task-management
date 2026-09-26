import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RECHECK_AFTER_HIDDEN_MS, decideFreshness, parseDeploymentId, shouldCheckOnReturn } from './tabRecovery'

const A = 'dpl_ERfEboEmxgUnGKNWDptiWFvwa4xk'
const B = 'dpl_3PpVa4CVXXquJwrP1WjcBqkCTC7i'

describe('decideFreshness', () => {
  test('same deployment: nothing to do', () => {
    assert.equal(decideFreshness({ own: A, live: A }), 'current')
  })
  test('a new deployment is only ever OFFERED — there is no automatic reload', () => {
    assert.equal(decideFreshness({ own: A, live: B }), 'offer-refresh')
  })
  test('a notice the person dismissed is not offered again for that deployment', () => {
    assert.equal(decideFreshness({ own: A, live: B, dismissed: B }), 'current')
    const C = 'dpl_Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1'
    assert.equal(decideFreshness({ own: A, live: C, dismissed: B }), 'offer-refresh', 'a later deployment is offered again')
  })
  test('an unknown id on either side is never treated as a new deployment', () => {
    assert.equal(decideFreshness({ own: null, live: B }), 'current')
    assert.equal(decideFreshness({ own: A, live: null }), 'current')
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

describe('wiring', () => {
  const read = (p: string) => readFileSync(join(__dirname, p), 'utf8').replace(/\r/g, '')
  const src = read('../../components/layout/TabRecovery.tsx')
  test('Providers mounts TabRecovery exactly once', () => {
    assert.equal((read('../../components/layout/Providers.tsx').match(/<TabRecovery \/>/g) ?? []).length, 1)
  })
  test('the page reloads or navigates ONLY from the notice buttons, never on its own', () => {
    const code = src.replace(/\/\/.*$/gm, '')
    assert.equal((code.match(/window\.location\.reload\(\)/g) ?? []).length, 1)
    assert.equal((code.match(/window\.location\.assign\(/g) ?? []).length, 1)
    // Both sit inside the one button's onClick handler.
    assert.ok(/onClick=\{\(\) => \{ if \(isStall\) window\.location\.assign\(notice\.href\); else window\.location\.reload\(\) \}\}/.test(code))
    assert.equal(/location\.(href|replace)\s*[=(]/.test(code), false)
    assert.equal(/reload-now/.test(code + read('./tabRecovery.ts')), false)
  })
  test('it patches nothing global', () => {
    const code = src.replace(/\/\/.*$/gm, '')
    assert.equal(/window\.fetch\s*=|window\.addEventListener\s*=|window\.removeEventListener\s*=/.test(code), false)
  })
  test('/api/deployment reveals only the deployment id and is never cached', () => {
    const route = read('../../app/api/deployment/route.ts')
    assert.ok(route.includes("'cache-control': 'no-store'"))
    assert.equal(/cookies\(|getUser|getSession|supabase/i.test(route.replace(/\/\/.*$/gm, '')), false)
  })
})
