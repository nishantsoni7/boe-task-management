// The route error boundaries: what a failed page says, and that it never
// reloads or leaks the error text on its own.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ROUTE_ERROR_COPY, classifyRouteError, safeDigest } from './routeError'
import { RouteErrorView } from '@/components/errors/RouteErrorView'
import RouteError from '@/app/error'
import GlobalError from '@/app/global-error'

const err = (message: string, name = 'Error', digest?: string) => Object.assign(new Error(message), { name, digest })
const noop = () => {}

describe('classifyRouteError', () => {
  test('missing code after a deployment reads as an update', () => {
    assert.equal(classifyRouteError(err('Loading chunk 123 failed.')), 'updated')
    assert.equal(classifyRouteError(err('x', 'ChunkLoadError')), 'updated')
    assert.equal(classifyRouteError(err('Failed to load chunk /_next/static/chunks/0co_-dclus4cm.js')), 'updated')
    assert.equal(classifyRouteError(err('Failed to fetch dynamically imported module: https://x/y.js')), 'updated')
  })
  test('a dropped connection reads as network', () => {
    for (const m of ['Failed to fetch', 'Load failed', 'NetworkError when attempting to fetch resource.']) {
      assert.equal(classifyRouteError(err(m, 'TypeError')), 'network', m)
    }
  })
  test('anything else is a plain error, including the original /expenses crash', () => {
    assert.equal(classifyRouteError(err('e.amount.trim is not a function', 'TypeError')), 'error')
    assert.equal(classifyRouteError(null), 'error')
    assert.equal(classifyRouteError({ message: 42 }), 'error')
  })
})

describe('the fallback', () => {
  const render = (e: Error & { digest?: string }) => renderToStaticMarkup(createElement(RouteErrorView, { error: e, retry: noop }))

  test('never shows the error text — it can carry record data', () => {
    const html = render(err('Customer Riya Traders owes 45000 on PI 7', 'TypeError'))
    assert.equal(html.includes('Riya'), false)
    assert.equal(html.includes('45000'), false)
    assert.ok(html.includes(ROUTE_ERROR_COPY.error.title))
  })
  test('a plain error offers Try again, Reload page and Go to Modules', () => {
    const html = render(err('boom'))
    assert.ok(html.includes('>Try again<'))
    assert.ok(html.includes('>Reload page<'))
    assert.ok(html.includes('href="/modules"'))
    assert.ok(html.includes('role="alert"'))
  })
  test('after a deployment the primary action is Reload, and it is a button the person presses', () => {
    const html = render(err('Loading chunk 9 failed.'))
    assert.ok(html.includes(ROUTE_ERROR_COPY.updated.title))
    assert.ok(html.includes('>Reload<'))
    assert.equal(html.includes('>Try again<'), false)
  })
  test('a server digest is shown as a reference; anything else is not', () => {
    assert.ok(render(err('x', 'Error', '3147581029')).includes('Reference: 3147581029'))
    assert.equal(render(err('x', 'Error', '<b>x</b>')).includes('Reference'), false)
    assert.equal(safeDigest('abc-DEF_12'), 'abc-DEF_12')
    assert.equal(safeDigest(12), null)
  })
  test('both boundary files render the same fallback; global-error brings its own html and body', () => {
    const page = renderToStaticMarkup(createElement(RouteError, { error: err('boom'), unstable_retry: noop }))
    assert.ok(page.includes(ROUTE_ERROR_COPY.error.title))
    const global = renderToStaticMarkup(createElement(GlobalError, { error: err('boom'), unstable_retry: noop }))
    assert.ok(global.startsWith('<html'))
    assert.ok(global.includes('<body'))
    assert.ok(global.includes(ROUTE_ERROR_COPY.error.title))
  })
})

describe('wiring', () => {
  const root = join(__dirname, '../../app')
  const read = (p: string) => readFileSync(p, 'utf8').replace(/\r/g, '')
  test('the root error boundaries exist and are client components', () => {
    for (const f of ['error.tsx', 'global-error.tsx']) {
      assert.ok(existsSync(join(root, f)), f)
      assert.ok(read(join(root, f)).startsWith("'use client'"), f)
    }
  })
  test('nothing reloads or navigates on its own — only from a button or link the person uses', () => {
    const src = read(join(__dirname, '../../components/errors/RouteErrorView.tsx')).replace(/\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    assert.equal((src.match(/window\.location\.reload\(\)/g) ?? []).length, 1)
    assert.ok(/const reload = \(\) => window\.location\.reload\(\)/.test(src))
    assert.equal(/location\.(href|assign|replace)/.test(src), false)
    assert.equal(/setTimeout|setInterval/.test(src), false)
  })
  test('the error is handed to window.reportError, never rendered', () => {
    const src = read(join(__dirname, '../../components/errors/RouteErrorView.tsx'))
    assert.ok(src.includes('window.reportError?.(error)'))
    assert.equal(/\{error\.message\}|error\.stack/.test(src), false)
  })
})
