import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

// GUARD — OWNER DECISION 2026-11-12 ("Yes, load on click"): no page loads
// another page in advance. A page loads when the person clicks it.
//
// Next's default <Link> loads every page it points to as soon as the link is
// on screen, and router.prefetch loads one on demand. Each loaded page brings a
// stylesheet the current page never applies; Chrome logged it as "preloaded but
// not used" and kept repeating it as the person moved around a long-open tab,
// so a few files became dozens of warnings on every page. Narrowing WHEN pages
// loaded (#649, #651, #656, #658, #659) only cut it down. See
// src/components/ui/AppLink.tsx.

const ROOT = process.cwd()
const SRC = path.join(ROOT, 'src')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(tsx?|jsx?|mjs)$/.test(name) && !/\.test\.(tsx?|jsx?|mjs)$/.test(name)) out.push(p)
  }
  return out
}

const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join('/')
// Code only: a comment may describe what used to happen.
const code = (f: string) => readFileSync(f, 'utf8')
  .split(/\r?\n/)
  .filter(line => { const t = line.trim(); return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*') })
  .join('\n')

const FILES = walk(SRC)
const APP_LINK = 'src/components/ui/AppLink.tsx'

describe('no page is loaded in advance', () => {
  it('AppLink is the only file that imports next/link', () => {
    const offenders = FILES.filter(f => readFileSync(f, 'utf8').includes("from 'next/link'")).map(rel).filter(r => r !== APP_LINK)
    assert.deepEqual(offenders, [], 'use `import { AppLink as Link } from \'@/components/ui/AppLink\'`')
  })

  it('AppLink turns prefetch off after the caller\'s props, so no caller can turn it back on', () => {
    const src = readFileSync(path.join(ROOT, APP_LINK), 'utf8')
    assert.ok(src.includes('return <Link {...props} prefetch={false} />'))
  })

  it('nothing calls router.prefetch', () => {
    // `.prefetch(` only: React Query's data warm-ups (`prefetchQuery`) load data,
    // not pages, and bring no stylesheet.
    const offenders = FILES.filter(f => /\.prefetch\(/.test(code(f))).map(rel)
    assert.deepEqual(offenders, [])
  })
})
