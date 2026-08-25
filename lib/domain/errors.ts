export const DOMAIN_ERROR_CODES = {
  amountInvalid: "AMOUNT_INVALID",
  amountPrecision: "AMOUNT_PRECISION",
  customerRequired: "CUSTOMER_REQUIRED",
  duplicateInvoice: "DUPLICATE_INVOICE",
  overpaymentApprovalRequired: "OVERPAYMENT_APPROVAL_REQUIRED",
  overpaymentCustomerRequired: "OVERPAYMENT_CUSTOMER_REQUIRED",
} as const;

export type DomainErrorCode =
  (typeof DOMAIN_ERROR_CODES)[keyof typeof DOMAIN_ERROR_CODES];

export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode) {
    super(code);
    this.name = "DomainError";
    this.code = code;
  }
}
