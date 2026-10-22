// THE RECORD PAGES ARE PREPARED ONCE AND CACHED (2026-10-22).
//
// /orders/[id] and /orders/drafts/[submissionId] used to be rendered by a server function on every
// navigation (about 260-400 ms, and a 10.6 s cold start was seen), and a link could not prefetch them.
// Their layouts now return an empty generateStaticParams, so Next prepares each record page the first
// time it is asked for and serves it from the cache after that.
//
// That is only safe while the pages' SERVER output is the same for every reader. It is: both pages are
// client components that read their data in the browser under the reader's own access. These tests pin
// the two things that keep it true, so a later change cannot quietly turn a shared cache into a leak.
//
// Run with: npx tsx --test "src/lib/orders/recordPagesCached.test.ts"

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const APP = join(__dirname, '..', '..', 'app')
const read = (p: string) => readFileSync(p, 'utf8').replace(/\r/g, '')

const RECORDS = [
  { dir: join(APP, 'orders', '[id]'), name: 'Confirmed Order' },
  { dir: join(APP, 'orders', 'drafts', '[submissionId]'), name: 'PI Draft' },
]

function sourcesUnder(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) out.push(...sourcesUnder(p))
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) out.push(p)
  }
  return out
}

describe('the record pages are prepared once and cached', () => {
  for (const { dir, name } of RECORDS) {
    test(`${name}: its layout returns an empty generateStaticParams and passes its children through`, () => {
      const layout = read(join(dir, 'layout.tsx'))
      assert.match(layout, /export function generateStaticParams\(\) \{\s*return \[\]\s*\}/)
      assert.match(layout, /\{ children \}: \{ children: React\.ReactNode \}\) \{\s*return children\s*\}/)
      assert.equal(/['"]use client['"]/.test(layout), false, 'a layout that exports generateStaticParams must be a server component')
    })

    test(`${name}: the page itself is a client component that reads its data in the browser`, () => {
      const page = read(join(dir, 'page.tsx'))
      assert.match(page, /^['"]use client['"]/m)
      assert.match(page, /createClient\(\)/)
    })
  }
})

describe('nothing private can end up in the cached output', () => {
  test('no server-side read of cookies, headers or the session anywhere under the two record routes', () => {
    for (const { dir, name } of RECORDS) {
      for (const file of sourcesUnder(dir)) {
        const src = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
        assert.equal(/from ['"]next\/headers['"]|\bcookies\(\)|\bheaders\(\)|unstable_noStore|connection\(\)/.test(src), false,
          `${name}: ${file} reads request data on the server`)
      }
    }
  })

  test('the layouts above them (orders, root) do not either', () => {
    for (const file of [join(APP, 'orders', 'layout.tsx'), join(APP, 'layout.tsx')]) {
      const src = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      assert.equal(/from ['"]next\/headers['"]|\bcookies\(\)|\bheaders\(\)/.test(src), false, file)
    }
  })

  test('no route in the tree forces dynamic rendering, which would undo the caching without anyone noticing', () => {
    for (const { dir, name } of RECORDS) {
      for (const file of sourcesUnder(dir)) {
        assert.equal(/export const dynamic\s*=\s*['"]force-dynamic['"]/.test(read(file)), false, `${name}: ${file}`)
      }
    }
  })
})
