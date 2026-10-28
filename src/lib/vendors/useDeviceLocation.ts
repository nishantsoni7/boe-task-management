'use client'

import { useCallback, useEffect, useState } from 'react'

// Where the phone says it is. Asked once when `enabled` turns on (the browser shows its own permission prompt),
// and again whenever the person taps "Try again". The answer always arrives through a callback, so nothing is set
// while rendering. A denied or failed request is a plain, honest state ("unavailable"), never a silent guess.

export type DeviceLocation =
  | { state: 'asking' }
  | { state: 'ok'; latitude: number; longitude: number; accuracy: number }
  | { state: 'unavailable'; reason: string }

export function useDeviceLocation(enabled: boolean): { where: DeviceLocation; retry: () => void } {
  const [where, setWhere] = useState<DeviceLocation>({ state: 'asking' })

  const request = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      queueMicrotask(() => setWhere({ state: 'unavailable', reason: 'This phone does not share its location.' }))
      return
    }
    navigator.geolocation.getCurrentPosition(
      pos => setWhere({
        state: 'ok', latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: Math.round(pos.coords.accuracy),
      }),
      err => setWhere({
        state: 'unavailable',
        reason: err.code === err.PERMISSION_DENIED
          ? 'Location is switched off for this site. Allow it in the browser settings.'
          : 'The phone could not find its location.',
      }),
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 },
    )
  }, [])

  useEffect(() => { if (enabled) request() }, [enabled, request])

  const retry = useCallback(() => { setWhere({ state: 'asking' }); request() }, [request])
  return { where, retry }
}
