// The price pool for pricing model v2 (pricing_pool, 20270621000000): every recorded price of the product types asked
// for, with its parameters. One call per screen; the model is fitted from it in the browser.

import type { createClient } from '@/lib/supabase/client'
import { fetchWordsFor, PRODUCT_TYPES } from './features'
import type { ModelPoint } from './model'

type Supabase = ReturnType<typeof createClient>

/** The words for these product types, at most 40 (the function's limit). */
export const poolWords = (types: Iterable<string>) => [...new Set([...types].flatMap(fetchWordsFor))].sort().slice(0, 40)

export async function fetchPool(s: Supabase, words: string[], exclude: string | null = null): Promise<ModelPoint[]> {
  if (words.length === 0) return []
  const { data, error } = await s.rpc('pricing_pool', { p_words: words, p_exclude: exclude })
  if (error) throw new Error(/Could not find the function|does not exist/i.test(error.message) ? 'The price model is being set up: its database part has not been applied yet.' : error.message.replace(/^.*PRICING_\w+:\s*/, ''))
  return (data ?? []) as ModelPoint[]
}

/** The words of every product type, in groups of at most 40 (one pool call each). */
export function allTypeWords(): string[][] {
  const words = [...new Set(PRODUCT_TYPES.flatMap(t => fetchWordsFor(t.type)))].sort()
  return Array.from({ length: Math.ceil(words.length / 40) }, (_, i) => words.slice(i * 40, i * 40 + 40))
}

/** Every price of every product type ("How accurate is it"): one call per group of words, a price met twice kept once. */
export async function fetchWholePool(s: Supabase): Promise<ModelPoint[]> {
  const parts = await Promise.all(allTypeWords().map(w => fetchPool(s, w)))
  const seen = new Set<string>()
  return parts.flat().filter(p => { const k = JSON.stringify(p); if (seen.has(k)) return false; seen.add(k); return true })
}
