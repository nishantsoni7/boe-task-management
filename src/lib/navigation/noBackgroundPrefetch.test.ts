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

// Every spelling: single or double quotes, a static import, import() or require().
const NEXT_LINK = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]next\/link['"]/
// next/form loads the page its form submits to as soon as the form is on screen, like the old <Link>.
const NEXT_FORM = /['"]next\/form['"]/
const PREFETCH_CALL = /\.prefetch\s*(?:\?\.)?\s*\(/
// A file asked for in advance and not used within a few seconds is the same "preloaded but not used"
// warning. The two fonts are preloaded by next/font (src/app/layout.tsx) and are used on every page
// (checked live 2026-11-12); React's preconnect() opens a connection only and never warns.
const HAND_PRELOAD = /rel\s*=\s*\{?\s*['"](?:preload|prefetch|modulepreload)['"]|\b(?:preload|preinit|preinitModule|preloadModule)\s*\(/

describe('no page is loaded in advance', () => {
  it('the patterns catch every spelling and nothing else', () => {
    for (const s of ["import Link from 'next/link'", 'import Link from "next/link"', "await import('next/link')", 'require("next/link")']) assert.ok(NEXT_LINK.test(s), s)
    for (const s of ["from 'next/linkify'", "from '@/components/ui/AppLink'"]) assert.ok(!NEXT_LINK.test(s), s)
    assert.ok(NEXT_FORM.test('import Form from "next/form"'))
    for (const s of ['router.prefetch(href)', 'router.prefetch?.(href)', 'router.prefetch (href)']) assert.ok(PREFETCH_CALL.test(s), s)
    assert.ok(!PREFETCH_CALL.test('queryClient.prefetchQuery({ queryKey })'))
    for (const s of ['<link rel="preload" href={u} />', "<link rel={'prefetch'} />", 'rel="modulepreload"', "preload('/a.css', { as: 'style' })", "preinit('/a.css')"]) assert.ok(HAND_PRELOAD.test(s), s)
    for (const s of ["preconnect('https://x')", 'preloadImages(list)', 'rel="stylesheet"']) assert.ok(!HAND_PRELOAD.test(s), s)
  })

  it('AppLink is the only file that imports next/link', () => {
    const offenders = FILES.filter(f => NEXT_LINK.test(code(f))).map(rel).filter(r => r !== APP_LINK)
    assert.deepEqual(offenders, [], 'use `import { AppLink as Link } from \'@/components/ui/AppLink\'`')
  })

  it('nothing uses next/form', () => {
    const offenders = FILES.filter(f => NEXT_FORM.test(code(f))).map(rel)
    assert.deepEqual(offenders, [], 'use a plain <form>')
  })

  it('no file asks the browser to load a file in advance by hand', () => {
    const offenders = FILES.filter(f => HAND_PRELOAD.test(code(f))).map(rel)
    assert.deepEqual(offenders, [])
  })

  it('AppLink turns prefetch off after the caller\'s props, so no caller can turn it back on', () => {
    const src = readFileSync(path.join(ROOT, APP_LINK), 'utf8')
    assert.ok(src.includes('return <Link {...props} prefetch={false} />'))
  })

  it('nothing calls router.prefetch', () => {
    // `.prefetch(` only: React Query's data warm-ups (`prefetchQuery`) load data,
    // not pages, and bring no stylesheet.
    const offenders = FILES.filter(f => PREFETCH_CALL.test(code(f))).map(rel)
    assert.deepEqual(offenders, [])
  })
})
