// ── Product Master sidebar counts ─────────────────────────────────────────────
// The grouping half of the `?counts=1` endpoint. It lives here rather than in
// the route because a Next route file may only export route handlers, and
// because this is where the correctness risk sits: PostgREST cannot GROUP BY,
// so the endpoint reads active products once and tallies them in memory. What
// must never come back is a head-count query per category — an N+1 that grows
// with the catalogue.

export type CategoryTally = {
  /**
   * Every active product, including any still pointing at a category that has
   * since been deactivated or deleted. So the parent badge can legitimately
   * exceed the sum of the children: it is the catalogue total, not their sum.
   */
  total: number
  categories: { name: string; count: number }[]
}

/**
 * Group active products by category name.
 *
 * Matching is exact on the stored name (after trimming stray padding on the
 * product's own value). A mis-cased value is deliberately NOT merged into its
 * look-alike: that would hide a real data problem behind a plausible badge, and
 * the number would then disagree with the list, which filters case-sensitively.
 */
export function tallyByCategory(
  rows: readonly { category: string | null }[],
  categoryNames: readonly string[],
): CategoryTally {
  const tally = new Map<string, number>()
  for (const row of rows) {
    const name = (row.category ?? '').trim()
    if (!name) continue
    tally.set(name, (tally.get(name) ?? 0) + 1)
  }
  return {
    total: rows.length,
    categories: categoryNames.map(name => ({ name, count: tally.get(name) ?? 0 })),
  }
}
