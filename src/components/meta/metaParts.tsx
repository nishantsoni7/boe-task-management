'use client'

import { plural, syncedWhen } from '@/lib/meta/report'
import type { MetaCtx } from './MetaScreen'
import s from './meta.module.css'

/** What is connected, in the owner's words: view only, when it was last read, how much has been read. */
export function ConnectionPanel({ ctx }: { ctx: MetaCtx }) {
  const { structure, sync, today } = ctx
  const last = sync.kind === 'ok' ? sync.lastOkAt : sync.kind === 'failed' ? sync.lastOkAt : null
  return (
    <section className={`boe-panel ${s.panel}`} aria-labelledby="meta-connection">
      <h2 className={s.heading} id="meta-connection">Connection</h2>
      <dl className={s.kv}>
        <dt>Access</dt><dd>View only</dd>
        <dt>Last sync</dt><dd>{last ? syncedWhen(last, today).replace(/^./, c => c.toUpperCase()) : 'Not yet'}</dd>
        <dt>Read so far</dt><dd>{plural(structure.campaigns.length, 'campaign')}, {plural(structure.adSets.length, 'ad set')}</dd>
      </dl>
      <p className={s.note}>BOE One cannot change anything in this ad account.</p>
    </section>
  )
}
