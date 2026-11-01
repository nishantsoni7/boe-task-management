import type { SupabaseClient } from '@supabase/supabase-js'
import { istAddDays, istToday } from '@/lib/istDate'
import { fetchAllRows } from '@/lib/supabasePaging'
import type { SeoData, SeoLogRow, SeoMetric, SeoPlanItem, SeoReview, SeoRun, SeoWatch } from './report'

// All the SEO screens share this one read, so moving between them costs nothing. RLS decides who gets rows:
// module_entry_open('seo'). Thirteen months keeps a full year on the screen and the read small as days add up.
const KEEP_DAYS = 400

export async function fetchSeoData(supabase: SupabaseClient): Promise<SeoData> {
  const since = istAddDays(istToday(), -KEEP_DAYS)
  const [metrics, watchlist, planItems, reviews, log, runs] = await Promise.all([
    fetchAllRows<SeoMetric>((from, to) => supabase
      .from('seo_metrics')
      .select('metric_date, metric, scope, value, detail, source')
      .gte('metric_date', since)
      .order('metric_date', { ascending: false })
      .order('metric')
      .order('scope')
      .range(from, to)),
    supabase.from('seo_watchlist').select('kind, entry_key, label, note, active'),
    supabase.from('seo_plan_items').select('id, window_key, title, who, due_date, status, evidence').order('due_date').order('id'),
    supabase.from('seo_reviews').select('review_date, verdict, items_due, items_done, numbers_on_target, summary')
      .order('review_date', { ascending: false }).limit(60),
    supabase.from('seo_log').select('id, kind, log_date, title, body, before_value, after_value, source')
      .order('log_date', { ascending: false }).limit(500),
    supabase.from('seo_feed_runs').select('feed, run_date, status, message, row_count')
      .order('run_date', { ascending: false }).limit(100),
  ])
  if (!metrics.ok) throw new Error(metrics.error)
  for (const result of [watchlist, planItems, reviews, log, runs]) {
    if (result.error) throw new Error(result.error.message)
  }
  return {
    metrics: metrics.rows,
    watchlist: (watchlist.data ?? []) as SeoWatch[],
    planItems: (planItems.data ?? []) as SeoPlanItem[],
    reviews: (reviews.data ?? []) as SeoReview[],
    log: (log.data ?? []) as SeoLogRow[],
    runs: (runs.data ?? []) as SeoRun[],
  }
}
