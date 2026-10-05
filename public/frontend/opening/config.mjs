export const OPENING_DESIGN_VERSION = "R9.4-F1";

export const RAIN_LIMITS = Object.freeze({
  density: Object.freeze([0, 10]),
  trailPercent: Object.freeze([0, 100]),
  dropSize: Object.freeze([2, 14]),
  trailWidth: Object.freeze([2, 22]),
  speed: Object.freeze([15, 180]),
  bend: Object.freeze([0, 100]),
  splash: Object.freeze([0, 10]),
  trailLife: Object.freeze([1, 18]),
  beadLife: Object.freeze([2, 25]),
  contrast: Object.freeze([20, 140]),
  slideDelay: Object.freeze([0, 250]),
  slideLength: Object.freeze([60, 400])
});

export const RAIN_DEFAULTS = Object.freeze({
  density: 3.5,
  trailPercent: 60,
  dropSize: 7.5,
  trailWidth: 12,
  speed: 85,
  bend: 80,
  splash: 5,
  trailLife: 4,
  beadLife: 9,
  contrast: 119,
  slideDelay: 50,
  slideLength: 145,
  protectBrand: false
});

export const OPENING_DEFAULTS = Object.freeze({
  designVersion: OPENING_DESIGN_VERSION,
  schemaVersion: 1,
  enabled: true,
  showBrand: true,
  config: RAIN_DEFAULTS
});

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

function finiteNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function validateRainConfig(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const config = {};
  for (const [key, [minimum, maximum]] of Object.entries(RAIN_LIMITS)) {
    const candidate = finiteNumber(source[key]);
    config[key] = candidate === null
      ? RAIN_DEFAULTS[key]
      : clamp(candidate, minimum, maximum);
  }
  config.protectBrand = typeof source.protectBrand === "boolean"
    ? source.protectBrand
    : RAIN_DEFAULTS.protectBrand;
  return Object.freeze(config);
}

export function validateOpeningConfig(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const rainSource = source.config && typeof source.config === "object"
    ? source.config
    : source;
  return Object.freeze({
    designVersion: OPENING_DESIGN_VERSION,
    schemaVersion: OPENING_DEFAULTS.schemaVersion,
    enabled: typeof source.enabled === "boolean" ? source.enabled : OPENING_DEFAULTS.enabled,
    showBrand: typeof source.showBrand === "boolean" ? source.showBrand : OPENING_DEFAULTS.showBrand,
    config: validateRainConfig(rainSource)
  });
}
