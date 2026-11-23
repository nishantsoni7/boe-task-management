// Wood in cubic feet from a cut list (owner, 23 Nov 2026: "the exact wood usage in cubic feet, then labour and hardware
// to come to a raw structure cost"). Sizes are the finished sizes in inches; the waste % turns them into wood bought.

export type CutPart = { qty: number; length: number; width: number; thick: number }

export const cuFt = (p: CutPart) => (p.qty > 0 && p.length > 0 && p.width > 0 && p.thick > 0 ? p.qty * p.length * p.width * p.thick / 1728 : 0)

/** Wood in the piece, and wood bought once the conversion waste is added. */
export function cutList(parts: readonly CutPart[], wastePct: number): { net: number; gross: number } {
  const net = parts.reduce((s, p) => s + cuFt(p), 0)
  return { net, gross: net * (1 + Math.max(0, wastePct) / 100) }
}
