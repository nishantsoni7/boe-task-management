'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { LoadingScreen } from '@/components/ui/atoms'
import { usePermissionContext } from '@/hooks/queries/usePermissionContext'
import { useSalesAccess } from '@/hooks/useSalesAccess'
import { formatPhone, telHref } from '@/lib/exhibitionLeads/phone'
import { clearHeldChat, fetchHeldChats, HELD_KEY, makeHeldChatALead, SALES_KEY, SalesRequestError, type HeldChat } from '@/lib/salesLeads/api'
import { HELD_KINDS } from '@/lib/salesLeads/constants'
import { plural, whenLabel } from '@/lib/salesLeads/format'
import { createClient } from '@/lib/supabase/client'
import { SalesFrame } from './SalesFrame'
import { useToast } from './useToast'
import s from './salesLeads.module.css'

// Filtered chats (20270613000000): WhatsApp chats BOE One judged NOT to be leads (job seekers, suppliers, transport...).
// They are not in the Lead Master. People who allot look here, and press "This is a lead" when the judge was wrong.

export function FilteredChatsScreen() {
  const { ready } = usePermissionContext()
  const { canAssign } = useSalesAccess()
  const supabase = useMemo(() => createClient(), [])
  const queryClient = useQueryClient()
  const toast = useToast()
  const [busy, setBusy] = useState<string | null>(null)

  const held = useQuery({ queryKey: HELD_KEY, queryFn: () => fetchHeldChats(supabase), enabled: ready && canAssign })
  const rows = held.data?.rows ?? []

  async function act<T>(chat: HeldChat, run: () => Promise<T>, done: (result: T) => string) {
    setBusy(chat.id)
    try {
      toast.show(done(await run()))
      await queryClient.invalidateQueries({ queryKey: [SALES_KEY] })
    } catch (e) {
      toast.show(e instanceof SalesRequestError ? e.message : 'Something went wrong. Try again.', true)
    } finally {
      setBusy(null)
    }
  }

  const makeLead = (chat: HeldChat) => act(chat, () => makeHeldChatALead(supabase, chat.id), r => r.status === 'duplicate'
    ? `This number is already lead #${r.lead.lead_no}.`
    : `Lead #${r.lead.lead_no} added, not allotted yet. Allot it in the Lead Master.`)

  let body: React.ReactNode
  if (!ready) {
    body = <LoadingScreen message="Loading..." />
  } else if (!canAssign) {
    body = (
      <div className="boe-empty">
        <p className="boe-empty-title">Only people who allot leads see filtered chats</p>
        <p>Ask an administrator for the Assign right on Sales.</p>
        <Link className="boe-btn boe-btn-secondary" href="/sales/lead-master">Back to the Lead Master</Link>
      </div>
    )
  } else {
    body = (
      <div className={`${s.wrap} ${s.wrapForm}`}>
        <div className="boe-callout" style={{ marginBottom: 14 }}>
          <div>
            <span className="boe-callout-title">WhatsApp chats that did not look like leads</span>
            <span>
              Job seekers, suppliers, transport companies and the like. They are kept here for 30 days and are not in the Lead
              Master. If one is a buyer, press This is a lead.
            </span>
          </div>
        </div>

        {held.isError && (
          <div className="boe-callout boe-callout-error" role="alert">
            <div>
              <span className="boe-callout-title">The filtered chats could not be loaded</span>
              <span><button type="button" className="boe-btn boe-btn-secondary" onClick={() => held.refetch()}>Try again</button></span>
            </div>
          </div>
        )}
        {held.isPending && !held.isError && <LoadingScreen message="Loading..." />}
        {held.isSuccess && rows.length === 0 && (
          <div className={s.empty} style={{ display: 'block' }}>No filtered chats. Every WhatsApp chat so far looked like a lead, or was checked.</div>
        )}

        {rows.length > 0 && (
          <>
            <p className="fin-count" style={{ margin: '0 0 8px' }}>{plural(rows.length, 'chat')}, newest first</p>
            <ul className={s.heldList}>
              {rows.map(c => (
                <li key={c.id} className={`${s.panel} ${s.heldCard}`}>
                  <div className={s.heldHead}>
                    <div>
                      <div className="fin-primary-text">{c.name ?? formatPhone(c.phone)}</div>
                      <a className={s.phone} href={telHref(c.phone)}>{formatPhone(c.phone)}</a>
                    </div>
                    <span className={s.tag}>{HELD_KINDS[c.category] ?? HELD_KINDS.other}</span>
                  </div>
                  {c.reason && <p className={s.heldWhy}>{c.reason}</p>}
                  <ul className={s.heldWords} aria-label="Their messages">
                    {c.messages.filter(Boolean).map((m, i) => <li key={i}>{m}</li>)}
                  </ul>
                  <div className={s.heldFoot}>
                    <span className="fin-sub">Last message {whenLabel(c.last_at)}</span>
                    <span className={s.heldActions}>
                      <button type="button" className="boe-btn boe-btn-secondary" disabled={busy !== null}
                        onClick={() => void act(c, () => clearHeldChat(supabase, c.id), () => 'Cleared. It stays out of this list.')}>
                        Clear
                      </button>
                      <button type="button" className="boe-btn boe-btn-primary" disabled={busy !== null} onClick={() => void makeLead(c)}>
                        {busy === c.id ? 'Saving…' : 'This is a lead'}
                      </button>
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
        {toast.node}
      </div>
    )
  }

  return <SalesFrame title="Filtered chats" subtitle="Lead Master">{body}</SalesFrame>
}
