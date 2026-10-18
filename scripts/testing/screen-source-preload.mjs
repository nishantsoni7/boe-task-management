// Test-only preload (see docs/testing/writing-tests.md).
//
// Big screens are split into sibling files. Source-text tests were written against the
// ONE-FILE layout (they slice a function out by name), so reading a screen would break
// each time a piece moves. A screen leaves a marker comment where a block was cut out:
//
//     // @split: src/app/finance/received/receivedPaymentsAtoms.tsx private=SectionHeader,DetailRow
//
// and when a TEST reads the file as text this preload puts the block back in place, so the
// test sees the original layout. `private=` lists names that were NOT exported originally
// (the split had to export them); their `export ` keyword is removed again.
// Only readFileSync calls made DIRECTLY from a *.test.* file are expanded; the compiler,
// Next and tsx always read the real file.
import fs from 'node:fs'
import path from 'node:path'

const MARK = /^[ \t]*\/\/ @split: (\S+)(?: private=(\S*))?[ \t]*$/gm
const realRead = fs.readFileSync
const root = process.cwd()

// The DIRECT caller of readFileSync must be a test file. (A test file further up the import stack is
// not enough: the compiler reading a module while a test imports it must see the real file.)
function calledFromTest() {
  const frames = (new Error().stack || '').split(String.fromCharCode(10))
  // frames: 0 message, 1 calledFromTest, 2 patchedReadFileSync, 3 the caller.
  return /[.]test[.][cm]?[jt]sx?:/.test(frames[3] || '')
}

function unexport(text, names) {
  const set = new Set(names.split(',').filter(Boolean))
  return text.split(String.fromCharCode(10)).map(line => {
    const m = /^export (async function|function|const|type|interface|class) ([A-Za-z_$][A-Za-z0-9_$]*)/.exec(line)
    return m && set.has(m[2]) ? line.slice('export '.length) : line
  }).join(String.fromCharCode(10))
}

function expand(text, depth) {
  if (depth > 6 || !text.includes('// @split: ')) return text
  return text.replace(MARK, (_m, rel, priv) => {
    const raw = realRead.call(fs, path.resolve(root, rel), 'utf8').split('\r\n').join('\n')
    // The sibling's own 'use client' directive is not part of the original layout.
    const body = expand(raw.replace(/^'use client'\n+/, ''), depth + 1)
    return priv ? unexport(body, priv) : body
  })
}

fs.readFileSync = function patchedReadFileSync(file, options) {
  const out = realRead.apply(fs, arguments)
  const enc = typeof options === 'string' ? options : options && options.encoding
  if (!enc || typeof out !== 'string') return out
  if (typeof file !== 'string' || !/\.(tsx?|jsx?)$/.test(file)) return out
  if (!out.includes('// @split: ')) return out
  if (!calledFromTest()) return out
  const crlf = out.includes('\r\n')
  const expanded = expand(out.split('\r\n').join('\n'), 0)
  return crlf ? expanded.split('\n').join('\r\n') : expanded
}
