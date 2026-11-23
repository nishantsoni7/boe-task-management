import type { QueryClient } from '@tanstack/react-query'
import type { createClient } from '@/lib/supabase/client'
import { fetchPictureMark, fetchQuotation, fetchSuggestionSettings, pictureMarkKey, quotationKeys, suggestionsKey } from './api'

type Supabase = ReturnType<typeof createClient>

// OPENING A QUOTATION STARTS ITS READS AT THE CLICK (23 Nov 2026, page speed).
//
// A click on a row used to go: fetch the page's server payload, load its code, mount the builder, and ONLY THEN ask the
// database for the quotation (measured on production: server payload 0.07-0.45 s, then the quotation read 0.3-1.0 s,
// one after the other). The reads need nothing from the page, so they now leave with the click and run beside the page's
// own loading: the builder's useQuery finds them already in flight (or done) under the same keys.
//
// It starts on a CLICK, never on hover or for a link merely on screen (owner decision #682: nothing is prefetched).
// Only the three reads that do not depend on anything the page works out: the quotation, the picture-mark switch, and
// who sees suggested prices. A failed read is swallowed here (prefetchQuery never throws) and the builder asks again.

/** How long a read started at the click, or a quotation just closed, counts as fresh: the builder does not ask again inside it. */
export const OPEN_FRESH_MS = 10_000

export function startOpeningReads(qc: QueryClient, supabase: Supabase, id: string): void {
  void qc.prefetchQuery({ queryKey: quotationKeys.one(id), queryFn: () => fetchQuotation(supabase, id), staleTime: OPEN_FRESH_MS, retry: false })
  void qc.prefetchQuery({ queryKey: pictureMarkKey(id), queryFn: () => fetchPictureMark(supabase, id), staleTime: OPEN_FRESH_MS, retry: false })
  void qc.prefetchQuery({ queryKey: suggestionsKey, queryFn: () => fetchSuggestionSettings(supabase), staleTime: 300_000, retry: false })
}
