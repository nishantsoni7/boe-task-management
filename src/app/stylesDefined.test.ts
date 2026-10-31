/**
 * A CLASS A SCREEN ASKS FOR MUST EXIST.
 *
 * #522 removed two old blocks from globals.css and took the Founders' payouts
 * block between them: 64 classes still in use. Nothing failed, because a class
 * name is only a string, and the page went out with no styling at all.
 * foundersStyles.test.ts guards that one page; this test asks the same question
 * of every screen. Each name on a className must have a rule in globals.css, in
 * an inline <style>, or, for styles.x, in the module that styles came from.
 *
 * Only one direction. About 180 classes in globals.css are used by nothing, so
 * "every rule is used" is not asked here.
 *
 * It cannot see two things. A name built at run time (`fin-pill--${tone}`), and a
 * rule deleted while the name survives in another rule (.x:hover keeps .x defined).
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, posix } from 'node:path'
import ts from 'typescript'

const SRC = join(process.cwd(), 'src')
const files = readdirSync(SRC, { recursive: true, encoding: 'utf8' }).map(f => f.replace(/\\/g, '/'))
const read = (file: string) => readFileSync(join(SRC, file), 'utf8')

/**
 * Named on a screen, and rightly without a rule. A name goes here only with its
 * reason; the last test fails if one stops being used or gains a rule.
 */
const NO_RULE_NEEDED: Record<string, readonly string[]> = {
  'the element carries its styling inline; the name only labels it': [
    'available-money', 'available-money-row', 'boe-destination-card', 'boe-module-switch',
    'order-ff-pend-approve', 'order-highlight', 'payment-track', 'payment-track-step',
    'pi-amounts-toggle-label', 'pi-detail-quote', 'pi-detail-workflow-body', 'pi-note-money',
  ],
  'the shared base class is the whole look; the second name only labels this use': [
    'boe-cj-age', 'boe-row-icon--edit', 'order-doc-change--rejected', 'order-doc-pi-notice',
    'pi-pay-details-activity', 'pv-table--pi',
  ],
  'a table cell or wrapper that takes the default look': [
    'od-strip-label', 'ops-na-due', 'ops-na-sp', 'ops-na-wait', 'pv-editor',
  ],
  '.pi-form-grid > * already spans all twelve columns': ['pi-span-12'],
  'a Tailwind utility, written by Tailwind and so in no stylesheet here': ['sr-only'],
}
const noRuleNeeded = new Set(Object.values(NO_RULE_NEEDED).flat())

// ── What the stylesheets define ─────────────────────────────────────────────

const selectorsOf = (css: string) =>
  [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(?<=^|[{};])[^{};]+(?=\{)/g)].map(m => m[0])
const classesIn = (selector: string) =>
  [...selector.replace(/\[[^\]]*\]/g, '').matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map(m => m[1])
/** A module does not hash what sits in :global(...), so a plain string reaches it. */
const GLOBAL_PART = /:global\(((?:[^()]|\([^()]*\))*)\)/g

const plainRules = new Set<string>()
const moduleRules = new Map<string, Set<string>>()

for (const file of files.filter(f => f.endsWith('.css'))) {
  const own = new Set<string>()
  for (const selector of selectorsOf(read(file))) {
    if (!file.endsWith('.module.css')) {
      for (const name of classesIn(selector)) plainRules.add(name)
      continue
    }
    for (const part of selector.matchAll(GLOBAL_PART)) for (const name of classesIn(part[1])) plainRules.add(name)
    for (const name of classesIn(selector.replace(GLOBAL_PART, ' '))) own.add(name)
  }
  if (file.endsWith('.module.css')) moduleRules.set(file, own)
}

// ── What the screens ask for ────────────────────────────────────────────────

/** Two stylesheets are handed on under another name: file it comes from, then the stylesheet. */
const HANDED_ON: Record<string, Record<string, string>> = {
  'components/attendancePayroll/ui': { ui: 'components/attendancePayroll/ui.module.css' },
  'components/controlCenter/CcPrimitives': { cc: 'components/controlCenter/controlCenter.module.css' },
}
const CLASS_PROP = /^(?:class|[a-zA-Z]*[cC]lassName)$/

