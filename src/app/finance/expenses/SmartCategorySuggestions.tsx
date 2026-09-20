'use client'

// ── "Smart suggestion" — three chips under the category picker ──────────────
//
// THE NAME ON THE SCREEN IS "Smart suggestion", and that is a deliberate,
// literal choice. There is no model behind this, no hosted inference, no API
// key and no network call: suggestCategories is string comparison over the
// company's own finalized expenses, running in this browser. Nothing here says
// or implies AI, because claiming it would be false.
//
// IT SUGGESTS AND NOTHING ELSE. No chip is pre-selected, no category is created,
// nothing is written. A suggestion is a tap the person can ignore — the ordinary
// picker beside it still offers every active category, and the form is exactly
// as usable with the suggestions switched off.
//
// WHEN IT SAYS NOTHING. Nothing typed, nothing matched, or a category already
// chosen: the panel disappears rather than filling the space with its best bad
// guess. An empty form deliberately produces no suggestions at all — offering
// the three most-used categories to somebody who has typed nothing is exactly
// the "most frequently used wins" failure this is built to avoid.

import { useMemo } from 'react'
import { Plus, Sparkles } from 'lucide-react'
import { colors } from '@/lib/tokens'
import type { ExpenseCategory } from '@/lib/finance/expenses'
import {
  suggestCategories,
  type ExpenseHistoryEntry,
} from '@/lib/finance/expenseCategoryMatch'

export const SMART_SUGGESTION_LABEL = 'Smart suggestion'
export const SUGGESTED_NEW_CATEGORY_LABEL = 'Suggested new category'

export function SmartCategorySuggestions({
  paidTo, purpose, categories, history, selectedCategoryId, disabled,
  onPick, onProposeNew,
}: {
  paidTo: string
  /** The purpose/remark field. Weighted ABOVE the payee — see the matcher. */
  purpose: string
  categories: readonly ExpenseCategory[]
  /** Finalized, non-deleted expenses. The matcher re-applies that rule itself. */
  history: readonly ExpenseHistoryEntry[]
  selectedCategoryId: string
  disabled?: boolean
  onPick: (categoryId: string) => void
  /** Opens the Add-category dialog prefilled. It does NOT create anything. */
  onProposeNew: (name: string) => void
}) {
  const result = useMemo(
    () => suggestCategories({ paidTo, purpose }, categories, history),
    [paidTo, purpose, categories, history],
  )

  // A CATEGORY IS ALREADY CHOSEN. The question has been answered, so the panel
  // goes rather than second-guessing a deliberate choice.
  if (selectedCategoryId !== '') return null
  if (result.suggestions.length === 0 && result.newCategory === null) return null

  return (
    <div
      data-testid="smart-category-suggestions"
      style={{
        display: 'flex', flexDirection: 'column', gap: '8px',
        padding: '10px 12px', borderRadius: '10px',
        border: `1px solid ${colors.border}`, background: colors.raised,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <Sparkles size={13} strokeWidth={2} color={colors.muted} aria-hidden="true" />
        <span style={{
          fontSize: '10.5px', fontWeight: 700, color: colors.muted,
          textTransform: 'uppercase', letterSpacing: '0.06em',
        }}>
          {SMART_SUGGESTION_LABEL}
        </span>
      </div>

      {result.suggestions.length > 0 && (
        <>
          {/* Strongest first. Each chip carries its own reason, because a
              suggestion somebody cannot check is one they either trust blindly
              or ignore, and neither is useful. */}
          <div
            role="group"
            aria-label="Suggested categories"
            style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}
          >
            {result.suggestions.map((s, index) => (
              <button
                key={s.categoryId}
                type="button"
                disabled={disabled}
                onClick={() => onPick(s.categoryId)}
                data-suggestion-rank={index}
                aria-label={`Use category ${s.categoryName} — ${s.reasonText}`}
                className="boe-btn"
                style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '2px',
                  minHeight: '44px', padding: '6px 12px', textAlign: 'left',
                  background: colors.base,
                  border: `1px solid ${index === 0 ? colors.borderSoft : colors.border}`,
                }}
              >
                <span style={{ fontSize: '13px', fontWeight: 600, color: colors.primary }}>
                  {s.categoryName}
                </span>
                <span style={{ fontSize: '10.5px', color: colors.muted, lineHeight: 1.4 }}>
                  {s.reasonText}
                </span>
              </button>
            ))}
          </div>
          <div style={{ fontSize: '10.5px', color: colors.muted, lineHeight: 1.5 }}>
            Suggested from earlier expenses. Pick any other category if none fits.
          </div>
        </>
      )}

      {/* ── A CATEGORY THAT DOES NOT EXIST YET ──
          Offered ONLY when nothing existing matched. The near-misses come
          FIRST, deliberately: the commonest way an expense log becomes
          unusable is a new category created beside one that would have done. */}
      {result.newCategory && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
          {result.newCategory.similar.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
              <span style={{ fontSize: '11px', color: colors.tertiary, lineHeight: 1.5 }}>
                {result.newCategory.reasonText} Similar existing categories:
              </span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                {result.newCategory.similar.map(c => (
                  <button
                    key={c.categoryId}
                    type="button"
                    disabled={disabled}
                    onClick={() => onPick(c.categoryId)}
                    className="boe-btn boe-btn-ghost"
                    style={{ minHeight: '38px', padding: '5px 11px', fontSize: '12px' }}
                  >
                    {c.categoryName}
                  </button>
                ))}
              </div>
            </div>
          )}
          {result.newCategory.similar.length === 0 && (
            <span style={{ fontSize: '11px', color: colors.tertiary, lineHeight: 1.5 }}>
              {result.newCategory.reasonText}
            </span>
          )}

          <div style={{
            display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
            paddingTop: '6px', borderTop: `1px dashed ${colors.border}`,
          }}>
            <span style={{
              fontSize: '10px', fontWeight: 700, color: colors.muted,
              textTransform: 'uppercase', letterSpacing: '0.06em',
            }}>
              {SUGGESTED_NEW_CATEGORY_LABEL}
            </span>
            {/* A SEPARATE, DELIBERATE TAP. This opens the Add-category dialog
                with the name filled in; it creates nothing on its own, and the
                dialog still has its own Save. */}
            <button
              type="button"
              disabled={disabled}
              onClick={() => onProposeNew(result.newCategory!.name)}
              className="boe-btn boe-btn-ghost"
              style={{ minHeight: '40px', padding: '6px 12px', fontSize: '12.5px' }}
            >
              <Plus size={13} strokeWidth={2} style={{ verticalAlign: '-2px', marginRight: '5px' }} />
              Add &ldquo;{result.newCategory.name}&rdquo;
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
