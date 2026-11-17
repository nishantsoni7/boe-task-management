'use client'

import { QuotationPriceApprovalSetting } from '@/components/controlCenter/QuotationPriceApprovalSetting'
import { QuotationSuggestionsSetting } from '@/components/controlCenter/QuotationSuggestionsSetting'

// Control Center › Sales › Quotation price approval. Admin gating is the Control Center layout's;
// quotation_price_settings_set and quotation_suggestions_set repeat it in the database for every change.
export default function ControlCenterQuotationPriceApprovalPage() {
  return (
    <>
      <QuotationPriceApprovalSetting />
      <QuotationSuggestionsSetting />
    </>
  )
}
