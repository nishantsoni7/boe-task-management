/**
 * The one Back control — where it goes from every page.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { join, sep } from 'node:path'
import { MODULES_PATH, backTarget, parentPathFor } from './backTarget'
import { RETURN_TO_PARAM, returnLabelFor } from './recordReturn'

const ORDER = '/orders/4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f'
const SAMPLE_ID = '4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f'

describe('parentPathFor', () => {
  test('a module home goes up to Modules, and Modules itself has no Back', () => {
    assert.equal(parentPathFor('/quotations'), MODULES_PATH)
    assert.equal(parentPathFor('/orders/'), MODULES_PATH)
    assert.equal(parentPathFor(MODULES_PATH), null)
    assert.equal(parentPathFor('/modules/'), null)
    assert.equal(parentPathFor('/'), null)
  })

  test('a page goes up one level, whatever query or fragment it carries', () => {
    assert.equal(parentPathFor('/quotations/abc'), '/quotations')
    assert.equal(parentPathFor('/quotations/abc?tab=2#top'), '/quotations')
    assert.equal(parentPathFor('/finance/received/linked'), '/finance/received')
    assert.equal(parentPathFor(`${ORDER}/edit-pi`), ORDER)
  })

  test("an Order goes to Confirmed Orders, not the dashboard", () => {
    assert.equal(parentPathFor(ORDER), '/orders/all')
  })

  test('pages whose parent folder is not a page go to a real one', () => {
    assert.equal(parentPathFor(`${ORDER}/dispatch/${SAMPLE_ID}`), ORDER)
    assert.equal(parentPathFor(`/tasks/${SAMPLE_ID}`), '/tasks/my')
    assert.equal(parentPathFor('/tasks/my'), '/dashboard')
    assert.equal(parentPathFor('/tasks/my/completed'), '/tasks/my')
    assert.equal(parentPathFor('/admin/control-center'), MODULES_PATH)
    assert.equal(parentPathFor('/admin/control-center/people'), '/admin/control-center')
    assert.equal(parentPathFor('/showroom-admin/products/ABC-1/edit'), '/showroom-admin/products')
  })
})

describe('backTarget', () => {
  test('walked in from a list: POP, so the list comes back as it was', () => {
    assert.deepEqual(
      backTarget({ pathname: '/quotations/abc', search: '', inAppHistory: true }),
      { kind: 'history', label: 'Back' },
    )
  })

  test('a popped entry is named when the opener said where it came from', () => {
    const search = `?${RETURN_TO_PARAM}=${encodeURIComponent('/finance/received')}`
    assert.deepEqual(
      backTarget({ pathname: ORDER, search, inAppHistory: true }),
      { kind: 'history', label: 'Back to Confirmed Payments' },
    )
  })

  test('first page in the tab: GO to the returnTo, then to one level up — never pop', () => {
    const search = `?${RETURN_TO_PARAM}=${encodeURIComponent('/orders/all?status=running')}`
    assert.deepEqual(
      backTarget({ pathname: ORDER, search, inAppHistory: false }),
      { kind: 'path', path: '/orders/all?status=running', label: 'Back to Confirmed Orders' },
    )
    assert.deepEqual(
      backTarget({ pathname: '/quotations/abc', search: '', inAppHistory: false }),
      { kind: 'path', path: '/quotations', label: 'Back to Quotations' },
    )
  })

  test('a returnTo that could leave the app is ignored', () => {
    for (const evil of ['https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)']) {
      const search = `?${RETURN_TO_PARAM}=${encodeURIComponent(evil)}`
      assert.deepEqual(
        backTarget({ pathname: '/quotations/abc', search, inAppHistory: false }),
        { kind: 'path', path: '/quotations', label: 'Back to Quotations' },
        evil,
      )
    }
  })

  test('no button on Modules, where there is nothing further back', () => {
    assert.equal(backTarget({ pathname: MODULES_PATH, search: '', inAppHistory: true }), null)
    assert.equal(backTarget({ pathname: MODULES_PATH, search: '', inAppHistory: false }), null)
  })
})

describe('module homes are named', () => {
  test('so the fallback tooltip says where it goes', () => {
    assert.equal(returnLabelFor('/quotations'), 'Back to Quotations')
    assert.equal(returnLabelFor('/modules'), 'Back to Modules')
    assert.equal(returnLabelFor('/somewhere/unknown'), 'Back')
  })
})

// ── Every page in the app has a real page one level above it ─────────────────
//
// The rule above is "drop the last segment". That is right only when the result
// is a page. Walk every page in src/app and prove it, so a new route whose
// parent folder is not a page fails here and gets an override, instead of a
// Back button that opens a 404.

function pageRoutes(): string[] {
  const root = join(process.cwd(), 'src', 'app')
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name === 'page.tsx') {
        const segments = full.slice(root.length).split(sep).filter(Boolean).slice(0, -1)
          .filter(s => !(s.startsWith('(') && s.endsWith(')')))
        out.push('/' + segments.join('/'))
      }
    }
  }
  walk(root)
  return out
}

const toRegExp = (route: string) =>
  new RegExp('^' + route.split('/').map(s => (s.startsWith('[') ? '[^/]+' : s.replace(/[.*+?^${}()|\\]/g, '\\$&'))).join('/') + '/?$')

describe('every page has a real parent', () => {
  const all = pageRoutes().filter(r => r !== '/')
  const exists = all.map(toRegExp)
  // Pages with no module header, so no Back button to point anywhere: the link a
  // client opens without a login (/q) and the showroom QR flow, which has its own pages.
  const noHeader = (r: string) => r.startsWith('/q/') || r.startsWith('/showroom/')
  const routes = all.filter(r => !noHeader(r))
  const matches = (path: string) => path === MODULES_PATH || exists.some(re => re.test(path))

  test('the walk found the app', () => {
    assert.ok(routes.length > 100, `only ${routes.length} pages found`)
    assert.ok(routes.includes('/modules'))
  })

  test('parentPathFor never lands on a missing page', () => {
    const dead: string[] = []
    for (const route of routes) {
      const sample = route.replace(/\[\.\.\.[^\]]+\]/g, 'x/y').replace(/\[[^\]]+\]/g, SAMPLE_ID)
      const parent = parentPathFor(sample)
      if (parent !== null && !matches(parent)) dead.push(`${route}  ->  ${parent}`)
    }
    assert.deepEqual(dead, [], `Back would open a missing page from:\n${dead.join('\n')}`)
  })
})
