import * as THREE from './vendor/three.module.js';

export const WORLD_EXTENT = Object.freeze({ width: 180, depth: 150 });

const destinations = (items) => items.map(([id, label, x, z]) => ({ id, label, x, z, zoom: .45 }));
export const WORLD_LANDMARKS = Object.freeze({
  anthill: destinations([
    ['tronco-cavo', 'Tronco cavo', -52, -38],
    ['granai-colonia', 'Granai della colonia', 52, -36],
    ['giardini-rugiada', 'Giardini di rugiada', -57, 38],
    ['cava-ambra', 'Cava d’ambra', 56, 40],
    ['piazza-radici', 'Piazza delle radici', 0, 58]
  ]),
  forest: destinations([
    ['cascata', 'Cascata dei salici', -54, -39],
    ['rovine', 'Rovine nel bosco', 53, -39],
    ['ponte-sospeso', 'Ponte sospeso', -52, 35],
    ['radura-lucciole', 'Radura delle lucciole', 52, 37],
    ['grande-quercia', 'La grande quercia', 0, 57]
  ]),
  beach: destinations([
    ['faro', 'Faro delle maree', -56, -39],
    ['porto', 'Porto dei pescatori', 52, 36],
    ['arco-roccia', 'Arco sul mare', 55, -40],
    ['dune', 'Dune dorate', -53, 37],
    ['isola-coralli', 'Isola dei coralli', 0, 58]
  ]),
  mountains: destinations([
    ['osservatorio', 'Osservatorio alpino', -52, -40],
    ['viadotto', 'Viadotto di pietra', 51, 36],
    ['tornanti', 'Sentiero dei tornanti', 53, -40],
    ['rifugio', 'Rifugio delle stelle', -54, 37],
    ['lago-alpino', 'Lago alpino', 0, 58]
  ])
});

/* The original campus keeps its complete 60 × 50 clearing. The surrounding
 * districts are deterministic, spatially baked miniatures: distant geography
 * survives every quality tier, while small details have a shorter draw range. */
