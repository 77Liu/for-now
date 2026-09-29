export const safeText = (value, max = 12000) => String(value ?? "").trim().slice(0, max);
export const recordVersion = value => Math.max(1, Math.round(Number(value) || 1));
export const safeIso = value => {
  if (!value) return "";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
};
export const nullableNumber = (value, min = -Infinity, max = Infinity, integer = false) => {
  if (value === "" || value == null) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const bounded = Math.min(max, Math.max(min, number));
  return integer ? Math.round(bounded) : Math.round(bounded * 100) / 100;
};
export const numberOrFallback = (value, fallback, min, max, integer = false) => nullableNumber(value, min, max, integer) ?? fallback;
