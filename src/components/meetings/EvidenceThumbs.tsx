'use client'

import { useEffect, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { ImageOff } from 'lucide-react'
import { colors } from '@/lib/tokens'
import { MEETING_EVIDENCE_BUCKET, MEETING_EVIDENCE_URL_TTL_SECONDS } from '@/lib/meetings/evidence'
import { formatMeetingTimestamp, type MeetingOrderEvidence } from '@/lib/meetings/types'

// Evidence thumbnails, signed on demand.
//
// The bucket is private, so every image is reached through a short-lived signed
// URL. Signing happens only when a strip actually renders — a collapsed earlier
// meeting signs nothing — and in ONE batched request per strip. Signed URLs are
// kept for the tab, so switching Orders or re-expanding a meeting does not sign
// again what is still valid. Thumbnails are lazy-loaded; clicking one opens the
// original in a new tab.
//
// Every thumbnail names who attached it and when. That caption is the point:
// the image is evidence of what was communicated at that time, by that person.

type Signed = { url: string | null; expiresAt: number }

const signedUrls = new Map<string, Signed>()

/** Re-sign a little before expiry, so an image never breaks mid-meeting. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000
/** A failed signature is retried after this, not on every render. */
const RETRY_AFTER_MS = 30 * 1000

export function EvidenceThumbs({
  supabase, items,
}: {
  supabase: SupabaseClient
  items: readonly MeetingOrderEvidence[]
}) {
  // Bumped when a batch of signatures lands; the URLs themselves live in the
  // tab-wide map above.
  const [, setSignedVersion] = useState(0)
  const pathsKey = items.map(item => item.storage_path).join('|')

  useEffect(() => {
    const paths = pathsKey ? pathsKey.split('|') : []
    const now = Date.now()
    const due = paths.filter(path => {
      const signed = signedUrls.get(path)
      return !signed || signed.expiresAt - REFRESH_MARGIN_MS < now
    })
    if (due.length === 0) return

    let active = true
    supabase.storage
      .from(MEETING_EVIDENCE_BUCKET)
      .createSignedUrls(due, MEETING_EVIDENCE_URL_TTL_SECONDS)
      .then(({ data, error }) => {
        const signedAt = Date.now()
        const byPath = new Map<string, string>()
        for (const row of data ?? []) {
          if (row.path && row.signedUrl && !row.error) byPath.set(row.path, row.signedUrl)
        }
        for (const path of due) {
          const url = error ? null : (byPath.get(path) ?? null)
          signedUrls.set(path, url
            ? { url, expiresAt: signedAt + MEETING_EVIDENCE_URL_TTL_SECONDS * 1000 }
            : { url: null, expiresAt: signedAt + REFRESH_MARGIN_MS + RETRY_AFTER_MS })
        }
        if (active) setSignedVersion(v => v + 1)
      })
    return () => { active = false }
  }, [supabase, pathsKey])

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
      {items.map(item => {
        const signed = signedUrls.get(item.storage_path)
        const who = item.uploader_name ?? 'Unknown'
        const when = formatMeetingTimestamp(item.created_at)
        const title = `${item.file_name} — attached by ${who}, ${when}`
        const tile: React.CSSProperties = {
          width: 108, height: 80, borderRadius: '7px', display: 'block',
          border: `1px solid ${colors.border}`, background: colors.raised,
        }
        return (
          <figure key={item.id} style={{ margin: 0, width: 108 }}>
            {signed?.url ? (
              <a href={signed.url} target="_blank" rel="noopener noreferrer" title={title} style={{ display: 'block' }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={signed.url}
                  alt={item.file_name}
                  loading="lazy"
                  decoding="async"
                  style={{ ...tile, objectFit: 'cover' }}
                />
              </a>
            ) : (
              <div
                title={title}
                style={{
                  ...tile, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px',
                  fontSize: '10.5px', color: colors.muted,
                }}
              >
                {signed ? <><ImageOff size={13} strokeWidth={1.8} /> Unavailable</> : 'Loading…'}
              </div>
            )}
            <figcaption style={{ fontSize: '10.5px', color: colors.muted, marginTop: '4px', lineHeight: 1.3 }}>
              <div style={{
                color: colors.secondary, fontWeight: 600,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {who}
              </div>
              <div>{when}</div>
            </figcaption>
          </figure>
        )
      })}
    </div>
  )
}
