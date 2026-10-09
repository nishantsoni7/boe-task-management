/**
 * Reading test sources as code rather than as text.
 *
 * Two contracts in this directory decide which test files may talk to a
 * database, and both were originally written with plain substring matching.
 * That is not good enough here, for a specific reason: several suites in this
 * repo assert on the SOURCE of a route, so their own text is full of lines
 * like `assert.ok(route.includes("await createClient()"))`. A naive scan
 * reports those as database clients — six of nine files in the first manual
 * sweep of this repo were exactly that false positive — and a scan tuned to
 * dodge them starts missing real ones instead.
 *
 * So: strip comments and string literals first, then look at what is left.
 * Both helpers are exercised directly by noLiveDbInDefaultRun.test.ts, so a
 * scrubber that quietly stops working fails a test rather than silently
 * approving every file it reads.
 */

/**
 * Remove comments and string/template literals, leaving executable code.
 *
 * Each removed literal becomes `""` so the tokens either side stay separated.
 * This is deliberately not a parser: it does not track regex literals or JSX,
 * neither of which can carry an import statement.
 */
export function scrub(source: string): string {
  let out = ''
  let i = 0
  while (i < source.length) {
    const two = source.slice(i, i + 2)
    if (two === '//') {
      const end = source.indexOf('\n', i)
      i = end === -1 ? source.length : end
    } else if (two === '/*') {
      const end = source.indexOf('*/', i + 2)
      i = end === -1 ? source.length : end + 2
    } else if (source[i] === "'" || source[i] === '"' || source[i] === '`') {
      const quote = source[i]
      i++
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') i++
        i++
      }
      i++
      out += '""'
    } else {
      out += source[i]
      i++
    }
  }
  return out
}

/**
 * The module specifiers this source imports as VALUES.
 *
 * Type-only imports are excluded: `import type { SupabaseClient }` is erased
 * at compile time and cannot construct anything, and it is how the mocked
 * suites accept a stub client as a parameter. Both the statement form
 * (`import type { X } from`) and the inline form (`import { type X } from`)
 * are recognised.
 */
export function valueImportedModules(source: string): string[] {
  const scrubbed = scrub(source)
  const found: string[] = []
  const statement = /import\s+([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/g
  let match: RegExpExecArray | null

  while ((match = statement.exec(source)) !== null) {
    const [whole, clause, specifier] = match

    if (/^\s*type\s/.test(clause)) continue

    // A brace-only clause whose every binding carries its own `type` modifier.
    const braces = clause.match(/\{([^}]*)\}/)
    if (braces && !/^\s*[\w*]/.test(clause)) {
      const bindings = braces[1].split(',').map(b => b.trim()).filter(Boolean)
      if (bindings.length > 0 && bindings.every(b => /^type\s/.test(b))) continue
    }

    // An import that exists only inside a string literal is not real code.
    const head = whole.slice(0, whole.indexOf('from')).trimEnd()
    if (!scrubbed.includes(head)) continue

    found.push(specifier)
  }
  return found
}

/**
 * True when `source` actually calls `name`, rather than merely mentioning it
 * in a comment or asserting on it as text.
 */
export function callsFunction(source: string, name: string): boolean {
  return new RegExp(`\\b${name}\\s*\\(`).test(scrub(source))
}
