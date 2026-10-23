import { DomainError } from '../shared/domain-error';
import { MINOR_UNITS_PER_MAJOR, MONEY_SCALE, isCurrencyCode } from './currency';

export interface MoneyProps {
  amount: string;
  currency: string;
}

export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';
}

export class UnsupportedCurrencyError extends DomainError {
  readonly code = 'UNSUPPORTED_CURRENCY';
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';
}

// Up to 15 integer digits keeps any single amount far below the bigint column limit.
const AMOUNT_PATTERN = /^(0|[1-9][0-9]{0,14})\.([0-9]{2})$/;

export class Money {
  private constructor(
    private readonly minor: bigint,
    public readonly currency: string,
  ) {}

  /** Parses a contract amount, a non-negative decimal string with exactly two decimals. Other input throws; nothing is rounded. */
  static from(props: MoneyProps, supportedCurrencies: ReadonlySet<string>): Money {
    if (!supportedCurrencies.has(props.currency)) {
      throw new UnsupportedCurrencyError(`Unsupported currency: ${props.currency}`);
    }
    const match = typeof props.amount === 'string' ? AMOUNT_PATTERN.exec(props.amount) : null;
    if (match === null) {
      throw new InvalidMoneyError(`Invalid amount: expected a decimal string with ${MONEY_SCALE} decimals`);
    }
    const [, units = '0', cents = '00'] = match;
    return new Money(BigInt(units) * MINOR_UNITS_PER_MAJOR + BigInt(cents), props.currency);
  }

  static ofMinor(minor: bigint, currency: string): Money {
    if (!isCurrencyCode(currency)) {
      throw new UnsupportedCurrencyError(`Invalid currency code: ${currency}`);
    }
    return new Money(minor, currency);
  }

  static zero(currency: string): Money {
    return Money.ofMinor(0n, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor + other.minor, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor - other.minor, this.currency);
  }

  negate(): Money {
    return new Money(-this.minor, this.currency);
  }

  isZero(): boolean {
    return this.minor === 0n;
  }

  isPositive(): boolean {
    return this.minor > 0n;
  }

  isNegative(): boolean {
    return this.minor < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor < other.minor;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minor === other.minor;
  }

  toMinor(): bigint {
    return this.minor;
  }

  toJSON(): MoneyProps {
    const sign = this.minor < 0n ? '-' : '';
    const abs = this.minor < 0n ? -this.minor : this.minor;
    const units = abs / MINOR_UNITS_PER_MAJOR;
    const cents = (abs % MINOR_UNITS_PER_MAJOR).toString().padStart(MONEY_SCALE, '0');
    return { amount: `${sign}${units.toString()}.${cents}`, currency: this.currency };
  }

  toString(): string {
    const { amount, currency } = this.toJSON();
    return `${amount} ${currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(`Currency mismatch: ${this.currency} vs ${other.currency}`);
    }
  }
}
