'use client'

import { createContext, useContext } from 'react'

/**
 * Whether the Orders page is ON SCREEN (2026-11-18, page speed). The Orders guard builds the page hidden while it
 * waits for the permission answer, so the page's reads start at once; this is false until the guard has said yes.
 * Anything a page does just by being opened that is more than a read (the Order page marking its updates seen)
 * waits for this, so a person the guard turns away is never marked as having seen anything.
 * Outside the Orders guard it is always true.
 */
export const OrdersShownContext = createContext(true)

export const useOrdersShown = () => useContext(OrdersShownContext)
