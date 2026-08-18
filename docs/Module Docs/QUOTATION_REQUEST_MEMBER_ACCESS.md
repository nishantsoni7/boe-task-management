# Quotation Request Member Access

Last updated: 18 August 2026

Quotation Request is an employee-specific protected action inside Task Management.

## Administrator workflow

1. Open **Control Center → Access Control**.
2. Select the employee.
3. Open **Task Management → Custom**.
4. Set **Submit Quotation Requests** to **Allow** and save.

The system automatically enables the required Task Management entry and quotation-view permissions. Removing either required permission also removes the stronger submission permission, so Access Control cannot save a grant that has no visible effect.

## Employee result

An enabled employee can:

- see the **Quotation Request** submission option;
- open the quotation register;
- submit a request to the configured quotation owner;
- see only requests they created or were assigned.

The existing task ownership policies remain the row boundary. The employee does not receive company-wide quotation access.

## Approval notification

The quotation owner uses the existing **Mark Quotation Complete** action after preparing or approving the request. That status change sends the existing notification to the requester. No second approval state or duplicate notification workflow was added.
