import * as THREE from './vendor/three.module.js';

/* A small, entirely geometric toy world. No image assets or model loaders. */
export function createOfficeWorld(host, { onSelect = () => {}, onPositions = () => {} } = {}) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#dcebd9');
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // A toy world needs clean color separation. Filmic highlight compression
  // washes these deliberately saturated materials toward beige and gray.
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;outline:none;';
  renderer.domElement.setAttribute('aria-label', 'Ufficio 3D: trascina per ruotare, seleziona un collega');
  renderer.domElement.tabIndex = 0;
  host.appendChild(renderer.domElement);

  const camera = new THREE.OrthographicCamera(-14, 14, 12, -12, .1, 120);
  let angle = .62, elevation = .72, width = 1, height = 1, quiet = false, disposed = false;
  let theme = 'forest', selected = null, elapsed = 0, frame = 0;
  const lookAt = new THREE.Vector3(0, .45, 0);
  const mats = new Map();
  const geometryCache = new Map();
  const scratch = new THREE.Vector3();
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  function material(color, opts = {}) {
    const key = color + JSON.stringify(opts);
    if (!mats.has(key)) mats.set(key, new THREE.MeshStandardMaterial({ color, roughness: .82, metalness: 0, ...opts }));
    return mats.get(key);
  }
  function geo(type, ...args) {
    const key = type + args.join(',');
    if (!geometryCache.has(key)) geometryCache.set(key, type === 'box' ? new THREE.BoxGeometry(...args) : type === 'cylinder' ? new THREE.CylinderGeometry(...args) : type === 'cone' ? new THREE.ConeGeometry(...args) : new THREE.IcosahedronGeometry(...args));
    return geometryCache.get(key);
  }
  function mesh(group, geometry, color, x, y, z, opts) {
    const m = new THREE.Mesh(geometry, typeof color === 'string' ? material(color, opts) : color);
    m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; group.add(m); return m;
  }
  function box(g, x, y, z, w, h, d, color, ry = 0) { const m = mesh(g, geo('box', w, h, d), color, x, y, z); m.rotation.y = ry; return m; }
  function cyl(g, x, y, z, rt, rb, h, color, n = 8) { return mesh(g, geo('cylinder', rt, rb, h, n), color, x, y, z); }
  function cone(g, x, y, z, r, h, color, n = 5) { return mesh(g, geo('cone', r, h, n), color, x, y, z); }
  function group(parent, x = 0, y = 0, z = 0) { const g = new THREE.Group(); g.position.set(x, y, z); parent.add(g); return g; }
  let seed = 14;
  function random() { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }

  // Merge static objects by material. Hundreds of handmade pieces become a few draws.
  const mergedGeometries = [];
  function bake(root) {
    root.updateMatrixWorld(true);
    const inverse = new THREE.Matrix4().copy(root.matrixWorld).invert();
    const buckets = new Map();
    const transforms = new THREE.Matrix4();
    root.traverse(o => {
      if (!o.isMesh) return;
      transforms.multiplyMatrices(inverse, o.matrixWorld);
      const raw = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
      raw.applyMatrix4(transforms);
      if (!buckets.has(o.material)) buckets.set(o.material, []);
      buckets.get(o.material).push(raw);
    });
    root.clear();
    buckets.forEach((parts, mat) => {
      const count = parts.reduce((n, p) => n + p.attributes.position.count, 0);
      const positions = new Float32Array(count * 3), normals = new Float32Array(count * 3);
      let at = 0;
      parts.forEach(p => { positions.set(p.attributes.position.array, at); normals.set(p.attributes.normal.array, at); at += p.attributes.position.array.length; p.dispose(); });
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
      geometry.computeBoundingSphere(); mergedGeometries.push(geometry);
      const m = new THREE.Mesh(geometry, mat); m.castShadow = m.receiveShadow = true; root.add(m);
    });
  }

  scene.add(new THREE.HemisphereLight('#e9f5ff', '#7d9851', 1.25));
  const sun = new THREE.DirectionalLight('#fff0d4', 2.4);
  sun.position.set(-9, 20, 13); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -18, right: 18, top: 18, bottom: -18, near: 1, far: 55 });
  sun.shadow.bias = -.00035; sun.shadow.normalBias = .025;
  scene.add(sun);
  const fill = new THREE.DirectionalLight('#d8efff', .36); fill.position.set(10, 8, -8); scene.add(fill);

  const foundation = group(scene);
  const baseMat = material('#a0b98f');
  const earthMat = material('#adbd94');
  box(foundation, 0, -.78, 0, 23, 1.1, 18.5, earthMat);
  box(foundation, 0, -.17, 0, 23.2, .18, 18.7, baseMat);
  // A dark green rim and small stepping stones make the floating island read as a toy.
  box(foundation, 0, -1.36, 0, 22.7, .13, 18.2, '#4c683e');
  bake(foundation);
  const courtyard = group(scene);
  const pathMat = material('#e9d5a3');
  box(courtyard, 0, -.025, .1, 2.2, .07, 14.6, pathMat);
  box(courtyard, 0, -.017, -.3, 14.5, .08, 1.6, pathMat);
  // A little central plaza, low enough to keep every walking route unobstructed.
  cyl(courtyard, 0, .015, -.1, 2.0, 2.0, .08, pathMat, 12);
  for (let i = -3; i <= 3; i++) box(courtyard, i * 1.1, .035, 7.6, .92, .12, .62, '#faf4e4', (i % 2) * .04);

  const cast = [
    { id: 'nova', color: '#e86f4d', skin: '#dba784', hair: '#56392f', x: -5.15, z: -3.5, style: 'bob', phase: 1 },
    { id: 'radar', color: '#588f50', skin: '#bd865e', hair: '#342c29', x: .1, z: -4.7, style: 'short', phase: 11 },
    { id: 'forge', color: '#9355cb', skin: '#eed0ae', hair: '#392d43', x: 5.2, z: -3.3, style: 'long', phase: 21 },
    { id: 'muse', color: '#e2ad2d', skin: '#d9a879', hair: '#855536', x: -3.8, z: 2.7, style: 'short', phase: 6 },
    { id: 'growth', color: '#369acf', skin: '#865944', hair: '#30282b', x: 3.8, z: 2.7, style: 'bun', phase: 16 }
  ];

  function plant(parent, x, y, z, size = 1) {
    const p = group(parent, x, y, z); p.scale.setScalar(size);
    cyl(p, 0, .18, 0, .23, .17, .36, '#e7c5a4', 6);
    cyl(p, 0, .37, 0, .215, .215, .06, '#75664e', 6);
    box(p, 0, .64, 0, .075, .55, .075, '#3b8143');
    const leaf1 = box(p, -.16, .69, 0, .35, .1, .16, '#39a154'); leaf1.rotation.z = -.5;
    const leaf2 = box(p, .15, .82, 0, .36, .1, .18, '#6eba4e'); leaf2.rotation.z = .6;
    const leaf3 = box(p, 0, .99, 0, .18, .25, .14, '#4bab4c'); leaf3.rotation.z = -.2;
  }
  function mug(parent, x, y, z, color = '#f4eddf') {
    cyl(parent, x, y + .1, z, .11, .1, .2, color, 8);
    cyl(parent, x, y + .208, z, .086, .086, .01, '#725443', 8);
    box(parent, x + .13, y + .11, z, .07, .12, .07, color);
  }
  const screens = [];
  cast.forEach((a, index) => {
    const pod = group(courtyard, a.x, 0, a.z);
    box(pod, 0, .015, -.12, 3.25, .08, 3.2, '#9fbf78');
    box(pod, 0, .065, .28, 2.65, .065, 2.7, '#e2d8af');
    box(pod, .02, 1.17, .55, 2.25, .16, .96, '#a76936');
    box(pod, .02, 1.275, .55, 2.3, .055, 1.0, '#dfb472');
    for (const x of [-.88, .88]) for (const z of [.2, .86]) box(pod, x, .6, z, .12, 1.1, .12, '#3f574b');
    // Raised laptop, keyboard, glowing code lines, small colored task notebook.
    box(pod, 0, 1.32, .44, .81, .045, .52, '#516467');
    box(pod, 0, 1.351, .35, .59, .017, .22, '#d7ddcf');
    const lid = group(pod, 0, 1.6, .72); lid.rotation.x = -.13;
    box(lid, 0, 0, 0, .85, .55, .045, '#455b5d');
    box(lid, 0, .01, -.026, .74, .44, .014, '#b1d7cc');
    for (let j = 0; j < 3; j++) box(lid, -.07 + (j % 2) * .08, .1 - j * .095, -.038, .42 - j * .06, .025, .008, '#6e9c96');
    box(lid, 0, 0, .033, .16, .13, .018, '#9eb9a9');
    box(pod, .77, 1.32, .43, .32, .045, .39, a.color, -.18);
    mug(pod, -.77, 1.31, .32);
    plant(pod, .83, 1.31, .88, .54);
    // A compact stool; the characters stand up to work and roam naturally.
    box(pod, 0, .67, -1.16, .64, .14, .65, a.color);
    box(pod, 0, .36, -1.16, .13, .58, .13, '#3f574b');
    box(pod, 0, .1, -1.16, .65, .08, .48, '#3f574b');
    const indicator = mesh(scene, geo('box', .09, .06, .06), material(a.color, { emissive: a.color, emissiveIntensity: .3 }), a.x + .33, 1.75, a.z + .76);
    screens.push(indicator);
  });

  // Coffee corner gives the walking animations a real destination.
  const coffee = group(courtyard, 8.4, 0, 3.4);
  box(coffee, 0, .6, 0, 1.75, 1.1, .88, '#cab18b');
  box(coffee, 0, 1.21, 0, 1.92, .16, 1.04, '#f5e2bd');
  box(coffee, .32, 1.65, .14, .62, .74, .54, '#4c6762');
  box(coffee, .32, 1.73, .424, .4, .21, .025, '#a8c4b8');
  box(coffee, .32, 1.44, .43, .38, .09, .22, '#293e39');
  mug(coffee, -.52, 1.3, .12); mug(coffee, -.26, 1.3, -.13);
  plant(coffee, .66, 0, .92, 1.05);
  // A tiny welcome sign with a simple embossed leaf icon.
  box(courtyard, -7.9, .65, 4.8, .13, 1.3, .13, '#987b59');
  box(courtyard, -7.9, 1.32, 4.8, 1.3, .75, .13, '#f7eacb');
  box(courtyard, -7.9, 1.32, 4.88, .11, .43, .035, '#79a070', -.2);
  box(courtyard, -8.07, 1.4, 4.9, .3, .12, .03, '#79a070', -.5);
  box(courtyard, -7.74, 1.28, 4.9, .26, .12, .03, '#79a070', .5);
  bake(courtyard);

  function makeAvatar(a) {
    const root = group(scene, a.x, -.04, a.z - .61);
    const visual = group(root);
    visual.scale.setScalar(1.15);
    const head = group(visual, 0, 1.96, 0);
    box(head, 0, 0, 0, .59, .61, .53, a.skin);
    box(head, -.306, -.015, 0, .065, .13, .15, a.skin);
    box(head, .306, -.015, 0, .065, .13, .15, a.skin);
    box(head, -.13, .025, .274, .059, .073, .02, '#342e30');
    box(head, .13, .025, .274, .059, .073, .02, '#342e30');
    box(head, -.115, .049, .286, .015, .018, .007, '#fff5e1');
    box(head, .145, .049, .286, .015, .018, .007, '#fff5e1');
    box(head, 0, -.06, .288, .07, .064, .055, a.skin);
    box(head, 0, -.146, .277, .12, .025, .017, '#8b5749');
    box(head, -.066, -.128, .278, .027, .033, .018, '#8b5749');
    box(head, .066, -.128, .278, .027, .033, .018, '#8b5749');
    box(head, -.206, -.095, .273, .06, .03, .012, '#d7927d');
    box(head, .206, -.095, .273, .06, .03, .012, '#d7927d');
    box(head, 0, .293, -.014, .65, .17, .59, a.hair);
    box(head, -.19, .19, .254, .24, .15, .08, a.hair);
    box(head, .19, .245, .24, .22, .08, .1, a.hair);
    box(head, 0, .14, -.277, .61, .27, .08, a.hair);
    if (a.style === 'bob' || a.style === 'long') {
      box(head, -.298, -.015, -.05, .115, .55, .49, a.hair);
      box(head, .298, -.015, -.05, .115, .55, .49, a.hair);
      if (a.style === 'long') box(head, 0, -.33, -.285, .6, .6, .12, a.hair);
    } else if (a.style === 'bun') {
      box(head, 0, .31, -.34, .35, .34, .32, a.hair);
      box(head, .015, .42, -.28, .27, .045, .31, a.color);
    } else {
      box(head, -.18, .37, 0, .28, .12, .47, a.hair, -.09);
      box(head, .24, .13, -.1, .09, .27, .33, a.hair);
    }
    bake(head);
    const torso = group(visual);
    box(torso, 0, 1.29, 0, .64, .65, .37, a.color);
    box(torso, 0, 1.65, 0, .22, .14, .23, a.skin);
    box(torso, 0, 1.59, .1, .28, .06, .2, '#f4ead5');
    box(torso, -.17, 1.4, .194, .14, .12, .035, '#f5e6d4');
    box(torso, 0, .94, 0, .57, .15, .36, '#486272');
    bake(torso);
    const arms = [], elbows = [], legs = [], knees = [];
    for (const sign of [-1, 1]) {
      const arm = group(visual, sign * .435, 1.56, 0);
      const upper = group(arm);
      box(upper, 0, -.17, 0, .235, .36, .3, a.color);
      box(upper, 0, -.35, 0, .2, .16, .25, a.skin);
      bake(upper);
      const elbow = group(arm, 0, -.42, 0);
      box(elbow, 0, -.135, 0, .19, .3, .24, a.skin);
      box(elbow, 0, -.307, .015, .215, .12, .25, a.skin);
      bake(elbow);
      arms.push(arm); elbows.push(elbow);
      const leg = group(visual, sign * .175, .96, 0);
      box(leg, 0, -.205, 0, .265, .42, .31, '#486272');
      const knee = group(leg, 0, -.4, 0);
      const lower = group(knee);
      box(lower, 0, -.17, 0, .25, .36, .3, '#486272');
      box(lower, 0, -.376, .045, .29, .16, .43, '#f5eddb');
      box(lower, 0, -.432, .045, .295, .035, .44, '#d2cfbc');
      bake(lower);
      legs.push(leg); knees.push(knee);
    }
    // Invisible generous hit box keeps small people easy to select on mobile.
    const hit = new THREE.Mesh(geo('box', 1.35, 2.9, 1.15), new THREE.MeshBasicMaterial({ visible: false }));
    hit.position.y = 1.45; hit.userData.agentId = a.id; root.add(hit);
    const halo = new THREE.Mesh(new THREE.RingGeometry(.52, .65, 28), new THREE.MeshBasicMaterial({ color: a.color, transparent: true, opacity: .45, side: THREE.DoubleSide, depthWrite: false }));
    halo.rotation.x = -Math.PI / 2; halo.position.y = .145; root.add(halo);
    const home = new THREE.Vector3(a.x, -.04, a.z - .61);
    const sideX=home.x+(home.x<0?1.55:-1.55), meetingX=a.x<0?-1.35:1.35, meetingZ=a.z>0?1.25:-1;
    const routeXs=[home.x,sideX,sideX,meetingX], routeZs=[home.z,home.z,meetingZ,meetingZ];
    const routeLengths=[Math.abs(sideX-home.x),Math.abs(meetingZ-home.z),Math.abs(meetingX-sideX)];
    return { ...a, root, visual, head, arms, elbows, legs, knees, halo, hit, home, routeXs, routeZs, routeLengths, working: false, routineWorking: false, lastCycle: 0, status: 'idle', walking: false, position: { id: a.id, x: 0, y: 0, visible: true } };
  }
  const agents = cast.map(makeAvatar);
  const hitBoxes = agents.map(a => a.hit);
  const labels = agents.map(a => a.position);

  // Landscape silhouettes live around the office, leaving the actors unobstructed.
  const themes = { forest: group(scene), beach: group(scene), mountains: group(scene) };
  function rock(g, x, z, s, color = '#a1aaa1', y = 0) { const r = mesh(g, geo('ico', 1, 0), color, x, y + s * .28, z); r.scale.set(s * .85, s * .54, s * .67); r.rotation.set(0, random() * 3, .13); }
  function flower(g, x, z, color, s = 1) {
    box(g, x, .18 * s, z, .045, .37 * s, .045, '#749766');
    box(g, x, .38 * s, z, .24 * s, .07 * s, .105 * s, color);
    box(g, x, .39 * s, z, .105 * s, .055 * s, .24 * s, color);
    box(g, x, .43 * s, z, .065 * s, .045 * s, .065 * s, '#efc963');
  }
  function grass(g, x, z, s = 1, color = '#419b46') {
    for (let j = -1; j <= 1; j++) { const blade = box(g, x + j * .12, .18 * s, z, .095 * s, .36 * s, .06 * s, color); blade.rotation.z = -j * .25; }
  }
  function tree(g, x, z, s = 1, variant = 0) {
    const t = group(g, x, 0, z); t.scale.setScalar(s);
    box(t, 0, 1.35, 0, .39, 2.7, .4, '#89552e');
    box(t, -.34, 1.91, 0, .88, .25, .25, '#89552e', -.12);
    box(t, .36, 1.58, .05, .84, .24, .24, '#89552e', .17);
    box(t, 0, 3.12, 0, 1.82, 1.62, 1.63, variant ? '#329959' : '#248750', .12);
    box(t, -.69, 2.49, .21, 1.18, .95, 1.24, '#4bb457', -.08);
    box(t, .6, 2.65, .03, 1.34, 1.05, 1.32, '#58b956', .09);
    box(t, -.18, 4.02, 0, 1.13, .44, 1.02, '#7ac862', -.04);
  }
  function pine(g, x, z, s = 1) {
    const t = group(g, x, 0, z); t.scale.setScalar(s);
    box(t, 0, .82, 0, .31, 1.64, .31, '#967651');
    cone(t, 0, 1.7, 0, 1.16, 1.95, '#337b59', 4).rotation.y = Math.PI / 4;
    cone(t, 0, 2.53, 0, .87, 1.7, '#459a6a', 4).rotation.y = Math.PI / 4;
    cone(t, 0, 3.21, 0, .53, 1.4, '#69b581', 4).rotation.y = Math.PI / 4;
  }
  const forest = themes.forest;
  [[-9,-6,1.12],[-6.9,-7.1,1],[-2.5,-7.75,.85],[2.8,-7.7,1],[8.8,-6.7,1.18],[10,-2.5,.92],[-10,-1.5,.84],[-9.9,3.4,.78],[10,6.5,.75],[-5.9,7.3,.63]].forEach((p,i) => tree(forest,...p,i%2));
  [[-4.9,-8,.68],[.4,-8.15,.72],[5.9,-7.9,.79]].forEach((p,i)=>tree(forest,...p,i%2));
  // A little creek stays in the left border of the diorama.
  box(forest, -9.55, .005, 3.2, 1.45, .045, 8.8, '#28b7bd');
  box(forest, -8.82, .01, 6.5, 2.55, .05, 2.2, '#28b7bd');
  box(forest, -9.55, .05, .7, 1.65, .09, 1.25, '#bda47c');
  for (let j = 0; j < 6; j++) box(forest, -10.24 + j * .28, .13, .7, .21, .1, 1.3, '#e0c597');
  for (let j = 0; j < 7; j++) { rock(forest, -8.7 + random() * .2, -1 + j * 1.2, .35); box(forest, -9.8 + random() * .6, .036, -.8 + j * 1.1, .34, .015, .07, '#93e5d8'); }
  [[-7.8,6.9],[7.7,-7.5],[-10.7,-4.2],[10.5,1.1]].forEach(p => rock(forest,...p,.75));
  for (let i = 0; i < 62; i++) {
    const x = (random() - .5) * 21.3, z = (random() - .5) * 16.7;
    if ((Math.abs(x) > 7.1 || z < -6.8 || z > 6.1) && !(x < -8.6 && z > -1.5)) {
      if (i % 3) grass(forest, x, z, .65 + random() * .6);
      else flower(forest, x, z, ['#f5dcb7', '#eed3b8', '#dab2c4'][i % 3], .85);
    }
  }

  const beach = themes.beach;
  function palm(g, x, z, s = 1, rotation = 0) {
    const t = group(g, x, 0, z); t.scale.setScalar(s); t.rotation.y = rotation;
    for (let j = 0; j < 6; j++) box(t, j * .045, .26 + j * .47, 0, .31 - j * .013, .49, .31 - j * .013, j % 2 ? '#a76f35' : '#bd8545');
    for (let j = 0; j < 6; j++) {
      const leaf = group(t, .25, 2.95, 0); leaf.rotation.y = j * Math.PI / 3;
      const stem = box(leaf, 0, .08, .6, .45, .15, 1.5, j % 2 ? '#4cab62' : '#298d58'); stem.rotation.x = -.18;
      const tip = box(leaf, 0, -.22, 1.4, .34, .13, .62, '#63bb61'); tip.rotation.x = .55;
    }
    for (let j = 0; j < 3; j++) box(t, .11 + (j % 2) * .23, 2.7, -.16 + j * .14, .25, .29, .25, '#a38157');
  }
  [[-9.4,-6.5,1.1,0],[8.8,-7.3,1.2,.3],[10,-2.3,.9,.8],[-10.2,1.6,.82,.4],[-8,6.1,.75,1]].forEach(p => palm(beach,...p));
  box(beach, 0, -.02, -8.1, 23.1, .1, 2.1, '#4fc8c7');
  box(beach, 10.5, -.015, 2.1, 2.2, .08, 12.5, '#50c7c6');
  box(beach, 0, -.02, 8.23, 23.1, .1, 1.9, '#50c7c6');
  box(beach, 0, .017, 7.45, 23.15, .025, .23, '#f9efce');
  box(beach, 9.53, .018, 2.5, .18, .03, 10.1, '#f9efce');
  const parasol = group(beach, -7.8, 0, -3.3);
  box(parasol, 0, 1.35, 0, .09, 2.7, .09, '#ae723e');
  cone(parasol, 0, 2.76, 0, 1.33, .53, '#e57a51', 8);
  cone(parasol, 0, 2.84, 0, .94, .48, '#f2d8ab', 8);
  box(parasol, .15, .2, .38, .8, .13, 1.95, '#f5e1b8', -.2);
  box(parasol, .15, .285, .38, .58, .06, 1.84, '#d9a68d', -.2);
  for (let j = 0; j < 18; j++) {
    const x = (random() - .5) * 20, z = j % 2 ? 6.6 : -6.7;
    if (j % 3) rock(beach, x, z, .23 + random() * .25, '#d6c7a3');
    else { box(beach, x, .08, z, .25, .06, .075, '#d8ac91', .7); box(beach, x, .08, z, .075, .06, .25, '#d8ac91', .7); }
  }
  const water = group(scene);
  const waveStrips = [];
  for (let j = 0; j < 8; j++) { const w = box(water, -9 + j * 2.65, .033, 8.05 + (j % 2) * .4, 1.4, .018, .08, '#bceee1'); waveStrips.push(w); }
  for (let j = 0; j < 5; j++) { const w = box(water, 10.4 + (j % 2) * .4, .034, -3.7 + j * 2.4, .075, .018, 1.3, '#bceee1'); waveStrips.push(w); }

  const mountains = themes.mountains;
  function peak(x, z, radius, h, color) {
    const p = cone(mountains, x, h / 2 - .04, z, radius, h, color, 4); p.rotation.y = Math.PI / 4;
    const cap = cone(mountains, x, h - h * .22, z, radius * .445, h * .445, '#eef0de', 4); cap.rotation.y = Math.PI / 4;
  }
  peak(-7.8, -7.3, 3.05, 5.0, '#a9b9ad'); peak(-3.5, -8.0, 2.45, 5.9, '#9faea9'); peak(6.6, -7.8, 3.1, 5.4, '#adb9b3');
  [[-10.2,-4.4,1],[-8.4,-1.4,.85],[9,-5.5,1.2],[10.1,.2,.94],[-9.6,5.4,.7],[7.9,6.7,.78]].forEach(p=>pine(mountains,...p));
  const cabin = group(mountains, 8.4, 0, -1.4);
  box(cabin, 0, 1.02, 0, 2.15, 1.94, 1.8, '#b7834a');
  for(let j=0;j<5;j++) box(cabin, 0, .25+j*.34, .928, 2.2, .065, .08, '#8b5d32');
  const roof1 = box(cabin, -.62, 2.03, 0, 1.53, .19, 2.17, '#6f8d85'); roof1.rotation.z = .57;
  const roof2 = box(cabin, .62, 2.03, 0, 1.53, .19, 2.17, '#87a098'); roof2.rotation.z = -.57;
  box(cabin, -.44, .59, .94, .59, 1.19, .06, '#667d6f');
  box(cabin, .46, 1.2, .948, .58, .54, .06, '#f5dfa6');
  box(cabin, .46, 1.2, .99, .055, .59, .045, '#9b7e5a');
  box(cabin, .46, 1.2, .99, .62, .055, .045, '#9b7e5a');
  box(cabin, .64, 2.61, -.38, .34, .88, .36, '#9da098');
  for(let i=0;i<45;i++) {
    const x=(random()-.5)*21, z=(random()-.5)*16;
    if(Math.abs(x)>7 || z>6.4) { if(i%4) grass(mountains,x,z,.75,'#6ca447'); else flower(mountains,x,z,'#ede7cf',.8); }
  }
  [[-7,6.9,1.1],[10,4.5,.8],[-10,-.5,.9],[4.7,7,.6]].forEach(p=>rock(mountains,...p,'#a5b0a5'));
  Object.values(themes).forEach(bake);

  // A pale underside shadow makes the island float without an expensive contact pass.
  const floor = mesh(scene, geo('box', 200, .1, 200), material('#dcebd9'), 0, -1.6, 0); floor.castShadow = false;
  const selection = new THREE.Mesh(new THREE.RingGeometry(.72, .79, 40), new THREE.MeshBasicMaterial({ color: '#f5da90', side: THREE.DoubleSide, transparent: true, opacity: .95, depthWrite: false }));
  selection.rotation.x = -Math.PI / 2; selection.visible = false; scene.add(selection);

  function updateCamera() {
    const distance = 34;
    camera.position.set(Math.sin(angle) * Math.cos(elevation) * distance, Math.sin(elevation) * distance, Math.cos(angle) * Math.cos(elevation) * distance);
    camera.lookAt(lookAt);
    // Fit the complete diorama in either a tall or wide panel.
    const aspect = width / height;
    const halfY = Math.max(10.0, 15.2 / aspect);
    camera.left = -halfY * aspect; camera.right = halfY * aspect; camera.top = halfY; camera.bottom = -halfY;
    camera.updateProjectionMatrix();
  }
  function resize() {
    width = Math.max(1, host.clientWidth); height = Math.max(1, host.clientHeight);
    renderer.setSize(width, height, false); updateCamera();
  }
  const observer = new ResizeObserver(resize); observer.observe(host); resize();

  let pointerStartX = 0, pointerStartY = 0, lastX = 0, lastY = 0, dragged = false, pointerId = null;
  function pointerDown(event) {
    if (pointerId !== null) return;
    renderer.domElement.focus({ preventScroll: true });
    pointerId = event.pointerId; lastX = pointerStartX = event.clientX; lastY = pointerStartY = event.clientY; dragged = false;
    renderer.domElement.setPointerCapture?.(event.pointerId);
  }
  function pointerMove(event) {
    if (pointerId !== event.pointerId) return;
    if (Math.hypot(event.clientX-pointerStartX,event.clientY-pointerStartY)>5) dragged = true;
    if (dragged) { angle -= (event.clientX-lastX) * .006; elevation = THREE.MathUtils.clamp(elevation+(event.clientY-lastY)*.004,.4,1.05); updateCamera(); }
    lastX=event.clientX;lastY=event.clientY;
  }
  function pointerUp(event) {
    if (pointerId !== event.pointerId) return;
    if (!dragged) {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set((event.clientX-rect.left)/width*2-1,-(event.clientY-rect.top)/height*2+1);
      raycaster.setFromCamera(pointer,camera);
      const hits=raycaster.intersectObjects(hitBoxes,false);
      if(hits.length) { selected = agents.find(a=>a.id===hits[0].object.userData.agentId); onSelect(selected.id); }
    }
    if(renderer.domElement.hasPointerCapture?.(event.pointerId)) renderer.domElement.releasePointerCapture(event.pointerId);
    pointerId=null;
  }
  function pointerCancel() { pointerId=null; dragged=false; }
  function keyDown(event) {
    if(event.key==='ArrowLeft') angle-=.12;
    else if(event.key==='ArrowRight') angle+=.12;
    else if(event.key==='ArrowUp') elevation=THREE.MathUtils.clamp(elevation+.07,.4,1.05);
    else if(event.key==='ArrowDown') elevation=THREE.MathUtils.clamp(elevation-.07,.4,1.05);
    else if(event.key.toLowerCase()==='r'||event.key==='Home') { resetCamera();event.preventDefault();return; }
    else return;
    event.preventDefault();updateCamera();
  }
  renderer.domElement.addEventListener('pointerdown',pointerDown);
  renderer.domElement.addEventListener('pointermove',pointerMove);
  renderer.domElement.addEventListener('pointerup',pointerUp);
  renderer.domElement.addEventListener('pointercancel',pointerCancel);
  renderer.domElement.addEventListener('keydown',keyDown);

  function routePoint(a, progress, result) {
    // Step to the side of the workstation before joining the plaza.
    // These shared aisles keep walkers out of the furniture.
    const xs=a.routeXs, zs=a.routeZs, lengths=a.routeLengths;
    let distance=progress*(lengths[0]+lengths[1]+lengths[2]);
    for(let i=0;i<3;i++) {
      if(distance<=lengths[i]||i===2) {
        const part=lengths[i]>0?Math.min(1,distance/lengths[i]):1;
        result.x=THREE.MathUtils.lerp(xs[i],xs[i+1],part);result.z=THREE.MathUtils.lerp(zs[i],zs[i+1],part);
        result.facing=Math.atan2(xs[i+1]-xs[i],zs[i+1]-zs[i]);return;
      }
      distance-=lengths[i];
    }
  }
  const route={x:0,z:0,facing:0};
  function pose(a, dt) {
    const t = elapsed + a.phase;
    // Staggered 30 s routines: desk → shared path → coffee / conversation → desk.
    // Everyone already has a different phase, so movement is visible immediately.
    const cycle = t % 30;
    if(cycle<a.lastCycle) a.routineWorking=a.working;
    a.lastCycle=cycle;
    const homeX = a.home.x, homeZ = a.home.z;
    const meetingX = a.x < 0 ? -1.35 : 1.35;
    const meetingZ = a.z > 0 ? 1.25 : -1.0;
    let targetX = homeX, targetZ = homeZ, facing = 0, walking = false, social = false;
    const start = a.routineWorking ? 14 : 6;
    const walkDuration=a.routineWorking?4:5;
    const walkEnd = start+walkDuration, pauseEnd = walkEnd+(a.routineWorking?3:5), returnEnd = pauseEnd+walkDuration;
    if(cycle>=start && cycle<walkEnd) {
      routePoint(a,(cycle-start)/walkDuration,route);
      targetX=route.x;targetZ=route.z;facing=route.facing;
      walking=true;
    } else if(cycle>=walkEnd && cycle<pauseEnd) {
      targetX=meetingX;targetZ=meetingZ;facing=meetingX<0?Math.PI/2:-Math.PI/2;social=true;
    } else if(cycle>=pauseEnd && cycle<returnEnd) {
      const progress=(cycle-pauseEnd)/(returnEnd-pauseEnd);
      routePoint(a,1-progress,route);
      targetX=route.x;targetZ=route.z;facing=route.facing+Math.PI;
      walking=true;
    }
    if(quiet) { targetX=a.root.position.x; targetZ=a.root.position.z;walking=false;social=false;facing=a.root.rotation.y; }
    a.root.position.x = THREE.MathUtils.damp(a.root.position.x,targetX,10,dt);
    a.root.position.z = THREE.MathUtils.damp(a.root.position.z,targetZ,10,dt);
    let deltaAngle = Math.atan2(Math.sin(facing-a.root.rotation.y),Math.cos(facing-a.root.rotation.y));
    a.root.rotation.y += deltaAngle * Math.min(1,dt*9);
    a.walking=walking;
    const stride = Math.sin(t*8.5), breath = quiet ? 0 : Math.sin(t*2.2)*.018;
    a.visual.position.y=breath+(walking?Math.abs(Math.cos(t*8.5))*.035:0);
    a.head.rotation.y=quiet?0:walking?0:Math.sin(t*.65)*.095;
    a.head.rotation.z=social&&!quiet?Math.sin(t*2)*.05:0;
    for(let i=0;i<2;i++) {
      const sign=i===0?1:-1;
      a.legs[i].rotation.x=walking?stride*.53*sign:0;
      a.knees[i].rotation.x=walking?Math.max(0,-stride*sign)*.34:0;
      if(walking) { a.arms[i].rotation.x=-stride*.43*sign; a.elbows[i].rotation.x=-.22; a.arms[i].rotation.z=sign*.035; }
      else if(social) { a.arms[i].rotation.x=-.35-Math.max(0,Math.sin(t*2.3+i))*.35; a.elbows[i].rotation.x=-.7; a.arms[i].rotation.z=sign*.1; }
      else { a.arms[i].rotation.x=quiet?-.25:-.5+Math.sin(t*(a.working?9:4)+i*2)*.06; a.elbows[i].rotation.x=quiet?-.18:-.75+Math.sin(t*(a.working?11:5)+i*2)*.075; a.arms[i].rotation.z=sign*.04; }
    }
    a.halo.material.opacity=selected===a?.5:.2;
    a.halo.scale.setScalar(a.working?1.08:1);
  }
  let lastTime = performance.now();
  function animate(now) {
    if(disposed) return;
    const dt=Math.min((now-lastTime)/1000,.06);lastTime=now;
    if(!quiet) elapsed+=dt;
    for(const a of agents) pose(a,dt);
    if(theme==='beach'&&!quiet) waveStrips.forEach((w,i)=>{ w.scale.x=1+Math.sin(elapsed*1.1+i)*.15;w.position.y=.035+Math.sin(elapsed*.8+i)*.011;w.material.opacity=.7; });
    screens.forEach((s,i)=>{s.material.emissiveIntensity=quiet?.22:.2+(Math.sin(elapsed*1.6+i)*.5+.5)*.25;});
    if(selected) { selection.visible=true;selection.position.set(selected.root.position.x,.14,selected.root.position.z); }
    renderer.render(scene,camera);
    for(const a of agents) {
      scratch.set(a.root.position.x,3.0+a.visual.position.y,a.root.position.z).project(camera);
      a.position.x=(scratch.x*.5+.5)*width;a.position.y=(-scratch.y*.5+.5)*height;
      a.position.visible=scratch.z>-1&&scratch.z<1&&scratch.x>-1.12&&scratch.x<1.12&&scratch.y>-1.12&&scratch.y<1.12;
    }
    onPositions(labels);
    frame=requestAnimationFrame(animate);
  }
  function setLandscape(name) {
    const aliases={foresta:'forest',bosco:'forest',spiaggia:'beach',montagna:'mountains',mountain:'mountains'};
    theme=aliases[name]||name;if(!themes[theme]) theme='forest';
    Object.entries(themes).forEach(([key,g])=>g.visible=key===theme);water.visible=theme==='beach';
    const palette=theme==='beach'?['#dbebe4','#ebcf87','#bc965e']:theme==='mountains'?['#d9e8e2','#93b75d','#899d79']:['#d4e9d5','#78b748','#99733e'];
    scene.background.set(palette[0]);floor.material.color.set(palette[0]);baseMat.color.set(palette[1]);earthMat.color.set(palette[2]);
  }
  function setAgentStatus(id,status) {
    const a=agents.find(person=>person.id===id);if(!a)return;
    a.status=status;a.working=/lavor|work|busy|active|thinking|running|scriv|pens|coordin/i.test(String(status));
  }
  function setQuiet(value) { quiet=!!value; }
  function resetCamera() { angle=.62;elevation=.72;updateCamera(); }
  function dispose() {
    disposed=true;cancelAnimationFrame(frame);observer.disconnect();
    const canvas=renderer.domElement;
    canvas.removeEventListener('pointerdown',pointerDown);canvas.removeEventListener('pointermove',pointerMove);canvas.removeEventListener('pointerup',pointerUp);canvas.removeEventListener('pointercancel',pointerCancel);
    canvas.removeEventListener('keydown',keyDown);
    geometryCache.forEach(g=>g.dispose());mergedGeometries.forEach(g=>g.dispose());mats.forEach(m=>m.dispose());
    agents.forEach(a=>{a.hit.material.dispose();a.halo.material.dispose();a.halo.geometry.dispose();});
    selection.material.dispose();selection.geometry.dispose();renderer.dispose();canvas.remove();
  }
  setLandscape('forest');
  quiet=window.matchMedia?.('(prefers-reduced-motion: reduce)').matches||false;
  frame=requestAnimationFrame(animate);
  return { setLandscape,setAgentStatus,setQuiet,resetCamera,dispose };
}
