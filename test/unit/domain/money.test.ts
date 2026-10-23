import { describe, expect, test } from 'bun:test';
import {
  CurrencyMismatchError,
  InvalidMoneyError,
  Money,
  UnsupportedCurrencyError,
} from '../../../src/domain/money/money';

const supported = new Set(['BRL', 'USD', 'EUR']);
const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' }, supported);

describe('Money.from', () => {
  test.each(['0.00', '25.00', '999999999999999.99'])('accepts %p', (amount) => {
    expect(brl(amount).toJSON()).toEqual({ amount, currency: 'BRL' });
  });

  test.each([
    '',
    '25',
    '25.5',
    '25.555',
    '0.005',
    '1e3',
    'NaN',
    'Infinity',
    '-1.00',
    '+1.00',
    ' 1.00',
    '01.00',
    '1000000000000000.00',
  ])('rejects %p without rounding', (amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  test.each(['brl', 'XYZ'])('rejects unsupported currency %p', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency }, supported)).toThrow(UnsupportedCurrencyError);
  });

  test('rejects non-string amounts coming from untrusted input', () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' }, supported)).toThrow(
      InvalidMoneyError,
    );
  });
});

describe('Money arithmetic', () => {
  test('adds cents exactly', () => {
    expect(brl('0.10').add(brl('0.20')).equals(brl('0.30'))).toBe(true);
  });

  test('subtracts into negative values internally', () => {
    const result = brl('10.00').subtract(brl('25.50'));
    expect(result.isNegative()).toBe(true);
    expect(result.toJSON()).toEqual({ amount: '-15.50', currency: 'BRL' });
  });

  test('negates', () => {
    expect(Money.ofMinor(-2550n, 'BRL').negate().toJSON()).toEqual({ amount: '25.50', currency: 'BRL' });
  });

  test('formats single-digit cents with fixed scale', () => {
    expect(Money.ofMinor(5n, 'BRL').toJSON().amount).toBe('0.05');
    expect(Money.ofMinor(-5n, 'BRL').toJSON().amount).toBe('-0.05');
  });

  test('refuses to mix currencies', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' }, supported);
    expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
    expect(brl('1.00').equals(usd)).toBe(false);
  });

  test('is immutable', () => {
    const a = brl('10.00');
    a.add(brl('5.00'));
    a.negate();
    expect(a.toJSON().amount).toBe('10.00');
  });

  test('exposes sign and ordering predicates', () => {
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('1.00').isLessThan(brl('1.01'))).toBe(true);
    expect(brl('1.01').isLessThan(brl('1.00'))).toBe(false);
    expect(brl('12.34').toMinor()).toBe(1234n);
    expect(brl('12.34').toString()).toBe('12.34 BRL');
  });
});