const asked = new Map<string, string>()
const askedOfModule = new Map<string, Map<string, string>>()

const resolveFrom = (file: string, spec: string) =>
  spec.startsWith('@/') ? spec.slice(2) : posix.normalize(posix.join(posix.dirname(file), spec))

function readScreen(file: string, source: string) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX)
  const at = (n: ts.Node) => `${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`
  const imports = new Map<string, string>()
  const declared = new Map<string, ts.Expression>()

  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !st.importClause) continue
    const from = resolveFrom(file, st.moduleSpecifier.text)
    if (from.endsWith('.module.css') && st.importClause.name) imports.set(st.importClause.name.text, from)
    const named = st.importClause.namedBindings
    if (named && ts.isNamedImports(named)) {
      for (const el of named.elements) {
        const sheet = HANDED_ON[from]?.[(el.propertyName ?? el.name).text]
        if (sheet) imports.set(el.name.text, sheet)
      }
    }
  }
  ;(function index(n: ts.Node) {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) declared.set(n.name.text, n.initializer)
    n.forEachChild(index)
  })(sf)

  const seen = new Set<string>()
  const ask = (name: string, n: ts.Node) => { if (!asked.has(name)) asked.set(name, at(n)) }

  /** Every whole class name an expression can put on a className. */
  function namesIn(n: ts.Expression | undefined): void {
    if (!n) return
    if (ts.isStringLiteralLike(n)) {
      for (const name of n.text.split(/\s+/)) if (name) ask(name, n)
    } else if (ts.isTemplateExpression(n)) {
      const pieces = [n.head.text, ...n.templateSpans.map(s => s.literal.text)]
      pieces.forEach((piece, i) => {
        const words = piece.split(/\s+/)
        words.forEach((word, w) => {
          // A word touching a ${...} is only part of a name.
          const gluedLeft = w === 0 && i > 0
          const gluedRight = w === words.length - 1 && i < pieces.length - 1
          if (word && !gluedLeft && !gluedRight) ask(word, n)
        })
      })
      n.templateSpans.forEach((span, i) => {
        const before = pieces[i]
        const after = pieces[i + 1]
        // And a ${...} touching a word is only part of a name.
        if (/(?:^|\s)$/.test(before) && /^(?:\s|$)/.test(after)) namesIn(span.expression)
      })
    } else if (ts.isConditionalExpression(n)) {
      namesIn(n.whenTrue)
      namesIn(n.whenFalse)
    } else if (ts.isBinaryExpression(n)) {
      const op = n.operatorToken.kind
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) namesIn(n.right)
      if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
        namesIn(n.left)
        namesIn(n.right)
      }
    } else if (ts.isArrayLiteralExpression(n)) {
      n.elements.forEach(namesIn)
    } else if (ts.isObjectLiteralExpression(n)) {
      for (const p of n.properties) if (ts.isPropertyAssignment(p)) namesIn(p.initializer)
    } else if (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n) || ts.isSatisfiesExpression(n)) {
      namesIn(n.expression)
    } else if (ts.isElementAccessExpression(n)) {
      namesIn(n.expression)
    } else if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      namesIn(n.expression.expression) // [...].filter(Boolean).join(' ')
    } else if (ts.isIdentifier(n) && declared.has(n.text) && !seen.has(n.text)) {
      seen.add(n.text)
      namesIn(declared.get(n.text))
      seen.delete(n.text)
    }
  }

  function askOfModule(sheet: string, name: string, n: ts.Node) {
    if (!askedOfModule.has(sheet)) askedOfModule.set(sheet, new Map())
    if (!askedOfModule.get(sheet)!.has(name)) askedOfModule.get(sheet)!.set(name, at(n))
  }

  ;(function visit(n: ts.Node) {
    if (ts.isJsxAttribute(n) && CLASS_PROP.test(n.name.getText(sf)) && n.initializer) {
      namesIn(ts.isJsxExpression(n.initializer) ? n.initializer.expression : n.initializer)
    }
    if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && CLASS_PROP.test(n.name.text)) namesIn(n.initializer)
    if ((ts.isBindingElement(n) || ts.isParameter(n)) && ts.isIdentifier(n.name) && CLASS_PROP.test(n.name.text)) namesIn(n.initializer)

    // A local `const a = document.createElement('a')` can shadow `import a`. Nobody
    // assigns to a stylesheet or calls one, so those two shapes are skipped.
    const skipped = ts.isCallExpression(n) ? n.expression
      : ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken ? n.left
      : null
    if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && imports.has(n.expression.text)) {
      askOfModule(imports.get(n.expression.text)!, n.name.text, n)
    }
    if (ts.isElementAccessExpression(n) && ts.isIdentifier(n.expression) && imports.has(n.expression.text) && ts.isStringLiteralLike(n.argumentExpression)) {
      askOfModule(imports.get(n.expression.text)!, n.argumentExpression.text, n)
    }

    // A class defined in an inline <style> counts as defined.
    if (ts.isJsxElement(n) && n.openingElement.tagName.getText(sf) === 'style') {
      for (const child of n.children) {
        if (ts.isJsxExpression(child) && child.expression) readInlineCss(child.expression, sf)
      }
    }
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && /_(?:CSS|STYLES)$/.test(n.name.text) && n.initializer) {
      readInlineCss(n.initializer, sf)
    }
    // A print window writes out a whole page, <style> and all.
    if ((ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n)) && n.getText(sf).includes('<style')) {
      readInlineCss(n, sf)
    }

    n.forEachChild(child => {
      if (child === skipped && ts.isPropertyAccessExpression(child)) visit(child.expression)
      else visit(child)
    })
  })(sf)
}

