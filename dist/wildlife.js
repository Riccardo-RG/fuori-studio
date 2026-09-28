import * as THREE from './vendor/three.module.js';

const TAU = Math.PI * 2;
const clamp = value => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
const mix = (a, b, amount) => a + (b - a) * amount;
const smooth = value => { const t = clamp(value); return t * t * (3 - 2 * t); };
const THEMES = ['anthill', 'forest', 'beach', 'mountains'];
const DEN = Object.freeze({ x: -19, z: -12.5 });
const TARGETS = Object.freeze({ anthill: { x: -13, z: -10 }, forest: { x: -15, z: 6 }, beach: { x: 14, z: 12 }, mountains: { x: -15, z: 9 } });
const ANT_PHASES = Object.freeze([['approach', 6], ['attack', 7], ['feeding', 7], ['carry', 12], ['den', 5]]);
const OTHER_PHASES = Object.freeze([['approach', 6], ['alarm', 8], ['retreat', 8], ['settle', 4]]);

// Pure phase selection makes encounter timing testable without a WebGL renderer.
export function getEncounterStage(seconds, landscape = 'anthill') {
  const phases = landscape === 'anthill' ? ANT_PHASES : OTHER_PHASES;
  let remaining = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  for (const [phase, duration] of phases) {
    if (remaining < duration) return { phase, progress: remaining / duration, duration };
    remaining -= duration;
  }
  return { phase: 'alert', progress: 1, duration: 0 };
}