export function createWorldExpanse({ scene, group, mesh, geo, material, bake }) {
  const root = group(scene);
  root.name = 'world-expanse';
  const worlds = new Map();
  const ownedGeometries = [];
  const ownedMaterials = [];
  let active = null;
  let state = { x: 0, z: 0, viewRadius: 70, quality: 'balanced', elapsed: 0, night: false, quiet: false };

  // All construction primitives share unit geometries, including scaled rocks.
  // A different tree size never creates another geometry in the world cache.
  const cube = (g, x, y, z, w, h, d, color, rotation = 0) => {
    const part = mesh(g, geo('box', 1, 1, 1), color, x, y, z);
    part.scale.set(w, h, d); part.rotation.y = rotation; return part;
  };
  const cylinder = (g, x, y, z, radius, height, color, taper = 1, sides = 8) => {
    const part = mesh(g, geo('cylinder', taper, 1, 1, sides), color, x, y, z);
    part.scale.set(radius, height, radius); return part;
  };
  const peak = (g, x, y, z, radius, height, color, sides = 6) => {
    const part = mesh(g, geo('cone', 1, 1, sides), color, x, y, z);
    part.scale.set(radius, height, radius); return part;
  };
  const stone = (g, x, y, z, w, h, d, color, rotation = 0) => {
    const part = mesh(g, geo('ico', 1, 0), color, x, y, z);
    part.scale.set(w, h, d); part.rotation.set(.08, rotation, -.08); return part;
  };
  const up = new THREE.Vector3(0, 1, 0);
  const beam = (parent, from, to, radius, color) => {
    const start = new THREE.Vector3(...from), end = new THREE.Vector3(...to);
    const direction = end.clone().sub(start), length = direction.length();
    const part = mesh(parent, geo('cylinder', 1, 1, 1, 6), color, (start.x + end.x) / 2, (start.y + end.y) / 2, (start.z + end.z) / 2);
    part.scale.set(radius, length, radius);
    part.quaternion.setFromUnitVectors(up, direction.normalize()); return part;
  };
  const randomFor = (initial) => {
    let seed = initial;
    return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  };
  const outsideCampus = (x, z, padding = 0) => Math.abs(x) > 30.25 + padding || Math.abs(z) > 25.25 + padding;
  const withinWorld = (x, z, padding = 0) => Math.abs(x) < 89 - padding && Math.abs(z) < 74 - padding;

  const palettes = {
    anthill: { ground: ['#adad69', '#a5a25b', '#bdb371'], hill: ['#a99c57', '#bca56a', '#cdb57b'], path: '#dac396', edge: '#a68b58', rock: '#ac895b', trunk: '#776047', greens: ['#5e8745', '#73974c', '#90a957'] },
    forest: { ground: ['#7caa64', '#91b874', '#719958'], hill: ['#648552', '#72965c', '#91ae70'], path: '#c6b88c', edge: '#6d8c5b', rock: '#839383', trunk: '#72513d', greens: ['#397253', '#4a8760', '#689a62'] },
    beach: { ground: ['#e6d19b', '#ecdcae', '#d9c590'], hill: ['#cbb984', '#e1ce96', '#f1dfaa'], path: '#f4e5bd', edge: '#ceb783', rock: '#af9d83', trunk: '#99734e', greens: ['#4c9470', '#63a776', '#83b982'] },
    mountains: { ground: ['#96aa8c', '#a5b398', '#8a9f86'], hill: ['#85958c', '#9ba49a', '#b0b8a5'], path: '#d6d0b5', edge: '#829183', rock: '#8a9791', trunk: '#695848', greens: ['#3d6b59', '#477c65', '#66947a'] }
  };

  function chunkAt(world, x, z) {
    const column = Math.max(0, Math.min(5, Math.floor((x + 90) / 30)));
    const row = Math.max(0, Math.min(4, Math.floor((z + 75) / 30)));
    const key = `${column}:${row}`;
    if (!world.chunks.has(key)) {
      const main = group(world.root), detail = group(world.root);
      main.name = `landscape-${key}`; detail.name = `undergrowth-${key}`;
      world.chunks.set(key, { x: -75 + column * 30, z: -60 + row * 30, radius: 39, main, detail });
    }
    return world.chunks.get(key);
  }
  const landscape = (world, x, z, detail = false) => chunkAt(world, x, z)[detail ? 'detail' : 'main'];
  const local = (world, x, z, y = 0, detail = false) => group(landscape(world, x, z, detail), x, y, z);

  function geometryMesh(parent, positions, color, colors = null) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    if (colors) geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.computeVertexNormals();
    // Originals are released once baked, and never enter the shared primitive cache.
    ownedGeometries.push(geometry);
    return mesh(parent, geometry, colors ? material(color, { vertexColors: true }) : color, 0, 0, 0);
  }

  function mound(world, x, z, rx, rz, height, colors = world.palette.hill, rotation = 0) {
    const parent = landscape(world, x, z), vertices = [], paint = [];
    const rings = 5, sides = 14;
    const samples = [];
    for (let ring = 0; ring <= rings; ring++) {
      const radius = ring / rings;
      samples.push(Array.from({ length: sides }, (_, side) => {
        const angle = side / sides * Math.PI * 2;
        const wobble = 1 + Math.sin(angle * 3 + x) * .07 + Math.cos(angle * 5 + z) * .035;
        const px = Math.cos(angle) * radius * rx * wobble, pz = Math.sin(angle) * radius * rz * wobble;
        return [x + px * Math.cos(rotation) - pz * Math.sin(rotation), -.057 + height * Math.pow(Math.max(0, 1 - radius * radius), 1.6), z + px * Math.sin(rotation) + pz * Math.cos(rotation)];
      }));
    }
    const tint = colors.map((color) => new THREE.Color(color));
    const triangle = (a, b, c, shade) => {
      vertices.push(...a, ...b, ...c);
      const color = tint[shade];
      for (let j = 0; j < 3; j++) paint.push(color.r, color.g, color.b);
    };
    for (let ring = 0; ring < rings; ring++) for (let side = 0; side < sides; side++) {
      const next = (side + 1) % sides;
      const shade = ring < 2 ? 2 : (side + ring) % 5 === 0 ? 0 : 1;
      triangle(samples[ring][side], samples[ring + 1][next], samples[ring + 1][side], shade);
      if (ring) triangle(samples[ring][side], samples[ring][next], samples[ring + 1][next], shade);
    }
    return geometryMesh(parent, vertices, '#ffffff', paint);
  }

  function oval(world, x, z, rx, rz, color, y = -.04, rotation = 0, detail = false) {
    const g = landscape(world, x, z, detail), positions = [], count = 24;
    for (let i = 0; i < count; i++) {
      const a = i / count * Math.PI * 2, b = (i + 1) / count * Math.PI * 2;
      const point = (angle) => {
        const wobble = 1 + Math.sin(angle * 3 + x) * .035;
        const px = Math.cos(angle) * rx * wobble, pz = Math.sin(angle) * rz * wobble;
        return [x + px * Math.cos(rotation) - pz * Math.sin(rotation), y, z + px * Math.sin(rotation) + pz * Math.cos(rotation)];
      };
      positions.push(x, y, z, ...point(b), ...point(a));
    }
    geometryMesh(g, positions, color);
  }

  function path(world, points, width = 1.5, color = world.palette.path, edge = world.palette.edge, surface = null) {
    const curve = new THREE.CatmullRomCurve3(points.map(([x, z, y = .015]) => new THREE.Vector3(x, y, z)), false, 'centripetal');
    const length = curve.getLength(), steps = Math.max(8, Math.ceil(length / 1.6));
    const samples = curve.getPoints(steps);
    const ribbons = new Map();
    const offsetAt = (index, size) => {
      const before = samples[Math.max(0, index - 1)], after = samples[Math.min(steps, index + 1)];
      const dx = after.x - before.x, dz = after.z - before.z;
      const factor = size / 2 / Math.max(.001, Math.hypot(dx, dz));
      return [-dz * factor, dx * factor];
    };
    for (let i = 0; i < steps; i++) {
      const a = samples[i], b = samples[i + 1];
      const parent = landscape(world, (a.x + b.x) / 2, (a.z + b.z) / 2);
      if (!ribbons.has(parent)) ribbons.set(parent, [[], []]);
      [width + .48, width].forEach((size, layer) => {
        const [ax, az] = offsetAt(i, size), [bx, bz] = offsetAt(i + 1, size), rise = layer * .024;
        const vertex = (sample, dx, dz) => [sample.x + dx, (surface ? surface(sample.x + dx, sample.z + dz) : sample.y) + rise, sample.z + dz];
        // Adjacent segments share exactly the same corners. Independent normals
        // leave visible triangular cracks on broad curves at close zoom.
        const va = vertex(a, ax, az), vb = vertex(a, -ax, -az);
        const vc = vertex(b, bx, bz), vd = vertex(b, -bx, -bz);
        ribbons.get(parent)[layer].push(...va, ...vc, ...vb, ...vb, ...vc, ...vd);
      });
    }
    ribbons.forEach((layers, parent) => {
      geometryMesh(parent, layers[0], edge); geometryMesh(parent, layers[1], color);
    });
    world.routes.push({ samples, width });
  }

  function nearPath(world, x, z, clearance = 1) {
    for (const route of world.routes) for (let i = 0; i < route.samples.length; i += 2) {
      const point = route.samples[i];
      if (Math.hypot(point.x - x, point.z - z) < route.width / 2 + clearance) return true;
    }
    return false;
  }

  function pond(world, x, z, rx, rz, color = '#65b6b0') {
    oval(world, x, z, rx + 1.15, rz + 1.05, world.name === 'beach' ? '#f4e4b7' : '#a8ad86', -.039);
    oval(world, x, z, rx, rz, color, -.014);
    oval(world, x - rx * .15, z - rz * .1, rx * .75, rz * .74, world.name === 'beach' ? '#5caead' : '#539b9b', -.006);
    oval(world, x - rx * .2, z - rz * .15, rx * .46, rz * .51, world.name === 'beach' ? '#45979e' : '#45888e', -.002);
    const g = landscape(world, x, z, true);
    for (let i = 0; i < 11; i++) {
      const angle = i * 2.399;
      const px = x + Math.cos(angle) * rx * .8, pz = z + Math.sin(angle) * rz * .8;
      cube(g, px, .025, pz, .45 + (i % 4) * .36, .018, .055, '#bce5d8', .12);
    }
  }

  function broadleaf(world, x, z, size = 1, variant = 0, y = -.025) {
    const g = local(world, x, z, y), colors = world.palette.greens;
    g.rotation.y = world.random() * Math.PI * 2;
    cylinder(g, 0, 1.6 * size, 0, .23 * size, 3.2 * size, world.palette.trunk, .66, 6);
    for (const side of [-1, 1]) {
      beam(g, [0, 1.75 * size, 0], [side * .85 * size, 3.2 * size, .2 * size], .11 * size, world.palette.trunk);
      stone(g, side * .9 * size, 3.7 * size, .15 * size, 1.6 * size, 1.45 * size, 1.42 * size, colors[(variant + (side === 1 ? 1 : 0)) % 3], side * .2);
    }
    stone(g, 0, 4.6 * size, 0, 1.75 * size, 1.65 * size, 1.6 * size, colors[(variant + 2) % 3], .4);
    if (size > 1.45) for (let i = 0; i < 3; i++) {
      const a = i * 2.094;
      beam(g, [Math.cos(a) * .8 * size, 0, Math.sin(a) * .8 * size], [0, .8 * size, 0], .13 * size, world.palette.trunk);
    }
  }

  function pine(world, x, z, size = 1, y = -.025, variant = 0) {
    const g = local(world, x, z, y), colors = world.palette.greens;
    cylinder(g, 0, 1.7 * size, 0, .2 * size, 3.4 * size, world.palette.trunk, .7, 5);
    for (let layer = 0; layer < 3; layer++) {
      const part = peak(g, 0, (2.15 + layer * 1.03) * size, 0, (1.7 - layer * .39) * size, 2.6 * size, colors[(layer + variant) % 3]);
      part.rotation.y = layer * .55;
      if (world.name === 'mountains' && variant === 2) peak(g, 0, (2.94 + layer * 1.03) * size, 0, (.56 - layer * .12) * size, 1 * size, '#e6ebe0');
    }
  }

  function palm(world, x, z, size = 1, y = -.02) {
    const g = local(world, x, z, y);
    const lean = (world.random() - .5) * .9;
    for (let segment = 0; segment < 4; segment++) {
      const a = [lean * segment * segment * .075 * size, segment * 1.15 * size, 0];
      const b = [lean * (segment + 1) ** 2 * .075 * size, (segment + 1) * 1.15 * size, 0];
      beam(g, a, b, (.22 - segment * .027) * size, segment % 2 ? '#a27d52' : '#ba9464');
    }
    const crown = group(g, lean * 1.2 * size, 4.55 * size, 0);
    for (let i = 0; i < 7; i++) {
      const angle = i / 7 * Math.PI * 2, dx = Math.cos(angle), dz = Math.sin(angle);
      const leaf = [0, .05, 0, dx * 1.25 * size + dz * .4 * size, .3 * size, dz * 1.25 * size - dx * .4 * size, dx * 2.5 * size, -.65 * size, dz * 2.5 * size, dx * 1.25 * size - dz * .4 * size, .3 * size, dz * 1.25 * size + dx * .4 * size];
      geometryMesh(crown, [...leaf.slice(0, 3), ...leaf.slice(6, 9), ...leaf.slice(3, 6), ...leaf.slice(0, 3), ...leaf.slice(9, 12), ...leaf.slice(6, 9), ...leaf.slice(0, 3), ...leaf.slice(3, 6), ...leaf.slice(6, 9), ...leaf.slice(0, 3), ...leaf.slice(6, 9), ...leaf.slice(9, 12)], world.palette.greens[i % 3]);
    }
    for (let i = 0; i < 3; i++) stone(crown, (i - 1) * .22 * size, -.2 * size, .05, .19 * size, .23 * size, .19 * size, '#86623e');
  }

  function shrub(world, x, z, size = 1, detail = false, color = null) {
    const g = landscape(world, x, z, detail);
    stone(g, x, size * .45, z, size, size * .65, size * .82, color || world.palette.greens[1], x);
    stone(g, x + size * .5, size * .3, z + size * .2, size * .55, size * .45, size * .6, color || world.palette.greens[2], z);
  }

  function grass(world, x, z, size = 1, color = null) {
    const g = landscape(world, x, z, true), tint = color || world.palette.greens[2];
    for (let i = 0; i < 3; i++) {
      const stalk = peak(g, x + (i - 1) * .14 * size, .3 * size, z + (i % 2) * .12 * size, .11 * size, (.45 + i * .08) * size, tint, 3);
      stalk.rotation.z = (i - 1) * .23;
    }
  }

  function flower(world, x, z, size = 1, color = '#e9c96b') {
    const g = landscape(world, x, z, true);
    cylinder(g, x, .3 * size, z, .025 * size, .6 * size, '#66834d', 1, 4);
    for (let i = 0; i < 5; i++) {
      const a = i * Math.PI * .4;
      stone(g, x + Math.cos(a) * .13 * size, .64 * size, z + Math.sin(a) * .13 * size, .11 * size, .08 * size, .11 * size, color);
    }
    stone(g, x, .69 * size, z, .07 * size, .05 * size, .07 * size, '#c39949');
  }

  function mushroom(world, x, z, size = 1, color = '#c87556', detail = false) {
    const g = landscape(world, x, z, detail);
    cylinder(g, x, .43 * size, z, .13 * size, .85 * size, '#e8d9ad', .84, 6);
    stone(g, x, .87 * size, z, .68 * size, .29 * size, .68 * size, color, x);
    if (size > 1.8) for (let i = 0; i < 4; i++) stone(g, x + Math.cos(i * 1.9) * .36 * size, 1.08 * size, z + Math.sin(i * 1.9) * .32 * size, .1 * size, .03 * size, .09 * size, '#eee0b7');
  }

  function rockCluster(world, x, z, size = 1, color = world.palette.rock) {
    const g = landscape(world, x, z);
    for (let i = 0; i < 4; i++) {
      const angle = i * 2.4, radius = i ? size * .75 : 0;
      stone(g, x + Math.cos(angle) * radius, size * (.48 - i * .065), z + Math.sin(angle) * radius, size * (.9 - i * .1), size * (.82 - i * .13), size * (.85 - i * .1), i === 2 ? world.palette.hill[2] : color, angle);
    }
  }

  function bench(world, x, z, rotation = 0) {
    const g = local(world, x, z); g.rotation.y = rotation;
    cube(g, 0, .64, 0, 2.1, .13, .66, '#bb9362');
    cube(g, 0, 1.02, -.28, 2.1, .28, .09, '#b38959');
    for (const side of [-.8, .8]) { cube(g, side, .33, 0, .15, .66, .56, '#59645a'); cube(g, side, .81, -.28, .12, .55, .1, '#59645a'); }
  }

  function signpost(world, x, z, rotation = 0) {
    const g = local(world, x, z); g.rotation.y = rotation;
    cylinder(g, 0, .95, 0, .095, 1.9, '#8e704b', 1, 5);
    cube(g, .16, 1.7, 0, 1.45, .32, .13, '#e3c793', -.04);
    cube(g, -.13, 1.28, 0, 1.14, .3, .13, '#bb955e', .06);
    for (let i = 0; i < 3; i++) cube(g, -.24 + i * .24, 1.7, .071, .13, .04, .014, '#896b44');
  }

  function bridge(world, x, z, length, width = 3, rotation = 0, height = .9, rope = false) {
    const g = local(world, x, z); g.rotation.y = rotation;
    const steps = Math.ceil(length / .42);
    for (let i = 0; i < steps; i++) {
      const pz = -length / 2 + (i + .5) * length / steps;
      const y = height + (rope ? -.4 : .55) * Math.sin((i + .5) / steps * Math.PI);
      cube(g, 0, y, pz, width, .13, length / steps - .035, i % 3 ? '#b49065' : '#cfab77');
    }
    for (const side of [-1, 1]) {
      const xSide = side * (width / 2 + .09);
      for (let i = 0; i <= 8; i++) {
        const pz = -length / 2 + length * i / 8;
        const y = height + (rope ? -.4 : .55) * Math.sin(i / 8 * Math.PI);
        cylinder(g, xSide, y + .56, pz, .09, 1.3, '#80664d', 1, 5);
        if (i) {
          const lastY = height + (rope ? -.4 : .55) * Math.sin((i - 1) / 8 * Math.PI);
          beam(g, [xSide, lastY + 1.14, -length / 2 + length * (i - 1) / 8], [xSide, y + 1.14, pz], rope ? .045 : .065, rope ? '#d7c59c' : '#8d7352');
          if (rope) beam(g, [xSide, lastY + .35, -length / 2 + length * (i - 1) / 8], [xSide, y + .35, pz], .036, '#bbaa7d');
        }
      }
    }
    return g;
  }

  function layRoutes(world) {
    const width = world.name === 'anthill' ? 2.35 : 1.7;
    path(world, [[-30.5, 0], [-37, -3], [-41, -18], [-52, -38], [-69, -50], [-38, -59], [0, -58], [31, -59], [53, -39], [69, -18], [73, 7], [60, 34], [48, 49], [24, 59], [0, 58], [-25, 59], [-49, 49], [-57, 36], [-72, 18], [-71, -6], [-53, -17], [-37, -3]], width);
    path(world, [[30.5, 0], [37, -1], [43, -18], [53, -39]], width);
    path(world, [[37, -1], [43, 15], [54, 35], [60, 48]], width);
    path(world, [[0, -25.5], [-3, -34], [8, -43], [0, -58]], width);
    path(world, [[0, 25.5], [5, 34], [-3, 45], [0, 58]], width);
    path(world, [[-30.5, 18], [-40, 21], [-52, 35], [-57, 47]], width);
    path(world, [[30.5, 21], [38, 29], [52, 37]], width);
    [[-36, -4], [37, 0], [3, 35], [-5, -35], [-47, 29], [45, 30]].forEach(([x, z], i) => signpost(world, x, z, i * .7));
  }

  function scatterDistrict(world, { x, z, rx, rz, count, type = 'tree', size = 1, rotation = 0 }) {
    const random = world.random;
    for (let i = 0, attempts = 0; i < count && attempts < count * 6; attempts++) {
      const angle = random() * Math.PI * 2, radius = Math.sqrt(random());
      const px = Math.cos(angle) * rx * radius, pz = Math.sin(angle) * rz * radius;
      const tx = x + px * Math.cos(rotation) - pz * Math.sin(rotation), tz = z + px * Math.sin(rotation) + pz * Math.cos(rotation);
      const scale = size * (.7 + random() * .6);
      if (!outsideCampus(tx, tz, scale * 2.2) || !withinWorld(tx, tz, scale * 2.5) || nearPath(world, tx, tz, scale * 1.6)) continue;
      if (WORLD_LANDMARKS[world.name].some((site) => Math.hypot(tx - site.x, tz - site.z) < 10)) continue;
      if (type === 'pine') pine(world, tx, tz, scale, -.025, i % 3);
      else if (type === 'palm') palm(world, tx, tz, scale);
      else if (type === 'rock') rockCluster(world, tx, tz, scale);
      else if (type === 'mushroom') mushroom(world, tx, tz, scale, i % 3 ? '#b97952' : '#dca663');
      else broadleaf(world, tx, tz, scale, i % 3);
      if (i % 3 === 0) shrub(world, tx + scale * 1.3, tz + scale * .8, scale * .75);
      if (i % 4 === 0) grass(world, tx - scale, tz + scale * 1.5, scale * .9);
      i++;
    }
  }

  function surfaceDetails(world) {
    const random = world.random;
    for (let i = 0; i < 420; i++) {
      const x = (random() - .5) * 174, z = (random() - .5) * 144;
      if (!outsideCampus(x, z, 2) || nearPath(world, x, z, 1.8)) continue;
      if (world.name === 'beach' && (Math.abs(x) > 67 || Math.abs(z) > 59)) continue;
      const color = world.palette.ground[i % 3];
      oval(world, x, z, 1 + random() * 1.8, .7 + random(), color, -.046, random() * 6, true);
      if (i % 3 === 0) grass(world, x, z, .7 + random(), world.name === 'beach' ? '#a4b381' : null);
      if (i % 9 === 0) flower(world, x + .4, z + .4, .8 + random() * .5, world.name === 'forest' ? '#cab4dd' : '#ead18b');
      if (i % 13 === 0) stone(landscape(world, x, z, true), x, .14, z, .3, .21, .24, world.palette.hill[2], random());
    }
  }

  function hollowLog(world, x, z, length = 18, radius = 3.2, rotation = -.12) {
    const g = local(world, x, z); g.rotation.y = rotation;
    const positions = [], colors = [], sides = 14;
    const paints = ['#866142', '#644b38', '#cea576'].map((value) => new THREE.Color(value));
    const point = (end, angle, inner = false) => [end * length / 2, radius + Math.sin(angle) * (radius - (inner ? .48 : 0)), Math.cos(angle) * (radius - (inner ? .48 : 0))];
    const quad = (a, b, c, d, tint) => {
      positions.push(...a, ...b, ...c, ...a, ...c, ...d);
      for (let i = 0; i < 6; i++) colors.push(paints[tint].r, paints[tint].g, paints[tint].b);
    };
    for (let i = 0; i < sides; i++) {
      const a = i / sides * Math.PI * 2, b = (i + 1) / sides * Math.PI * 2;
      quad(point(1, a), point(1, b), point(-1, b), point(-1, a), 0);
      quad(point(-1, a, true), point(-1, b, true), point(1, b, true), point(1, a, true), 1);
      for (const end of [-1, 1]) {
        const ring = [point(end, a), point(end, a, true), point(end, b, true), point(end, b)];
        if (end < 0) ring.reverse();
        quad(...ring, 2);
      }
      if (i < 7) {
        const y = radius + Math.sin(a) * (radius + .015), pz = Math.cos(a) * (radius + .015);
        for (let segment = 0; segment < 4; segment++) {
          const stick = cube(g, -length * .375 + segment * length * .25, y, pz, length * .23, .09, .11, i % 2 ? '#9b7350' : '#755139');
          stick.rotation.x = Math.PI / 2 - a;
        }
      }
    }
    geometryMesh(g, positions, '#ffffff', colors);
    for (const side of [-1, 1]) {
      const branch = cylinder(g, side * 3.8, radius * 1.6, -.5, .64, 3.1, '#826041', .66, 7);
      branch.rotation.z = side * .65;
      stone(g, side * 3, radius * 1.96, .1, 2.6, .2, 1.1, '#749448');
    }
    for (let i = 0; i < 13; i++) {
      const px = -length / 2 + 1 + i * (length - 2) / 12;
      cube(g, px, .13, 0, .72, .16, 3.15, i % 2 ? '#bd965d' : '#d2ad73');
    }
  }

  function acornHouse(world, x, z, size = 1) {
    const g = local(world, x, z);
    cylinder(g, 0, 1.75 * size, 0, 1.45 * size, 3.5 * size, '#c5a273', .84, 10);
    cylinder(g, 0, 3.35 * size, 0, 1.69 * size, .7 * size, '#8c6c45', .91, 10);
    peak(g, 0, 4.2 * size, 0, 1.8 * size, 1.65 * size, '#9d7e4b', 10);
    cylinder(g, 0, 5.06 * size, 0, .17 * size, .7 * size, '#76583b', .7, 5);
    cube(g, 0, .82 * size, 1.43 * size, .82 * size, 1.6 * size, .1, '#624b35');
    cube(g, 0, .81 * size, 1.49 * size, .55 * size, 1.35 * size, .06, '#8e714a');
    for (let i = 0; i < 9; i++) {
      const a = i / 9 * Math.PI * 2;
      cylinder(g, Math.cos(a) * 1.49 * size, 3.4 * size, Math.sin(a) * 1.49 * size, .11 * size, .56 * size, '#b19760', 1, 4);
    }
    for (const side of [-1, 1]) {
      cube(g, side * .8 * size, 2.18 * size, 1.21 * size, .36 * size, .48 * size, .1, '#514b35');
      cube(g, side * .8 * size, 2.18 * size, 1.28 * size, .05 * size, .5 * size, .035, '#e7c58e');
    }
    for (let i = 0; i < 3; i++) cube(g, 0, .12 + i * .13, (2.1 - i * .2) * size, 1.24 * size, .23, .45 * size, '#b49b6d');
  }

  function antCart(world, x, z, rotation = 0) {
    const g = local(world, x, z); g.rotation.y = rotation;
    cube(g, 0, .72, 0, 1.5, .14, 2.1, '#a17b4e');
    for (const side of [-1, 1]) {
      cube(g, side * .74, 1.08, 0, .09, .64, 2.1, '#bc975f');
      for (const pz of [-.65, .65]) {
        const wheel = cylinder(g, side * .87, .4, pz, .4, .12, '#68533e', 1, 8); wheel.rotation.z = Math.PI / 2;
      }
      beam(g, [side * .53, .67, 1], [side * .53, .9, 2.6], .075, '#ac8758');
    }
    for (let i = 0; i < 7; i++) stone(g, Math.sin(i * 4) * .4, 1.08 + (i % 3) * .2, Math.cos(i * 4) * .65, .27, .35, .21, i % 2 ? '#dfbb6c' : '#c3a057');
  }

  function anthillLandscape(world) {
    [[-74, -60, 13, 10, 3], [-41, -61, 17, 8, 2.7], [21, -62, 20, 9, 3.8], [74, -57, 10, 13, 3.1], [-76, 35, 10, 17, 2.8], [78, 21, 9, 13, 3.5], [-25, 64, 13, 7, 2]].forEach((args) => mound(world, ...args));
    scatterDistrict(world, { x: -66, z: -27, rx: 20, rz: 37, count: 45, type: 'mushroom', size: 1.6 });
    scatterDistrict(world, { x: 61, z: -20, rx: 22, rz: 38, count: 42, type: 'tree', size: .75 });
    scatterDistrict(world, { x: -48, z: 43, rx: 33, rz: 24, count: 46, type: 'tree', size: .95 });
    scatterDistrict(world, { x: 50, z: 48, rx: 34, rz: 20, count: 40, type: 'mushroom', size: 1.35 });
    scatterDistrict(world, { x: 0, z: -51, rx: 35, rz: 19, count: 24, type: 'rock', size: 1.4 });
    hollowLog(world, -52, -38);
    path(world, [[-66, -40], [-60, -37], [-48, -38], [-40, -40]], 2.3);
    for (let i = 0; i < 12; i++) mushroom(world, -61 + world.random() * 19, -44 - world.random() * 3, 1 + world.random() * 2.3, i % 2 ? '#c78a51' : '#a7644b');
    antCart(world, -61, -34, .7);
    bench(world, -44, -33, -.3);

    // The grain district is a little working village, with terraced stores,
    // drying racks, loading decks, and an open central threshing floor.
    oval(world, 52, -36, 13, 10, '#bdaf73');
    oval(world, 51, -32, 7, 5, '#dbc58c', -.018);
    [[46, -41, 1.3], [53, -44, 1.6], [60, -39, 1.1], [59, -31, .95]].forEach(([x, z, size]) => acornHouse(world, x, z, size));
    for (let i = 0; i < 3; i++) antCart(world, 44 + i * 3, -29 - i % 2, .1 + i * .45);
    const granary = local(world, 48, -34);
    for (const px of [-2.6, 2.6]) cylinder(granary, px, 2.1, 0, .13, 4.2, '#8e764d', .8, 6);
    beam(granary, [-2.6, 3.8, 0], [2.6, 3.8, 0], .12, '#8e764d');
    for (let i = 0; i < 9; i++) {
      const px = -2.25 + i * .56;
      beam(granary, [px, 3.7, 0], [px, 2.3, 0], .03, '#c9b17c');
      stone(granary, px, 2.25, 0, .25, .64, .22, i % 2 ? '#d6b86b' : '#c9a252');
    }
    for (let i = 0; i < 18; i++) {
      const px = 42 + i % 6 * 1.1, pz = -48 + Math.floor(i / 6) * 1.25;
      stone(landscape(world, px, pz), px, .24, pz, .44, .37, .29, '#dab463', i);
    }

    pond(world, -57, 38, 7.6, 5.8, '#79bdb3');
    for (let i = 0; i < 12; i++) {
      const a = i * Math.PI / 6, x = -57 + Math.cos(a) * 10, z = 38 + Math.sin(a) * 8;
      mushroom(world, x, z, 1.3 + (i % 3) * .5, i % 2 ? '#e2b979' : '#cb925c');
      shrub(world, x + .5, z + .5, 1.2, false, '#98ad56');
      const leaf = stone(landscape(world, x, z), x + 1.1, 1.75, z, .65, .13, 1.5, '#6f9851', a);
      leaf.rotation.z = -.3;
      stone(landscape(world, x, z), x + 1.15, 2.02, z, .22, .31, .22, '#b8e5d2');
    }
    bridge(world, -57, 38, 13, 2.25, Math.PI / 2, .23);

    const quarry = local(world, 56, 40);
    mound(world, 58, 43, 12, 9, 4.4, ['#9b754b', '#b79059', '#d5b477'], -.4);
    for (let i = 0; i < 5; i++) {
      const g = group(quarry, -6 + i * 2.7, .4 + (i % 3) * .8, (i % 2) * 3);
      g.rotation.set(.12, i * .9, (i - 2) * .15);
      cylinder(g, 0, 1.3, 0, .72, 2.5, i % 2 ? '#c1843d' : '#e1b75b', 1, 5);
      peak(g, 0, 2.9, 0, .72, .75, '#f0d58a', 5);
      cylinder(g, -.68, .6, .4, .35, 1.1, '#cb9345', 1, 5);
      peak(g, -.68, 1.42, .4, .35, .58, '#e5c576', 5);
    }
    for (let i = 0; i < 9; i++) cube(quarry, -8 + i * 1.7, .14, -6, 1.35, .28, 1.8, i % 2 ? '#b8a178' : '#c9b189', .04);
    antCart(world, 63, 34, 1.6);
    path(world, [[49, 34], [50, 42], [59, 45, 3.5]], 1.3);

    const plaza = local(world, 0, 58);
    cylinder(plaza, 0, .07, 0, 8.6, .22, '#9d8358', 1, 18);
    cylinder(plaza, 0, .21, 0, 7.9, .08, '#d0b783', 1, 18);
    cylinder(plaza, 0, 1.4, 0, 3.15, 2.7, '#8e6b47', .87, 12);
    cylinder(plaza, 0, 2.78, 0, 2.8, .12, '#dbb885', 1, 12);
    for (const radius of [2.3, 1.6, .9]) {
      for (let i = 0; i < 14; i++) {
        const a = i / 14 * Math.PI * 2, b = (i + 1) / 14 * Math.PI * 2;
        beam(plaza, [Math.cos(a) * radius, 2.86, Math.sin(a) * radius], [Math.cos(b) * radius, 2.86, Math.sin(b) * radius], .025, '#a17e53');
      }
    }
    for (let i = 0; i < 7; i++) {
      const a = i / 7 * Math.PI * 2;
      beam(plaza, [Math.cos(a) * 2.1, 1.1, Math.sin(a) * 2.1], [Math.cos(a) * 6, .25, Math.sin(a) * 6], .4, '#826345');
      mushroom(world, Math.cos(a) * 9.8, 58 + Math.sin(a) * 9.8, 1.5 + i % 3 * .5, '#b58056');
    }
    bench(world, -6, 62, .8); bench(world, 6, 62, -.8);
  }

  function forestLandscape(world) {
    [[-75, -58, 13, 13, 4.2], [-43, -59, 16, 10, 3.6], [14, -60, 24, 10, 3], [70, -59, 13, 10, 4.3], [-76, 12, 11, 22, 3], [75, 14, 10, 23, 3.8], [-30, 64, 12, 7, 2.5]].forEach((args) => mound(world, ...args));
    scatterDistrict(world, { x: -64, z: -35, rx: 24, rz: 33, count: 70, size: 1.15 });
    scatterDistrict(world, { x: 54, z: -37, rx: 29, rz: 30, count: 72, size: 1.05 });
    scatterDistrict(world, { x: -61, z: 36, rx: 25, rz: 32, count: 62, size: 1.1 });
    scatterDistrict(world, { x: 58, z: 38, rx: 26, rz: 32, count: 67, size: 1.2 });
    scatterDistrict(world, { x: 0, z: -54, rx: 42, rz: 18, count: 43, type: 'pine', size: 1.1 });
    scatterDistrict(world, { x: 1, z: 58, rx: 37, rz: 13, count: 32, size: 1.2 });

    // Layered slate, a split cascade, and pale foam make the water readable even
    // without costly transparency, reflections, or animated surface shaders.
    pond(world, -54, -35, 9.5, 7, '#75bfb6');
    const waterfall = local(world, -54, -43);
    for (let tier = 0; tier < 4; tier++) {
      for (let i = 0; i < 4; i++) {
        cube(waterfall, -7.5 + i * 5 + (tier % 2) * .7, tier * 1.5 + .68, -tier * .75, 5.2, 1.45, 4.6, tier % 2 ? '#829a88' : '#9aac95', (i - 2) * .07);
        if (i % 2) stone(waterfall, -6 + i * 4.4, tier * 1.5 + 1.5, 1.1 - tier * .7, 2.6, .22, 1.8, '#79905e');
      }
    }
    cube(waterfall, 0, 6.8, -1.8, 6.4, .11, 4.8, '#75bcb7');
    for (let i = 0; i < 5; i++) {
      const px = -2.6 + i * 1.1, fallHeight = 5.7 + (i % 2) * .8;
      cube(waterfall, px, fallHeight / 2 + .2, 1.28 + (i % 2) * .12, .88, fallHeight, .16, i % 2 ? '#a0d8cd' : '#6ebbbd');
      cube(waterfall, px - .2, fallHeight / 2 + .2, 1.38 + (i % 2) * .12, .13, fallHeight * .94, .03, '#d0efe1');
      stone(waterfall, px, .25, 1.5, 1.15, .28, .68, '#c1e9d9');
    }
    for (let i = 0; i < 9; i++) rockCluster(world, -64 + i * 2.8, -44 - i % 2 * 3, 1.2 + i % 3 * .35);
    path(world, [[-55, -29], [-58, -18], [-63, -7], [-59, 11], [-52, 35], [-60, 51], [-66, 63]], 3.3, '#79b5ad', '#a6be96');
    bridge(world, -59, -11, 7.8, 2.65, 1.18, .3);
    bench(world, -43, -34, -.7);

    const ruins = local(world, 53, -39);
    cylinder(ruins, 0, .06, 0, 9.2, .19, '#9baf93', 1, 16);
    for (let i = 0; i < 7; i++) {
      const a = -Math.PI * .82 + i * Math.PI * .27, px = Math.cos(a) * 6.1, pz = Math.sin(a) * 6.1;
      const h = 3.2 + (i % 3) * .8;
      cube(ruins, px, .35, pz, 1.8, .7, 1.8, '#b4b9a2', a);
      cylinder(ruins, px, h / 2 + .6, pz, .56, h, '#bfc5b0', .88, 7);
      cube(ruins, px, h + .7, pz, 1.6, .45, 1.6, '#cbd0bb', a);
      for (let band = 0; band < 4; band++) cylinder(ruins, px, .8 + band * .75, pz, .58 - band * .02, .07, '#9da990', 1, 7);
      if (i % 2 === 0) stone(ruins, px, .75, pz + .5, 1.3, .28, 1.05, '#698851');
    }
    const lintel = cube(ruins, -4.9, 4.8, -1.9, 5.7, .95, 1.75, '#adb7a1', -.65); lintel.rotation.z = .05;
    for (let i = 0; i < 10; i++) cube(ruins, -6 + (i % 5) * 2.2, .16, 2.5 + Math.floor(i / 5) * 1.9, 1.7, .2, 1.5, i % 2 ? '#c2c8ad' : '#b2bd9f', (i % 3 - 1) * .09);
    cylinder(ruins, 0, .52, -.8, 2, .85, '#acb9a0', .93, 12);
    cylinder(ruins, 0, .96, -.8, 1.62, .04, '#79a79a', 1, 12);
    for (let i = 0; i < 11; i++) shrub(world, 44 + world.random() * 17, -46 + world.random() * 4, .6 + world.random(), false, '#63875c');
    rockCluster(world, 61, -34, 1.5);

    pond(world, -52, 35, 5, 9, '#64a5a1');
    mound(world, -62, 35, 6, 9, 3.8);
    mound(world, -42, 35, 6, 9, 3.8);
    bridge(world, -52, 35, 18, 2.55, Math.PI / 2, 3.1, true);
    path(world, [[-68, 35], [-62, 35, 3.1], [-59, 35, 3.1]], 2.3);
    path(world, [[-45, 35, 3.1], [-42, 35, 3.1], [-37, 29]], 2.3);
    for (const x of [-61, -43]) {
      const g = landscape(world, x, 35);
      for (const z of [33.4, 36.6]) cylinder(g, x, 3.8, z, .23, 7.6, '#775c41', .8, 6);
      beam(g, [x, 7.2, 33.4], [x, 7.2, 36.6], .2, '#8e704b');
    }

    oval(world, 52, 37, 10, 8, '#a1ba78');
    pond(world, 52, 37, 4.5, 3.5, '#83b5a4');
    for (let i = 0; i < 19; i++) {
      const a = i / 19 * Math.PI * 2;
      mushroom(world, 52 + Math.cos(a) * 6.8, 37 + Math.sin(a) * 5.5, .8 + (i % 4) * .23, i % 3 ? '#d5b587' : '#b97156');
      for (let j = 0; j < 3; j++) flower(world, 52 + Math.cos(a) * (8 + j * .5), 37 + Math.sin(a) * (6.6 + j * .5), 1.1, j % 2 ? '#c8b5df' : '#ece1ac');
    }
    bench(world, 45, 40, .7); bench(world, 59, 40, -.7);

    const oak = local(world, 0, 57);
    cylinder(oak, 0, 4.5, 0, 1.55, 9, '#77543e', .65, 9);
    for (let i = 0; i < 7; i++) {
      const a = i * Math.PI * 2 / 7;
      beam(oak, [Math.cos(a) * 1.2, 5, Math.sin(a) * 1.2], [Math.cos(a) * 4, 9 + i % 2, Math.sin(a) * 4], .49, '#77543e');
      beam(oak, [0, 1.4, 0], [Math.cos(a) * 4, .04, Math.sin(a) * 4], .42, '#73523d');
      stone(oak, Math.cos(a) * 4.4, 10.4 + i % 3 * .7, Math.sin(a) * 4, 4.5, 3.1, 4.1, world.palette.greens[i % 3], a);
    }
    stone(oak, 0, 13, 0, 4.7, 3.7, 4.5, '#64915b');
    for (let i = 0; i < 16; i++) {
      const a = i / 16 * Math.PI * 2;
      cube(oak, Math.cos(a) * 6.5, .3, Math.sin(a) * 6.5, 2.35, .15, 1.25, '#ad8a5d', -a - Math.PI / 2);
    }
    bench(world, -8, 60, .4); bench(world, 8, 60, -.4);
  }

  function sailboat(world, x, z, scale = 1, rotation = 0, color = '#9d5d47') {
    const g = local(world, x, z); g.rotation.y = rotation; g.scale.setScalar(scale);
    stone(g, 0, .15, 0, 1, .55, 2.5, color);
    cube(g, 0, .38, 0, 1.35, .1, 3.1, '#d9b984');
    cube(g, 0, .5, .3, .95, .18, 1.25, '#6c8c86');
    cylinder(g, 0, 2.6, -.2, .065, 4.7, '#95744f', .8, 6);
    beam(g, [0, 1.2, -.2], [0, 1.2, 1.8], .055, '#95744f');
    const sail = [0, 1.26, -.17, 0, 4.6, -.17, 0, 1.26, 1.7];
    geometryMesh(g, [...sail, ...sail.slice(6, 9), ...sail.slice(3, 6), ...sail.slice(0, 3)], '#f1e6bf');
    beam(g, [0, 4.6, -.2], [0, .45, -2.1], .018, '#d6c699');
    beam(g, [0, 4.6, -.2], [0, .45, 2], .018, '#d6c699');
    return g;
  }

  function cabin(world, x, z, size = 1, color = '#a67350', rotation = 0, y = 0) {
    const g = local(world, x, z, y); g.rotation.y = rotation; g.scale.setScalar(size);
    cube(g, 0, .25, 0, 5.2, .5, 4.4, '#a6a791');
    cube(g, 0, 1.8, 0, 4.6, 2.8, 3.6, color);
    for (let i = 0; i < 7; i++) {
      cube(g, 0, .7 + i * .36, 1.825, 4.65, .05, .03, '#8a6348');
      cube(g, 2.325, .7 + i * .36, 0, .03, .05, 3.6, '#8a6348');
    }
    for (const side of [-1, 1]) {
      const roof = cube(g, side * 1.4, 3.65, 0, 3.25, .23, 4.8, world.name === 'beach' ? '#5d9188' : '#687e76');
      roof.rotation.z = side * -.48;
    }
    cube(g, 0, 1.2, 1.86, .92, 1.85, .1, '#4f665f');
    for (const side of [-1, 1]) {
      cube(g, side * 1.48, 1.98, 1.85, 1.06, 1.05, .12, '#e3c69c');
      cube(g, side * 1.48, 1.98, 1.925, .76, .76, .035, '#86b7b0');
      cube(g, side * 1.48, 1.98, 1.96, .06, .78, .035, '#f0ddb4');
      cube(g, side * 1.48, 1.98, 1.96, .78, .06, .035, '#f0ddb4');
    }
    cube(g, -1.1, 4.45, -.65, .6, 1.7, .62, '#a79e87');
    cube(g, -1.1, 5.32, -.65, .8, .18, .82, '#c1b59b');
    return g;
  }

  function stoneArch(g, x, y, z, radius, thickness, depth, color = '#aab09e') {
    const segments = 11;
    for (let i = 0; i < segments; i++) {
      const a = i / segments * Math.PI, b = (i + 1) / segments * Math.PI;
      const vertices = [], outer = radius + thickness;
      const front = [[x + Math.cos(a) * radius, y + Math.sin(a) * radius, z + depth / 2], [x + Math.cos(b) * radius, y + Math.sin(b) * radius, z + depth / 2], [x + Math.cos(b) * outer, y + Math.sin(b) * outer, z + depth / 2], [x + Math.cos(a) * outer, y + Math.sin(a) * outer, z + depth / 2]];
      const back = front.map(([px, py]) => [px, py, z - depth / 2]);
      const quad = (a, b, c, d) => vertices.push(...a, ...b, ...c, ...a, ...c, ...d);
      quad(...front.slice().reverse()); quad(...back);
      for (let edge = 0; edge < 4; edge++) { const next = (edge + 1) % 4; quad(front[edge], back[edge], back[next], front[next]); }
      geometryMesh(g, vertices, i % 3 === 0 ? '#c2c4ae' : color);
    }
  }

  function beachLandscape(world) {
    // Broad, layered water shapes form four coves. The centre remains dry sand,
    // and every landmark can be reached by the connected coastal walking loop.
    pond(world, -69, -43, 18, 23, '#8cccc1');
    pond(world, 67, -44, 19, 24, '#8cccc1');
    pond(world, 57, 51, 26, 18, '#89c9bc');
    pond(world, 0, 65, 31, 7.2, '#93d3c3');
    [[-78, 14, 9, 20, 2.3], [-53, 39, 15, 10, 3.6], [-29, 62, 14, 9, 2.4], [30, -57, 16, 10, 2.1], [45, -19, 9, 13, 1.3]].forEach((args) => mound(world, ...args));
    scatterDistrict(world, { x: -55, z: -14, rx: 25, rz: 18, count: 32, type: 'palm', size: 1.05 });
    scatterDistrict(world, { x: -59, z: 33, rx: 24, rz: 32, count: 25, type: 'palm', size: 1.15 });
    scatterDistrict(world, { x: 52, z: 11, rx: 25, rz: 24, count: 33, type: 'palm', size: .95 });
    scatterDistrict(world, { x: -5, z: -52, rx: 33, rz: 17, count: 24, type: 'palm', size: 1.1 });
    scatterDistrict(world, { x: 0, z: 46, rx: 36, rz: 12, count: 20, type: 'palm', size: .95 });

    mound(world, -56, -39, 10, 9, 3.9, ['#9eaa98', '#b2b6a0', '#c8c5a9']);
    const lighthouse = local(world, -56, -39, 3.5);
    cylinder(lighthouse, 0, .18, 0, 3.7, .45, '#bec1a7', 1, 12);
    for (let i = 0; i < 5; i++) cylinder(lighthouse, 0, 1 + i * 1.7, 0, 2.15 - i * .17, 1.72, i % 2 ? '#cf785b' : '#eee4c5', .91, 12);
    cylinder(lighthouse, 0, 9.2, 0, 2.2, .3, '#596e68', 1, 12);
    cylinder(lighthouse, 0, 10.25, 0, 1.38, 1.8, '#9cc8bb', 1, 10);
    for (let i = 0; i < 8; i++) {
      const a = i / 8 * Math.PI * 2;
      cylinder(lighthouse, Math.cos(a) * 1.43, 10.25, Math.sin(a) * 1.43, .065, 1.94, '#56736b', 1, 4);
      cylinder(lighthouse, Math.cos(a) * 2, 9.72, Math.sin(a) * 2, .045, .82, '#576b63', 1, 4);
      const next = (i + 1) / 8 * Math.PI * 2;
      beam(lighthouse, [Math.cos(a) * 2, 10.1, Math.sin(a) * 2], [Math.cos(next) * 2, 10.1, Math.sin(next) * 2], .045, '#576b63');
    }
    cylinder(lighthouse, 0, 11.26, 0, 1.75, .2, '#567269', 1, 10);
    peak(lighthouse, 0, 12, 0, 1.9, 1.35, '#d5805e', 10);
    cylinder(lighthouse, 0, 13.15, 0, .075, 1, '#6d7560', .7, 5);
    cube(lighthouse, 0, .9, 2, .85, 1.55, .11, '#53665f');
    for (let i = 0; i < 3; i++) cube(lighthouse, 0, 3 + i * 2.15, 1.8 - i * .16, .4, .85, .09, '#557773');
    cabin(world, -64, -32, .78, '#d6bd8d', -.4);
    path(world, [[-49, -30], [-52, -32, 1.1], [-57, -34, 2.7], [-57, -37, 3.7]], 1.8);
    for (let i = 0; i < 8; i++) rockCluster(world, -64 + Math.cos(i) * 7, -44 + Math.sin(i) * 10, 1.5 + i % 3 * .6, '#9fa999');
    bench(world, -50, -34, -1);

    const harbor = local(world, 52, 36);
    for (let i = 0; i < 33; i++) cube(harbor, 0, .42, -2.5 + i * .4, 4.5, .16, .37, i % 3 ? '#b7976a' : '#d3b386');
    for (let i = 0; i < 18; i++) cube(harbor, -6 + i * .45, .44, 10.1, .42, .17, 3.2, i % 3 ? '#b7976a' : '#d3b386');
    for (const side of [-2.4, 2.4]) for (let i = 0; i < 5; i++) {
      cylinder(harbor, side, .2, -2 + i * 3, .18, 1.9, '#7d7155', .86, 6);
      cylinder(harbor, side, 1.16, -2 + i * 3, .22, .12, '#d3bd8e', 1, 6);
    }
    cabin(world, 45, 31, 1.05, '#c4a476', -.08);
    cabin(world, 60, 32, .8, '#87aaa1', .12);
    const awning = local(world, 52, 29);
    for (const px of [-2.1, 2.1]) for (const pz of [-1.7, 1.7]) cylinder(awning, px, 1.6, pz, .07, 3.2, '#90764e', 1, 5);
    for (let i = 0; i < 8; i++) cube(awning, -1.88 + i * .53, 3.1, 0, .53, .07, 4, i % 2 ? '#e9dbb5' : '#d98c6d');
    cube(awning, 0, .9, 0, 3.5, .15, 1.5, '#bd9864');
    for (let i = 0; i < 9; i++) {
      const px = 46 + i % 3 * 1.1, pz = 36 + Math.floor(i / 3) * 1.1, g = landscape(world, px, pz);
      cube(g, px, .48, pz, .85, .85, .85, i % 2 ? '#a88358' : '#c3a170');
      for (const side of [-.32, .32]) cube(g, px + side, .48, pz + .44, .07, .85, .03, '#dec190');
    }
    sailboat(world, 58, 46, 1.3, -.35, '#b95e46');
    sailboat(world, 46, 48, 1.05, .25, '#6a9690');
    sailboat(world, 65, 56, .9, -.5, '#ca9d54');
    path(world, [[45, 28], [52, 30], [52, 36, .42]], 2.5);

    const arch = local(world, 55, -40); arch.rotation.y = -.36;
    for (const side of [-1, 1]) {
      stone(arch, side * 6.2, 3, 0, 3.3, 4.5, 3.2, '#b5b7a0', side * .4);
      cube(arch, side * 5.5, 3, 0, 2.8, 6, 3.5, '#afb39e', side * -.1);
      stone(arch, side * 6, 6.9, 0, 3.4, .8, 3, '#c5c4a8');
    }
    stoneArch(arch, 0, 3.6, 0, 4.7, 1.75, 3.6, '#b3b6a0');
    for (let i = 0; i < 6; i++) stone(arch, -5 + i * 2, 8.8 + Math.sin(i * .6) * .6, 0, 2.1, .5, 2.3, i % 2 ? '#d0cdb0' : '#b9bda3');
    rockCluster(world, 61, -48, 2.3, '#b8bba6');
    sailboat(world, 70, -47, .8, .6, '#a79b73');
    path(world, [[46, -34], [50, -36], [55, -40], [60, -43]], 1.5, '#ead8a7', '#cfc594');

    const duneDeck = local(world, -53, 37, 3.25);
    for (let i = 0; i < 14; i++) cube(duneDeck, -.5, .15, -3.5 + i * .52, 4.7, .12, .47, i % 2 ? '#b59d72' : '#ceb58c');
    for (const side of [-2.5, 2.5]) for (const pz of [-3.5, 3.3]) cylinder(duneDeck, side, .48, pz, .075, 1.1, '#a98f65', 1, 5);
    for (const side of [-2.5, 2.5]) beam(duneDeck, [side, 1.02, -3.5], [side, 1.02, 3.3], .036, '#d5c294');
    path(world, [[-54, 47], [-53, 43, 1.7], [-53, 38, 3.4]], 2.2, '#ceb38a', '#a48f69');
    for (let i = 0; i < 30; i++) {
      const a = i * 2.4, radius = 7 + i % 5;
      grass(world, -53 + Math.cos(a) * radius, 37 + Math.sin(a) * radius * .7, 1.7, i % 2 ? '#a9b081' : '#a9a674');
    }
    const umbrella = local(world, -61, 31);
    cylinder(umbrella, 0, 1.55, 0, .07, 3.1, '#b69965', 1, 5);
    peak(umbrella, 0, 3.1, 0, 2.15, 1.15, '#e6a76c', 8);
    bench(world, -62, 34, .1);

    oval(world, 0, 58, 10.5, 6.8, '#f0dca9', .018);
    oval(world, 1, 59, 4.5, 3.3, '#a8ddd0', .028);
    palm(world, -5, 57, 1.45); palm(world, 5, 57, 1.2);
    for (let i = 0; i < 11; i++) {
      const a = i * 2.4, x = Math.cos(a) * 6.3, z = 59 + Math.sin(a) * 4;
      const g = landscape(world, x, z);
      for (let branch = 0; branch < 3; branch++) {
        const tint = i % 2 ? '#d9957d' : '#d4b79a';
        beam(g, [x, .06, z], [x + (branch - 1) * .35, .8 + branch * .24, z + Math.sin(branch) * .23], .08, tint);
      }
    }
    for (let i = 0; i < 7; i++) cube(landscape(world, 0, 51 + i), 0, .12, 51 + i * .7, 2.2, .12, .62, '#c9ae7e');
  }

  function mountainPeak(world, x, z, radius, height, rotation = 0) {
    const g = local(world, x, z);
    const rock = peak(g, 0, height / 2 - .03, 0, radius, height, '#85968f', 5); rock.rotation.y = rotation;
    const shoulder = peak(g, radius * .5, height * .3, -radius * .06, radius * .67, height * .6, '#9aa69c', 5); shoulder.rotation.y = rotation + .3;
    const snow = peak(g, 0, height * .84, 0, radius * .335, height * .335, '#e4eadf', 5); snow.rotation.y = rotation;
    const crest = peak(g, radius * .5, height * .56, -radius * .06, radius * .13, height * .085, '#d7e0d4', 5); crest.rotation.y = rotation + .3;
  }

  function mountainsLandscape(world) {
    [[-76, -56, 10, 19], [-62, -63, 9, 15], [-34, -62, 11, 19], [-12, -65, 8, 14], [13, -63, 10, 17], [76, -55, 10, 20], [78, -28, 8, 13], [-78, 10, 9, 15], [80, 16, 7, 12], [-72, 59, 10, 15], [69, 61, 9, 16]].forEach(([x, z, r, h], i) => mountainPeak(world, x, z, r, h, i * .65));
    scatterDistrict(world, { x: -55, z: -22, rx: 26, rz: 31, count: 66, type: 'pine', size: 1 });
    scatterDistrict(world, { x: 52, z: -18, rx: 24, rz: 31, count: 55, type: 'pine', size: .95 });
    scatterDistrict(world, { x: -55, z: 42, rx: 27, rz: 28, count: 64, type: 'pine', size: 1.1 });
    scatterDistrict(world, { x: 57, z: 42, rx: 27, rz: 28, count: 67, type: 'pine', size: 1.05 });
    scatterDistrict(world, { x: 0, z: -48, rx: 37, rz: 14, count: 32, type: 'pine', size: .95 });
    scatterDistrict(world, { x: 0, z: 57, rx: 36, rz: 13, count: 23, type: 'rock', size: 1.3 });

    mound(world, -52, -40, 12, 10, 6.5);
    const observatory = local(world, -52, -40, 6.1);
    cylinder(observatory, 0, .22, 0, 4.7, .45, '#b9beac', 1, 12);
    cylinder(observatory, 0, 1.9, 0, 3.3, 3.3, '#dbd9be', 1, 12);
    cylinder(observatory, 0, 3.58, 0, 3.48, .23, '#839893', 1, 14);
    // A faceted hemisphere makes a genuine observatory dome, including its
    // dark meridian opening and the telescope visible through the roof slot.
    const dome = new THREE.SphereGeometry(3.32, 16, 6, 0, Math.PI * 2, 0, Math.PI / 2);
    ownedGeometries.push(dome); mesh(observatory, dome, '#a7c2b7', 0, 3.72, 0);
    const slot = new THREE.SphereGeometry(3.36, 3, 6, .91, .35, 0, Math.PI / 2);
    ownedGeometries.push(slot); mesh(observatory, slot, '#536e6c', 0, 3.74, 0);
    beam(observatory, [.35, 4.8, .35], [2.7, 7.2, 1.65], .29, '#e6dfbf');
    stone(observatory, 2.7, 7.2, 1.65, .33, .33, .33, '#547b7c');
    cube(observatory, 0, 1.2, 3.3, 1.2, 2.1, .1, '#5d7972');
    for (let i = 0; i < 5; i++) {
      const a = i / 5 * Math.PI * 2;
      cube(observatory, Math.cos(a) * 3.21, 2.1, Math.sin(a) * 3.21, .7, .85, .1, '#779e98', -a + Math.PI / 2);
    }
    for (let i = 0; i < 3; i++) {
      const panel = cube(observatory, -6, .9, -2 + i * 1.8, 2.5, .13, 1.55, '#597a87', .1); panel.rotation.z = -.3;
      cylinder(observatory, -6, .35, -2 + i * 1.8, .1, .7, '#889a8e', 1, 5);
    }
    path(world, [[-43, -33], [-46, -29], [-56, -32, 2.3], [-59, -39, 4.6], [-52, -36, 6.3]], 1.8);

    // The switchback trail follows the mountain's radial height profile, so
    // every turn sits on its slope and can be read from the overview.
    const sx = 53, sz = -40, rx = 15, rz = 13, height = 11;
    const ridge = mound(world, sx, sz, rx, rz, height, ['#8c9991', '#a1aa9d', '#b8bda8']);
    ridge.updateWorldMatrix(true, false);
    const probe = new THREE.Raycaster(new THREE.Vector3(), new THREE.Vector3(0, -1, 0));
    const trailSurface = (x, z) => {
      probe.ray.origin.set(x, 30, z);
      const hit = probe.intersectObject(ridge, false)[0];
      return (hit ? hit.point.y : -.025) + .11;
    };
    const slopeHeight = (x, z) => -.03 + height * Math.pow(Math.max(0, 1 - ((x - sx) / rx) ** 2 - ((z - sz) / rz) ** 2), 1.6) + .06;
    const turns = [[42, -32], [62, -34], [43, -37], [61, -40], [47, -44], [58, -45], [53, -40]];
    path(world, turns.map(([x, z]) => [x, z, slopeHeight(x, z)]), 1.3, '#e0d9b9', '#8b988a', trailSurface);
    const summit = local(world, 53, -40, 10.9);
    cylinder(summit, 0, .11, 0, 2.8, .2, '#cbd0b8', 1, 10);
    cylinder(summit, 0, 1.75, 0, .095, 3.5, '#687d72', .8, 5);
    geometryMesh(summit, [0, 3.3, 0, 1.7, 3, 0, 0, 2.65, 0, 0, 2.65, 0, 1.7, 3, 0, 0, 3.3, 0], '#cb8c64');
    for (let i = 0; i < 9; i++) {
      const a = i / 9 * Math.PI * 2;
      cylinder(summit, Math.cos(a) * 2.5, .6, Math.sin(a) * 2.5, .055, 1.1, '#7f8f7c', 1, 5);
    }

    // Five real open arches support a small railway viaduct. Keeping the
    // openings empty gives the silhouette its recognisable alpine character.
    path(world, [[39, 27], [44, 34], [49, 42], [49, 55], [40, 65]], 4.3, '#76aaa3', '#aebba0');
    const viaduct = local(world, 51, 36); viaduct.rotation.y = -.28;
    const span = 5.2, deckY = 7.5;
    for (let i = 0; i < 6; i++) {
      const px = -13 + i * span;
      cube(viaduct, px, 2.45, 0, 1.4, 4.9, 3.5, '#a5aea0');
      cube(viaduct, px, .2, 0, 2.15, .4, 4.2, '#b6bcaa');
      for (let band = 0; band < 5; band++) cube(viaduct, px, .7 + band * .86, 1.76, 1.43, .035, .03, '#87988c');
      if (i < 5) stoneArch(viaduct, px + span / 2, 3.6, 0, 1.9, .65, 3.5, '#a9b2a1');
    }
    cube(viaduct, 0, 6.8, 0, 28.3, 1.3, 3.5, '#afb7a5');
    cube(viaduct, 0, deckY, 0, 29, .24, 4, '#c5c8b0');
    for (const side of [-1.82, 1.82]) {
      cube(viaduct, 0, 8, side, 28.6, .75, .23, '#a6b09e');
      cube(viaduct, 0, 8.42, side, 28.8, .13, .36, '#d0d1b6');
    }
    for (let i = 0; i < 48; i++) cube(viaduct, -13.7 + i * .58, 7.69, 0, .24, .08, 2.7, '#8e8970');
    for (const side of [-.76, .76]) cube(viaduct, 0, 7.78, side, 28.2, .1, .1, '#67796e');
    mound(world, 36, 32, 7, 9, 7.5); mound(world, 66, 40, 7, 9, 7.5);

    mound(world, -54, 37, 11, 9, 2.4);
    cabin(world, -54, 37, 1.6, '#ac7951', -.1, 2.1);
    const terrace = local(world, -54, 43, 2.1);
    for (let i = 0; i < 18; i++) cube(terrace, -4.5 + i * .52, .12, 0, .48, .15, 4.5, i % 2 ? '#b29163' : '#c7a575');
    for (let i = 0; i < 4; i++) {
      cube(terrace, -3 + i * 2, .83, 0, 1.1, .12, 1.1, '#cda977');
      cylinder(terrace, -3 + i * 2, .42, 0, .11, .82, '#7c6d52', 1, 5);
    }
    path(world, [[-45, 43], [-48, 46, 1.1], [-54, 45, 2.3]], 2.1);
    const fire = local(world, -44, 37);
    for (let i = 0; i < 10; i++) stone(fire, Math.cos(i * Math.PI / 5) * 1.4, .23, Math.sin(i * Math.PI / 5) * 1.4, .46, .35, .35, '#9aab98', i);
    beam(fire, [-.6, .1, -.5], [.6, .25, .5], .2, '#775c41');
    beam(fire, [.6, .1, -.5], [-.6, .25, .5], .2, '#775c41');
    bench(world, -43, 40, -.2);

    pond(world, 0, 58, 12, 7.5, '#79b8b4');
    for (let i = 0; i < 17; i++) {
      const a = i * Math.PI * 2 / 17;
      rockCluster(world, Math.cos(a) * 13.5, 58 + Math.sin(a) * 8.8, .8 + i % 3 * .35, '#a3afa0');
    }
    bridge(world, 0, 49, 6.8, 2.1, Math.PI / 2, .2);
    bench(world, 12, 55, -1.4);
    for (let i = 0; i < 20; i++) flower(world, -15 + i % 5 * .9, 49 + Math.floor(i / 5) * .65, .9, i % 2 ? '#d8d2e3' : '#eee9c9');
  }

  function createLife(world) {
    const wings = new THREE.BufferGeometry();
    // Both sides are explicit triangles, avoiding a double-sided material and
    // keeping small silhouettes visible from every camera heading.
    const left = [0, 0, .2, -.43, .14, -.1, -.15, .03, -.23];
    const right = [0, 0, .2, .15, .03, -.23, .43, .14, -.1];
    wings.setAttribute('position', new THREE.Float32BufferAttribute([...left, ...left.slice(6), ...left.slice(3, 6), ...left.slice(0, 3), ...right, ...right.slice(6), ...right.slice(3, 6), ...right.slice(0, 3)], 3));
    wings.computeVertexNormals();
    const dayMat = new THREE.MeshBasicMaterial({ color: '#ffffff' });
    const glowMat = new THREE.MeshBasicMaterial({ color: '#e6f3b1' });
    const glowGeometry = new THREE.IcosahedronGeometry(.07, 0);
    ownedGeometries.push(wings, glowGeometry); ownedMaterials.push(dayMat, glowMat);
    const day = new THREE.InstancedMesh(wings, dayMat, 32);
    const glow = new THREE.InstancedMesh(glowGeometry, glowMat, 48);
    day.instanceMatrix.setUsage(THREE.DynamicDrawUsage); glow.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    day.frustumCulled = false; glow.frustumCulled = false;
    world.root.add(day, glow);
    const seeds = [], color = new THREE.Color();
    for (let i = 0; i < 48; i++) {
      const target = WORLD_LANDMARKS[world.name][i % 5];
      seeds.push({ x: target.x + (world.random() - .5) * 15, z: target.z + (world.random() - .5) * 12, phase: world.random() * Math.PI * 2, radius: 1.2 + world.random() * 3, height: 1 + world.random() * 2 });
      if (i < 32) {
        color.set(world.name === 'beach' ? i % 3 ? '#eee9cc' : '#768c85' : world.name === 'mountains' ? '#536d63' : ['#d5bc7b', '#bca1ca', '#dc9870'][i % 3]);
        day.setColorAt(i, color);
      }
    }
    world.life = { day, glow, seeds, transform: new THREE.Object3D() };
  }

  function updateLife(world, elapsed, night, quiet, quality, x, z, radius) {
    const { day, glow, seeds, transform } = world.life;
    const nocturnal = night && (world.name === 'forest' || world.name === 'anthill');
    day.visible = !night; glow.visible = nocturnal;
    const target = nocturnal ? glow : day;
    const maximum = quality === 'lite' ? 8 : quality === 'detailed' ? nocturnal ? 48 : 32 : nocturnal ? 30 : 20;
    const time = quiet ? 0 : elapsed;
    let count = 0;
    if (!night || nocturnal) for (let i = 0; i < maximum; i++) {
      const seed = seeds[i], t = seed.phase + time * (nocturnal ? .19 : .24);
      if (Math.hypot(seed.x - x, seed.z - z) > Math.min(radius + 12, 82)) continue;
      const bird = world.name === 'beach' || world.name === 'mountains';
      transform.position.set(seed.x + Math.cos(t) * seed.radius, seed.height + Math.sin(t * 1.8) * .45 + (bird ? 6 : 0), seed.z + Math.sin(t) * seed.radius);
      transform.rotation.set(nocturnal ? 0 : Math.sin(time * 5 + seed.phase) * .13, -t, nocturnal ? 0 : Math.sin(time * (bird ? 2.4 : 7.5) + seed.phase) * .5);
      const size = nocturnal ? .6 + (Math.sin(time * 1.4 + seed.phase) + 1) * .5 : bird ? .8 : .6;
      transform.scale.setScalar(size); transform.updateMatrix();
      target.setMatrixAt(count++, transform.matrix);
    }
    day.count = nocturnal ? 0 : count; glow.count = nocturnal ? count : 0;
    target.instanceMatrix.needsUpdate = true;
    world.ambientCount = count;
  }

  function constructTheme(name) {
    const temporaryStart = ownedGeometries.length;
    const world = { name, root: group(root), palette: palettes[name], random: randomFor({ anthill: 417, forest: 832, beach: 1247, mountains: 1662 }[name]), chunks: new Map(), routes: [], triangles: 0, visibleChunks: 0, detailChunks: 0, ambientCount: 0 };
    world.root.name = `expanse-${name}`;
    layRoutes(world);
    ({ anthill: anthillLandscape, forest: forestLandscape, beach: beachLandscape, mountains: mountainsLandscape })[name](world);
    surfaceDetails(world);
    for (const chunk of world.chunks.values()) {
      bake(chunk.main); bake(chunk.detail);
      chunk.mainTriangles = 0; chunk.detailTriangles = 0;
      for (const layer of [chunk.main, chunk.detail]) layer.traverse((object) => {
        if (!object.isMesh) return;
        const triangles = (object.geometry.index?.count || object.geometry.attributes.position.count) / 3;
        world.triangles += triangles;
        chunk[layer === chunk.main ? 'mainTriangles' : 'detailTriangles'] += triangles;
      });
      // Static geometry near tile boundaries can extend beyond its nominal
      // footprint. The actual baked sphere makes CPU culling conservative.
      let reach = 24;
      chunk.main.traverse((object) => {
        if (!object.isMesh) return;
        object.geometry.computeBoundingBox();
        const bounds = object.geometry.boundingBox;
        reach = Math.max(reach, Math.hypot(Math.max(Math.abs(bounds.min.x - chunk.x), Math.abs(bounds.max.x - chunk.x)), Math.max(Math.abs(bounds.min.z - chunk.z), Math.abs(bounds.max.z - chunk.z))));
      });
      chunk.radius = reach;
    }
    // bake() owns the merged buffers; release our construction-only terrain
    // buffers immediately rather than retaining duplicate CPU geometry.
    ownedGeometries.splice(temporaryStart).forEach((geometry) => geometry.dispose());
    createLife(world);
    return world;
  }

  function buildTheme(name) {
    // Theme builders and spatial construction helpers are defined below.
    return constructTheme(name);
  }

  function setTheme(name) {
    if (!WORLD_LANDMARKS[name]) name = 'anthill';
    if (!worlds.has(name)) worlds.set(name, buildTheme(name));
    worlds.forEach((world, key) => { world.root.visible = key === name; });
    active = worlds.get(name);
    update(state);
  }

  function update(next = {}) {
    state = { ...state, ...next };
    if (!active) return;
    const { x, z, viewRadius, quality, elapsed, night, quiet } = state;
    const radius = Math.max(28, Number(viewRadius) || 70);
    let visibleChunks = 0, detailChunks = 0, visibleTriangles = 0;
    for (const chunk of active.chunks.values()) {
      const distance = Math.hypot(chunk.x - x, chunk.z - z);
      chunk.main.visible = distance < radius + chunk.radius;
      chunk.detail.visible = quality !== 'lite' && distance < Math.min(radius + 21, quality === 'detailed' ? 78 : 49);
      if (chunk.main.visible) { visibleChunks++; visibleTriangles += chunk.mainTriangles; }
      if (chunk.detail.visible) { detailChunks++; visibleTriangles += chunk.detailTriangles; }
    }
    active.visibleChunks = visibleChunks;
    active.detailChunks = detailChunks;
    active.visibleTriangles = visibleTriangles;
    updateLife(active, elapsed, night, quiet, quality, x, z, radius);
  }

  function getDiagnostics() {
    return {
      theme: active?.name || null,
      builtThemes: worlds.size,
      chunks: active?.chunks.size || 0,
      visibleChunks: active?.visibleChunks || 0,
      detailChunks: active?.detailChunks || 0,
      triangles: active?.triangles || 0,
      visibleTriangles: active?.visibleTriangles || 0,
      landmarks: active ? WORLD_LANDMARKS[active.name].length : 0,
      ambientCount: active?.ambientCount || 0
    };
  }

  function dispose() {
    root.removeFromParent();
    ownedGeometries.forEach((geometry) => geometry.dispose());
    ownedMaterials.forEach((mat) => mat.dispose());
    worlds.clear(); active = null;
  }

  return { setTheme, update, getDiagnostics, dispose };
}
