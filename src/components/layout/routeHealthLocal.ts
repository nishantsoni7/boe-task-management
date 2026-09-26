// The device's own copy of its route-health reports (see LOCAL_EVIDENCE_* in
// src/lib/telemetry/routeHealth.ts for why). Only reports that have already
// passed the whitelist are stored, and they are re-validated when read back.
// Nothing here leaves the device; /diagnostics shows it for copying by hand.

import {
  LOCAL_EVIDENCE_KEY, appendLocalEvidence, readLocalEvidence, type RouteHealthReport, type StoredReport,
} from '@/lib/telemetry/routeHealth'

function stored(): unknown {
  try { return JSON.parse(localStorage.getItem(LOCAL_EVIDENCE_KEY) ?? '[]') } catch { return [] }
}

export function keepLocally(report: RouteHealthReport): void {
  try { localStorage.setItem(LOCAL_EVIDENCE_KEY, JSON.stringify(appendLocalEvidence(stored(), report, new Date()))) } catch { /* best-effort */ }
}

export function readLocally(): StoredReport[] {
  return readLocalEvidence(stored())
}

export function clearLocally(): void {
  try { localStorage.removeItem(LOCAL_EVIDENCE_KEY) } catch { /* best-effort */ }
}
