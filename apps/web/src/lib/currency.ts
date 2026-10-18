export const PLATFORM_CURRENCY = {
  code: 'KES',
  name: 'Kenyan Shilling',
  symbol: 'KSh',
  locale: 'en-KE',
  decimalPlaces: 0,
} as const;

export function formatMoney(amount: number): string {
  if (!Number.isSafeInteger(amount)) {
    throw new RangeError('KES amounts must be safe whole numbers.');
  }
  const formatted = new Intl.NumberFormat(PLATFORM_CURRENCY.locale, {
    minimumFractionDigits: PLATFORM_CURRENCY.decimalPlaces,
    maximumFractionDigits: PLATFORM_CURRENCY.decimalPlaces,
  }).format(amount);
  return `${PLATFORM_CURRENCY.symbol} ${formatted}`;
}