function readInlineCss(n: ts.Expression, sf: ts.SourceFile) {
  if (!ts.isStringLiteralLike(n) && !ts.isTemplateExpression(n)) return
  for (const selector of selectorsOf(n.getText(sf).slice(1, -1))) {
    for (const name of classesIn(selector)) plainRules.add(name)
  }
}

for (const file of files) {
  if (file.endsWith('.tsx') && !file.includes('.test.')) readScreen(file, read(file))
}

describe('every class a screen asks for has a rule', () => {
  test('the search above is still finding the app', () => {
    assert.ok(asked.size > 1500, `only ${asked.size} plain names found: the search has stopped working`)
    assert.ok(plainRules.size > 1500, `only ${plainRules.size} rules found in the stylesheets`)
    assert.ok(moduleRules.size > 25, `only ${moduleRules.size} stylesheet modules found`)
    assert.ok(asked.has('boe-btn') && plainRules.has('boe-btn'), 'the shared button is not being seen')
    assert.ok(asked.has('boe-spin'), 'a name on a ternary is not being seen')
    assert.ok(askedOfModule.get('components/attendancePayroll/ui.module.css')?.has('toolbar'), 'a stylesheet handed on as ui is not being seen')
    assert.ok(askedOfModule.get('components/controlCenter/controlCenter.module.css')?.size, 'a stylesheet handed on as cc is not being seen')
  })

  test('every plain class name has a rule', () => {
    const missing = [...asked].filter(([name]) => !plainRules.has(name) && !noRuleNeeded.has(name))
    assert.deepEqual(
      missing.map(([name, where]) => `${name} (${where})`), [],
      'A rule was deleted or a name mistyped. If the class truly needs no rule, add it to NO_RULE_NEEDED with the reason.',
    )
  })

  test('every styles.x is defined in the module it is read from', () => {
    const missing: string[] = []
    for (const [sheet, names] of askedOfModule) {
      const rules = moduleRules.get(sheet)
      if (!rules) { missing.push(`${sheet} does not exist`); continue }
      for (const [name, where] of names) if (!rules.has(name)) missing.push(`${name} in ${sheet} (${where})`)
    }
    assert.deepEqual(missing, [])
  })

  test('the exceptions still earn their place', () => {
    const stale = [...noRuleNeeded].filter(name => !asked.has(name) || plainRules.has(name))
    assert.deepEqual(stale, [], 'Each of these is no longer used, or now has a rule: take it off NO_RULE_NEEDED.')
  })
})
