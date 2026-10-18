import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * Source-text tests read a screen's file to check what it contains. Big screens are
 * split into sibling files; where a block was cut out the screen keeps a marker
 *
 *     // @split: src/app/finance/received/receivedPaymentsAtoms.tsx private=SectionHeader
 *
 * and this puts each block back in place, so a test sees the ORIGINAL one-file layout
 * (slicing a function out by name keeps working, wherever the function now lives).
 * `private=` lists names that were not exported originally; their `export ` is removed again.
 *
 * `npm test` / `npm run test:file` install the same expansion for every plain
 * readFileSync made from a test (scripts/testing/screen-source-preload.mjs), so older
 * tests need no change. Splitting another screen is: `node scripts/dev/split-block.mjs`.
 */
const MARK = /^[ \t]*\/\/ @split: (\S+)(?: private=(\S*))?[ \t]*$/gm
const NL = String.fromCharCode(10)

function unexport(text: string, names: string): string {
  const set = new Set(names.split(',').filter(Boolean))
  return text.split(NL).map(line => {
    const m = /^export (async function|function|const|type|interface|class) ([A-Za-z_$][A-Za-z0-9_$]*)/.exec(line)
    return m && set.has(m[2]) ? line.slice('export '.length) : line
  }).join(NL)
}

export function expandSplits(text: string, depth = 0): string {
  if (depth > 6 || !text.includes('// @split: ')) return text
  return text.replace(MARK, (_m, rel: string, priv?: string) => {
    const raw = readFileSync(resolve(process.cwd(), rel), 'utf8').split(String.fromCharCode(13) + NL).join(NL)
    const body = expandSplits(raw.replace(/^'use client'\n+/, ''), depth + 1)
    return priv ? unexport(body, priv) : body
  })
}

export function readScreenSource(path: string): string {
  const text = readFileSync(join(process.cwd(), path.split(String.fromCharCode(92)).join('/')), 'utf8')
    .split(String.fromCharCode(13) + NL).join(NL)
  return expandSplits(text)
}

/** The file exactly as written: markers NOT expanded (a plain readFileSync from a test is expanded by the preload). */
export function readRawSource(path: string): string {
  return readFileSync(path, 'utf8').split(String.fromCharCode(13) + NL).join(NL)
}
