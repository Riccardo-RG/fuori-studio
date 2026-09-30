// Presentation-only quality policy. Device names and GPU fingerprints are not needed.
export const QUALITY_PROFILES = Object.freeze({
  lite: Object.freeze({ pixelRatio: 1, maxPixels: 1_100_000, shadowSize: 0 }),
  balanced: Object.freeze({ pixelRatio: 1.5, maxPixels: 2_400_000, shadowSize: 1024 }),
  detailed: Object.freeze({ pixelRatio: 2, maxPixels: 4_000_000, shadowSize: 2048 })
});
const tiers = Object.keys(QUALITY_PROFILES);
export function createQualityController({ compact = false, cores = 0 } = {}) {
  let mode = 'auto', tier = compact && cores > 0 && cores <= 4 ? 'lite' : 'balanced';
  let samples = [], warmup = 60, stableWindows = 0, cooldown = 0;
  function reset() { samples = []; warmup = 60; stableWindows = 0; }
  return {
    get mode() { return mode; },
    get tier() { return tier; },
    get profile() { return QUALITY_PROFILES[tier]; },
    reset,
    setMode(value) {
      mode = value === 'auto' || tiers.includes(value) ? value : 'auto';
      tier = mode === 'auto' ? (compact && cores > 0 && cores <= 4 ? 'lite' : 'balanced') : mode;
      cooldown = 0; reset();
      return tier;
    },
    sample(milliseconds) {
      if (mode !== 'auto' || !Number.isFinite(milliseconds) || milliseconds <= 0) return false;
      // A suspended tab, startup compilation or a single long stall isn't a GPU benchmark.
      if (milliseconds > 180) { reset(); return false; }
      cooldown = Math.max(0, cooldown - milliseconds);
      if (warmup > 0) { warmup--; return false; }
      samples.push(milliseconds);
      if (samples.length < 90) return false;
      const mean = samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
      const slow = samples.filter(sample => sample > 29).length / samples.length;
      const p90 = samples.sort((a, b) => a - b)[Math.floor(samples.length * .9)];
      samples = [];
      if (cooldown) { stableWindows = 0; return false; }
      const index = tiers.indexOf(tier);
      let next = index;
      if (mean > 32 || slow > .4) { next = Math.max(0, index - 1); stableWindows = 0; }
      else if (mean < 18.5 && p90 < 21) { if (++stableWindows >= 2) next = Math.min(tiers.length - 1, index + 1); }
      else stableWindows = 0;
      if (next === index) return false;
      tier = tiers[next]; cooldown = 9000; stableWindows = 0;
      return true;
    }
  };
}

export function renderPixelRatio(profile, deviceRatio, width, height) {
  const ratio = Number.isFinite(deviceRatio) && deviceRatio > 0 ? deviceRatio : 1;
  return Math.max(.1, Math.min(ratio, profile.pixelRatio, Math.sqrt(profile.maxPixels / Math.max(1, width * height))));
}
