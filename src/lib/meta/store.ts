// The sync's only door to the database. The sync talks to this small interface, so it can be tested without one;
// supabaseStore is the real thing and is used with the service role, because browsers cannot write these tables.

import type { SupabaseClient } from '@supabase/supabase-js'

export type MetaTable = 'meta_ad_accounts' | 'meta_campaigns' | 'meta_ad_sets' | 'meta_insights_daily'
export type RunKind = 'first' | 'daily'
export type RunFinish = { status: 'ok' | 'failed'; message: string; campaigns: number; ad_sets: number; insight_rows: number }

export type MetaStore = {
  hasRunningSince(iso: string): Promise<boolean>
  hasOkRun(): Promise<boolean>
  startRun(kind: RunKind): Promise<string>
  finishRun(id: string, finish: RunFinish): Promise<void>
  upsert(table: MetaTable, rows: object[], onConflict: string): Promise<void>
}

const CHUNK = 500

function check(error: { message: string } | null, what: string): void {
  if (error) throw new Error(`Saving ${what} failed: ${error.message}`.slice(0, 300))
}

export function supabaseStore(svc: SupabaseClient): MetaStore {
  return {
    async hasRunningSince(iso) {
      const { data, error } = await svc.from('meta_sync_runs').select('id').eq('status', 'running').gt('started_at', iso).limit(1)
      check(error, 'the sync check')
      return (data ?? []).length > 0
    },

    async hasOkRun() {
      const { data, error } = await svc.from('meta_sync_runs').select('id').eq('status', 'ok').limit(1)
      check(error, 'the sync check')
      return (data ?? []).length > 0
    },

    async startRun(kind) {
      const { data, error } = await svc.from('meta_sync_runs').insert({ kind, status: 'running' }).select('id').single()
      check(error, 'the sync run')
      return String((data as { id: string }).id)
    },

    async finishRun(id, finish) {
      const { error } = await svc.from('meta_sync_runs').update({ ...finish, finished_at: new Date().toISOString() }).eq('id', id)
      check(error, 'the sync run')
    },

    async upsert(table, rows, onConflict) {
      for (let i = 0; i < rows.length; i += CHUNK) {
        const { error } = await svc.from(table).upsert(rows.slice(i, i + CHUNK), { onConflict })
        check(error, table)
      }
    },
  }
}
