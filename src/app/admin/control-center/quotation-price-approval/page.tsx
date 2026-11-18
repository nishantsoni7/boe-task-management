'use client'

import { QuotationPriceApprovalSetting } from '@/components/controlCenter/QuotationPriceApprovalSetting'
import { QuotationPaymentSetting } from '@/components/controlCenter/QuotationPaymentSetting'
import { QuotationSuggestionsSetting } from '@/components/controlCenter/QuotationSuggestionsSetting'

// Control Center › Sales › Quotation price approval (also holds the payment details printed on quotations). Admin gating is the Control Center layout's;
// quotation_price_settings_set and quotation_suggestions_set repeat it in the database for every change.
export default function ControlCenterQuotationPriceApprovalPage() {
  return (
    <>
      <QuotationPriceApprovalSetting />
      <QuotationSuggestionsSetting />
      <QuotationPaymentSetting />
    </>
  )
}
