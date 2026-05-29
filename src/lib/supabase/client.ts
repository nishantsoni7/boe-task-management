import { createBrowserClient } from '@supabase/ssr'

// ─── SINGLETON FIX ────────────────────────────────────────────────────────────
// Previously: createClient() called createBrowserClient() unconditionally and
// returned a brand-new client instance on every call.
//
// Every page does:  const supabase = useMemo(() => createClient(), [])
// useMemo prevents recreation within ONE component instance across re-renders,
// but a fresh component mount (every page navigation) calls createClient() again
// → a new client instance, a new auth state subscriber, duplicated token refresh
// logic, and duplicated GoTrue internal state.
//
// The login page is worse — it calls createClient() inside the click handler:
//   const supabase = createClient()  ← inside handleLogin()
// That creates a new instance on every sign-in attempt.
//
// Fix: module-level variable holds the single instance. After the first call,
// every subsequent call to createClient() returns the same object — zero cost.
//
// Note: @supabase/ssr >= 0.0.10 has internal singleton behaviour in
// createBrowserClient, but it is not guaranteed and not documented as stable.
// This explicit guard makes the behaviour certain regardless of package version.

let _client: ReturnType<typeof createBrowserClient> | null = null

export function createClient() {
  if (!_client) {
    _client = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    )
  }
  return _client
}