export function createWildlife(scene) {
  const root = new THREE.Group(); root.name = 'studio-wildlife'; scene.add(root);
  const geometryCache = new Map(), materials = new Map(), bakedGeometry = new Set();
  const groups = Object.fromEntries(THEMES.map(theme => { const group = new THREE.Group(); group.name = `wildlife-${theme}`; root.add(group); return [theme, group]; }));
  const animals = [], nightSwarms = [];
  const matrixObject = new THREE.Object3D(), axis = new THREE.Vector3(0, 1, 0);
  let landscape = 'anthill', night = false, disposed = false, quiet = false;
  let time = 0, motionTime = 0, load = 0, targetLoad = 0, problemKey = null, eventTime = 0, eventCount = 0;
  let encounter = false;
  const seenProblems = new Set();

  function geometry(kind) {
    if (!geometryCache.has(kind)) {
      let result;
      if (kind === 'orb') result = new THREE.IcosahedronGeometry(1, 1);
      else if (kind === 'pebble') result = new THREE.IcosahedronGeometry(1, 0);
      else if (kind === 'rod') result = new THREE.CylinderGeometry(1, 1, 1, 6);
      else if (kind === 'cone') result = new THREE.ConeGeometry(1, 1, 6);
      else if (kind === 'ring') result = new THREE.TorusGeometry(1, .065, 4, 24);
      else if (kind === 'squirrel-tail') result = new THREE.TubeGeometry(new THREE.CatmullRomCurve3([[0, 0, 0], [0, .25, -.32], [0, .75, -.42], [0, 1.22, -.17], [0, 1.25, .2], [0, 1.03, .3], [0, .93, .08]].map(p => new THREE.Vector3(...p))), 12, .18, 6, false);
      else if (kind === 'horn') result = new THREE.TubeGeometry(new THREE.CatmullRomCurve3([[0, 0, 0], [0, .4, -.1], [0, .7, -.34], [0, .76, -.66], [0, .5, -.8]].map(p => new THREE.Vector3(...p))), 9, .065, 5, false);
      else throw Error(`Unknown wildlife geometry: ${kind}`);
      geometryCache.set(kind, result);
    }
    return geometryCache.get(kind);
  }
  function material(color, glow = false) {
    const key = `${color}-${glow}`;
    if (!materials.has(key)) materials.set(key, new THREE.MeshStandardMaterial({ color, roughness: .8, flatShading: true, ...(glow ? { emissive: color, emissiveIntensity: 1.8, toneMapped: false } : {}) }));
    return materials.get(key);
  }
  function group(parent, x = 0, y = 0, z = 0) { const item = new THREE.Group(); item.position.set(x, y, z); parent.add(item); return item; }
  function part(parent, kind, color, position, scale = [1, 1, 1], rotation = null) {
    const item = new THREE.Mesh(geometry(kind), material(color));
    item.position.set(...position); item.scale.set(...scale);
    if (rotation) item.rotation.set(...rotation);
    item.castShadow = true; item.receiveShadow = true; parent.add(item); return item;
  }
  function rod(parent, color, a, b, radius = .055) {
    const start = new THREE.Vector3(...a), end = new THREE.Vector3(...b);
    const mesh = part(parent, 'rod', color, start.clone().add(end).multiplyScalar(.5).toArray(), [radius, start.distanceTo(end), radius]);
    mesh.quaternion.setFromUnitVectors(axis, end.sub(start).normalize()); return mesh;
  }
  // Static detail is baked by material inside each animated body part.
  function bake(parent) {
    parent.updateMatrixWorld(true);
    const inverse = new THREE.Matrix4().copy(parent.matrixWorld).invert(), buckets = new Map();
    parent.traverse(item => {
      if (!item.isMesh) return;
      const transformed = item.geometry.index ? item.geometry.toNonIndexed() : item.geometry.clone();
      transformed.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inverse, item.matrixWorld));
      if (!buckets.has(item.material)) buckets.set(item.material, []);
      buckets.get(item.material).push(transformed);
    });
    parent.clear();
    for (const [mat, pieces] of buckets) {
      const length = pieces.reduce((total, piece) => total + piece.attributes.position.array.length, 0);
      const positions = new Float32Array(length), normals = new Float32Array(length); let offset = 0;
      for (const piece of pieces) { positions.set(piece.attributes.position.array, offset); normals.set(piece.attributes.normal.array, offset); offset += piece.attributes.position.array.length; piece.dispose(); }
      const merged = new THREE.BufferGeometry(); merged.setAttribute('position', new THREE.BufferAttribute(positions, 3)); merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3)); merged.computeBoundingSphere(); bakedGeometry.add(merged);
      const mesh = new THREE.Mesh(merged, mat); mesh.castShadow = mesh.receiveShadow = true; parent.add(mesh);
    }
  }
  function eyes(head, spread, y, z, size = .043) {
    for (const sign of [-1, 1]) { part(head, 'orb', '#251f20', [sign * spread, y, z], [size, size * 1.15, size]); part(head, 'orb', '#fff6d9', [sign * spread, y + size * .25, z + size * .75], [size * .3, size * .3, size * .25]); }
  }
  function quadruped(parent, species, color, cream = '#e8d4ad') {
    const model = group(parent), body = group(model), legs = [], head = group(model);
    let tail = null, cargo = null;
    const tall = species === 'ibex', fox = species === 'fox' || species === 'wolf', squirrel = species === 'squirrel';
    const height = tall ? .94 : fox ? .65 : .43;
    part(body, 'orb', color, [0, height, 0], [tall ? .39 : .34, tall ? .43 : .32, fox || tall ? .78 : .5]);
    part(body, 'orb', cream, [0, height - .05, .2], [.265, .24, .37]); bake(body);
    head.position.set(0, tall ? 1.29 : fox ? .87 : .72, tall ? .66 : fox ? .72 : .45);
    part(head, 'orb', color, [0, 0, 0], [tall ? .24 : .28, tall ? .32 : .25, .3]);
    part(head, 'orb', cream, [0, -.095, .23], [fox ? .2 : .18, .125, fox ? .34 : .2]);
    part(head, 'orb', '#2f2825', [0, -.035, fox ? .51 : .39], [.075, .058, .06]);
    for (const sign of [-1, 1]) part(head, fox || tall ? 'cone' : 'orb', color, [sign * .18, .23, -.04], [fox ? .13 : .095, fox ? .33 : .16, .1], fox ? [0, 0, sign * -.2] : null);
    eyes(head, .195, .055, .19, .046);
    if (tall) {
      for (const sign of [-1, 1]) part(head, 'horn', '#8b7355', [sign * .15, .25, -.12], [1, 1, 1]);
      part(head, 'cone', '#624d38', [0, -.34, .2], [.105, .31, .08], [Math.PI, 0, 0]);
    } else if (!fox) {
      for (const sign of [-1, 1]) part(head, 'rod', '#fff1d5', [sign * .035, -.17, .385], [.035, .085, .025]);
    }
    bake(head);
    for (const x of [-1, 1]) for (const z of [-1, 1]) {
      const leg = group(model, x * (tall ? .27 : .24), height - .08, z * (fox || tall ? .5 : .27));
      const length = tall ? .77 : fox ? .5 : .32;
      part(leg, 'orb', color, [0, -length * .4, 0], [tall ? .09 : .12, length * .55, .11]);
      part(leg, 'orb', tall || fox ? '#45392f' : color, [0, -length + .065, .09], [.115, .075, .18]); bake(leg); legs.push(leg);
    }
    tail = group(model, 0, height + .02, fox || tall ? -.68 : -.43);
    if (squirrel) part(tail, 'squirrel-tail', color, [0, 0, 0]);
    else if (fox) { part(tail, 'orb', color, [0, .08, -.43], [.18, .2, .58], [-.24, 0, 0]); part(tail, 'orb', cream, [0, .2, -.86], [.155, .16, .27], [-.24, 0, 0]); }
    else part(tail, 'orb', color, [0, .01, -.13], [.13, .12, tall ? .2 : .3]);
    bake(tail);
    if (squirrel || species === 'marmot') {
      cargo = group(model, 0, .47, .73);
      part(cargo, 'orb', '#b87939', [0, 0, 0], [.115, .16, .115]); part(cargo, 'cone', '#714c2a', [0, .11, 0], [.135, .11, .135]); rod(cargo, '#5f502a', [0, .15, 0], [.02, .23, 0], .022); bake(cargo);
    }
    return { model, head, legs, tail, cargo, species };
  }
  function bird(parent, gull = false) {
    const model = group(parent), body = group(model), head = group(model, 0, .4, .33), legs = [], wings = [];
    const color = gull ? '#f3eee1' : '#679296';
    part(body, 'orb', color, [0, .25, 0], [.24, .23, .39]);
    part(body, 'orb', gull ? '#e5ddc9' : '#d78353', [0, .23, .23], [.19, .18, .2]);
    part(body, 'cone', gull ? '#5d6a6e' : '#486d70', [0, .24, -.44], [.18, .46, .055], [-Math.PI / 2, 0, 0]);
    for (const sign of [-1, 1]) { rod(body, '#8c6635', [sign * .1, .14, .05], [sign * .1, .015, .09], .025); rod(body, '#8c6635', [sign * .1, .018, .04], [sign * .1, .015, .22], .022); }
    bake(body);
    part(head, 'orb', color, [0, 0, 0], [.185, .19, .18]);
    part(head, 'cone', gull ? '#e6ac3c' : '#9b743e', [0, -.02, .24], [.08, .23, .06], [Math.PI / 2, 0, 0]); eyes(head, .13, .045, .125, .032); bake(head);
    for (const sign of [-1, 1]) {
      const wing = group(model, sign * .17, .36, -.07);
      part(wing, 'orb', color, [sign * .31, -.025, -.03], [.42, .065, .26]);
      part(wing, 'orb', gull ? '#657177' : '#3c6267', [sign * .56, -.02, -.08], [.22, .047, .19]); bake(wing); wings.push(wing);
    }
    const cargo = group(model, 0, .25, .76); part(cargo, 'pebble', '#85a148', [0, 0, 0], [.18, .035, .29]); bake(cargo); cargo.visible = false;
    return { model, head, legs, wings, cargo, species: gull ? 'seagull' : 'bird' };
  }
  function crab(parent, color) {
    const model = group(parent), body = group(model), legs = [], claws = [];
    part(body, 'orb', color, [0, .27, 0], [.5, .2, .36]); part(body, 'orb', '#e9b480', [0, .2, .12], [.36, .075, .28]);
    for (const sign of [-1, 1]) { rod(body, color, [sign * .23, .35, .2], [sign * .26, .59, .25], .035); part(body, 'orb', '#292829', [sign * .26, .61, .25], [.063, .075, .055]); }
    for (let i = 0; i < 3; i++) part(body, 'pebble', '#d59163', [(i - 1) * .18, .449, -.04], [.07, .023, .055]); bake(body);
    for (const sign of [-1, 1]) {
      for (let n = 0; n < 4; n++) {
        const leg = group(model, sign * .37, .25, -.3 + n * .19);
        rod(leg, color, [0, 0, 0], [sign * .32, .04, -.08], .05); rod(leg, color, [sign * .32, .04, -.08], [sign * .47, -.22, -.03], .032); bake(leg); legs.push(leg);
      }
      const claw = group(model, sign * .35, .28, .22);
      rod(claw, color, [0, 0, 0], [sign * .25, .12, .22], .072); part(claw, 'orb', color, [sign * .28, .19, .3], [.18, .21, .16]);
      part(claw, 'cone', '#e9ae75', [sign * .22, .39, .32], [.075, .29, .075], [0, 0, -.2 * sign]);
      part(claw, 'cone', color, [sign * .39, .36, .33], [.075, .24, .075], [0, 0, .3 * sign]); bake(claw); claws.push(claw);
    }
    const cargo = group(model, 0, .34, .5); part(cargo, 'pebble', '#82a858', [0, 0, 0], [.21, .035, .3]); bake(cargo);
    return { model, head: body, legs, claws, cargo, species: 'crab' };
  }
  function turtle(parent) {
    const model = group(parent), body = group(model), head = group(model, 0, .26, .78), legs = [];
    part(body, 'orb', '#5c7950', [0, .35, 0], [.62, .38, .83]); part(body, 'orb', '#c8c590', [0, .15, .02], [.59, .12, .77]);
    for (let i = 0; i < 7; i++) {
      const angle = i / 6 * TAU, central = i === 6;
      part(body, 'pebble', i % 2 ? '#87915a' : '#a6a565', [central ? 0 : Math.sin(angle) * .35, central ? .718 : .622, central ? 0 : Math.cos(angle) * .44], [central ? .25 : .2, .045, .26], [0, angle, 0]);
    }
    part(body, 'cone', '#7c965d', [0, .15, -.9], [.09, .32, .08], [-Math.PI / 2, 0, 0]); bake(body);
    part(head, 'orb', '#829c62', [0, 0, .12], [.225, .18, .31]); eyes(head, .16, .055, .29, .033); bake(head);
    for (const sign of [-1, 1]) for (const end of [-1, 1]) { const leg = group(model, sign * .5, .17, end * .45); part(leg, 'orb', '#859861', [sign * .16, -.035, .03], [.32, .075, .2], [0, sign * end * .45, 0]); bake(leg); legs.push(leg); }
    return { model, body, head, legs, species: 'turtle' };
  }
  function beetle(parent) {
    const model = group(parent), body = group(model), head = group(model, 0, .43, .79), legs = [];
    part(body, 'orb', '#34463e', [0, .32, -.08], [.53, .27, .85]);
    for (const sign of [-1, 1]) part(body, 'orb', sign < 0 ? '#527451' : '#668751', [sign * .235, .51, -.16], [.31, .32, .77]);
    rod(body, '#b0a666', [0, .797, -.73], [0, .81, .37], .025); bake(body);
    part(head, 'orb', '#384334', [0, 0, 0], [.37, .25, .35]); eyes(head, .28, .075, .19, .045);
    for (const sign of [-1, 1]) {
      rod(head, '#455037', [sign * .22, .1, .22], [sign * .5, .4, .66], .035); rod(head, '#727f44', [sign * .5, .4, .66], [sign * .62, .34, .9], .026);
      part(head, 'cone', '#8c7948', [sign * .18, -.12, .39], [.12, .34, .09], [Math.PI / 2, .25 * sign, 0]);
    }
    bake(head);
    for (const sign of [-1, 1]) for (let i = 0; i < 3; i++) {
      const leg = group(model, sign * .42, .31, -.6 + i * .49);
      rod(leg, '#3f4734', [0, 0, 0], [sign * .5, .12, -.13], .055); rod(leg, '#3f4734', [sign * .5, .12, -.13], [sign * .75, -.28, .05], .038); bake(leg); legs.push(leg);
    }
    return { model, body, head, legs, species: 'beetle' };
  }
  function addAnimal(theme, creature, x, z, scale, index, range = [1.8, 1.2]) {
    creature.model.scale.setScalar(scale); creature.model.position.set(x, 0, z); creature.model.name = `${theme}-${creature.species}-${index}`;
    Object.assign(creature, { theme, home: { x, z }, scale, index, phase: index * 1.73, range }); animals.push(creature); return creature;
  }
  // Animal groups occupy the wider landscape, leaving the studio courtyard free.
  [[-15, 5.5], [-18, 8.5], [-12.8, 6.8], [14.7, -11]].forEach(([x, z], i) => addAnimal('forest', quadruped(groups.forest, 'squirrel', i % 2 ? '#b27140' : '#935332'), x, z, .95 + i % 2 * .15, i));
  [[-15.4, 11], [-19, 5], [14, -12], [18, -9.5], [13, -15]].forEach(([x, z], i) => { const animal = addAnimal('forest', bird(groups.forest), x, z, .9 + i % 2 * .15, i + 5, [2, 1.3]); animal.flying = i % 2 === 0; });
  [[12.8, 11], [16, 12.8], [10, 14.6], [19.5, 9.8], [-15, 12.5]].forEach(([x, z], i) => addAnimal('beach', crab(groups.beach, i % 2 ? '#c77248' : '#cf8553'), x, z, .85 + i % 2 * .17, i, [1.5, .8]));
  [[16.5, 16.5], [21, 13.8], [-14, 17]].forEach(([x, z], i) => addAnimal('beach', turtle(groups.beach), x, z, 1.05 + i * .12, i + 6, [2.1, 1]));
  [[-14.3, 8.5], [-18, 10.5], [-12.8, 12], [17, -11]].forEach(([x, z], i) => addAnimal('mountains', quadruped(groups.mountains, 'marmot', i % 2 ? '#9b8b68' : '#a18f69', '#cfc29d'), x, z, 1.04, i, [1.2, .8]));
  [[14, -10.5], [18, -12], [-18.5, 12.6]].forEach(([x, z], i) => addAnimal('mountains', quadruped(groups.mountains, 'ibex', i % 2 ? '#9b8060' : '#ae926d', '#dacdb0'), x, z, 1 + i * .06, i + 5, [1.25, .9]));

  function gatherPatch(theme, x, z, seedColor) {
    const patch = group(groups[theme], x, 0, z);
    for (let i = 0; i < 11; i++) { const theta = i * 2.4, radius = .2 + i * .065; part(patch, 'pebble', seedColor, [Math.cos(theta) * radius, .09 + i % 3 * .035, Math.sin(theta) * radius], [.14, .08, .19], [0, theta, 0]); }
    if (theme === 'forest') { part(patch, 'rod', '#835c39', [-1.6, .25, .4], [.24, 1.7, .24], [0, 0, Math.PI / 2]); part(patch, 'rod', '#c4a073', [-2.46, .25, .4], [.2, .035, .2], [0, 0, Math.PI / 2]); }
    if (theme === 'mountains') { part(patch, 'orb', '#7e826f', [-1.1, .35, -.1], [.75, .45, .58]); part(patch, 'orb', '#3d4638', [-1.08, .13, .39], [.37, .17, .04]); }
    bake(patch);
  }
  gatherPatch('forest', -15, 6, '#c4a061'); gatherPatch('forest', 15, -11, '#aa934f'); gatherPatch('beach', 14, 12, '#809554'); gatherPatch('mountains', -15, 9, '#b6a067');

  function instances(parent, kind, color, count, glow = false) {
    const mesh = new THREE.InstancedMesh(geometry(kind), material(color, glow), count); mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); mesh.frustumCulled = false; mesh.castShadow = !glow; mesh.receiveShadow = !glow; parent.add(mesh); return mesh;
  }
  for (const theme of THEMES) {
    const swarm = instances(groups[theme], 'orb', theme === 'beach' ? '#8cebd0' : '#dceb81', theme === 'forest' ? 18 : 10, true);
    swarm.visible = false; nightSwarms.push({ theme, mesh: swarm });
  }
  const encounters = {};
  for (const theme of THEMES) {
    const eventRoot = group(groups[theme]); eventRoot.name = `${theme}-encounter`;
    const creature = theme === 'anthill' ? beetle(eventRoot) : theme === 'beach' ? bird(eventRoot, true) : quadruped(eventRoot, theme === 'forest' ? 'fox' : 'wolf', theme === 'forest' ? '#bf7845' : '#85847b', '#e1d6bc');
    creature.model.scale.setScalar(theme === 'anthill' ? 1.2 : theme === 'beach' ? 1.65 : 1.18);
    const marker = part(eventRoot, 'ring', '#d5ac5c', [TARGETS[theme].x, .025, TARGETS[theme].z], [1.65, 1.65, 1.65], [Math.PI / 2, 0, 0]); marker.material = material('#d5ac5c', true); marker.castShadow = false;
    encounters[theme] = { root: eventRoot, creature, marker }; eventRoot.visible = false;
  }
  const defense = group(encounters.anthill.root);
  const DEFENDERS = 24;
  const antBodies = instances(defense, 'orb', '#493223', DEFENDERS * 3);
  const antLegs = instances(defense, 'rod', '#4d3928', DEFENDERS * 6);
  const antAntennae = instances(defense, 'rod', '#765338', DEFENDERS * 2);
  const remains = instances(defense, 'pebble', '#768755', 8);
  const beetleFood = group(encounters.anthill.root, TARGETS.anthill.x, 0, TARGETS.anthill.z + 1);
  for (let i = 0; i < 8; i++) part(beetleFood, 'pebble', i % 2 ? '#d1b174' : '#83a449', [Math.sin(i * 2.4) * .6, .13, Math.cos(i * 2.4) * .45], [.17, .12, .24]); bake(beetleFood);

  function setInstance(mesh, index, x, y, z, sx, sy, sz, ry = 0, rz = 0, rx = 0) {
    matrixObject.position.set(x, y, z); matrixObject.scale.set(sx, sy, sz); matrixObject.rotation.set(rx, ry, rz); matrixObject.updateMatrix(); mesh.setMatrixAt(index, matrixObject.matrix);
  }
  function antPose(index, x, z, angle, activity, bob = 0) {
    const forwardX = Math.sin(angle), forwardZ = Math.cos(angle), sideX = Math.cos(angle), sideZ = -Math.sin(angle);
    for (let n = 0; n < 3; n++) { const along = [-.23, 0, .22][n]; setInstance(antBodies, index * 3 + n, x + forwardX * along, .15 + bob, z + forwardZ * along, n === 0 ? .14 : .10, .09, n === 0 ? .19 : .12, angle); }
    for (let side = 0; side < 2; side++) for (let n = 0; n < 3; n++) {
      const sign = side ? 1 : -1, stride = Math.sin(motionTime * 13 + index + n * 1.8 + side * Math.PI) * activity;
      const along = (n - 1) * .13 + stride * .04;
      setInstance(antLegs, index * 6 + side * 3 + n, x + sideX * sign * .18 + forwardX * along, .09 + bob, z + sideZ * sign * .18 + forwardZ * along, .02, .34, .02, angle, sign * 1.1, stride * .3);
    }
    for (let side = 0; side < 2; side++) { const sign = side ? 1 : -1; setInstance(antAntennae, index * 2 + side, x + forwardX * .33 + sideX * sign * .08, .23 + bob, z + forwardZ * .33 + sideZ * sign * .08, .015, .21, .015, angle - sign * .32, sign * .35, .9); }
  }
  function poseCreature(creature, stride, amount, alert = false) {
    creature.legs.forEach((leg, i) => { leg.rotation.x = Math.sin(stride + (i % 2) * Math.PI + (i > 1 ? Math.PI : 0)) * amount; });
    if (creature.tail) creature.tail.rotation.z = Math.sin(stride * .38) * (alert ? .28 : .1);
    if (creature.wings) creature.wings.forEach((wing, i) => { wing.rotation.z = (i ? 1 : -1) * Math.sin(stride * 1.4) * amount * 2; });
  }
  function ambientPose(animal, stage) {
    const activeThreat = encounter && ['approach', 'alarm', 'attack'].includes(stage.phase);
    const t = motionTime * (animal.species === 'turtle' ? .22 : .47) + animal.phase;
    const gathering = Math.sin(t * .7) > .45;
    let x = animal.home.x + Math.sin(t) * animal.range[0], z = animal.home.z + Math.sin(t * .73) * animal.range[1], y = 0;
    let angle = Math.atan2(Math.cos(t) * animal.range[0], Math.cos(t * .73) * animal.range[1] * .73);
    let gait = gathering ? .09 : .35 + load * .24;
    if (activeThreat) {
      const target = TARGETS[landscape], distance = Math.hypot(animal.home.x - target.x, animal.home.z - target.z);
      if (distance < 8) {
        const strength = (1 - distance / 10) * (stage.phase === 'approach' ? stage.progress : 1);
        if (animal.species === 'ibex') { x = mix(x, -17.5, strength); z = mix(z, 10.5, strength); angle = Math.atan2(target.x - x, target.z - z); }
        else { x += (animal.home.x < target.x ? -1 : 1) * strength * .9; z += strength * .55; gait *= 1.6; }
      }
    }
    if (animal.species === 'bird') {
      if (night) { x = animal.home.x; z = animal.home.z; y = .04; gait = .03; }
      else if (animal.flying) { y = 2.1 + Math.sin(t * 1.8) * .6; gait = .7; }
      else y = Math.max(0, Math.sin(t * 5)) * .15;
    } else if (animal.species === 'squirrel') y = gathering ? 0 : Math.max(0, Math.sin(t * 5)) * (.13 + load * .17);
    else if (animal.species === 'ibex') y = !gathering && !activeThreat ? Math.max(0, Math.sin(t * 2.8)) * .18 : 0;
    animal.model.position.set(x, y, z); animal.model.rotation.y = angle;
    animal.head.rotation.x = animal.species === 'ibex' && activeThreat ? .43 : gathering ? .2 + Math.sin(time * 2.5 + animal.phase) * .08 : Math.sin(t * 1.8) * .06;
    if (animal.species === 'turtle') { animal.head.position.z = activeThreat ? .54 : .78; gait *= .4; }
    if (animal.species === 'marmot') { animal.model.rotation.x = activeThreat ? -.19 : 0; animal.head.rotation.x = activeThreat ? -.23 : animal.head.rotation.x; }
    if (animal.claws) animal.claws.forEach((claw, i) => { claw.rotation.z = (i ? -1 : 1) * (activeThreat ? .62 : .18 + Math.sin(t * 2) * .14); });
    if (animal.cargo) animal.cargo.visible = !activeThreat && Math.sin(t * .7) < -.05 + load * .65;
    poseCreature(animal, motionTime * 5 + animal.phase, night ? gait * .45 : gait, activeThreat);
  }
  function antEncounter(stage) {
    const { creature } = encounters.anthill, target = TARGETS.anthill;
    const phase = stage.phase, p = smooth(stage.progress);
    defense.visible = ['approach', 'attack', 'feeding', 'carry', 'den'].includes(phase);
    beetleFood.visible = phase === 'approach' || phase === 'attack';
    creature.model.visible = ['approach', 'attack', 'feeding'].includes(phase);
    creature.model.position.set(phase === 'approach' ? mix(-23, target.x, p) : target.x, phase === 'feeding' ? .04 : 0, phase === 'approach' ? mix(-9, target.z, p) : target.z);
    creature.model.rotation.set(0, phase === 'approach' ? Math.atan2(10, -1) : .3 + Math.sin(time * 1.7) * .12, phase === 'feeding' ? mix(0, .45, p) : 0);
    creature.model.scale.setScalar(phase === 'feeding' ? mix(1.2, .62, p) : 1.2);
    creature.head.rotation.x = phase === 'attack' ? .25 + Math.sin(time * 7) * .2 : 0;
    poseCreature(creature, motionTime * 9, phase === 'feeding' ? .03 : .35);
    const radius = phase === 'feeding' ? 1.15 : phase === 'attack' ? 1.65 : 2.1;
    const moving = phase === 'carry' || phase === 'den';
    for (let i = 0; i < DEFENDERS; i++) {
      const theta = i / DEFENDERS * TAU + (phase === 'attack' ? time * .35 : 0);
      const variedRadius = radius + Math.sin(i * 2.4) * .22;
      let x = target.x + Math.sin(theta) * variedRadius, z = target.z + Math.cos(theta) * variedRadius, delivered = false;
      if (phase === 'approach') { const emerge = smooth((stage.progress - i * .012) * 1.35); x = mix(DEN.x, x, emerge); z = mix(DEN.z, z, emerge); }
      if (moving) {
        const segment = Math.floor(i / 3), raw = (phase === 'den' ? 1.4 + p * .5 : p * 1.4) - segment * .1, along = clamp(raw);
        const side = (i % 3 - 1) * .31, wait = 1 - smooth(raw * 8);
        x = mix(target.x, DEN.x, along) + side * .45 + Math.sin(segment * 2.4) * wait * 1.25;
        z = mix(target.z, DEN.z, along) - side + Math.cos(segment * 2.4) * wait * 1.25;
        delivered = raw > 1;
      }
      const angle = moving ? Math.atan2(DEN.x - target.x, DEN.z - target.z) : Math.atan2(target.x - x, target.z - z);
      antPose(i, x, z, angle, phase === 'feeding' ? .3 : .85, delivered ? -1.2 : phase === 'feeding' ? Math.sin(time * 9 + i) * .025 : 0);
    }
    remains.visible = moving || (phase === 'feeding' && stage.progress > .55);
    for (let i = 0; i < 8; i++) {
      const raw = phase === 'den' ? 1.4 + p * .5 - i * .1 : phase === 'carry' ? p * 1.4 - i * .1 : 0;
      const along = clamp(raw), waitingRadius = moving ? (1 - smooth(raw * 8)) * 1.25 : .38;
      const shrink = moving ? 1 - smooth((raw - .93) / .07) : 1;
      setInstance(remains, i, mix(target.x, DEN.x, along) + Math.sin(i * 2.4) * waitingRadius, .42 + Math.sin(time * 7 + i) * .025, mix(target.z, DEN.z, along) + Math.cos(i * 2.4) * waitingRadius, .2 * shrink, .11 * shrink, .25 * shrink, i * .7);
    }
    for (const mesh of [antBodies, antLegs, antAntennae, remains]) mesh.instanceMatrix.needsUpdate = true;
  }
  function otherEncounter(stage) {
    const { creature } = encounters[landscape], target = TARGETS[landscape];
    const phase = stage.phase, p = smooth(stage.progress), beach = landscape === 'beach';
    const start = beach ? { x: 25, z: 18 } : { x: -27, z: landscape === 'forest' ? 4 : 13 };
    creature.model.visible = ['approach', 'alarm', 'retreat'].includes(phase);
    const progress = phase === 'approach' ? p : phase === 'retreat' ? 1 - p : 1;
    creature.model.position.set(mix(start.x, target.x, progress), beach ? mix(5, .65, progress) + Math.sin(time * 3) * .12 : 0, mix(start.z, target.z, progress));
    creature.model.rotation.y = Math.atan2(target.x - start.x, target.z - start.z) + (phase === 'retreat' ? Math.PI : 0);
    creature.head.rotation.x = phase === 'alarm' ? .16 + Math.sin(time * 5) * .1 : 0;
    poseCreature(creature, motionTime * (phase === 'retreat' ? 12 : 8), beach ? .64 : phase === 'alarm' ? .06 : .4, true);
    if (creature.cargo) creature.cargo.visible = beach && phase === 'retreat';
  }
  function renderState() {
    const stage = encounter ? getEncounterStage(eventTime, landscape) : { phase: problemKey ? 'alert' : 'idle', progress: 0, duration: 0 };
    for (const animal of animals) if (animal.theme === landscape) ambientPose(animal, stage);
    for (const theme of THEMES) {
      const entry = encounters[theme]; entry.root.visible = theme === landscape && problemKey !== null;
      entry.marker.visible = stage.phase === 'alert'; entry.marker.scale.setScalar(1.55 + Math.sin(time * 1.4) * .07);
      if (theme !== landscape) continue;
      if (theme === 'anthill') antEncounter(stage); else otherEncounter(stage);
    }
    for (const swarm of nightSwarms) {
      swarm.mesh.visible = night && swarm.theme === landscape;
      if (!swarm.mesh.visible) continue;
      const base = TARGETS[swarm.theme];
      for (let i = 0; i < swarm.mesh.count; i++) {
        const theta = i * 2.4 + time * .12, radius = 1 + i % 5 * .75;
        const glow = .032 + (Math.sin(time * 1.7 + i * .8) + 1) * .012;
        let x = base.x + Math.sin(theta) * radius;
        const z = base.z + Math.cos(theta) * radius;
        if (Math.abs(z) < 8.5 && Math.abs(x) < 11.5) x = Math.sign(base.x) * 11.5;
        setInstance(swarm.mesh, i, x, .7 + (Math.sin(time * .6 + i) + 1) * .75, z, glow, glow, glow);
      }
      swarm.mesh.instanceMatrix.needsUpdate = true;
    }
  }
  function setLandscape(name) {
    if (disposed) return;
    const canonical = name === 'mountain' ? 'mountains' : name;
    if (!THEMES.includes(canonical)) return;
    landscape = canonical;
    for (const theme of THEMES) groups[theme].visible = theme === landscape;
    renderState();
  }
  function setNight(value) { if (disposed) return; night = !!value; renderState(); }
  function setActivity({ load: activity = 0, problemKey: key = null } = {}) {
    if (disposed) return;
    targetLoad = clamp(activity);
    const next = typeof key === 'string' && key.trim() ? key.slice(0, 1000) : null;
    if (next === problemKey) return;
    problemKey = next;
    if (!next) { encounter = false; eventTime = 0; }
    else if (!seenProblems.has(next)) { seenProblems.add(next); if (seenProblems.size > 256) seenProblems.delete(seenProblems.values().next().value); encounter = true; eventTime = 0; eventCount += 1; }
    else { encounter = false; eventTime = 0; }
    renderState();
  }
  function getAntTarget() {
    if (disposed || landscape !== 'anthill' || !problemKey || !encounter) return null;
    const stage = getEncounterStage(eventTime, 'anthill');
    if (stage.phase === 'alert') return null;
    if (stage.phase === 'carry' || stage.phase === 'den') return { x: DEN.x, z: DEN.z, strength: .75 };
    return { ...TARGETS.anthill, strength: stage.phase === 'approach' ? .4 : 1 };
  }
  function getDiagnostics() {
    const current = animals.filter(animal => animal.theme === landscape);
    const phase = encounter ? getEncounterStage(eventTime, landscape) : { phase: problemKey ? 'alert' : 'idle', progress: 0 };
    return {
      landscape, night, quiet, load, targetLoad, problemKey, eventCount, eventElapsed: eventTime, elapsed: time, phase: phase.phase, phaseProgress: phase.progress,
      activeAnimals: current.length, animalsBySpecies: current.reduce((counts, animal) => ({ ...counts, [animal.species]: (counts[animal.species] || 0) + 1 }), {}),
      defenders: landscape === 'anthill' && problemKey && ['approach', 'attack', 'feeding', 'carry', 'den'].includes(phase.phase) ? DEFENDERS : 0,
      carriedPieces: landscape === 'anthill' && ['carry', 'den'].includes(phase.phase) ? 8 : 0,
      antTarget: getAntTarget(), target: { ...TARGETS[landscape] }, disposed,
    };
  }
  function dispose() {
    if (disposed) return;
    disposed = true; root.removeFromParent();
    root.traverse(item => { if (item.isInstancedMesh) item.dispose(); });
    for (const item of geometryCache.values()) item.dispose();
    for (const item of bakedGeometry) item.dispose();
    for (const item of materials.values()) item.dispose();
    geometryCache.clear(); bakedGeometry.clear(); materials.clear(); seenProblems.clear(); root.clear();
  }
  setLandscape('anthill');
  return {
    setLandscape, setNight, setActivity, getDiagnostics, getAntTarget, dispose,
    update(_elapsed, dt, options = {}) {
      if (disposed) return;
      quiet = !!options.quiet;
      if (quiet) return;
      const delta = Math.min(.1, Math.max(0, Number.isFinite(dt) ? dt : 0));
      time += delta; load += (targetLoad - load) * (1 - Math.exp(-delta * 3));
      motionTime += delta * (.45 + load * 1.5) * (night ? .64 : 1);
      if (encounter && problemKey) eventTime += delta;
      renderState();
    },
  };
}
