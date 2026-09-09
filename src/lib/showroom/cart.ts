// ── The showroom selection, before it becomes an inquiry ──────────────────────
//
// The customer walks the floor and scans a QR sticker on each piece they like.
// Every scan opens `/showroom/product/<code>` in a fresh tab (the phone's camera
// app does that, not us), so this list lives in `localStorage` under
// `boe_cart` and is the only thing carried between those tabs.
//
// The rule that was missing: scanning the same sticker twice — which happens
// constantly, because a customer walking back past a chair has no way to know
// whether they already added it — pushed a SECOND ROW for the same product. The
// list then showed "Rimini Chair ×1" twice, the totals were right but the list
// read as a mistake, and removing "the duplicate" removed a real quantity.
//
// Adding an already-selected product now raises its quantity instead, and says
// so. Everything here is pure so that rule, and the message the customer is
// shown, can be asserted without a browser.

export type CartItem = {
  product_id: string
  product_code: string
  name: string
  mrp: number
  quantity: number
  image_url?: string | null
  dim_str?: string | null
}

export type AddOutcome = {
  cart: CartItem[]
  /** True when an existing line's quantity went up rather than a line being added. */
  merged: boolean
  /** The quantity that line now holds. */
  quantity: number
  /** What to tell the customer. Already includes the code and the name. */
  message: string
}

/** Selections are capped so a stuck "+" cannot produce an absurd inquiry. */
export const MAX_ITEM_QUANTITY = 99

const clampQty = (n: number): number =>
  Math.min(MAX_ITEM_QUANTITY, Math.max(1, Math.round(Number(n) || 1)))

/**
 * Add a product to the selection, merging with an existing line if there is one.
 *
 * Identity is `product_id`, not `product_code`: the code is what the sticker
 * carries and what the customer reads, but the id is what the inquiry is
 * submitted with, and it is the one the server validates.
 *
 * Returns a NEW array — the caller writes it to storage and to state, and
 * mutating the old one in place would leave a stale React render holding the
 * updated list.
 */
export function addToCart(
  cart: CartItem[],
  item: CartItem,
  requestedQty: number = item.quantity,
): AddOutcome {
  const qty = clampQty(requestedQty)
  const existingIndex = (cart ?? []).findIndex(c => c.product_id === item.product_id)

  if (existingIndex === -1) {
    const added = { ...item, quantity: qty }
    return {
      cart: [...(cart ?? []), added],
      merged: false,
      quantity: qty,
      message: `${item.product_code} · ${item.name} added`,
    }
  }

  const existing = cart[existingIndex]
  const nextQty = clampQty(existing.quantity + qty)
  const next = cart.map((c, i) => (i === existingIndex ? { ...c, quantity: nextQty } : c))

  // At the ceiling the quantity did not actually move, and saying "quantity
  // increased to 99" when it was already 99 is a lie the customer can see.
  const message = nextQty === existing.quantity
    ? `${item.product_code} is already selected (maximum quantity ${MAX_ITEM_QUANTITY}).`
    : `${item.product_code} already selected. Quantity increased to ${nextQty}.`

  return { cart: next, merged: true, quantity: nextQty, message }
}

/**
 * Restore a selection saved by an earlier tab.
 *
 * The value is whatever is in `localStorage`, which is to say: possibly absent,
 * possibly written by an older version of this page, possibly hand-edited.
 * Anything that is not a usable line is dropped rather than allowed to reach a
 * `.toLocaleString()` on a field that turns out to be undefined — a customer
 * mid-visit must never see a crashed page over a bad stored row.
 */
export function parseCart(raw: string | null | undefined): CartItem[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const out: CartItem[] = []
  const seen = new Set<string>()
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue
    const row = entry as Record<string, unknown>
    const productId = typeof row.product_id === 'string' ? row.product_id : ''
    if (!productId) continue

    const mrp = Number(row.mrp)
    const item: CartItem = {
      product_id: productId,
      product_code: typeof row.product_code === 'string' ? row.product_code : '—',
      name: typeof row.name === 'string' ? row.name : 'Product',
      mrp: Number.isFinite(mrp) && mrp >= 0 ? mrp : 0,
      quantity: clampQty(Number(row.quantity)),
      image_url: typeof row.image_url === 'string' ? row.image_url : null,
      dim_str: typeof row.dim_str === 'string' ? row.dim_str : null,
    }

    // A list saved before merging existed can hold the same product twice.
    // Fold it on the way in, so an old session does not keep showing duplicates.
    if (seen.has(productId)) {
      const at = out.findIndex(c => c.product_id === productId)
      out[at] = { ...out[at], quantity: clampQty(out[at].quantity + item.quantity) }
      continue
    }
    seen.add(productId)
    out.push(item)
  }
  return out
}

/** Change one line's quantity by a step, dropping nothing below 1. */
export function changeQuantity(cart: CartItem[], productId: string, delta: number): CartItem[] {
  return cart.map(c =>
    c.product_id === productId ? { ...c, quantity: clampQty(c.quantity + delta) } : c,
  )
}

/** Remove one line by product, not by array index — indexes shift, products do not. */
export function removeFromCart(cart: CartItem[], productId: string): CartItem[] {
  return cart.filter(c => c.product_id !== productId)
}

export type CartSummary = {
  /** Distinct products. */
  lines: number
  /** Total pieces across all lines — what "6 items" means to a salesperson. */
  units: number
  total: number
  /** Ready for the sticky bar: `6 items · ₹2,45,000`. */
  label: string
}

/**
 * The running summary the salesperson and customer both read off the sticky bar.
 *
 * Counts UNITS, not lines: two chairs and a table is four items when the
 * quantities are 2, 1 and 1, and a customer checking the list against what they
 * picked counts pieces.
 */
export function summarizeCart(cart: CartItem[]): CartSummary {
  const lines = cart.length
  const units = cart.reduce((sum, c) => sum + c.quantity, 0)
  const total = cart.reduce((sum, c) => sum + c.mrp * c.quantity, 0)
  return {
    lines,
    units,
    total,
    label: `${units} ${units === 1 ? 'item' : 'items'} · ₹${total.toLocaleString('en-IN')}`,
  }
}
