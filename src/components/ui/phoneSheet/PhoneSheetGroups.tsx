'use client'

import type { ReactNode } from 'react'

/**
 * WHAT GOES INSIDE A PHONE FILTER SHEET: labelled groups.
 *
 * A group is one of three kinds:
 *   - single choice: `options` with `value` and `onChange` (Sort, Date),
 *   - several at once: `options` with `multiple` (Vendors' Expertise, Area),
 *   - free content: `content`, a page's own control (a date field, a select).
 *
 * Every choice calls the page's own setter, so a filter set on a phone is the
 * same filter on a desktop.
 */

export type PhoneSheetOption = { readonly value: string; readonly label: string }

export type PhoneSheetGroup = {
  id: string
  label: string
  /** Single choice: the option shown pressed. */
  value?: string
  options?: readonly PhoneSheetOption[]
  /** Single choice: called with the option pressed. */
  onChange?: (value: string) => void
  /** Several at once: the options on, and the next set when one is pressed. */
  multiple?: {
    value: readonly string[]
    onChange: (next: string[]) => void
    /** Said in place of the options when there are none. */
    emptyText?: string
  }
  /** Free content instead of option buttons (a date field, a toggle). */
  content?: ReactNode
}

/**
 * One group. `idPrefix` names the label's id (`p3-sheet-sort`,
 * `orders-sheet-sort`) so the group is announced by its label.
 */
export function PhoneSheetGroupBlock({ group: g, idPrefix = 'p3-sheet-' }: { group: PhoneSheetGroup; idPrefix?: string }) {
  return (
    <div className="orders-sheet-group" role="group" aria-labelledby={`${idPrefix}${g.id}`}>
      <div id={`${idPrefix}${g.id}`} className="orders-sheet-label">{g.label}</div>
      {g.content ?? (
        <div className="orders-sheet-options">
          {g.multiple ? <MultiOptions options={g.options ?? []} {...g.multiple} /> : (g.options ?? []).map(o => (
            <button key={o.value} type="button" aria-pressed={g.value === o.value} onClick={() => g.onChange?.(o.value)}>
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function MultiOptions({ options, value, onChange, emptyText }: {
  options: readonly PhoneSheetOption[]
  value: readonly string[]
  onChange: (next: string[]) => void
  emptyText?: string
}) {
  return (
    <>
      {options.length === 0 && emptyText && <span className="p3-sheet-empty">{emptyText}</span>}
      {options.map(o => {
        const on = value.includes(o.value)
        return (
          <button key={o.value} type="button" aria-pressed={on}
                  onClick={() => onChange(on ? value.filter(v => v !== o.value) : [...value, o.value])}>
            {o.label}
          </button>
        )
      })}
    </>
  )
}

/** Several groups in order. */
export function PhoneSheetGroups({ groups, idPrefix }: { groups: readonly PhoneSheetGroup[]; idPrefix?: string }) {
  return <>{groups.map(g => <PhoneSheetGroupBlock key={g.id} group={g} idPrefix={idPrefix} />)}</>
}

/** A group where several options can be on at once, written as an element. */
export function PhoneMultiGroup({ id, label, options, value, onChange, emptyText, idPrefix }: {
  id: string
  label: string
  options: readonly PhoneSheetOption[]
  value: readonly string[]
  onChange: (next: string[]) => void
  emptyText?: string
  idPrefix?: string
}) {
  return <PhoneSheetGroupBlock idPrefix={idPrefix} group={{ id, label, options, multiple: { value, onChange, emptyText } }} />
}

/** A labelled block of the sheet for a page's own control (a select, a date input). */
export function PhoneSheetField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="orders-sheet-group p3-sheet-field">
      <div className="orders-sheet-label">{label}</div>
      {children}
    </div>
  )
}
