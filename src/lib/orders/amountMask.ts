// ── Hide amounts: a DISPLAY preference for the PI detail page ────────────────
//
// Somebody sharing their screen, or reading an order out to a client, needs the
// page without its money. This is that and nothing more: no permission changes,
// nothing is written to the database, and the figures are still in the page's
// state — they are simply not drawn.
//
// WHY THE TEXT IS MASKED WHERE IT LANDS, and not where it is formatted. Money
// reaches this page through a dozen formatters (formatInr, formatMoney, an Intl
// currency formatter in the middleman summary, sentences that embed a figure),
// and some code compares formatted strings (the discount row is dropped when it
// equals formatInr(0)). Changing the formatters would break that comparison and
// still miss the sentences. Every one of them prints the rupee sign directly
// before its digits, so the one rule below finds all of them, including any a
// later change adds.
//
// The preference is kept in sessionStorage: it survives navigation and reload in
// the same browser session and is gone when the session ends.

export const AMOUNTS_HIDDEN_STORAGE_KEY = 'boe.pi-detail.amounts-hidden'

/** What a hidden figure reads as. Fixed width, so the layout does not jump. */
export const AMOUNT_MASK = '₹ ••••'

/** A rupee figure: optional minus (U+2212 or hyphen), the sign, then digits with grouping. */
const MONEY = /[−-]?₹\s?\d[\d,]*(?:\.\d+)?/g

/** True when the text carries a rupee figure. */
export const hasAmount = (text: string): boolean => {
  MONEY.lastIndex = 0
  return MONEY.test(text)
}

/** The text with every rupee figure replaced by the mask. Other text is untouched. */
export function maskAmounts(text: string): string {
  return text.replace(MONEY, AMOUNT_MASK)
}

type ReadableStorage = Pick<Storage, 'getItem'>
type WritableStorage = Pick<Storage, 'setItem' | 'removeItem'>

/** Whether this browser session has asked for amounts to be hidden. Storage may throw or be absent. */
export function readAmountsHidden(storage: ReadableStorage | null | undefined): boolean {
  try {
    return storage?.getItem(AMOUNTS_HIDDEN_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

export function writeAmountsHidden(storage: WritableStorage | null | undefined, hidden: boolean): void {
  try {
    if (hidden) storage?.setItem(AMOUNTS_HIDDEN_STORAGE_KEY, '1')
    else storage?.removeItem(AMOUNTS_HIDDEN_STORAGE_KEY)
  } catch {
    // Private windows and blocked site data: the toggle still works for this page view.
  }
}

// ── Applying the mask to a rendered tree ─────────────────────────────────────

/** The parts of a DOM node this needs, so the walk can be tested without a browser. */
export type MaskableNode = {
  nodeType: number
  nodeValue: string | null
  childNodes: ArrayLike<MaskableNode>
  tagName?: string
  getAttribute?: (name: string) => string | null
  setAttribute?: (name: string, value: string) => void
}

const TEXT_NODE = 3
const ELEMENT_NODE = 1

/** Attributes a screen reader or a tooltip would otherwise still speak. */
export const MASKED_ATTRIBUTES = ['aria-label', 'title', 'alt'] as const

/** What a node held before it was masked, and what it was masked to. */
export type MaskMemory = WeakMap<object, Record<string, { original: string; masked: string }>>

const TEXT_KEY = '#text'

const remember = (memory: MaskMemory, node: MaskableNode, key: string, original: string, masked: string) => {
  const entry = memory.get(node) ?? {}
  entry[key] = { original, masked }
  memory.set(node, entry)
}

/**
 * Mask (or restore) every rupee figure under `root`.
 *
 * IDEMPOTENT AND SAFE TO RE-RUN. A node already showing its mask is skipped, and
 * a node React has rewritten since (its value no longer equals what was stored)
 * is treated as new. Restoring only touches a node that still shows the mask, so
 * it can never overwrite text the page changed in the meantime.
 */
export function applyAmountMask(root: MaskableNode, hidden: boolean, memory: MaskMemory): void {
  const visit = (node: MaskableNode) => {
    if (node.nodeType === TEXT_NODE) {
      const value = node.nodeValue ?? ''
      const held = memory.get(node)?.[TEXT_KEY]
      if (hidden) {
        if (held && value === held.masked) return
        const masked = maskAmounts(value)
        if (masked !== value) {
          remember(memory, node, TEXT_KEY, value, masked)
          node.nodeValue = masked
        }
      } else if (held && value === held.masked) {
        node.nodeValue = held.original
        memory.delete(node)
      }
      return
    }
    if (node.nodeType !== ELEMENT_NODE) return
    const tag = node.tagName?.toLowerCase()
    if (tag === 'script' || tag === 'style') return

    if (node.getAttribute && node.setAttribute) {
      for (const name of MASKED_ATTRIBUTES) {
        const value = node.getAttribute(name)
        if (value === null) continue
        const held = memory.get(node)?.[name]
        if (hidden) {
          if (held && value === held.masked) continue
          const masked = maskAmounts(value)
          if (masked !== value) {
            remember(memory, node, name, value, masked)
            node.setAttribute(name, masked)
          }
        } else if (held && value === held.masked) {
          node.setAttribute(name, held.original)
        }
      }
    }
    for (let i = 0; i < node.childNodes.length; i += 1) visit(node.childNodes[i])
  }
  visit(root)
}
