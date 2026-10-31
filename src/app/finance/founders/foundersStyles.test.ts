/**
 * THE FOUNDERS' PAYOUTS STYLES CANNOT GO MISSING QUIETLY AGAIN.
 *
 * #522 removed two old blocks from globals.css and took this page's block with
 * them. Nothing failed: every class name was only a string, the types were happy,
 * the tests passed, and the page went out with no styling at all. A CSS module
 * has the same weakness (a name it does not define is just undefined), so this
 * test reads both sides: every class a screen asks for must be defined, and every
 * class defined must be asked for.
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const DIR = join(process.cwd(), 'src/app/finance/founders')
const screens = readdirSync(DIR).filter(f => f.endsWith('.tsx') && !f.includes('.test.'))
const sources = new Map(screens.map(f => [f, readFileSync(join(DIR, f), 'utf8')]))
const css = readFileSync(join(DIR, 'founders.module.css'), 'utf8')

/** Comments are prose, and they name globals.css classes such as .fin-sub. */
const rules = css.replace(/\/\*[\s\S]*?\*\//g, '')
/** A :global(...) class is not this file's own. */
const defined = new Set([...rules.replace(/:global\([^)]*\)/g, '').matchAll(/\.([A-Za-z][A-Za-z0-9]*)(?![A-Za-z0-9_-])/g)].map(m => m[1]))

const asked = new Map<string, string>()
for (const [file, source] of sources) {
  for (const m of source.matchAll(/\bstyles\.([A-Za-z][A-Za-z0-9]*)/g)) asked.set(m[1], file)
}

describe('the Founders’ payouts stylesheet', () => {
  test('the page draws its classes from the module', () => {
    assert.ok(asked.size > 80, `only ${asked.size} classes found: the search above has stopped working`)
    assert.ok(defined.size > 80, `only ${defined.size} classes found in the module`)
    for (const file of ['FounderPayoutsView.tsx', 'FounderOverview.tsx', 'FounderPayments.tsx', 'FounderPlanner.tsx', 'FounderAccounts.tsx', 'FounderPayoutModal.tsx', 'FounderParts.tsx']) {
      assert.match(sources.get(file) ?? '', /import styles from '\.\/founders\.module\.css'/, file)
    }
  })

  test('every class a screen asks for is defined', () => {
    const missing = [...asked].filter(([name]) => !defined.has(name)).map(([name, file]) => `${name} (${file})`)
    assert.deepEqual(missing, [])
  })

  test('every class defined is used, so a block that is no longer needed is removed', () => {
    const unused = [...defined].filter(name => !asked.has(name) && name !== 'root')
    assert.deepEqual(unused, [])
  })

  test('the root class wraps the page, and the styles are not back in plain strings', () => {
    assert.match(sources.get('FounderPayoutsView.tsx') ?? '', /<div className=\{styles\.root\}>/)
    for (const [file, source] of sources) assert.doesNotMatch(source, /className="fp-|className=\{`fp-/, file)
  })

  test('this page has nothing left in globals.css to lose', () => {
    assert.doesNotMatch(readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8'), /\.fp-[a-z]/)
  })
})
