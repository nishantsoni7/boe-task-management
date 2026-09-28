'use client'

// The fallback shown by src/app/error.tsx and src/app/global-error.tsx.
// Wording and rules: src/lib/errors/routeError.ts.

import { useEffect } from 'react'
import { ROUTE_ERROR_COPY, classifyRouteError, safeDigest } from '@/lib/errors/routeError'

export function RouteErrorView({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const kind = classifyRouteError(error)
  const copy = ROUTE_ERROR_COPY[kind]
  const digest = safeDigest(error?.digest)

  // A boundary-caught error never reaches window 'error' listeners on its own.
  // reportError dispatches it there (and to the console), so the page-error
  // evidence recorder, where present, sees it like any uncaught error.
  useEffect(() => {
    try { window.reportError?.(error) } catch { /* reporting must never break the fallback */ }
  }, [error])

  const reload = () => window.location.reload()
  const button = {
    minHeight: 44, padding: '0 18px', borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: 'pointer',
  } as const
  const primary = { ...button, background: '#111318', color: '#fff', border: '1px solid #111318' }
  const secondary = { ...button, background: '#fff', color: '#111318', border: '1px solid rgba(0,0,0,0.15)' }

  return (
    <main
      role="alert"
      data-testid={`route-error-${kind}`}
      style={{
        minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16, background: '#F4F5F7', fontFamily: 'var(--font-body, DM Sans, system-ui, sans-serif)',
      }}
    >
      <div style={{
        width: '100%', maxWidth: 440, background: '#fff', border: '1px solid rgba(0,0,0,0.08)',
        borderRadius: 16, padding: '28px 24px', boxShadow: '0 4px 24px rgba(0,0,0,0.06)',
      }}>
        <h1 style={{ fontSize: 20, margin: '0 0 8px', color: '#111318' }}>{copy.title}</h1>
        <p style={{ fontSize: 14, lineHeight: 1.5, margin: '0 0 20px', color: '#4A5261' }}>{copy.body}</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {copy.primary === 'reload'
            ? <button type="button" style={primary} onClick={reload}>Reload</button>
            : <button type="button" style={primary} onClick={retry}>Try again</button>}
          {copy.primary === 'retry' && <button type="button" style={secondary} onClick={reload}>Reload page</button>}
          {/* A plain link: a full load of a known-good page, whatever state the router is in. */}
          <a href="/modules" style={{ ...secondary, display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }}>
            Go to Modules
          </a>
        </div>
        {digest && (
          <p style={{ fontSize: 12, color: '#8A909C', margin: '16px 0 0' }}>Reference: {digest}</p>
        )}
      </div>
    </main>
  )
}
