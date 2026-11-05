'use client'

import { useState, type ReactNode } from 'react'
import { BottomSheet, SheetTrigger } from './BottomSheet'
import { PhoneSheetGroups, type PhoneSheetGroup } from './PhoneSheetGroups'

/**
 * A BUTTON THAT OPENS A BOTTOM SHEET (phones): "Filter" on Confirmed Orders,
 * Sales, Vendors and Reviews, "Filter" and "Download" on the Attendance pages.
 * The sheet holds option groups (`groups`), then anything the page passes as
 * children (a date field, a select, download buttons), then one footer button
 * whose words the page gives.
 *
 * The classes are the caller's, so each list keeps the look it had:
 * `triggerClassName` (`orders-phone-filter` plus, say, `boe-phone-only p3-filter`)
 * and `sheetClassName` (`orders-sheet` plus, say, `p3-sheet`).
 */
export function PhoneSheetButton({
  label, icon, badge = 0, ariaLabel, title, doneLabel = 'Done', onDone, onClearAll,
  groups = [], groupIdPrefix, children, initiallyOpen = false,
  triggerClassName, className, sheetClassName,
}: {
  /** The trigger's words, e.g. "Filter". */
  label: string
  icon?: ReactNode
  /** How many settings inside are set; drawn as a count on the trigger. */
  badge?: number
  /** The trigger's name for a screen reader, if not its words. */
  ariaLabel?: string
  /** The sheet's heading, e.g. "Filter and sort". */
  title: string
  /** The footer button: "Show 12 leads", "Search", "Done". */
  doneLabel?: ReactNode
  /** Runs when the footer button is pressed, before the sheet closes (e.g. Search). */
  onDone?: () => void
  /** Offered as "Clear all" in the sheet's head when given. */
  onClearAll?: () => void
  groups?: readonly PhoneSheetGroup[]
  /** The id prefix of the groups' labels; `p3-sheet-` by default. */
  groupIdPrefix?: string
  /** The page's own controls, after the groups. */
  children?: ReactNode
  /** Tests only: draw the sheet open. */
  initiallyOpen?: boolean
  /** The trigger's look; `orders-phone-filter` by default. */
  triggerClassName?: string
  /** Added to the trigger after `is-set`. */
  className?: string
  /** The panel's classes; `orders-sheet` by default. */
  sheetClassName?: string
}) {
  const [open, setOpen] = useState(initiallyOpen)

  return (
    <>
      <SheetTrigger
        label={label}
        icon={icon}
        badge={badge}
        ariaLabel={ariaLabel}
        open={open}
        onOpen={() => setOpen(true)}
        baseClassName={triggerClassName}
        className={className}
      />
      {open && (
        <BottomSheet
          title={title}
          onClose={() => setOpen(false)}
          onClearAll={onClearAll}
          doneLabel={doneLabel}
          onDone={onDone}
          className={sheetClassName}
        >
          <PhoneSheetGroups groups={groups} idPrefix={groupIdPrefix} />
          {children}
        </BottomSheet>
      )}
    </>
  )
}
