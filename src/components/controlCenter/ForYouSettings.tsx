'use client'

import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { CcSection } from './CcPrimitives'
import {
  FOR_YOU_MODES_KEY,
  saveForYouMode,
  useForYouModes,
  type ModesRead,
} from '@/hooks/queries/useForYouSettings'
import {
  FOR_YOU_ITEMS,
  FOR_YOU_MODES,
  FOR_YOU_MODE_LABEL,
  FOR_YOU_MODE_MEANING,
  modeOf,
  type ForYouItem,
  type ForYouItemKey,
  type ForYouMode,
} from '@/lib/modules/forYouCatalogue'
import styles from './forYouSettings.module.css'

// Control Center › For you (owner, 2026-10-31): what can appear in the right-hand
// column on Modules. Off, Optional or Always on, per item, saved as it is chosen
// through set_for_you_item_mode, which refuses anyone but an active administrator.
//
// Admin gating of the screen is the Control Center layout's. An item moves between
// the two lists as it is switched on or off, which is what adding one looks like.
export function ForYouSettings() {
  const queryClient = useQueryClient()
  const { data, isPending } = useForYouModes()
  const [saving, setSaving] = useState<ForYouItemKey | null>(null)
  const [error, setError] = useState<string | null>(null)
  const modes = data?.modes ?? {}
  const unreadable = data?.failed === true

  const choose = async (key: ForYouItemKey, mode: ForYouMode) => {
    const before = queryClient.getQueryData<ModesRead>(FOR_YOU_MODES_KEY)
    setError(null)
    setSaving(key)
    queryClient.setQueryData<ModesRead>(FOR_YOU_MODES_KEY, prev => ({
      failed: false,
      modes: { ...prev?.modes, [key]: mode },
    }))
    const result = await saveForYouMode(key, mode)
    setSaving(null)
    if (!result.ok) {
      queryClient.setQueryData(FOR_YOU_MODES_KEY, before)
      setError(result.message)
      return
    }
    void queryClient.invalidateQueries({ queryKey: FOR_YOU_MODES_KEY })
  }

  const row = (item: ForYouItem) => (
    <ItemRow
      key={item.key}
      item={item}
      mode={modeOf(modes, item.key as ForYouItemKey)}
      disabled={unreadable || saving !== null}
      onChoose={mode => void choose(item.key as ForYouItemKey, mode)}
    />
  )

  const offered: readonly ForYouItem[] = FOR_YOU_ITEMS.filter(item => modeOf(modes, item.key) !== 'off')
  const ready: readonly ForYouItem[] = FOR_YOU_ITEMS.filter(item => modeOf(modes, item.key) === 'off')

  return (
    <>
      <dl className={styles.legend}>
        {FOR_YOU_MODES.map(mode => (
          <div key={mode} className={styles.legendItem}>
            <dt className={styles.legendName}>{FOR_YOU_MODE_LABEL[mode]}</dt>
            <dd className={styles.legendMeaning}>{FOR_YOU_MODE_MEANING[mode]}</dd>
          </div>
        ))}
      </dl>

      {unreadable && (
        <p className={styles.error} role="alert">
          The saved settings could not be loaded, so nothing can be changed yet. What shows below are the defaults.
        </p>
      )}
      {error && <p className={styles.error} role="alert">{error}</p>}

      {isPending ? (
        <p className={styles.note}>Loading…</p>
      ) : (
        <>
          {offered.length > 0 && (
            <CcSection title="In the column">
              <ul className={styles.rows}>{offered.map(row)}</ul>
            </CcSection>
          )}
          {ready.length > 0 && (
            <CcSection title="Ready to add">
              <ul className={styles.rows}>{ready.map(row)}</ul>
            </CcSection>
          )}
        </>
      )}

      <p className={styles.note}>
        Changes reach everyone within a minute. These settings never widen access: a person only ever gets an item
        their existing access already allows.
      </p>
    </>
  )
}

function ItemRow({ item, mode, disabled, onChoose }: {
  item: ForYouItem
  mode: ForYouMode
  disabled: boolean
  onChoose: (mode: ForYouMode) => void
}) {
  return (
    <li className={styles.row}>
      <div className={styles.what}>
        <div className={styles.name}>{item.label}</div>
        <div className={styles.meaning}>{item.meaning}</div>
      </div>
      <div className={styles.audience}>{item.audience}</div>
      <span className={styles.seg} role="radiogroup" aria-label={item.label}>
        {FOR_YOU_MODES.map(option => {
          const checked = mode === option
          return (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={checked}
              disabled={disabled}
              className={checked ? `${styles.segBtn} ${styles.segChosen}` : styles.segBtn}
              onClick={() => { if (!checked) onChoose(option) }}
            >
              {FOR_YOU_MODE_LABEL[option]}
            </button>
          )
        })}
      </span>
    </li>
  )
}
