import { DOMAIN_ERROR_CODES, DomainError } from "@/lib/domain/errors";

export type MoneyDirham = number;

const QAR_PATTERN = /^(\d+)(?:\.(\d{1,2}))?$/;
const UNSUPPORTED_PRECISION_PATTERN = /^\d+\.\d{3,}$/;
const DIRHAM_PER_QAR = BigInt(100);
const ZERO_DIRHAM = BigInt(0);

export function parseQar(value: string): MoneyDirham {
  if (UNSUPPORTED_PRECISION_PATTERN.test(value)) {
    throw new DomainError(DOMAIN_ERROR_CODES.amountPrecision);
  }

  const match = QAR_PATTERN.exec(value);

  if (!match) {
    throw new DomainError(DOMAIN_ERROR_CODES.amountInvalid);
  }

  const wholeDirham = BigInt(match[1]);
  const fractionalDirham = BigInt((match[2] ?? "").padEnd(2, "0"));
  const dirham = wholeDirham * DIRHAM_PER_QAR + fractionalDirham;

  if (dirham > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new DomainError(DOMAIN_ERROR_CODES.amountInvalid);
  }

  return Number(dirham);
}

export function formatQar(value: MoneyDirham): string {
  if (!Number.isSafeInteger(value)) {
    throw new DomainError(DOMAIN_ERROR_CODES.amountInvalid);
  }

  const dirham = BigInt(value);
  const sign = dirham < ZERO_DIRHAM ? "-" : "";
  const absoluteDirham = dirham < ZERO_DIRHAM ? -dirham : dirham;
  const whole = absoluteDirham / DIRHAM_PER_QAR;
  const fractional = (absoluteDirham % DIRHAM_PER_QAR)
    .toString()
    .padStart(2, "0");

  return `${sign}${whole}.${fractional}`;
}
