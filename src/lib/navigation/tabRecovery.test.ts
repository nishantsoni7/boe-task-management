import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  RECHECK_AFTER_HIDDEN_MS, coversScreen, decideFreshness, hasUnsavedWork, isBlockingLayer, isWriteRequest, parseDeploymentId,
  shouldCheckOnReturn, unsavedWorkReasons, type PageWorkSignals,
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
  const clean: PageWorkSignals = {
    editedSinceArrival: false, editableFocused: false, openOverlays: 0, chosenFiles: 0,
    pendingSaves: 0, filledFormFields: 0, leaveGuards: 0, declaredUnsaved: 0,
  }
  test('a page with nothing on it to lose is safe to reload', () => {
    assert.equal(hasUnsavedWork(clean), false)
    assert.deepEqual(unsavedWorkReasons(clean), [])
  })
  test('every single signal on its own blocks the quiet reload', () => {
    const one: Array<[keyof PageWorkSignals, boolean | number]> = [
      ['editedSinceArrival', true], ['editableFocused', true], ['openOverlays', 1], ['chosenFiles', 1],
      ['pendingSaves', 1], ['filledFormFields', 1], ['leaveGuards', 1], ['declaredUnsaved', 1],
    ]
    assert.equal(one.length, Object.keys(clean).length, 'a new signal needs a case here')
    for (const [key, value] of one) {
      assert.equal(hasUnsavedWork({ ...clean, [key]: value }), true, key)
      assert.deepEqual(unsavedWorkReasons({ ...clean, [key]: value }), [key])
    }
  })
  test('a count that cannot be read counts as unsaved, never as clean', () => {
    assert.equal(hasUnsavedWork({ ...clean, pendingSaves: Number.NaN }), true)
  })
  test('only writes are pending saves', () => {
    for (const m of ['POST', 'PATCH', 'PUT', 'DELETE', 'post']) assert.equal(isWriteRequest(m), true, m)
    for (const m of ['GET', 'HEAD', 'OPTIONS', 'get', undefined, null, '']) assert.equal(isWriteRequest(m), false, String(m))
  })
  test('a fixed layer counts as a modal only when it covers the screen', () => {
    const vp = { width: 390, height: 844 }
    assert.equal(coversScreen({ width: 390, height: 844 }, vp), true)
    assert.equal(coversScreen({ width: 260, height: 844 }, vp), false, 'a side drawer or the sidebar')
    assert.equal(coversScreen({ width: 360, height: 56 }, vp), false, 'a toast or this notice')
    assert.equal(coversScreen({ width: 390, height: 844 }, { width: 0, height: 0 }), false)
  })
  test('an invisible or click-through layer is not a modal (the phone sidebar backdrop)', () => {
    const shown = { position: 'fixed', visibility: 'visible', opacity: '1', pointerEvents: 'auto', display: 'block' }
    assert.equal(isBlockingLayer(shown), true)
    assert.equal(isBlockingLayer({ ...shown, opacity: '0.3' }), true, 'a dimmed backdrop')
    assert.equal(isBlockingLayer({ ...shown, opacity: '0', pointerEvents: 'none' }), false, '.boe-sidebar-overlay while closed')
    assert.equal(isBlockingLayer({ ...shown, pointerEvents: 'none' }), false)
    assert.equal(isBlockingLayer({ ...shown, visibility: 'hidden' }), false)
    assert.equal(isBlockingLayer({ ...shown, display: 'none' }), false)
    assert.equal(isBlockingLayer({ ...shown, position: 'absolute' }), false)
  })
  test('edits are detected from real input events, not value vs defaultValue (React keeps those equal)', () => {
    const src = readFileSync(join(__dirname, '../../components/layout/TabRecovery.tsx'), 'utf8').replace(/\r/g, '')
    assert.ok(src.includes("document.addEventListener('input', mark, true)"))
    assert.ok(src.includes("document.addEventListener('change', mark, true)"))
    assert.equal(src.includes('defaultValue'), false)
    assert.ok(/edited\.current = false\s*\n\s*\}, \[pathname\]\)/.test(src), 'a new page starts with nothing typed')
  })
  test('the component collects every signal, and counts writes and leave guards from module load', () => {
    const src = readFileSync(join(__dirname, '../../components/layout/TabRecovery.tsx'), 'utf8').replace(/\r/g, '')
    const collector = src.slice(src.indexOf('function pageWorkSignals'))
    for (const key of Object.keys(clean)) assert.ok(new RegExp(`\\b${key}[,:]`).test(collector), key)
    assert.ok(/^const inFlight: WorkCounters = typeof window === 'undefined'/m.test(src), 'installed when the module loads, before any page mounts')
    assert.ok(src.includes('queryClient.isMutating()'), 'React Query mutations count as pending saves')
    assert.ok(src.includes('input[type=file]'))
    assert.ok(src.includes('[data-unsaved="true"]'))
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
