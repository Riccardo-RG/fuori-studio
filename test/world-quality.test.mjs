import test from 'node:test';
import assert from 'node:assert/strict';
import { createQualityController, renderPixelRatio, QUALITY_PROFILES } from '../dist/world-quality.js';

test('adaptive quality responds to sustained load and recovers with hysteresis', () => {
  const quality = createQualityController();
  assert.equal(quality.tier, 'balanced');
  for (let i = 0; i < 151; i++) quality.sample(40);
  assert.equal(quality.tier, 'lite');
  for (let i = 0; i < 100; i++) quality.sample(16);
  assert.equal(quality.tier, 'lite', 'a brief recovery must not oscillate tiers');
  for (let i = 0; i < 1000; i++) quality.sample(16);
  assert.notEqual(quality.tier, 'lite');
});

test('manual overrides stay fixed, background gaps and invalid samples do not degrade', () => {
  const quality = createQualityController();
  quality.setMode('detailed');
  for (let i = 0; i < 300; i++) quality.sample(80);
  assert.equal(quality.tier, 'detailed');
  quality.setMode('auto');
  for (let i = 0; i < 200; i++) quality.sample(i % 2 ? 1200 : NaN);
  assert.equal(quality.tier, 'balanced');
  quality.setMode('invalid');
  assert.equal(quality.mode, 'auto');
});

test('large Retina canvases respect pixel budgets while small displays retain crisp resolution', () => {
  const ratio = renderPixelRatio(QUALITY_PROFILES.balanced, 3, 2560, 1440);
  assert.ok(2560 * 1440 * ratio * ratio <= 2_400_001);
  const largeDisplay = renderPixelRatio(QUALITY_PROFILES.lite, 2, 3840, 2160);
  assert.ok(3840 * 2160 * largeDisplay * largeDisplay <= 1_100_001);
  assert.equal(renderPixelRatio(QUALITY_PROFILES.detailed, 2, 800, 600), 2);
  assert.equal(createQualityController({compact: true, cores: 4}).tier, 'lite');
});
