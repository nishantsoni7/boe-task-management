/**
 * "Did this change only how something LOOKS?" — the question the branch-scope guards ask when a visual
 * identity change touches hundreds of files.
 *
 * A diff is PRESENTATION-ONLY when, after blanking the presentation values on each side, the lines it removes
 * and the lines it adds are the same multiset. Blanking is deliberately narrow, so that anything which could
 * change behaviour survives it and makes the comparison fail:
 *
 *   - a colour literal (hex, rgb[a], hsl[a]) is blanked anywhere EXCEPT on a line where the colour is an
 *     operand of a comparison or a match (=== !== == !=, .includes/.indexOf/.match/.test/.startsWith, `case`):
 *     a colour that code branches on is behaviour, not paint. A colour that is merely a value in a ternary
 *     branch is paint. Known limit: a colour used as a data key on an ordinary line is blanked;
 *   - `colors.<name>` (the design-token object) and `font.display|body|mono` are blanked; any other identifier
 *     (`status.completed`, `radius.x`) is not;
 *   - a number is blanked only as the value of a size/spacing/weight property (fontSize, border-radius,
 *     padding…), never in a condition, a count or an arithmetic expression;
 *   - font-family values and `var(--token)` references are blanked.
 *
 * Added or removed lines, changed text, handlers, conditions, imports and reordered code all survive and fail.
 */

const LOGIC_ON_COLOUR = new RegExp([
  /(?:===|!==|==|!=)\s*['"`]?(?:#[0-9a-fA-F]{3,8}|rgba?\()/.source,
  /(?:#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))['"`]?\s*(?:===|!==|==|!=)/.source,
  /\.(?:includes|indexOf|match|test|startsWith)\([^)]*(?:#[0-9a-fA-F]{3,8}|rgba?\()/.source,
  /(?:#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))['"`]?\s*\]\s*\.(?:includes|indexOf)\(/.source,
  /\bcase\s+['"`]?#/.source,
].join('|'))
const SIZE_PROP = /\b(font-?size|border-?radius|padding(?:-[a-z]+)?|margin(?:-[a-z]+)?|gap|letter-?spacing|line-?height|font-?weight|min-?height)(['"]?\s*:\s*)([^;,}\n]*)/gi

export function blankPresentation(line: string, isCss: boolean): string {
  let l = line.replace(/\r$/, '')
  if (isCss || !LOGIC_ON_COLOUR.test(l)) {
    l = l
      .replace(/#[0-9a-fA-F]{3,8}\b/g, '#')
      .replace(/\b(?:rgba?|hsla?)\([^)]*\)/g, '#')
  }
  l = l
    .replace(/\bcolors\.[A-Za-z]+/g, '#')
    .replace(/\bfont\.(?:display|body|mono)\b/g, '#')
    .replace(/var\(--[a-zA-Z0-9-]+(?:,[^)]*)?\)/g, '#')
    .replace(/font-family:[^;}\n]*/g, 'fontFamily:')
    .replace(/fontFamily:\s*(?:'[^']*'|"[^"]*"|`[^`]*`|[A-Za-z_.]+)/g, 'fontFamily:')
    .replace(SIZE_PROP, (_m, key: string, sep: string, value: string) =>
      key + sep + value.replace(/-?\d+(?:\.\d+)?(?:px|rem|em)?(?![\w])/g, '0'))
  return l.replace(/\s+/g, ' ').trim()
}

/** `git diff -U0` output → true when every change in it is a presentation value and nothing else. */
export function isPresentationOnlyDiff(diffText: string, isCss: boolean): boolean {
  const removed: string[] = []
  const added: string[] = []
  for (const line of diffText.split('\n')) {
    if (line.startsWith('---') || line.startsWith('+++')) continue
    if (line.startsWith('-')) removed.push(blankPresentation(line.slice(1), isCss))
    else if (line.startsWith('+')) added.push(blankPresentation(line.slice(1), isCss))
  }
  if (removed.length === 0 && added.length === 0) return false
  return removed.filter(Boolean).sort().join('\n') === added.filter(Boolean).sort().join('\n')
}

/** The same blanking applied to a whole source text, for "unchanged apart from presentation" comparisons. */
export const styleBlind = (source: string): string =>
  source.split('\n').map((l) => blankPresentation(l, false)).join('\n')
