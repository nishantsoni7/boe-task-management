'use client'

import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Lock, SlidersHorizontal } from 'lucide-react'
import { colors } from '@/lib/tokens'
import { useSignedInUserId } from '@/hooks/queries/usePermissionContext'
import {
  forYouChoicesKey,
  saveForYouChoices,
  useForYouAccess,
  useForYouChoices,
  useForYouModes,
  type ChoicesRead,
} from '@/hooks/queries/useForYouSettings'
import {
  FOR_YOU_ITEMS,
  itemApplies,
  modeOf,
  withItemHidden,
  type ForYouItemKey,
} from '@/lib/modules/forYouCatalogue'

const card: React.CSSProperties = {
  background: '#fff',
  border: `1px solid ${colors.border}`,
  borderRadius: 12,
  padding: '20px 22px',
  scrollMarginTop: 16,
}

const note: React.CSSProperties = { margin: '8px 0 0', fontSize: 13, lineHeight: 1.5, color: colors.secondary }

const row: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
  minHeight: 44, padding: '9px 0', borderTop: `1px solid ${colors.border}`,
}

const rowName: React.CSSProperties = { fontSize: 14, fontWeight: 600, lineHeight: 1.35, color: colors.primary }

const rowMeaning: React.CSSProperties = { fontSize: 12.5, lineHeight: 1.4, color: colors.secondary }

// Account Settings -> "For you" (owner, 2026-10-31). Every item Control Center
// offers is listed for everyone: the ones that reach this person with a switch,
// the rest under "Not part of your work". Choices are stored per account, so they
// follow the person between devices. Not while previewing somebody else: their
// choices are not the admin's to read or change.
export function ForYouChoicesCard() {
  const queryClient = useQueryClient()
  const { data: userId } = useSignedInUserId()
  const { viewMode, access } = useForYouAccess()
  const modesRead = useForYouModes(!!userId)
  const choicesRead = useForYouChoices(viewMode ? null : userId)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loaded = !!modesRead.data && !!choicesRead.data
  const unreadable = modesRead.data?.failed === true || choicesRead.data?.failed === true

  // The panel's button lands here, and this card fills in after the page has.
  useEffect(() => {
    if (loaded && window.location.hash === '#for-you') {
      document.getElementById('for-you')?.scrollIntoView()
    }
  }, [loaded])

  if (viewMode) return null

  const modes = modesRead.data?.modes ?? {}
  const hidden = choicesRead.data?.hidden ?? []
  const offered = FOR_YOU_ITEMS.filter(item => modeOf(modes, item.key) !== 'off')
  const mine = offered.filter(item => itemApplies(item.key, access))
  const others = offered.filter(item => !itemApplies(item.key, access))

  const toggle = async (key: ForYouItemKey, hide: boolean) => {
    if (!userId) return
    const next = withItemHidden(hidden, key, hide)
    const before = choicesRead.data
    setError(null)
    setSaving(true)
    queryClient.setQueryData<ChoicesRead>(forYouChoicesKey(userId), { hidden: next, failed: false })
    const result = await saveForYouChoices(userId, next)
    setSaving(false)
    if (!result.ok) {
      queryClient.setQueryData(forYouChoicesKey(userId), before)
      setError('Could not save that change. Please try again.')
    }
  }

  return (
    <section id="for-you" style={card} aria-labelledby="for-you-title">
      <h2 id="for-you-title" style={{ margin: 0, fontSize: 15, fontWeight: 600, color: colors.primary, display: 'flex', alignItems: 'center', gap: 8 }}>
        <SlidersHorizontal size={16} aria-hidden /> For you
      </h2>
      <p style={note}>Choose what shows on your Modules screen. Your choices follow you on every device.</p>

      {!loaded && <p style={note}>Loading…</p>}
      {unreadable && <p role="alert" style={{ ...note, color: colors.brandInk }}>Your choices could not be loaded. Please try again later.</p>}

      {loaded && !unreadable && (
        <>
          <div style={{ marginTop: 12 }}>
            {mine.map(item => {
              const always = modeOf(modes, item.key) === 'always'
              const on = !hidden.includes(item.key)
              return (
                <div key={item.key} style={row}>
                  <div style={{ minWidth: 0 }}>
                    <div style={rowName}>{item.label}</div>
                    <div style={rowMeaning}>{item.meaning}</div>
                  </div>
                  {always ? (
                    <span style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 600, color: colors.secondary }}>
                      <Lock size={13} aria-hidden /> Always on
                    </span>
                  ) : (
                    <button
                      type="button"
                      role="switch"
                      aria-checked={on}
                      aria-label={item.label}
                      disabled={saving}
                      onClick={() => void toggle(item.key, on)}
                      style={{
                        flexShrink: 0, width: 46, height: 28, padding: 3, display: 'flex',
                        justifyContent: on ? 'flex-end' : 'flex-start',
                        background: on ? colors.primary : '#C9C3BA',
                        border: 'none', borderRadius: 999, cursor: saving ? 'default' : 'pointer',
                      }}
                    >
                      <span style={{ width: 22, height: 22, borderRadius: 999, background: '#fff' }} />
                    </button>
                  )}
                </div>
              )
            })}
          </div>

          {others.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <h3 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: colors.primary }}>Not part of your work</h3>
              <p style={{ ...note, marginTop: 2 }}>You would get these only if your access changes.</p>
              <ul style={{ margin: '8px 0 0', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
                {others.map(item => (
                  <li key={item.key} style={{ fontSize: 13, lineHeight: 1.4, color: colors.secondary }}>
                    <span style={{ fontWeight: 600 }}>{item.label}</span> · {item.forWhom}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {error && <p role="alert" style={{ ...note, color: colors.brandInk }}>{error}</p>}
    </section>
  )
}
