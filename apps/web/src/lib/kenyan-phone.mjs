const PHONE_INPUT_PATTERN = /^\+?[\d ()-]{9,16}$/;

export function normalizeKenyanPhone(value) {
  if (typeof value !== 'string' || !PHONE_INPUT_PATTERN.test(value)) return null;
  const digits = value.replace(/\D/g, '');
  if (/^0[17]\d{8}$/.test(digits)) return `+254${digits.slice(1)}`;
  if (/^254[17]\d{8}$/.test(digits)) return `+${digits}`;
  return null;
}
