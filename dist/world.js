import * as THREE from './vendor/three.module.js';
import { createWildlife } from './wildlife.js';
import { createWorldExpanse, WORLD_EXTENT, WORLD_LANDMARKS } from './world-expanse.js';
import { createQualityController, renderPixelRatio } from './world-quality.js';

/* An explorable, entirely geometric miniature world. No external assets. */
export function createOfficeWorld(host, { onSelect = () => {}, onPositions = () => {}, onCameraChange = () => {}, onInteract = () => {}, onStationPositions = () => {} } = {}) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#dcebd9');
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'default' });
  const mobile = window.matchMedia?.('(max-width: 760px)').matches || false;
  const quality = createQualityController({ compact: mobile, cores: navigator.hardwareConcurrency || 0 });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.profile.pixelRatio));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // A toy world needs clean color separation. Filmic highlight compression
  // washes these deliberately saturated materials toward beige and gray.
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;outline:none;';
  renderer.domElement.setAttribute('aria-label', 'Ufficio 3D nel formicaio: trascina per ruotare, rotella o più e meno per lo zoom, Maiusc e trascina per esplorare, due dita per zoom e movimento. Home torna allo studio.');
  renderer.domElement.tabIndex = 0;
  host.appendChild(renderer.domElement);

  const camera = new THREE.OrthographicCamera(-14, 14, 12, -12, .1, 800);
  let angle = .62, elevation = .72, width = 1, height = 1, quiet = false, disposed = false;
  let theme = 'anthill', selected = null, elapsed = 0, frame = 0;
  let zoom = 1, overview = false, night = false;
  let antClock = 0, antVisibleCount = 0;
  let activity = { load: 0, problemKey: null, collaboratingIds: [], activeAgentIds: [] };
  let context = { name: 'Fuori Studio', kind: 'workspace', color: '#87b9ac' };
  let hidden = document.hidden, inViewport = true, sceneDirty = true, lastDrawCalls = 0;
  let wildlife = null, expanse = null, cameraFlight = null;
  const stations = [], stationHits = [], stationLabels = [], nightMaterials = [];
  const customGeometries = [], customMaterials = [];
  const MIN_ZOOM = .075, MAX_ZOOM = 2.8;
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
      // Colour attributes preserve every painted piece while collapsing opaque
      // surfaces into one draw. Emissive and live theme colours stay separate.
      const source=o.material;
      const combine=source.isMeshStandardMaterial&&!source.userData.liveColor&&!source.transparent&&source.opacity===1&&source.side===THREE.FrontSide&&source.roughness===.82&&source.metalness===0&&!source.flatShading&&!source.wireframe&&source.depthWrite&&source.depthTest&&source.blending===THREE.NormalBlending&&source.alphaTest===0&&!source.map&&!source.normalMap&&!source.bumpMap&&!source.roughnessMap&&!source.metalnessMap&&!source.aoMap&&!source.lightMap&&!source.envMap&&!source.displacementMap&&(source.emissive.getHex()===0||source.emissiveIntensity===0);
      const target=combine?material('#ffffff',{vertexColors:true}):source;
      if(combine){
        const count=raw.attributes.position.count,existing=raw.attributes.color,paint=new Float32Array(count*3);
        for(let i=0;i<count;i++){paint[i*3]=source.color.r*(existing?existing.getX(i):1);paint[i*3+1]=source.color.g*(existing?existing.getY(i):1);paint[i*3+2]=source.color.b*(existing?existing.getZ(i):1);}
        raw.setAttribute('color',new THREE.BufferAttribute(paint,3));
      }
      if (!buckets.has(target)) buckets.set(target, []);
      buckets.get(target).push(raw);
    });
    root.clear();
    buckets.forEach((parts, mat) => {
      const count = parts.reduce((n, p) => n + p.attributes.position.count, 0);
      const positions = new Float32Array(count * 3), normals = new Float32Array(count * 3);
      const colors = mat.vertexColors ? new Float32Array(count * 3).fill(1) : null;
      let at = 0;
      parts.forEach(p => { positions.set(p.attributes.position.array, at); normals.set(p.attributes.normal.array, at); if(colors && p.attributes.color) colors.set(p.attributes.color.array,at); at += p.attributes.position.array.length; p.dispose(); });
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
      if(colors) geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      geometry.computeBoundingSphere(); mergedGeometries.push(geometry);
      const m = new THREE.Mesh(geometry, mat); m.castShadow = m.receiveShadow = true; root.add(m);
    });
  }

  const hemisphere = new THREE.HemisphereLight('#d8ecf0', '#8b8162', 1.55); scene.add(hemisphere);
  scene.fog = new THREE.Fog('#e2e9df', 355, 570);
  const sun = new THREE.DirectionalLight('#fff0d4', 2.4);
  sun.position.set(-24, 45, 28); sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -42, right: 42, top: 38, bottom: -38, near: 1, far: 110 });
  sun.shadow.bias = -.00035; sun.shadow.normalBias = .025;
  scene.add(sun, sun.target);
  const fill = new THREE.DirectionalLight('#d8efff', .36); fill.position.set(10, 8, -8); scene.add(fill);

  const foundation = group(scene);
  const baseMat = material('#a0b98f');
  const earthMat = material('#adbd94');
  baseMat.userData.liveColor=true;earthMat.userData.liveColor=true;
  const halfWorldX = WORLD_EXTENT.width / 2, halfWorldZ = WORLD_EXTENT.depth / 2;
  box(foundation, 0, -1.17, 0, WORLD_EXTENT.width, 2.18, WORLD_EXTENT.depth, earthMat);
  box(foundation,0,-2.39,0,WORLD_EXTENT.width-.9,.4,WORLD_EXTENT.depth-.9,'#685441');
  box(foundation,0,-2.66,0,WORLD_EXTENT.width-1.7,.15,WORLD_EXTENT.depth-1.7,'#4e493c');
  for(let i=0;i<72;i++) {
    const h=.16+random()*.18, x=-halfWorldX+1.3+i*2.45;
    box(foundation,x,-.85-random()*.6,halfWorldZ+.015,1.3+random(),h,.026,i%2?'#b39a6c':'#7d684c');
    box(foundation,x,-1.8+random()*.18,halfWorldZ+.023,1.7+random()*.65,.07,.03,'#c0a983');
  }
  for(let i=0;i<60;i++) box(foundation,halfWorldX+.017,-.7-random()*.9,-halfWorldZ+2+i*2.4,.03,.16+random()*.17,1.3+random(),i%2?'#b39a6c':'#7d684c');
  // Keep the cap above earth (-.08), but below the original painted ground (-.064 ± .003).
  box(foundation, 0, -.16, 0, WORLD_EXTENT.width+.2, .18, WORLD_EXTENT.depth+.2, baseMat);
  // A dark green rim and small stepping stones make the floating island read as a toy.
  box(foundation, 0, -2.77, 0, WORLD_EXTENT.width-2.3, .12, WORLD_EXTENT.depth-2.3, '#4c683e');
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
    // Individual timber decks and woven rugs give every desk a distinct place.
    box(pod, 0, -.045, -.05, 3.5, .16, 3.48, '#785b43');
    for(let plank=0;plank<9;plank++) box(pod, -1.56+plank*.39, .036, -.05, .37, .032, 3.42, plank%3?'#bc9460':'#cba774');
    box(pod, 0, .059, -.12, 2.88, .016, 2.9, '#536f61');
    box(pod, 0, .075, .12, 2.6, .018, 2.68, '#d1c4a0');
    for(let stitch=0;stitch<8;stitch++) box(pod,-1.14+stitch*.325,.089,1.37,.07,.012,.14,a.color);
    box(pod,0,.09,-1.1,2.4,.012,.035,a.color);
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
  // A small open-air campus: timber decks, useful computers and a shared pavilion.
  function beam(parent, from, to, radius, color) {
    const start = new THREE.Vector3(...from), end = new THREE.Vector3(...to);
    const delta = end.clone().sub(start), length = delta.length();
    const part = mesh(parent, geo('cylinder', radius, radius, length, 6), color, (start.x+end.x)/2, (start.y+end.y)/2, (start.z+end.z)/2);
    part.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0), delta.normalize()); return part;
  }
  const lampMat = material('#ffedb4', { emissive: '#ffbd5a', emissiveIntensity: .22 }); nightMaterials.push(lampMat);
  [[-7.8,-6.7],[7.8,-6.7],[-7.8,5.0],[7.8,5.0]].forEach(([x,z])=>{
    box(courtyard,x,2.0,z,.14,4.0,.14,'#664f3b');
    cyl(courtyard,x,.13,z,.23,.28,.28,'#b7aaa0',6);
    box(courtyard,x,4.13,z,.3,.09,.3,'#a88255');
  });
  function lightString(x1,z1,x2,z2) {
    const points=[];
    for(let i=0;i<=18;i++) {
      const t=i/18, p=[THREE.MathUtils.lerp(x1,x2,t),4.05-Math.sin(t*Math.PI)*.48,THREE.MathUtils.lerp(z1,z2,t)]; points.push(p);
      if(i) beam(courtyard,points[i-1],p,.022,'#484839');
      if(i%2===1) {
        box(courtyard,p[0],p[1]-.12,p[2],.035,.24,.035,'#484839');
        const bulb=mesh(courtyard,geo('ico',1,1),lampMat,p[0],p[1]-.28,p[2]); bulb.scale.set(.09,.12,.09);
      }
    }
  }
  lightString(-7.8,-6.7,7.8,-6.7); lightString(-7.8,-6.7,-7.8,5); lightString(7.8,-6.7,7.8,5);
  const stationData = [
    {id:'memory',kind:'memory',label:'Memorie',x:-10.9,z:-3.5,color:'#dfae72'},
    {id:'projects',kind:'projects',label:'Progetti',x:10.9,z:-3.5,color:'#70b7c1'},
    {id:'workflows',kind:'workflows',label:'Procedure',x:-10.9,z:5.6,color:'#b598cf'},
    {id:'context',kind:'context',label:'Contesto',x:10.9,z:5.6,color:'#88b68a'}
  ];
  let contextBeacon = null;
  function monitor(parent,x,y,z,w,h,color) {
    box(parent,x,y-.37,z,.09,.68,.09,'#415659'); box(parent,x,y-.69,z,.65,.07,.39,'#415659');
    box(parent,x,y,z,w+.1,h+.1,.105,'#32474c');
    const glow=material(color,{emissive:color,emissiveIntensity:.17,roughness:.4}); nightMaterials.push(glow);
    box(parent,x,y+.012,z+.064,w,h,.018,glow);
    for(let row=0;row<3;row++) box(parent,x-w*.08,y+h*.25-row*h*.2,z+.077,w*(.58-row*.08),.023,.006,'#e9eee2');
    return glow;
  }
  stationData.forEach((data,index)=>{
    const hub=group(courtyard,data.x,0,data.z);
    box(hub,0,-.02,0,3.75,.2,3.45,'#665447');
    for(let i=0;i<10;i++) box(hub,-1.64+i*.365,.09,0,.35,.032,3.35,i%3?'#b39166':'#c5a67d');
    box(hub,0,.12,.75,2.8,.024,1.25,'#5c7568');
    box(hub,0,.65,-.12,2.55,1.03,.85,'#546f65');
    box(hub,0,1.21,-.1,2.78,.13,1.1,'#d4b17e');
    box(hub,0,1.315,.09,.84,.045,.3,'#d6dcd0');
    for(const x of [-1.52,1.52]) {
      box(hub,x,1.54,-1.18,.13,3.02,.13,'#67513d');
      box(hub,x,3.07,-.72,.18,.13,1.4,'#806145');
    }
    // Narrow shade slats frame the station while leaving the screen readable.
    for(let i=0;i<8;i++) box(hub,-1.55+i*.44,3.17,-.83,.19,.08,1.25,'#c8ac81',.03);
    box(hub,0,2.82,-1.14,2.65,.25,.08,data.color);
    for(let dot=0;dot<3;dot++) box(hub,-.23+dot*.23,2.83,-1.08,.07,.07,.015,'#f6efdc');
    if(data.kind==='memory') {
      box(hub,-.86,1.86,-.34,.54,1.1,.48,'#3d5154');
      for(let row=0;row<4;row++) {
        box(hub,-.86,1.51+row*.23,-.081,.44,.15,.045,'#839287');
        box(hub,-1.0,1.52+row*.23,-.047,.04,.045,.02,lampMat);
      }
      monitor(hub,.35,1.95,-.27,1.05,.74,'#d8b680');
      for(let file=0;file<4;file++) box(hub,.74+file*.1,1.4,.13,.07,.31,.26,['#ddbd87','#819781','#bac5b1','#bb967b'][file]);
    } else if(data.kind==='projects') {
      monitor(hub,-.59,1.93,-.3,.83,.66,'#70b9c5'); monitor(hub,.59,2.07,-.34,.84,.9,'#96c5bc');
      box(hub,.8,1.34,.33,.5,.02,.32,'#f0e1bd',.2);
      for(let tick=0;tick<3;tick++) box(hub,.72,1.356,.23+tick*.07,.21,.009,.012,'#55887e',.2);
    } else if(data.kind==='workflows') {
      monitor(hub,0,2.05,-.32,1.83,.85,'#a699c3');
      for(let node=0;node<3;node++) {
        box(hub,-.61+node*.6,2.05,-.237,.31,.25,.017,['#f0d8a3','#d9e5ca','#f5c4a0'][node]);
        if(node<2) box(hub,-.31+node*.6,2.05,-.23,.27,.035,.017,'#f5eee0');
      }
      box(hub,.89,1.43,.19,.25,.31,.32,'#dfb271');
    } else {
      monitor(hub,-.44,1.92,-.22,.97,.63,'#87b9ac');
      cyl(hub,.75,1.43,-.24,.25,.36,.32,'#415e58',8);
      contextBeacon=mesh(hub,geo('ico',1,1),material('#89c8b3',{emissive:'#69b89e',emissiveIntensity:.36}),.75,1.98,-.24); contextBeacon.scale.set(.36,.43,.36); nightMaterials.push(contextBeacon.material);
      for(let ring=0;ring<3;ring++) box(hub,.75,1.78+ring*.18,-.24,.84,.035,.035,'#d4c698',ring*.5);
    }
    plant(hub,-1.36,.1,.98,.7); mug(hub,1.06,1.3,.13);
    // Hit boxes belong only to computers, never to the neighbouring characters.
    const hit=new THREE.Mesh(geo('box',2.9,2.25,1.6),new THREE.MeshBasicMaterial({visible:false}));
    hit.position.set(data.x,1.35,data.z-.12);hit.userData.stationKind=data.kind;hit.userData.stationId=data.id;scene.add(hit);
    stationHits.push(hit);stations.push({...data,hit});stationLabels.push({id:data.id,kind:data.kind,label:data.label,x:0,y:0,visible:true});
  });
  const meeting=group(courtyard,0,0,9.0);
  box(meeting,0,-.035,0,6.75,.24,5.55,'#725640');
  for(let i=0;i<17;i++) box(meeting,-3.2+i*.4,.102,0,.38,.045,5.45,i%3?'#b68d60':'#c39b6d');
  box(meeting,0,.132,0,5.3,.018,4.3,'#6e8576');
  for(let stripe=0;stripe<4;stripe++) box(meeting,0,.147,-1.8+stripe*1.2,4.95,.01,.065,'#cbbd8f');
  for(const x of [-3.13,3.13]) for(const z of [-2.45,2.45]) box(meeting,x,2.07,z,.17,4.05,.17,'#6c533d');
  for(const x of [-3.13,3.13]) box(meeting,x,4.12,0,.23,.2,5.5,'#876540');
  for(let i=0;i<7;i++) box(meeting,0,4.24,-2.45+i*.81,6.7,.14,.19,'#b79a70');
  // An open pergola gives structure without hiding the people underneath it.
  cyl(meeting,0,.7,0,.2,.38,1.17,'#435d55',8);
  cyl(meeting,0,1.3,0,1.31,1.37,.14,'#d7b783',12);
  cyl(meeting,0,1.386,0,1.13,1.13,.025,'#ead6af',12);
  box(meeting,0,1.42,0,1.08,.02,.65,'#7daaa0',.15);
  for(let i=0;i<4;i++) box(meeting,-.34+i*.22,1.437,-.05,.12,.015,.26,['#efc876','#a1c5ae','#c1a5d0','#e6aa83'][i],.15);
  mug(meeting,-.7,1.41,.15);mug(meeting,.8,1.41,-.24);
  const meetingSeats=[[-2.15,8.9],[0,6.85],[2.15,8.9],[-1.4,10.95],[1.4,10.95]];
  meetingSeats.forEach(([x,z],i)=>{
    const stool=group(courtyard,x*1.2,0,9+(z-9)*1.2);box(stool,0,.57,0,.72,.17,.67,cast[i].color);box(stool,0,.29,0,.13,.48,.13,'#425951');box(stool,0,.1,0,.59,.07,.5,'#425951');
  });
  plant(meeting,-2.7,.14,2,.9);plant(meeting,2.7,.14,2,.9);
  const meetingHit=new THREE.Mesh(geo('box',2.8,1.55,2.8),new THREE.MeshBasicMaterial({visible:false}));
  meetingHit.position.set(0,1,9);meetingHit.userData.stationKind='meeting';meetingHit.userData.stationId='meeting';scene.add(meetingHit);stationHits.push(meetingHit);
  stations.push({id:'meeting',kind:'meeting',label:'Riunione',x:0,z:9,hit:meetingHit});stationLabels.push({id:'meeting',kind:'meeting',label:'Riunione',x:0,y:0,visible:true});
  // Stepping stones connect the working decks, computers and meeting pavilion.
  for(let side of [-1,1]) {
    for(let j=0;j<6;j++) box(courtyard,side*(7.1+j*.61),.014,-1.1,.48,.06,.88,j%2?'#c7bc9f':'#d8ceb6',side*.04);
    for(let j=0;j<7;j++) box(courtyard,side*7.25,.013,1+j*.72,.81,.055,.54,j%2?'#c7bc9f':'#d8ceb6',.02);
    for(let j=0;j<6;j++) box(courtyard,side*(3.6+j*.69),.023,6.0,.56,.07,.87,j%2?'#d6c6a5':'#bcab8a',-.03);
  }

  bake(courtyard);

  // The same real light source belongs to the studio in every landscape.
  const fireRoot = group(scene,0,0,.9), fireStatic=group(fireRoot), flameParts=[];
  cyl(fireStatic,0,.014,0,1.03,1.09,.09,'#5c5143',14);
  cyl(fireStatic,0,.068,0,.78,.84,.025,'#3d342c',14);
  for(let i=0;i<13;i++) {
    const theta=i/13*Math.PI*2;
    const stone=mesh(fireStatic,geo('ico',1,1),i%2?'#a4a493':'#8b958b',Math.sin(theta)*.88,.17,Math.cos(theta)*.88);
    stone.scale.set(.23,.19,.26);stone.rotation.y=theta;
  }
  for(let i=0;i<5;i++) {
    const log=group(fireStatic,0,.2,0);log.rotation.y=i*Math.PI/5;
    const trunk=cyl(log,0,0,0,.13,.16,1.38,i%2?'#765034':'#5e422e',7);trunk.rotation.z=Math.PI/2;
    const cut=cyl(log,.7,0,0,.106,.106,.023,'#bc8e57',7);cut.rotation.z=Math.PI/2;
  }
  const emberMat=material('#a34018',{emissive:'#ff6323',emissiveIntensity:1.2});
  for(let i=0;i<11;i++) {const coal=mesh(fireStatic,geo('ico',1,0),emberMat,Math.sin(i*2.7)*.45,.18,Math.cos(i*2.7)*.45);coal.scale.set(.13,.08,.16);}
  bake(fireStatic);
  const fireColors=['#ef6525','#ff9a32','#ffd566','#fff0a0'];
  const flameMats=fireColors.map(color=>{const m=new THREE.MeshBasicMaterial({color,transparent:true,opacity:.93,depthWrite:false});customMaterials.push(m);return m;});
  for(let i=0;i<9;i++) {
    const theta=i*2.4, outer=i<4;
    const f=mesh(fireRoot,geo('cone',outer?.24:.14,outer?1.12:.9,5),flameMats[i%4],Math.sin(theta)*(outer?.32:.15),outer?.78:.69,Math.cos(theta)*(outer?.32:.15));
    f.castShadow=false;f.receiveShadow=false;flameParts.push({mesh:f,baseY:f.position.y,phase:i*.77});
  }
  const fireLight=new THREE.PointLight('#ffb357',16,17,1.55);fireLight.position.set(0,1.3,.9);scene.add(fireLight);
  const fireGlowMat=new THREE.MeshBasicMaterial({color:'#ffb34d',transparent:true,opacity:.07,depthWrite:false,side:THREE.DoubleSide});customMaterials.push(fireGlowMat);
  const fireGlowGeo=new THREE.CircleGeometry(1.4,32);customGeometries.push(fireGlowGeo);
  const fireGlow=new THREE.Mesh(fireGlowGeo,fireGlowMat);fireGlow.rotation.x=-Math.PI/2;fireGlow.position.set(0,.095,.9);scene.add(fireGlow);
  const sparkGeometry=new THREE.BufferGeometry();customGeometries.push(sparkGeometry);
  const sparkPositions=new Float32Array(22*3);sparkGeometry.setAttribute('position',new THREE.BufferAttribute(sparkPositions,3));
  const sparkMat=new THREE.PointsMaterial({color:'#ffd58a',size:2.1,sizeAttenuation:false,transparent:true,opacity:.85,depthWrite:false});customMaterials.push(sparkMat);
  const sparks=new THREE.Points(sparkGeometry,sparkMat);sparks.position.copy(fireRoot.position);sparks.frustumCulled=false;scene.add(sparks);
  function updateFire() {
    const flicker=quiet?1:1+Math.sin(elapsed*9.2)*.07+Math.sin(elapsed*14.7)*.035;
    fireLight.intensity=night?29*flicker:0;
    fireGlow.visible=night;sparks.visible=night;emberMat.emissiveIntensity=night?1.2:0;
    fireGlowMat.opacity=night?.115:0;
    flameParts.forEach(({mesh:part,baseY,phase})=>{
      part.visible=night;
      const pulse=quiet?1:1+Math.sin(elapsed*7+phase)*.16;
      part.scale.set(1/pulse,pulse,1/pulse);part.position.y=baseY+(pulse-1)*.21;
      part.rotation.z=quiet?0:Math.sin(elapsed*5+phase)*.09;
    });
    for(let i=0;i<22;i++) {
      const life=(elapsed*(.22+(i%3)*.08)+i/22)%1;
      sparkPositions[i*3]=Math.sin(i*2.3+elapsed*.7)*(.11+life*.53);
      sparkPositions[i*3+1]=.55+life*2.05;
      sparkPositions[i*3+2]=Math.cos(i*1.7+elapsed*.8)*(.12+life*.4);
    }
    sparkGeometry.attributes.position.needsUpdate=true;
  }
  // Keep the moon beyond the working districts; a nearby moon crosses the
  // ground in the camera projection when exploring the outer landmarks.
  const sky = group(scene), moon=group(sky,-84,30,-65);
  const moonMat=new THREE.MeshBasicMaterial({color:'#f2edca'});customMaterials.push(moonMat);
  const moonBody=mesh(moon,geo('ico',1.8,3),moonMat,0,0,0);moonBody.castShadow=moonBody.receiveShadow=false;
  const moonHaloMat=new THREE.MeshBasicMaterial({color:'#b5c6d0',transparent:true,opacity:.045,depthWrite:false});customMaterials.push(moonHaloMat);
  const moonHalo=mesh(moon,geo('ico',2.55,2),moonHaloMat,0,0,0);moonHalo.castShadow=moonHalo.receiveShadow=false;
  const craterMat=new THREE.MeshBasicMaterial({color:'#c7d0b7'});customMaterials.push(craterMat);
  [[-.62,.41,1.52,.28],[.49,-.39,1.6,.21],[.12,.84,1.5,.15]].forEach(([x,y,z,r])=>{const crater=mesh(moon,geo('ico',r,1),craterMat,x,y,z);crater.scale.z=.12;crater.castShadow=false;});
  const starGeometry=new THREE.BufferGeometry();customGeometries.push(starGeometry);
  const starPositions=new Float32Array(170*3);
  for(let i=0;i<170;i++){starPositions[i*3]=(random()-.5)*125;starPositions[i*3+1]=15+random()*34;starPositions[i*3+2]=-55+random()*70;}
  starGeometry.setAttribute('position',new THREE.BufferAttribute(starPositions,3));
  const starMat=new THREE.PointsMaterial({color:'#dce9d7',size:1.7,sizeAttenuation:false,transparent:true,opacity:.82,depthWrite:false});customMaterials.push(starMat);
  const stars=new THREE.Points(starGeometry,starMat);sky.add(stars);

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
    return { ...a, root, visual, head, arms, elbows, legs, knees, halo, hit, home, routeXs, routeZs, routeLengths, travel: 0, meetingTarget: false, meetingRoute: [], meetingLength: 1, working: false, routineWorking: false, lastCycle: 0, status: 'idle', walking: false, position: { id: a.id, x: 0, y: 0, visible: true } };
  }
  const agents = cast.map(makeAvatar);
  const hitBoxes = agents.map(a => a.hit);
  const labels = agents.map(a => a.position);

  // Landscape silhouettes live around the office, leaving the actors unobstructed.
  const themes = { anthill: group(scene), forest: group(scene), beach: group(scene), mountains: group(scene) };
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
  [[-15,-7,1.45],[-12,-10,1.2],[-5,-10,.95],[3,-11,1.1],[12,-9,1.35],[15,-2.5,1.12],[-15,-1.5,1.1],[-16,5.4,.98],[15,9.5,1.15],[-8,13.3,.93]].forEach((p,i) => tree(forest,...p,i%2));
  [[-7,-13,1],[.4,-12.15,1.1],[7,-12.9,1.19]].forEach((p,i)=>tree(forest,...p,i%2));
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
  [[-14.4,-6.5,1.4,0],[13.8,-9.3,1.4,.3],[15,-2.3,1.2,.8],[-15.2,1.6,1.02,.4],[-15,10.1,1.15,1]].forEach(p => palm(beach,...p));
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
  [[-15.2,-5.4,1.3],[-15.4,-1.4,1.05],[14,-8.5,1.4],[16.1,.2,1.14],[-15.6,9.4,1.1],[14.9,11.7,1.18]].forEach(p=>pine(mountains,...p));
  const cabin = group(mountains, 16.4, 0, -4.4);
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
  // Low rounded mounds, branching roads and supplies make this an ant colony,
  // with the five desks occupying its open central clearing.
  const anthill = themes.anthill;
  const antRoads = [];
  const antSystems = [];
  function antRoad(points, width = .9, count = 20, speed = .8) {
    const curve = new THREE.CatmullRomCurve3(points.map(([x, z]) => new THREE.Vector3(x, .07, z)), true, 'centripetal');
    curve.arcLengthDivisions = 360;
    const length = curve.getLength();
    const samples = Math.ceil(length * 3), a = new THREE.Vector3(), b = new THREE.Vector3();
    for (let i = 0; i < samples; i++) {
      curve.getPointAt(i / samples, a); curve.getPointAt((i + 1) / samples, b);
      const strip = box(anthill, (a.x + b.x) / 2, -.016, (a.z + b.z) / 2, width, .045, a.distanceTo(b) + .09, '#c4a36a');
      strip.rotation.y = Math.atan2(b.x - a.x, b.z - a.z);
    }
    antRoads.push({ curve, length, count, speed });
  }
  antRoad([[-13.5,-7.9],[-4,-8.1],[3,-8.1],[13.5,-7.4],[14.7,0],[14.3,8.7],[5,13.0],[-4,13.0],[-14.0,8.5],[-14.7,0]], 1.0, 30, .72);
  antRoad([[-7.2,-.4],[-3.2,-1.1],[0,-2.6],[2.8,-1],[6.8,-.4],[6.7,4.8],[0,5.1],[-6.5,4.7]], .6, 18, .64);
  antRoad([[-10.4,-7.7],[-17,-10.8],[-22,-16],[-17,-19],[-9,-17],[-6,-12]], 1.1, 22, .95);
  antRoad([[9.6,-6.7],[16,-11],[23,-15],[26,-8],[21,-1],[15,1]], 1.1, 20, .88);
  antRoad([[-9.7,6],[-17,7],[-23,13],[-16,18],[-4,17],[5,18],[17,15],[24,8],[18,5],[10.4,6.5],[4,9],[-3,10]], 1.05, 30, 1.02);

  function mound(x, z, radius, high, facing = 0) {
    const nest = group(anthill, x, 0, z); nest.rotation.y = facing;
    // Nested faceted ellipsoids keep the nest softer than the rocky scenery.
    const bottom = mesh(nest, geo('ico', 1, 2), '#b1814e', 0, .02, 0); bottom.scale.set(radius, high * .62, radius * .82);
    const crown = mesh(nest, geo('ico', 1, 1), '#bc915a', -.28, high * .26, -.35); crown.scale.set(radius * .77, high * .69, radius * .63);
    const crest = mesh(nest, geo('ico', 1, 1), '#c9a36b', -.18, high * .55, -.22); crest.scale.set(radius * .46, high * .42, radius * .43);
    const entrance = mesh(nest, geo('ico', 1, 2), '#392b22', 0, .37, radius * .81); entrance.scale.set(radius * .28, .52, .19);
    const inner = mesh(nest, geo('ico', 1, 1), '#211e1a', 0, .32, radius * .88); inner.scale.set(radius * .2, .36, .08);
    // A stone arch and a well-worn ramp frame the visible entrance.
    for (let i = 0; i < 7; i++) {
      const theta = Math.PI * i / 6;
      const pebble = mesh(nest, geo('ico', 1, 0), i % 2 ? '#d4b17a' : '#9b7144', Math.cos(theta) * radius * .3, .1 + Math.sin(theta) * .68, radius * .89);
      pebble.scale.set(.23, .24, .23);
    }
    box(nest, 0, -.005, radius * 1.1, radius * .55, .08, radius * .66, '#c4a36a');
    for (let i = 0; i < 20; i++) {
      const theta = random() * Math.PI * 2, r = radius * (1 + random() * .24);
      rock(nest, Math.sin(theta) * r, Math.cos(theta) * r * .82, .13 + random() * .23, i % 2 ? '#d1ad79' : '#977442');
    }
  }
  mound(-19, -16.8, 4.6, 4.9, .12);
  mound(21.6, -12.6, 4.0, 4.1, -.9);
  mound(-22.3, 12.6, 3.1, 2.7, 2.0);
  mound(19.2, 15.7, 3.8, 3.1, -2.5);
  mound(-2.2, -19.6, 2.8, 2.5, .05);

  function clover(g, x, z, size = 1) {
    const tuft = group(g, x, 0, z); tuft.rotation.y = random() * Math.PI * 2;
    box(tuft, 0, .38 * size, 0, .055, .76 * size, .055, '#4d793e');
    for (let n = 0; n < 3; n++) {
      const theta = n * Math.PI * 2 / 3;
      const leaf = mesh(tuft, geo('ico', 1, 1), n % 2 ? '#71a748' : '#579541', Math.sin(theta) * .28 * size, .73 * size, Math.cos(theta) * .28 * size);
      leaf.scale.set(.34 * size, .08 * size, .32 * size); leaf.rotation.y = theta;
    }
  }
  function supplyPile(x, z, leafPile = false) {
    const pile = group(anthill, x, 0, z);
    cyl(pile, 0, -.007, 0, 1.5, 1.5, .035, '#b69a68', 10);
    for (let i = 0; i < 19; i++) {
      const theta = random() * Math.PI * 2, r = random() * 1.05;
      const item = mesh(pile, geo('ico', 1, 0), leafPile ? (i % 2 ? '#70a33c' : '#459548') : (i % 2 ? '#ebc376' : '#d5a450'), Math.sin(theta) * r, .14 + (1 - r) * .33, Math.cos(theta) * r);
      item.scale.set(leafPile ? .36 : .15, leafPile ? .06 : .13, leafPile ? .2 : .23); item.rotation.set(random() * .5, random() * 6, random() * .2);
    }
  }
  supplyPile(-13, -5.3, true); supplyPile(13.6, -3.4); supplyPile(4.9, 11.5, true); supplyPile(-16.8, 14.2);
  // A fallen branch, mushrooms and tall clover give the surrounding garden scale.
  const log = group(anthill, 11.7, .42, -17.8); log.rotation.set(0, -.48, Math.PI / 2);
  cyl(log, 0, 0, 0, .72, .85, 7.5, '#78502f', 9);
  cyl(log, 0, 3.78, 0, .59, .59, .05, '#ccaa71', 9);
  cyl(log, 0, 3.81, 0, .32, .32, .02, '#a97b4a', 9);
  function mushroom(x, z, size) {
    cyl(anthill, x, .45 * size, z, .14 * size, .22 * size, .9 * size, '#f0dfb8', 7);
    cone(anthill, x, .98 * size, z, .62 * size, .47 * size, '#c76d47', 9);
    cyl(anthill, x, .78 * size, z, .62 * size, .49 * size, .15 * size, '#ead0a3', 9);
  }
  [[-26,-5,1.7],[-24.7,-4.3,.9],[26,18,1.35],[25,17,.8],[-9,20,1.1]].forEach(p => mushroom(...p));
  for (let i = 0; i < 240; i++) {
    const x = (random() - .5) * 57, z = (random() - .5) * 46;
    if (Math.abs(x) < 12 && Math.abs(z) < 10) continue;
    // Keep nest entrances and the avenues visually open.
    if (antRoads.some(({curve}) => {
      for (let j = 0; j < 90; j++) { const p = curve.getPointAt(j / 90, scratch); if (Math.hypot(p.x - x, p.z - z) < .95) return true; }
      return false;
    })) continue;
    if (i % 11 === 0) rock(anthill, x, z, .6 + random() * 1.15, '#a6a58c');
    else if (i % 4 === 0) clover(anthill, x, z, .8 + random() * 1.6);
    else if (i % 7 === 0) flower(anthill, x, z, '#f2d89d', 1.1);
    else grass(anthill, x, z, .75 + random() * 1.8, i % 2 ? '#7f9952' : '#5f914b');
  }
  [[-26,-19,1.45],[-13,-22,1.1],[6,-22,1.4],[27,-18,1.25],[-27,19,1.15],[27,21,.95]].forEach((p,i) => tree(anthill, ...p, i % 2));
  // Small path-side stones leave the studio conspicuous when zooming far out.
  for (let i = 0; i < 18; i++) {
    const theta = i / 18 * Math.PI * 2;
    rock(anthill, Math.sin(theta) * 12.4, Math.cos(theta) * 9.3, .16 + (i % 3) * .07, '#e2cca1');
  }

  // Instancing lets 120 six-legged workers move with only six additional draws.
  const antCount = antRoads.reduce((total, road) => total + road.count, 0);
  const antLayer = group(scene);
  function antInstances(geometry, color, count) {
    const instances = new THREE.InstancedMesh(geometry, material(color), count);
    instances.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    instances.castShadow = true; instances.receiveShadow = true;
    instances.frustumCulled = false;
    antLayer.add(instances); antSystems.push(instances); return instances;
  }
  const antBodies = antInstances(geo('ico', 1, 1), '#513325', antCount * 3);
  const antLegs = antInstances(geo('cylinder', 1, 1, 1, 4), '#65452d', antCount * 12);
  const antFeelers = antInstances(geo('cylinder', 1, 1, 1, 4), '#493328', antCount * 4);
  const antLeaves = antInstances(geo('ico', 1, 0), '#78b84c', antCount);
  const antGrains = antInstances(geo('ico', 1, 1), '#f0cc7b', antCount);
  const antVeins = antInstances(geo('cylinder', 1, 1, 1, 4), '#bfda75', antCount);
  const ants = [];
  antRoads.forEach((road, roadIndex) => {
    for (let i = 0; i < road.count; i++) ants.push({ road, offset: (i + .2) / road.count, scale: .76 + random() * .24, phase: random() * Math.PI * 2, cargo: (i + roadIndex) % 3, direction: i % 4 === 0 ? -1 : 1 });
  });
  const antDummy = new THREE.Object3D(), antPosition = new THREE.Vector3(), antTangent = new THREE.Vector3();
  const antRotation = new THREE.Quaternion(), antStart = new THREE.Vector3(), antEnd = new THREE.Vector3(), antAxis = new THREE.Vector3(0, 1, 0), antDirection = new THREE.Vector3();
  let antScale = 1;
  function antPoint(target, x, y, z) { return target.set(x * antScale, y * antScale, z * antScale).applyQuaternion(antRotation).add(antPosition); }
  function antSegment(instances, index, ax, ay, az, bx, by, bz, radius) {
    antPoint(antStart, ax, ay, az); antPoint(antEnd, bx, by, bz);
    antDummy.position.copy(antStart).add(antEnd).multiplyScalar(.5);
    antDirection.subVectors(antEnd, antStart);
    const length = antDirection.length();
    antDummy.quaternion.setFromUnitVectors(antAxis, antDirection.normalize());
    antDummy.scale.set(radius * antScale, length, radius * antScale);
    antDummy.updateMatrix(); instances.setMatrixAt(index, antDummy.matrix);
  }
  function antPart(instances, index, x, y, z, sx, sy, sz) {
    antPoint(antDummy.position, x, y, z); antDummy.quaternion.copy(antRotation);
    antDummy.scale.set(sx * antScale, sy * antScale, sz * antScale); antDummy.updateMatrix(); instances.setMatrixAt(index, antDummy.matrix);
  }
  function updateAnts() {
    let outputIndex=0;
    const density=(.4+activity.load*.6)*(quality.tier==='lite'?.55:quality.tier==='balanced'?.8:1), threat=wildlife?.getAntTarget?.();
    ants.forEach((ant, sourceIndex) => {
      if((sourceIndex%10)/10>=density) return;
      const index=outputIndex++;
      const progress = ((ant.offset + antClock * ant.road.speed / ant.road.length * ant.direction) % 1 + 1) % 1;
      ant.road.curve.getPointAt(progress, antPosition); ant.road.curve.getTangentAt(progress, antTangent);
      antRotation.setFromAxisAngle(antAxis, Math.atan2(antTangent.x * ant.direction, antTangent.z * ant.direction));
      antScale = ant.scale;
      if(threat) {
        const dx=antPosition.x-threat.x,dz=antPosition.z-threat.z,distance=Math.hypot(dx,dz);
        if(distance>0.05&&distance<5.5) {const push=(1-distance/5.5)*2.2*threat.strength;antPosition.x+=dx/distance*push;antPosition.z+=dz/distance*push;}
      }
      // A second lane lets empty ants return past the laden convoy.
      const side = ant.direction * .17;
      antPosition.x += Math.cos(Math.atan2(antTangent.x, antTangent.z)) * side;
      antPosition.z -= Math.sin(Math.atan2(antTangent.x, antTangent.z)) * side;
      antPart(antBodies, index * 3, 0, .23, -.34, .2, .18, .29);
      antPart(antBodies, index * 3 + 1, 0, .24, 0, .115, .13, .2);
      antPart(antBodies, index * 3 + 2, 0, .25, .3, .18, .155, .18);
      for (let leg = 0; leg < 6; leg++) {
        const sign = leg < 3 ? -1 : 1, pair = leg % 3, z = (pair - 1) * .15;
        const stride = quiet ? 0 : Math.sin(antClock * 12 + ant.phase + pair * Math.PI + (sign > 0 ? Math.PI : 0));
        const footZ = z * 2.0 + stride * .1, footY = .02 + Math.max(0, stride) * .065;
        antSegment(antLegs, index * 12 + leg * 2, sign * .1, .23, z, sign * .34, .17, z * 1.6, .025);
        antSegment(antLegs, index * 12 + leg * 2 + 1, sign * .34, .17, z * 1.6, sign * .51, footY, footZ, .021);
      }
      for (let sideIndex = 0; sideIndex < 2; sideIndex++) {
        const sign = sideIndex ? 1 : -1;
        antSegment(antFeelers, index * 4 + sideIndex * 2, sign * .1, .33, .4, sign * .2, .4, .54, .021);
        antSegment(antFeelers, index * 4 + sideIndex * 2 + 1, sign * .2, .4, .54, sign * .27, .43, .7, .018);
      }
      // Unused cargo is collapsed locally rather than allocating extra meshes.
      const leaf = ant.cargo === 0 ? 1 : 0, grain = ant.cargo === 1 ? 1 : 0;
      antPart(antLeaves, index, 0, .52, .27, .26 * leaf, .08 * leaf, .48 * leaf);
      antPart(antGrains, index, 0, .47, .39, .14 * grain, .16 * grain, .23 * grain);
      antSegment(antVeins, index, 0, .597, -.07, 0, .597, .61, .014 * leaf);
    });
    antVisibleCount=outputIndex;
    [antBodies,antLegs,antFeelers,antLeaves,antGrains,antVeins].forEach((instances,i)=>{instances.count=outputIndex*[3,12,4,1,1,1][i];instances.instanceMatrix.needsUpdate=true;});
  }
  updateAnts();

  // Older environments also extend across the explorable map.
  for (let i = 0; i < 85; i++) {
    const x = (random() - .5) * 57, z = (random() - .5) * 46;
    if (Math.abs(x) < 13 && Math.abs(z) < 11) continue;
    if (i % 3 === 0) { tree(forest, x, z, .8 + random() * .9, i % 2); pine(mountains, x, z, .9 + random() * 1.1); }
    else { grass(forest, x, z, 1 + random()); rock(mountains, x, z, .5 + random(), '#a5b0a5'); }
    if (i % 9 === 0) palm(beach, x, z, .8 + random() * .6, random() * 6);
    else if (i % 4 === 0) rock(beach, x, z, .4 + random() * .7, '#d6c7a3');
  }
  box(beach, 0, -.022, -20.8, 60.15, .06, 8.4, '#4fc8c7');
  box(beach, 0, -.022, 21.6, 60.15, .06, 6.8, '#50c7c6');
  box(beach, 27.7, -.022, .4, 4.8, .06, 37, '#50c7c6');
  peak(-21, -19.6, 6.2, 9.6, '#a5b4ac'); peak(16, -20, 6, 9, '#adb9b3');

  // Broad, irregular colour fields break up the ground without texture downloads.
  function groundTexture(parent, palette) {
    const vertices=[],colors=[],shade=new THREE.Color(),cols=20,rows=17;
    const grid=[];
    for(let z=0;z<=rows;z++) for(let x=0;x<=cols;x++) grid.push(new THREE.Vector3(-30+x*3+(x&&x<cols?(random()-.5)*1.25:0),-.064+(random()-.5)*.006,-25+z*50/rows+(z&&z<rows?(random()-.5)*1.1:0)));
    for(let z=0;z<rows;z++) for(let x=0;x<cols;x++) {
      const ids=[z*(cols+1)+x,z*(cols+1)+x+1,(z+1)*(cols+1)+x,(z+1)*(cols+1)+x+1];
      const region=Math.sin(x*.7)+Math.cos(z*.9)+Math.sin((x+z)*.31);
      shade.set(palette[THREE.MathUtils.clamp(Math.floor((region+3)/6*palette.length),0,palette.length-1)]);
      for(const id of [ids[0],ids[2],ids[1],ids[1],ids[2],ids[3]]) {const p=grid[id];vertices.push(p.x,p.y,p.z);colors.push(shade.r,shade.g,shade.b);}
    }
    const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));geometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));geometry.computeVertexNormals();customGeometries.push(geometry);
    const mat=material('#ffffff',{vertexColors:true,roughness:1});
    const surface=new THREE.Mesh(geometry,mat);surface.receiveShadow=true;parent.add(surface);
  }
  groundTexture(anthill,['#98a871','#a2ad76','#acb17c','#b1b17c','#aaa773']);
  groundTexture(forest,['#6e935c','#769f63','#82a768','#8fac70','#94ad74']);
  groundTexture(beach,['#d6c58f','#ddcb95','#e5d5a3','#eadbad','#e4d09b']);
  groundTexture(mountains,['#869980','#90a088','#9aaa8f','#a3ad94','#95a089']);
  function landscapeHill(parent,x,z,r,h,color) {
    const hill=mesh(parent,geo('ico',1,2),color,x,-.22,z);hill.scale.set(r,h,r*.73);
    const terrace=mesh(parent,geo('ico',1,1),color,x-r*.18,h*.23-.16,z-r*.09);terrace.scale.set(r*.66,h*.69,r*.48);
    return hill;
  }
  function stream(parent,coords,width,color) {
    const curve=new THREE.CatmullRomCurve3(coords.map(([x,z])=>new THREE.Vector3(x,0,z))),a=new THREE.Vector3(),b=new THREE.Vector3();
    for(let j=0;j<125;j++) {
      curve.getPoint(j/125,a);curve.getPoint((j+1)/125,b);const rot=Math.atan2(b.x-a.x,b.z-a.z),length=a.distanceTo(b)+.12;
      box(parent,(a.x+b.x)/2,-.025,(a.z+b.z)/2,width+.7,.025,length,'#b5b092',rot);
      box(parent,(a.x+b.x)/2,.003,(a.z+b.z)/2,width,.026,length,color,rot);
      if(j%9===0) {
        const ripple=box(parent,a.x,.021,a.z,width*.48,.013,.052,'#b4ddd0',rot+.06);
        rock(parent,a.x+Math.cos(rot)*(width*.6),a.z-Math.sin(rot)*(width*.6),.3+random()*.35,'#929d90');
      }
    }
    return curve;
  }
  stream(forest,[[-21,-24],[-18,-16],[-19,-7],[-17,4],[-19,13],[-24,19],[-20,24]],2.7,'#5da8a1');
  const bridge=group(forest,-17.25,.1,5);
  for(let i=0;i<13;i++) box(bridge,-2.64+i*.44,.3,0,.41,.12,1.9,i%3?'#b99062':'#c7a779');
  for(let side of [-1,1]) {
    for(let x of [-2.7,-.9,.9,2.7]) box(bridge,x,.78,side*.87,.12,1.3,.12,'#765b3e');
    box(bridge,0,1.38,side*.87,5.6,.12,.14,'#957249');
  }
  [[-24,-15,4.4,2.2],[-23,15,4,1.5],[16,18,5.5,1.8],[21,-19,4.5,2.3]].forEach(([x,z,r,h],i)=>landscapeHill(forest,x,z,r,h,i%2?'#77945c':'#6d8c55'));
  const forestPond=group(forest,11.5,0,-16.5);
  cyl(forestPond,0,-.025,0,4.3,4.3,.035,'#b5ae87',18);cyl(forestPond,0,.006,0,3.94,3.94,.03,'#629f97',18);
  for(let i=0;i<14;i++) {
    const t=i/14*Math.PI*2;rock(forestPond,Math.sin(t)*4.2,Math.cos(t)*4.2,.35+random()*.35,'#939f87');
    if(i%2===0){const leaf=cyl(forestPond,Math.sin(t)*2.75,.034,Math.cos(t)*2.75,.25,.25,.025,'#608f5d',7);flower(forestPond,leaf.position.x,leaf.position.z,'#e7d3bd',.6);}
  }
  for(let i=0;i<36;i++) {
    const x=(random()-.5)*55,z=(random()-.5)*45;
    if(Math.abs(x)<14&&z>-10&&z<13)continue;
    const branch=box(forest,x,.08,z,.08,.08,.8+random(),'#866d4c',random()*6);
    if(i%3===0){mushroomForest(x+.3,z,.7+random()*.6);}
  }
  function mushroomForest(x,z,size) {cyl(forest,x,.22*size,z,.06,.1,.44*size,'#e2d9bd',6);cone(forest,x,.47*size,z,.28*size,.18*size,'#b17e5c',7);}

  // The colony stores its harvest under giant leaves, with gravel beside roads.
  const harvest=group(anthill,-15.3,0,5.1);
  for(let i=0;i<3;i++) {
    const support=group(harvest,-1+i,0,-.45+(i%2)*.55);support.rotation.z=(i-1)*.13;
    cyl(support,0,1.16,0,.04,.075,2.32,'#66804a',6);
    const leaf=mesh(support,geo('ico',1,1),i%2?'#7a9a4f':'#659347',0,2.37,0);leaf.scale.set(.87,.1,1.43);leaf.rotation.z=-.13;
    beam(support,[0,2.48,-1.2],[0,2.48,1.2],.025,'#a4b866');
  }
  for(let i=0;i<17;i++) {const seedPiece=mesh(harvest,geo('ico',1,1),i%2?'#d9b35f':'#e3c67d',(random()-.5)*2.6,.12+random()*.22,(random()-.5)*1.3);seedPiece.scale.set(.14,.13,.21);}
  [[-27,5,3.5,1.4],[25,-4,3,1.1],[-7,-22,3.4,1.2],[8,21,4.5,1.0]].forEach(([x,z,r,h])=>landscapeHill(anthill,x,z,r,h,'#a3a16c'));
  for(let i=0;i<70;i++) {
    const road=antRoads[i%antRoads.length],p=road.curve.getPointAt((i*.173)%1),t=road.curve.getTangentAt((i*.173)%1),side=i%2?1:-1;
    rock(anthill,p.x+t.z*side*.82,p.z-t.x*side*.82,.055+random()*.11,i%3?'#c9b689':'#8c8561');
  }
  for(let i=0;i<22;i++) {const x=-25+random()*50,z=i%2?-20+random()*6:15+random()*7;const chip=box(anthill,x,.04,z,.13,.035,.4,'#c6b27e',random()*6);}

  // A coastal lagoon, timber jetty and beached sailing boat give the shore a focus.
  const lagoon=group(beach,20.8,0,7.5);
  cyl(lagoon,0,-.024,0,7,7,.035,'#eae0b9',24);cyl(lagoon,0,.007,0,6.45,6.45,.04,'#72c2bf',24);cyl(lagoon,.9,.031,-.4,4.5,4.5,.023,'#58aeae',22);
  for(let j=0;j<12;j++) box(lagoon,-3.9+(j%4)*2.5,.052,-3.7+Math.floor(j/4)*3.15,1.2,.012,.05,'#b9e1d4',.15);
  const jetty=group(beach,17.8,0,1.7);
  for(let i=0;i<13;i++)box(jetty,i*.45,.39,0,.42,.13,1.6,i%2?'#b18b5c':'#c3a070');
  for(let x of [0,2.4,5.4])for(let z of [-.66,.66]){cyl(jetty,x,.34,z,.09,.1,1.28,'#746246',7);cyl(jetty,x,1.02,z,.13,.13,.13,'#c2b394',7);}
  const boat=group(beach,23,.17,3.6);boat.rotation.y=-.34;
  const hull=mesh(boat,geo('ico',1,1),'#f0dfb5',0,.14,0);hull.scale.set(.72,.39,1.66);
  const inside=mesh(boat,geo('ico',1,1),'#a88359',0,.37,0);inside.scale.set(.49,.11,1.29);
  box(boat,0,1.45,0,.075,2.6,.075,'#846b4b');
  const sailGeometry=new THREE.BufferGeometry();sailGeometry.setAttribute('position',new THREE.Float32BufferAttribute([.07,2.6,0,.07,.85,0,1.27,.88,0],3));sailGeometry.computeVertexNormals();customGeometries.push(sailGeometry);
  mesh(boat,sailGeometry,material('#e2c697',{side:THREE.DoubleSide}),0,0,0);
  [[-24,-16,4.2,1.1],[-22,13,5.7,1.1],[-9,19,4.6,.85],[12,-16,4.5,.9]].forEach(([x,z,r,h])=>landscapeHill(beach,x,z,r,h,'#e1d09d'));
  for(let i=0;i<65;i++) {
    const x=(random()-.5)*56,z=(random()-.5)*44;if(Math.abs(x)<14&&Math.abs(z)<13)continue;
    if(i%3)grass(beach,x,z,.45+random()*.7,'#b6b584');else rock(beach,x,z,.09+random()*.14,'#eee2c4');
  }

  // Alpine layers, a tarn and a switchback trail replace an empty grass border.
  [[-24,-10,4.5,3.2],[-22,14,4.4,2.8],[23,11,4.6,3.1],[22,-18,5.3,4.1]].forEach(([x,z,r,h],i)=>landscapeHill(mountains,x,z,r,h,i%2?'#84918b':'#93a094'));
  const tarn=group(mountains,-14.3,0,-15.5);
  cyl(tarn,0,-.022,0,4.1,4.1,.038,'#aeb7a6',17);cyl(tarn,0,.01,0,3.62,3.62,.04,'#679aa0',17);
  for(let j=0;j<6;j++)box(tarn,-2+j*.73,.037,-.8+(j%2)*1.5,.7,.009,.05,'#c1d5cd');
  for(let j=0;j<16;j++){const t=j/16*Math.PI*2;rock(tarn,Math.sin(t)*4,Math.cos(t)*4,.42+random()*.41,'#929f93');}
  stream(mountains,[[-13,-12],[-15,-7],[-17,0],[-19,8],[-19,16],[-24,23]],1.0,'#7ea9a8');
  const trail=[[-9,15],[-17,19],[-24,15],[-18,9],[-24,3],[-19,-2]];
  for(let j=0;j<trail.length-1;j++) {
    const a=trail[j],b=trail[j+1],length=Math.hypot(b[0]-a[0],b[1]-a[1]);box(mountains,(a[0]+b[0])/2,.017,(a[1]+b[1])/2,.7,.042,length,'#c4bc9d',Math.atan2(b[0]-a[0],b[1]-a[1]));
    for(let i=0;i<3;i++)rock(mountains,a[0]+(b[0]-a[0])*i/3,a[1]+(b[1]-a[1])*i/3,.12,'#cfd0b9');
  }
  const lookout=group(mountains,-20.5,0,17.1);
  for(let i=0;i<4;i++)cyl(lookout,0,.12+i*.22,0,.54-i*.105,.61-i*.09,.23,'#a9b1a2',6);
  box(lookout,0,1.42,0,.07,1.2,.07,'#73684c');box(lookout,.43,1.82,0,.8,.35,.05,'#c89963');
  for(let i=0;i<35;i++){const x=(random()-.5)*55,z=(random()-.5)*44;if(Math.abs(x)<14&&Math.abs(z)<13)continue;grass(mountains,x,z,.5+random()*.6,'#7c916e');if(i%4===0)flower(mountains,x+.3,z,'#c1b1cc',.7);}

  Object.values(themes).forEach(bake);
  wildlife=createWildlife(scene);
  expanse=createWorldExpanse({scene,group,mesh,box,cyl,cone,geo,material,bake,beam});

  // A pale underside shadow makes the island float without an expensive contact pass.
  const floor = mesh(scene, geo('box', 640, .1, 640), material('#dcebd9'), 0, -2.94, 0); floor.castShadow = false;
  const selection = new THREE.Mesh(new THREE.RingGeometry(.72, .79, 40), new THREE.MeshBasicMaterial({ color: '#f5da90', side: THREE.DoubleSide, transparent: true, opacity: .95, depthWrite: false }));
  selection.rotation.x = -Math.PI / 2; selection.visible = false; scene.add(selection);

  function updateCamera() {
    sceneDirty=true;
    const distance = 320, aspect = width / height;
    const halfY = Math.max(10.0, 14.7 / aspect);
    if (overview) {
      const extentX = Math.abs(Math.cos(angle)) * (halfWorldX+3) + Math.abs(Math.sin(angle)) * (halfWorldZ+3);
      const extentY = Math.sin(elevation) * (Math.abs(Math.sin(angle)) * (halfWorldX+3) + Math.abs(Math.cos(angle)) * (halfWorldZ+3)) + Math.cos(elevation) * 16;
      zoom = THREE.MathUtils.clamp(Math.min(halfY * aspect / extentX, halfY / extentY) * .9, MIN_ZOOM, MAX_ZOOM);
    }
    camera.position.set(lookAt.x + Math.sin(angle) * Math.cos(elevation) * distance, lookAt.y + Math.sin(elevation) * distance, lookAt.z + Math.cos(angle) * Math.cos(elevation) * distance);
    camera.lookAt(lookAt);
    camera.left = -halfY * aspect; camera.right = halfY * aspect; camera.top = halfY; camera.bottom = -halfY;
    camera.zoom = zoom; camera.updateProjectionMatrix(); camera.updateMatrixWorld();
    // Keep detailed shadows around the viewed district rather than stretching one map across the continent.
    const shadowSpan = THREE.MathUtils.clamp(halfY / zoom * 1.6, 24, 56);
    sun.position.set(lookAt.x-24,45,lookAt.z+28);sun.target.position.set(lookAt.x,0,lookAt.z);
    Object.assign(sun.shadow.camera,{left:-shadowSpan,right:shadowSpan,top:shadowSpan,bottom:-shadowSpan});
    sun.shadow.camera.updateProjectionMatrix();
    onCameraChange({ zoom, overview, target:{x:lookAt.x,z:lookAt.z}, angle,elevation,worldBounds:{...WORLD_EXTENT}, qualityMode:quality.mode,qualityTier:quality.tier });
  }
  function zoomBy(factor) {
    if (!Number.isFinite(factor) || factor <= 0) return;
    cameraFlight=null;overview = false; zoom = THREE.MathUtils.clamp(zoom * factor, MIN_ZOOM, MAX_ZOOM); updateCamera();
  }
  function panCamera(dx, dy) {
    const scale = (camera.top - camera.bottom) / zoom / height;
    cameraFlight=null;
    lookAt.x = THREE.MathUtils.clamp(lookAt.x - dx * scale * Math.cos(angle) + dy * scale * Math.sin(angle) / Math.sin(elevation), -halfWorldX+5, halfWorldX-5);
    lookAt.z = THREE.MathUtils.clamp(lookAt.z + dx * scale * Math.sin(angle) + dy * scale * Math.cos(angle) / Math.sin(elevation), -halfWorldZ+5, halfWorldZ-5);
    overview = false; updateCamera();
  }
  function showOverview() { cameraFlight=null;lookAt.set(0, .45, 0); overview = true; updateCamera(); }
  function getLandmarks(){return [{id:'studio',label:'Lo studio',x:0,z:0,zoom:1},...(WORLD_LANDMARKS[theme]||[])].map(place=>({...place}));}
  function focusLandmark(id){
    const destination=getLandmarks().find(place=>place.id===id);if(!destination)return false;
    overview=false;
    if(quiet){lookAt.set(destination.x,.45,destination.z);zoom=destination.zoom;updateCamera();}
    else cameraFlight={fromX:lookAt.x,fromZ:lookAt.z,fromZoom:zoom,to:destination,progress:0};
    return true;
  }
  function applyQuality(){
    const profile=quality.profile;
    renderer.setPixelRatio(renderPixelRatio(profile,window.devicePixelRatio,width,height));renderer.setSize(width,height,false);
    renderer.shadowMap.enabled=profile.shadowSize>0;
    if(profile.shadowSize&&sun.shadow.mapSize.x!==profile.shadowSize){sun.shadow.map?.dispose();sun.shadow.map=null;sun.shadow.mapSize.set(profile.shadowSize,profile.shadowSize);}
    renderer.shadowMap.needsUpdate=true;updateAnts();updateCamera();
  }
  function setQuality(mode){quality.setMode(mode);applyQuality();return quality.tier;}
  function resize() {
    width = Math.max(1, host.clientWidth); height = Math.max(1, host.clientHeight);
    quality.reset();applyQuality();
  }
  const observer = new ResizeObserver(resize); observer.observe(host); resize();
  const viewportObserver=typeof IntersectionObserver==='function'?new IntersectionObserver(entries=>{
    inViewport=entries[0]?.isIntersecting!==false;cancelAnimationFrame(frame);
    if(inViewport&&!hidden&&!disposed){lastTime=performance.now();quality.reset();sceneDirty=true;frame=requestAnimationFrame(animate);}
  },{rootMargin:'80px'}):null;
  viewportObserver?.observe(host);

  const activePointers = new Map();
  let pointerStartX = 0, pointerStartY = 0, dragged = false, panGesture = false;
  function pointerDown(event) {
    if (event.button !== 0 && event.button !== 2) return;
    cameraFlight=null;
    renderer.domElement.focus({ preventScroll: true });
    if (activePointers.size === 0) {
      pointerStartX = event.clientX; pointerStartY = event.clientY; dragged = false;
      panGesture = event.shiftKey || event.button === 2;
    } else dragged = true;
    activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    renderer.domElement.setPointerCapture?.(event.pointerId);
  }
  function pointerMove(event) {
    const previous = activePointers.get(event.pointerId);
    if (!previous) {
      if(event.pointerType==='mouse'){const rect=renderer.domElement.getBoundingClientRect();pointer.set((event.clientX-rect.left)/width*2-1,-(event.clientY-rect.top)/height*2+1);raycaster.setFromCamera(pointer,camera);renderer.domElement.style.cursor=raycaster.intersectObjects([...hitBoxes,...stationHits],false).length?'pointer':'grab';}
      return;
    }
    const before = Array.from(activePointers.values());
    const oldDistance = before.length === 2 ? Math.hypot(before[0].x - before[1].x, before[0].y - before[1].y) : 0;
    const oldCenterX = before.length === 2 ? (before[0].x + before[1].x) / 2 : previous.x;
    const oldCenterY = before.length === 2 ? (before[0].y + before[1].y) / 2 : previous.y;
    const dx = event.clientX - previous.x, dy = event.clientY - previous.y;
    activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (activePointers.size === 2) {
      dragged = true;
      const after = Array.from(activePointers.values());
      const distance = Math.hypot(after[0].x - after[1].x, after[0].y - after[1].y);
      if (oldDistance > 4 && distance > 4) zoomBy(distance / oldDistance);
      panCamera((after[0].x + after[1].x) / 2 - oldCenterX, (after[0].y + after[1].y) / 2 - oldCenterY);
      return;
    }
    if (activePointers.size > 2) return;
    if (Math.hypot(event.clientX - pointerStartX, event.clientY - pointerStartY) > 5) dragged = true;
    if (dragged) {
      if (panGesture || event.shiftKey) panCamera(dx, dy);
      else { angle -= dx * .006; elevation = THREE.MathUtils.clamp(elevation + dy * .004, .4, 1.15); updateCamera(); }
    }
  }
  function pointerUp(event) {
    if (!activePointers.has(event.pointerId)) return;
    if (!dragged && !panGesture && activePointers.size === 1) {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set((event.clientX - rect.left) / width * 2 - 1, -(event.clientY - rect.top) / height * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects([...hitBoxes,...stationHits], false);
      if (hits.length) {
        const data=hits[0].object.userData;
        if(data.stationKind){const station=stations.find(s=>s.id===data.stationId);onInteract({kind:data.stationKind,label:station?.label||data.stationKind});}
        else {selected=agents.find(a=>a.id===data.agentId);sceneDirty=true;if(selected)onSelect(selected.id);}
      }
    }
    activePointers.delete(event.pointerId);
    if (renderer.domElement.hasPointerCapture?.(event.pointerId)) renderer.domElement.releasePointerCapture(event.pointerId);
    // Keep dragged true until the last finger is lifted to avoid accidental picks.
  }
  function pointerCancel(event) { activePointers.delete(event.pointerId); dragged = true; }
  function wheel(event) { event.preventDefault(); zoomBy(Math.exp(-THREE.MathUtils.clamp(event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? height : 1), -200, 200) * .0015)); }
  function contextMenu(event) { event.preventDefault(); }
  function keyDown(event) {
    cameraFlight=null;
    if (event.key === '+' || event.key === '=') { zoomBy(1.18); event.preventDefault(); return; }
    if (event.key === '-' || event.key === '_') { zoomBy(1 / 1.18); event.preventDefault(); return; }
    if (event.key === '0') { showOverview(); event.preventDefault(); return; }
    if (event.shiftKey && event.key.startsWith('Arrow')) {
      panCamera(event.key === 'ArrowLeft' ? 45 : event.key === 'ArrowRight' ? -45 : 0, event.key === 'ArrowUp' ? 45 : event.key === 'ArrowDown' ? -45 : 0);
    } else if (event.key === 'ArrowLeft') angle -= .12;
    else if (event.key === 'ArrowRight') angle += .12;
    else if (event.key === 'ArrowUp') elevation = THREE.MathUtils.clamp(elevation + .07, .4, 1.15);
    else if (event.key === 'ArrowDown') elevation = THREE.MathUtils.clamp(elevation - .07, .4, 1.15);
    else if (event.key.toLowerCase() === 'r' || event.key === 'Home') { resetCamera(); event.preventDefault(); return; }
    else return;
    event.preventDefault(); updateCamera();
  }
  renderer.domElement.addEventListener('pointerdown', pointerDown);
  renderer.domElement.addEventListener('pointermove', pointerMove);
  renderer.domElement.addEventListener('pointerup', pointerUp);
  renderer.domElement.addEventListener('pointercancel', pointerCancel);
  renderer.domElement.addEventListener('lostpointercapture', pointerCancel);
  renderer.domElement.addEventListener('wheel', wheel, { passive: false });
  renderer.domElement.addEventListener('contextmenu', contextMenu);
  renderer.domElement.addEventListener('keydown', keyDown);

  // Each colleague follows their own clear aisle to an assigned place at the table.
  // Activity is supplied by the app; idle routines never pretend to collaborate.
  agents.forEach((a,index)=>{
    const destination=meetingSeats[index],sign=a.home.x<0?-1:1;
    const sideX=a.home.x+sign*1.72;
    const waypoints=[[a.home.x,a.home.z],[sideX,a.home.z]];
    if(a.home.z<0)waypoints.push([sideX,-1.3],[sign*7.3,-1.3]);
    waypoints.push([sign*7.3,5.65],[sign*3.78,5.65],[sign*3.78,destination[1]],[destination[0],destination[1]]);
    a.meetingRoute=waypoints;
    a.meetingLength=waypoints.slice(1).reduce((total,p,i)=>total+Math.hypot(p[0]-waypoints[i][0],p[1]-waypoints[i][1]),0);
    a.seat=destination;
  });
  function routePoint(a, progress, result) {
    let distance=progress*a.meetingLength;
    for(let i=0;i<a.meetingRoute.length-1;i++) {
      const from=a.meetingRoute[i],to=a.meetingRoute[i+1],length=Math.hypot(to[0]-from[0],to[1]-from[1]);
      if(distance<=length||i===a.meetingRoute.length-2) {
        const part=length>0?Math.min(1,distance/length):1;
        result.x=THREE.MathUtils.lerp(from[0],to[0],part);result.z=THREE.MathUtils.lerp(from[1],to[1],part);result.facing=Math.atan2(to[0]-from[0],to[1]-from[1]);return;
      }
      distance-=length;
    }
  }
  const route={x:0,z:0,facing:0};
  function pose(a,dt) {
    const t=elapsed+a.phase;
    const previous=a.travel;
    if(!quiet)a.travel=THREE.MathUtils.clamp(a.travel+(a.meetingTarget?1:-1)*dt*2.35/a.meetingLength,0,1);
    const walking=Math.abs(a.travel-previous)>0.000001;
    const social=a.meetingTarget&&a.travel>.985;
    routePoint(a,a.travel,route);
    const targetX=route.x,targetZ=route.z;
    let facing=walking?route.facing+(a.meetingTarget?0:Math.PI):social?Math.atan2(-a.seat[0],9-a.seat[1]):0;
    if(quiet)facing=a.root.rotation.y;
    if(!quiet){a.root.position.x=THREE.MathUtils.damp(a.root.position.x,targetX,14,dt);a.root.position.z=THREE.MathUtils.damp(a.root.position.z,targetZ,14,dt);a.root.position.y=a.travel>.98?.045:-.015;}
    const deltaAngle=Math.atan2(Math.sin(facing-a.root.rotation.y),Math.cos(facing-a.root.rotation.y));
    if(!quiet)a.root.rotation.y+=deltaAngle*Math.min(1,dt*9);a.walking=walking;
    const stride=Math.sin(t*8.5),breath=quiet?0:Math.sin(t*2.0)*.014;
    a.visual.position.y=breath+(walking?Math.abs(Math.cos(t*8.5))*.03:0);
    a.head.rotation.y=quiet||walking?0:Math.sin(t*(social?.9:.45))*(social?.12:.065);
    a.head.rotation.z=social&&!quiet?Math.sin(t*1.5)*.035:0;
    for(let i=0;i<2;i++) {
      const sign=i===0?1:-1;
      a.legs[i].rotation.x=walking?stride*.5*sign:0;
      a.knees[i].rotation.x=walking?Math.max(0,-stride*sign)*.32:0;
      if(walking){a.arms[i].rotation.x=-stride*.39*sign;a.elbows[i].rotation.x=-.2;a.arms[i].rotation.z=sign*.035;}
      else if(social&&!quiet){a.arms[i].rotation.x=-.25-Math.max(0,Math.sin(t*1.7+i))*.29;a.elbows[i].rotation.x=-.65;a.arms[i].rotation.z=sign*.08;}
      else if(a.working){a.arms[i].rotation.x=quiet?-.43:-.48+Math.sin(t*7+i*2)*.05;a.elbows[i].rotation.x=quiet?-.66:-.73+Math.sin(t*8+i*2)*.065;a.arms[i].rotation.z=sign*.04;}
      else {a.arms[i].rotation.x=-.12+(quiet?0:Math.sin(t*.65+i)*.035);a.elbows[i].rotation.x=-.2;a.arms[i].rotation.z=sign*.045;}
    }
    a.halo.material.opacity=selected===a?.5:a.working?.3:.13;
    a.halo.scale.setScalar(a.working?1.08:1);
  }

  let lastTime = performance.now();
  function animate(now) {
    if(disposed||hidden||!inViewport) return;
    if(quiet&&!sceneDirty&&!cameraFlight){lastTime=now;frame=requestAnimationFrame(animate);return;}
    const frameMilliseconds=now-lastTime,dt=THREE.MathUtils.clamp(frameMilliseconds/1000,0,.06);lastTime=now;
    if(cameraFlight){
      cameraFlight.progress=Math.min(1,cameraFlight.progress+dt/0.8);
      const t=cameraFlight.progress,blend=t*t*(3-2*t),flight=cameraFlight;
      lookAt.x=THREE.MathUtils.lerp(flight.fromX,flight.to.x,blend);lookAt.z=THREE.MathUtils.lerp(flight.fromZ,flight.to.z,blend);
      zoom=THREE.MathUtils.lerp(flight.fromZoom,flight.to.zoom,blend);
      if(t===1)cameraFlight=null;
      updateCamera();
    }
    if(!quiet){elapsed+=dt;antClock+=dt*(.3+activity.load*1.45);}
    for(const a of agents)pose(a,dt);
    if(theme==='anthill'&&!quiet)updateAnts();
    wildlife.update(elapsed,dt,{quiet});
    updateFire();
    if(theme==='beach'&&!quiet)waveStrips.forEach((w,i)=>{w.scale.x=1+Math.sin(elapsed*1.1+i)*.15;w.position.y=.035+Math.sin(elapsed*.8+i)*.011;});
    screens.forEach((s,i)=>{s.material.emissiveIntensity=(night?.5:.18)+(quiet?0:(Math.sin(elapsed*1.6+i)*.5+.5)*.2);});
    if(selected){selection.visible=true;selection.position.set(selected.root.position.x,.15,selected.root.position.z);}
    expanse.update({x:lookAt.x,z:lookAt.z,viewRadius:Math.hypot(camera.right,camera.top/Math.sin(elevation))/zoom,quality:quality.tier,elapsed,night,quiet});
    renderer.render(scene,camera);lastDrawCalls=renderer.info.render.calls;sceneDirty=false;
    for(const a of agents){
      scratch.set(a.root.position.x,3.0+a.visual.position.y,a.root.position.z).project(camera);
      a.position.x=(scratch.x*.5+.5)*width;a.position.y=(-scratch.y*.5+.5)*height;
      a.position.visible=zoom>=.28&&scratch.z>-1&&scratch.z<1&&scratch.x>-.98&&scratch.x<.98&&scratch.y>-.98&&scratch.y<.98;
    }
    for(let i=0;i<stations.length;i++){
      const station=stations[i],label=stationLabels[i];scratch.set(station.x,station.kind==='meeting'?4.65:3.55,station.z).project(camera);
      label.x=(scratch.x*.5+.5)*width;label.y=(-scratch.y*.5+.5)*height;
      label.visible=zoom>=.28&&scratch.z>-1&&scratch.z<1&&scratch.x>-.96&&scratch.x<.96&&scratch.y>-.96&&scratch.y<.96;
    }
    onPositions(labels);onStationPositions(stationLabels);
    if(!quiet&&quality.sample(frameMilliseconds))applyQuality();
    frame=requestAnimationFrame(animate);
  }
  const palettes={anthill:['#e1e8da','#9eaa6c','#9b724b'],forest:['#d9e7df','#78a761','#8b724e'],beach:['#dcebe7','#dfca92','#ba9867'],mountains:['#dce6e5','#9ca78d','#899687']};
  function updateLighting(){
    sceneDirty=true;
    const palette=palettes[theme];
    scene.background.set(night?'#152334':palette[0]);floor.material.color.copy(scene.background);scene.fog.color.copy(scene.background);
    baseMat.color.set(palette[1]);earthMat.color.set(palette[2]);
    hemisphere.color.set(night?'#a4bad4':'#d8ecf0');hemisphere.groundColor.set(night?'#404747':'#8b8162');hemisphere.intensity=night?.65:1.55;
    sun.color.set(night?'#b5cee7':'#fff0d4');sun.intensity=night?.72:2.3;
    fill.color.set(night?'#95b5d2':'#d8efff');fill.intensity=night?.23:.36;
    sky.visible=night;nightMaterials.forEach(mat=>mat.emissiveIntensity=night?(mat===lampMat?1.65:.62):(mat===lampMat?.15:.16));
    wildlife.setNight(night);updateFire();
  }
  function setLandscape(name){
    const aliases={formicaio:'anthill',ants:'anthill',foresta:'forest',bosco:'forest',spiaggia:'beach',montagna:'mountains',mountain:'mountains'};
    theme=aliases[name]||name;if(!themes[theme])theme='anthill';
    Object.entries(themes).forEach(([key,g])=>g.visible=key===theme);water.visible=theme==='beach';antLayer.visible=theme==='anthill';
    cameraFlight=null;expanse.setTheme(theme);quality.reset();wildlife.setLandscape(theme);updateLighting();updateCamera();
  }
  function setNight(value){night=!!value;updateLighting();}
  function setActivity(next={}){
    sceneDirty=true;
    const validIds=ids=>Array.isArray(ids)?[...new Set(ids.filter(id=>cast.some(a=>a.id===id)))]:[];
    const collaboratingIds=validIds(next.collaboratingIds),activeAgentIds=validIds(next.activeAgentIds);
    activity={load:THREE.MathUtils.clamp(Number(next.load)||0,0,1),problemKey:typeof next.problemKey==='string'?next.problemKey:null,collaboratingIds:collaboratingIds.length>=2?collaboratingIds:[],activeAgentIds};
    agents.forEach(a=>{
      a.meetingTarget=activity.collaboratingIds.includes(a.id);a.working=activity.activeAgentIds.includes(a.id)||/lavor|work|busy|active|thinking|running|scriv|pens|coordin/i.test(a.status);
      // Reduced motion still reflects a new task immediately, without a walk.
      if(quiet){a.travel=a.meetingTarget?1:0;routePoint(a,a.travel,route);a.root.position.set(route.x,a.meetingTarget?.045:-.015,route.z);a.root.rotation.y=a.meetingTarget?Math.atan2(-a.seat[0],9-a.seat[1]):0;}
    });
    wildlife.setActivity({load:activity.load,problemKey:activity.problemKey});updateAnts();
  }
  function setContext(next={}){
    sceneDirty=true;
    context={name:typeof next.name==='string'?next.name.slice(0,120):context.name,kind:typeof next.kind==='string'?next.kind:context.kind,color:/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(next.color||'')?next.color:context.color};
    if(contextBeacon){contextBeacon.material.color.set(context.color);contextBeacon.material.emissive.set(context.color);}
  }
  function setAgentStatus(id,status){
    sceneDirty=true;
    const a=agents.find(person=>person.id===id);if(!a)return;a.status=String(status);
    a.working=activity.activeAgentIds.includes(id)||/lavor|work|busy|active|thinking|running|scriv|pens|coordin/i.test(a.status);
  }
  function setQuiet(value){quiet=!!value;sceneDirty=true;quality.reset();if(quiet&&cameraFlight){lookAt.set(cameraFlight.to.x,.45,cameraFlight.to.z);zoom=cameraFlight.to.zoom;cameraFlight=null;updateCamera();}updateFire();}
  function resetCamera(){cameraFlight=null;angle=.62;elevation=.72;zoom=1;overview=false;lookAt.set(0,.45,0);updateCamera();}
  function getDiagnostics(){return {theme,night,quiet,hidden,zoom,overview,target:{x:lookAt.x,z:lookAt.z},worldBounds:{...WORLD_EXTENT},qualityMode:quality.mode,qualityTier:quality.tier,landmarks:getLandmarks(),expanse:expanse.getDiagnostics(),context:{...context},activity:{...activity,collaboratingIds:[...activity.collaboratingIds],activeAgentIds:[...activity.activeAgentIds]},fireVisible:fireRoot.visible&&night,fireLit:night,fireBaseVisible:fireRoot.visible,fireLightIntensity:fireLight.intensity,meetingIds:agents.filter(a=>a.meetingTarget).map(a=>a.id),meetingArrivedIds:agents.filter(a=>a.meetingTarget&&a.travel>.985).map(a=>a.id),stations:stations.map(({id,kind,label})=>({id,kind,label})),activeAnts:theme==='anthill'?antVisibleCount:0,drawCalls:lastDrawCalls,pixelRatio:renderer.getPixelRatio(),triangles:renderer.info.render.triangles,wildlife:wildlife.getDiagnostics()};}
  function visibilityChange(){
    hidden=document.hidden;cancelAnimationFrame(frame);
    if(!hidden&&inViewport&&!disposed){lastTime=performance.now();quality.reset();sceneDirty=true;frame=requestAnimationFrame(animate);}
  }
  document.addEventListener('visibilitychange',visibilityChange);
  function dispose(){
    disposed=true;cancelAnimationFrame(frame);observer.disconnect();viewportObserver?.disconnect();document.removeEventListener('visibilitychange',visibilityChange);
    const canvas=renderer.domElement;
    canvas.removeEventListener('pointerdown',pointerDown);canvas.removeEventListener('pointermove',pointerMove);canvas.removeEventListener('pointerup',pointerUp);canvas.removeEventListener('pointercancel',pointerCancel);
    canvas.removeEventListener('lostpointercapture',pointerCancel);canvas.removeEventListener('wheel',wheel);canvas.removeEventListener('contextmenu',contextMenu);canvas.removeEventListener('keydown',keyDown);
    activePointers.clear();expanse.dispose();wildlife.dispose();antSystems.forEach(instances=>instances.dispose());
    geometryCache.forEach(g=>g.dispose());mergedGeometries.forEach(g=>g.dispose());customGeometries.forEach(g=>g.dispose());mats.forEach(m=>m.dispose());customMaterials.forEach(m=>m.dispose());
    agents.forEach(a=>{a.hit.material.dispose();a.halo.material.dispose();a.halo.geometry.dispose();});stationHits.forEach(hit=>hit.material.dispose());
    sun.shadow.map?.dispose();selection.material.dispose();selection.geometry.dispose();renderer.dispose();canvas.remove();
  }
  quiet=window.matchMedia?.('(prefers-reduced-motion: reduce)').matches||false;
  setLandscape('anthill');setActivity({});updateFire();
  if(!hidden)frame=requestAnimationFrame(animate);
  return {setLandscape,setAgentStatus,setQuiet,setNight,setActivity,setContext,setQuality,getLandmarks,focusLandmark,getDiagnostics,zoomBy,showOverview,resetCamera,dispose};
}
