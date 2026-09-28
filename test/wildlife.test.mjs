import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../dist/vendor/three.module.js';
import { createWildlife, getEncounterStage } from '../dist/wildlife.js';

function fixture(t) {
  const scene = new THREE.Scene();
  const wildlife = createWildlife(scene);
  t.after(() => wildlife.dispose());
  return { scene, wildlife };
}
function advance(wildlife, frames = 1, quiet = false) {
  for (let frame = 0; frame < frames; frame++) wildlife.update(frame * .05, .05, { quiet });
}
function resources(scene) {
  const geometries = new Set(), materials = new Set(); let meshes = 0;
  scene.traverse(item => { if (item.isMesh) { meshes++; geometries.add(item.geometry); for (const material of Array.isArray(item.material) ? item.material : [item.material]) materials.add(material); } });
  return { geometries, materials, meshes };
}

test('each landscape has distinct recognizable species and reuses bounded scene resources', t => {
  const { scene, wildlife } = fixture(t);
  const initial = resources(scene);
  const expected = { forest: ['squirrel', 'bird'], beach: ['crab', 'turtle'], mountain: ['marmot', 'ibex'] };
  for (const [theme, species] of Object.entries(expected)) {
    wildlife.setLandscape(theme); wildlife.setActivity({ load: .8 }); advance(wildlife, 20);
    const diagnostics = wildlife.getDiagnostics();
    for (const kind of species) assert.ok(diagnostics.animalsBySpecies[kind] > 0);
    assert.ok(diagnostics.activeAnimals >= 4 && diagnostics.activeAnimals < 20);
    assert.equal(diagnostics.phase, 'idle'); assert.equal(diagnostics.problemKey, null);
  }
  assert.equal(wildlife.getDiagnostics().landscape, 'mountains');
  wildlife.setLandscape('unsupported-landscape');
  assert.equal(wildlife.getDiagnostics().landscape, 'mountains');
  const final = resources(scene);
  assert.equal(final.meshes, initial.meshes); assert.deepEqual(final.geometries, initial.geometries); assert.deepEqual(final.materials, initial.materials);
});

test('one stable failure drives the complete ant encounter and repeated polls do not respawn it', t => {
  const { wildlife } = fixture(t);
  wildlife.setActivity({ load: .7, problemKey: 'task:failed:one' });
  const phases = [];
  for (let frame = 0; frame < 1000; frame++) {
    wildlife.setActivity({ load: frame % 2 ? .2 : .8, problemKey: 'task:failed:one' });
    advance(wildlife);
    const state = wildlife.getDiagnostics();
    if (phases.at(-1) !== state.phase) phases.push(state.phase);
    assert.equal(state.eventCount, 1);
    if (state.phase === 'carry') {
      assert.ok(state.carriedPieces > 0);
      assert.ok(state.defenders > 0 && state.defenders <= 32);
      assert.ok(wildlife.getAntTarget().x < state.target.x, 'Cargo moves toward the western nest');
    }
  }
  assert.deepEqual(phases, ['approach', 'attack', 'feeding', 'carry', 'den', 'alert']);
  assert.equal(wildlife.getAntTarget(), null);
  wildlife.setActivity({ load: 0, problemKey: null });
  assert.equal(wildlife.getDiagnostics().phase, 'idle'); assert.equal(wildlife.getDiagnostics().defenders, 0);
  wildlife.setActivity({ load: 0, problemKey: 'task:failed:one' });
  assert.equal(wildlife.getDiagnostics().eventCount, 1); assert.equal(wildlife.getDiagnostics().phase, 'alert');
  wildlife.setActivity({ load: 0, problemKey: 'task:failed:two' });
  assert.equal(wildlife.getDiagnostics().eventCount, 2); assert.equal(wildlife.getDiagnostics().phase, 'approach');
});

test('quiet mode freezes an encounter and animal transforms while retaining the selected night state', t => {
  const { scene, wildlife } = fixture(t);
  wildlife.setLandscape('forest'); wildlife.setNight(true); wildlife.setActivity({ load: 1, problemKey: 'provider:error' }); advance(wildlife, 50);
  const poses = () => {
    const values = [];
    scene.traverse(item => { values.push(...item.position.toArray(), ...item.rotation.toArray().slice(0, 3)); if (item.isInstancedMesh) values.push(...item.instanceMatrix.array); });
    return values;
  };
  const before = wildlife.getDiagnostics(), beforePoses = poses();
  advance(wildlife, 100, true);
  const frozen = wildlife.getDiagnostics();
  assert.equal(frozen.night, true); assert.equal(frozen.quiet, true);
  assert.equal(frozen.elapsed, before.elapsed); assert.equal(frozen.eventElapsed, before.eventElapsed); assert.equal(frozen.load, before.load);
  assert.deepEqual(poses(), beforePoses);
  advance(wildlife, 2, false);
  assert.ok(wildlife.getDiagnostics().eventElapsed > before.eventElapsed);
});

test('real workload raises movement activity without creating an error encounter', t => {
  const calm = fixture(t), busy = fixture(t);
  for (const entry of [calm, busy]) entry.wildlife.setLandscape('forest');
  calm.wildlife.setActivity({ load: 0 }); busy.wildlife.setActivity({ load: 1 });
  const distance = [0, 0], entries = [calm, busy];
  const previous = entries.map(({ scene }) => scene.getObjectByName('forest-squirrel-0').position.clone());
  for (let frame = 0; frame < 240; frame++) entries.forEach(({ wildlife, scene }, index) => {
    advance(wildlife);
    const current = scene.getObjectByName('forest-squirrel-0').position;
    distance[index] += current.distanceTo(previous[index]); previous[index].copy(current);
  });
  assert.ok(distance[1] > distance[0] * 1.5, 'Higher actual activity makes gathering animals more active');
  assert.ok(busy.wildlife.getDiagnostics().load > .95); assert.equal(calm.wildlife.getDiagnostics().load, 0);
  assert.equal(busy.wildlife.getDiagnostics().eventCount, 0); assert.equal(busy.wildlife.getDiagnostics().phase, 'idle');
});

test('disposal releases owned rendering resources once and preserves unrelated scene objects', t => {
  const { scene, wildlife } = fixture(t);
  const external = new THREE.Group(); scene.add(external);
  const { geometries, materials } = resources(scene), counts = new Map();
  for (const resource of [...geometries, ...materials]) { counts.set(resource, 0); resource.addEventListener('dispose', () => counts.set(resource, counts.get(resource) + 1)); }
  wildlife.dispose(); wildlife.dispose();
  wildlife.update(20, .1, { quiet: false }); wildlife.setLandscape('forest'); wildlife.setActivity({ load: 1, problemKey: 'after-dispose' });
  assert.deepEqual(scene.children, [external]); assert.equal(wildlife.getDiagnostics().disposed, true);
  assert.ok([...counts.values()].every(value => value === 1));
  assert.equal(getEncounterStage(Number.NaN).phase, 'approach'); assert.equal(getEncounterStage(10000, 'beach').phase, 'alert');
});
