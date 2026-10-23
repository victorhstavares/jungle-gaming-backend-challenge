/** Every supported currency uses two decimal places; amounts are stored in minor units. */
export const MONEY_SCALE = 2;
export const MINOR_UNITS_PER_MAJOR = 100n;

const CURRENCY_CODE = /^[A-Z]{3}$/;

export function isCurrencyCode(value: string): boolean {
  return CURRENCY_CODE.test(value);
}
