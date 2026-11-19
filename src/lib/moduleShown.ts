'use client'

import { createContext, useContext } from 'react'

/**
 * Whether the page is ON SCREEN (2026-11-19, page speed). ModuleGuardStartsEarly builds the page hidden while it
 * waits for the permission answer, so the page's reads start at once; this is false until the guard has said yes.
 * Anything a page does just by being opened that is more than a read (the once-per-session "app open" ping, a form
 * that takes focus when it appears) waits for this, so a person the guard turns away is never recorded as having
 * opened anything and a field is never "focused" while nobody can see it.
 * Outside that guard it is always true.
 */
export const ModuleShownContext = createContext(true)

export const useModuleShown = () => useContext(ModuleShownContext)
