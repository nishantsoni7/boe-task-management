'use client'

import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { LoadingScreen } from '@/components/ui/atoms'
import { useDisplaySubject } from '@/hooks/queries/useDisplaySubject'
import { canAccessManagementModule } from '@/lib/permissions/moduleVisibility'
import { ModuleShownContext } from '@/lib/moduleShown'

// THE PARENT GATE, WHEN THE MODULE LETS ITS PAGE START WHILE THE ANSWER IS ON ITS WAY (2026-11-19, page speed).
//
// This is ModuleGuard's sibling, not a replacement: ModuleGuard is untouched, and every module that does not
// opt in (by using this component in its layout) keeps ModuleGuard's rule that `children` render in no state but
// `allowed`. Orders did the same with its own guard (#897, #898); this is the general version, used by Task
// Management first.
//
// WHY. A hard load (new tab, bookmark, the first open of the day) used to go: scripts, then the guard's two
// reads (profile and permissions, 0.2 to 1.2 s), and only THEN the page mounted and started its own reads
// (another 0.3 to 0.6 s). The page's reads need nothing from the answer: every one runs as the signed-in person
// and the database refuses what they may not see, whatever the screen thinks.
//
// WHAT CHANGES, AND ONLY AT THE FIRST LOAD:
//   * Until the context has answered for the first time, the page is built HIDDEN and INERT (display none, not
//     focusable, not clickable) next to the spinner, so its reads start at once. Nothing of it is seen.
//   * Answered yes: the same page is shown, not built again (the wrapper keeps its place in the tree).
//   * Answered no, or no session: the page is removed and the spinner stays while the redirect lands, exactly as
//     ModuleGuard does. The page never appears for a frame.
//   * Anything a page does just by being opened beyond reading waits for useModuleShown().
//   * After the first answer, if the context ever goes back to "checking" (View As switching person), this
//     behaves as ModuleGuard does: the page is unmounted and the spinner shows until the new answer.
//
// THE DECISION IS THE SAME ONE. The same display subject (the signed-in user, or the viewed employee while
// previewing) and the same canAccessManagementModule that ModuleGuard and the launcher card ask. A failed
// profile read still denies (a null role fails closed).
//
// HYDRATION. The server renders only the spinner (as ModuleGuard does); the hidden page is built in the browser
// after hydration (useSyncExternalStore), so the server's HTML and the browser's first render are identical
// (React error #418 in Orders' first version, fixed in #898).

const subscribeNothing = () => () => {}

type ViewProps = {
  /** The context has answered (for the person being displayed). */
  ready: boolean
  /** The answer is yes. Only meaningful when `ready`. */
  allowed: boolean
  /** The page may be built hidden while the answer is pending: in the browser, and the first answer not yet seen. */
  buildHidden: boolean
  /** Shown instead of the spinner while the answer is pending (Sales: its static page frame). Never shown once the answer is no. */
  checking?: ReactNode
  children: ReactNode
}

/**
 * May the page be built hidden right now? Only in the browser, and only until the context has answered for the
 * first time in this mount: a later return to "checking" (View As switching person) unmounts the page, as
 * ModuleGuard does. "Answered once" is derived during render (React's "adjust state while rendering" pattern),
 * so the very render that sees `ready` also stops building hidden pages.
 */
export function useBuildHidden(ready: boolean, inBrowser: boolean): boolean {
  const [answeredOnce, setAnsweredOnce] = useState(false)
  if (ready && !answeredOnce) setAnsweredOnce(true)
  return inBrowser && !answeredOnce
}

/** The states, with no hooks of its own, so a test can drive every one. */
export function ModuleGuardStartsEarlyView({ ready, allowed, buildHidden, checking, children }: ViewProps) {
  // Answered no (or no session): the spinner, never the page or the frame. The redirect lands from the effect in the wrapper.
  if (ready && !allowed) return <LoadingScreen />
  const pending = !ready
  return (
    <ModuleShownContext.Provider value={!pending}>
      {pending && (checking ?? <LoadingScreen />)}
      {(buildHidden || !pending) && (
        <div data-module-page={pending ? 'waiting' : 'shown'} inert={pending} style={{ display: pending ? 'none' : 'contents' }}>
          {children}
        </div>
      )}
    </ModuleShownContext.Provider>
  )
}

export default function ModuleGuardStartsEarly({
  moduleKey,
  children,
  deniedRoute = '/coming-soon',
  checking,
}: {
  moduleKey: string
  children: ReactNode
  /** Where an unauthorized employee lands. Same default as ModuleGuard. */
  deniedRoute?: string
  /** What to show beside the hidden page while the answer is pending, instead of the spinner (Sales: its static frame). */
  checking?: ReactNode
}) {
  const router = useRouter()
  const inBrowser = useSyncExternalStore(subscribeNothing, () => true, () => false)

  const { ready, actorUserId: userId, subjectRole: role, subjectPermissionsByModule: permissionsByModule }
    = useDisplaySubject()

  const buildHidden = useBuildHidden(ready, inBrowser)

  const allowed =
    ready &&
    userId !== null &&
    canAccessManagementModule({
      role,
      moduleKey,
      isModuleActive: true,
      permissions: permissionsByModule.get(moduleKey) ?? [],
    })

  useEffect(() => {
    // Nothing is decided until the context has resolved: `ready` false reports a null role and an empty
    // permission map, which is indistinguishable from a genuine denial.
    if (!ready) return
    if (userId === null) { router.replace('/login'); return }
    if (!allowed) router.replace(deniedRoute)
  }, [ready, userId, allowed, router, deniedRoute])

  return (
    <ModuleGuardStartsEarlyView ready={ready} allowed={allowed} buildHidden={buildHidden} checking={checking}>
      {children}
    </ModuleGuardStartsEarlyView>
  )
}
