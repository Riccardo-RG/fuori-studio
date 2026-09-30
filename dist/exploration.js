import { t, onLanguageChange } from './i18n.js';

const QUALITY_KEY = 'fuori-studio-quality';
const QUALITY_LABELS = {auto:'Automatico',lite:'Leggera',balanced:'Equilibrata',detailed:'Dettagliata'};
const THEMES = {anthill:'Formicaio',forest:'Bosco',beach:'Spiaggia',mountain:'Montagna'};
const QUALITY_HELP = 'Automatico adatta i dettagli alla fluidità del tuo dispositivo. Paesaggio, luoghi e strumenti restano disponibili a ogni livello. Scegli Leggera per ridurre il carico, oppure Equilibrata o Dettagliata per un livello fisso.';
const svgIcon = paths => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const atlasIcon = svgIcon('<path d="m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2V5Z"/><path d="M9 3v16m6-14v16"/><circle cx="15" cy="10" r="2"/>');
const studioIcon = svgIcon('<path d="m3 11 9-8 9 8M5 10v11h14V10M9 21v-7h6v7"/>');
const closeIcon = svgIcon('<path d="m6 6 12 12M18 6 6 18"/>');
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;
const noop = () => {};
let nextId = 0;

// A schematic atlas made from local vectors; landmarks use the same coordinates
// as the world. It is intentionally not a second WebGL render or an exact frustum.
const terrain = {
  anthill: '<path class="atlas-land" d="M-5 23Q55-7 98 17T183 14T307 26V182H-5Z"/><path class="atlas-contour" d="M-9 31Q42 15 79 33T153 36T231 18T311 42M-7 48Q42 31 82 51T164 50T240 37T310 59M-9 142Q45 109 81 142T153 155T240 120T307 139M-9 156Q49 129 81 157T159 167T243 139T309 154"/><ellipse class="atlas-grove" cx="73" cy="44" rx="33" ry="18"/><ellipse class="atlas-contour" cx="73" cy="44" rx="22" ry="11"/><ellipse class="atlas-contour" cx="73" cy="44" rx="11" ry="5"/><path class="atlas-stream" d="M260-8Q229 34 249 62T263 101T277 187"/>',
  forest: '<path class="atlas-land" d="M-8-8H308V188H-8Z"/><path class="atlas-grove" d="M-3 8Q51-10 101 18L81 60 34 75-4 58ZM184-5Q236 12 301 3L307 65 256 87 211 47ZM-5 143 40 108 82 128 105 179H-5ZM204 132 246 109 307 120V183H193Z"/><path class="atlas-contour" d="M-6 92Q41 53 89 84T185 79T304 101M-9 103Q44 69 89 95T190 91T308 113"/><path class="atlas-stream" d="M202-10Q182 23 205 42T173 83T159 119T129 192"/><path class="atlas-trees" d="m41 25-5 10h10Zm22 12-5 10h10Zm167-17-5 10h10Zm25 20-5 10h10ZM35 141l-5 10h10Zm25 13-5 10h10Zm191-19-5 10h10Z"/>',
  beach: '<path class="atlas-water" d="M-5-5H305V185H-5Z"/><path class="atlas-land" d="M-5-5H222Q215 25 238 44T223 81T208 119T163 137T126 184H-5Z"/><path class="atlas-shore" d="M214-5Q207 25 230 46T215 79T201 114T159 130T118 185"/><path class="atlas-contour" d="M24 25Q90 8 131 31T203 27M22 38Q92 22 125 44T198 41M-9 157Q47 127 88 149T125 169"/><path class="atlas-land" d="M251 131Q270 114 286 132T277 163Q256 171 247 153Z"/><path class="atlas-waves" d="M259 87h20m-14 8h27m-66 63h13m-47 12h21"/><path class="atlas-grove" d="M28 73Q60 51 74 83T55 108Q26 111 28 73Z"/>',
  mountain: '<path class="atlas-land" d="M-5-5H305V185H-5Z"/><path class="atlas-contour" d="M-6 43 39 17 65 37 102 11 129 41 156 20 201 43 233 13 310 49M-9 56 38 30 67 53 99 26 128 55 159 34 200 57 234 28 310 63M-6 147 41 125 77 150 115 131 168 156 214 120 255 147 307 135M-6 161 44 143 80 165 116 146 166 171 213 137 259 162 307 151"/><path class="atlas-peaks" d="m32 61 18-34 22 34Zm61-4 20-38 25 38Zm112 1 24-42 26 42ZM7 166l18-31 21 31Zm230 10 23-38 26 38Z"/><path class="atlas-snow" d="m41 44 9-17 11 17-7-3-4 5-4-5Zm175-5 13-23 14 23-9-4-5 5-5-5Z"/><path class="atlas-water" d="M175 109Q197 97 213 115T199 141Q181 144 168 130T175 109Z"/>'
};

export function createExplorationControls({world,host} = {}) {
  if (!host) return {updateCamera:noop,setTheme:noop,dispose:noop};
  const id = `studio-atlas-${++nextId}`, controller = new AbortController();
  const eventOptions = {signal:controller.signal};
  let theme = 'anthill', landmarks = [], state = {zoom:1,target:{x:0,z:0},worldBounds:{width:180,depth:150}};
  let qualityMode = 'auto', qualityTier = 'balanced', open = false, helpPinned = false, helpTimer = 0, layoutFrame = 0, disposed = false;
  try { const saved = localStorage.getItem(QUALITY_KEY); if (Object.hasOwn(QUALITY_LABELS,saved)) qualityMode = saved; } catch { /* Browser storage is optional. */ }
  const available = typeof world?.getLandmarks === 'function' && typeof world?.focusLandmark === 'function';
  const root = document.createElement('div'); root.className = 'world-exploration';
  root.innerHTML = `<button type="button" class="atlas-toggle" aria-expanded="false" aria-controls="${id}">${atlasIcon}<span data-atlas-copy="Esplora"></span><span class="atlas-toggle-chevron" aria-hidden="true">⌄</span></button><section class="atlas-panel" id="${id}" aria-labelledby="${id}-title" hidden><header class="atlas-head"><div><span class="atlas-eyebrow" data-atlas-copy="ATLANTE DELLO STUDIO"></span><h3 id="${id}-title"></h3></div><button type="button" class="atlas-close">${closeIcon}</button></header><div class="atlas-content"><div class="atlas-map"><svg class="atlas-terrain" viewBox="0 0 300 180" preserveAspectRatio="none" aria-hidden="true"></svg><span class="atlas-north" aria-hidden="true">N<span>↑</span></span><div class="atlas-map-pins"></div><span class="atlas-view-marker" aria-hidden="true"><span></span></span></div><div class="atlas-map-key"><span><i aria-hidden="true"></i><span data-atlas-copy="Centro della vista"></span></span><span data-atlas-copy="Mappa schematica"></span></div><div class="atlas-destinations"></div></div><footer class="atlas-footer"><div class="atlas-quality-label"><label for="${id}-quality" data-atlas-copy="Grafica"></label><button type="button" class="atlas-help" aria-expanded="false" aria-controls="${id}-help">?</button><span class="atlas-quality-tier"></span></div><select id="${id}-quality" class="atlas-quality">${Object.entries(QUALITY_LABELS).map(([value,label])=>`<option value="${value}" data-atlas-copy="${label}"></option>`).join('')}</select><div class="atlas-help-text" id="${id}-help" role="tooltip" hidden></div></footer></section><span class="visually-hidden atlas-announcement" role="status"></span>`;
  host.append(root);
  const $ = selector => root.querySelector(selector), toggle = $('.atlas-toggle'), panel = $('.atlas-panel'), title = $('h3'), map = $('.atlas-map'), pins = $('.atlas-map-pins'), destinations = $('.atlas-destinations'), marker = $('.atlas-view-marker'), qualitySelect = $('.atlas-quality'), tier = $('.atlas-quality-tier'), helpButton = $('.atlas-help'), helpText = $('.atlas-help-text');
  toggle.disabled = !available; qualitySelect.disabled = !available || typeof world?.setQuality !== 'function';
  qualitySelect.value = qualityMode;
  const point = item => ({x:clamp((finite(item.x,0)/finite(state.worldBounds?.width,180)+.5)*100,5,95),y:clamp((finite(item.z,0)/finite(state.worldBounds?.depth,150)+.5)*100,7,93)});
  const isStudio = item => item.id === 'studio';
  const labelFor = item => t(isStudio(item) ? 'Torna allo studio' : item.label);
  function diagnostics() { try { return world?.getDiagnostics?.() || {}; } catch { return {}; } }
  function refreshQuality(snapshot = diagnostics()) {
    const mode = snapshot.qualityMode, level = snapshot.qualityTier;
    if (Object.hasOwn(QUALITY_LABELS,mode)) qualityMode = mode;
    if (Object.hasOwn(QUALITY_LABELS,level) && level !== 'auto') qualityTier = level;
    qualitySelect.value = qualityMode;
    tier.textContent = qualityMode === 'auto' ? t('Ora: {quality}',{quality:t(QUALITY_LABELS[qualityTier])}) : '';
    tier.hidden = qualityMode !== 'auto';
  }
  function refreshCopy() {
    root.querySelectorAll('[data-atlas-copy]').forEach(node => { node.textContent = t(node.dataset.atlasCopy); });
    toggle.setAttribute('aria-label',t(available ? 'Esplora il paesaggio' : 'Esplorazione non disponibile'));
    toggle.title = t(available ? 'Mappa, luoghi e qualità grafica' : 'Esplorazione non disponibile');
    $('.atlas-close').setAttribute('aria-label',t('Chiudi atlante'));
    title.textContent = t(THEMES[theme]);
    helpButton.setAttribute('aria-label',t('Aiuto: qualità grafica'));
    helpText.textContent = t(QUALITY_HELP);
    destinations.setAttribute('aria-label',t('Luoghi da esplorare'));
    qualitySelect.setAttribute('aria-label',t('Qualità grafica'));
    for (const item of landmarks) {
      for (const button of root.querySelectorAll('[data-landmark]')) {
        if (button.dataset.landmark !== item.id) continue;
        button.setAttribute('aria-label',labelFor(item)); button.title = labelFor(item);
        const label = button.querySelector('.atlas-destination-label'); if (label) label.textContent = labelFor(item);
      }
    }
    refreshQuality(); scheduleLayout();
  }
  function renderLandmarks() {
    const focusId = document.activeElement?.closest?.('[data-landmark]')?.dataset.landmark;
    const focusOnMap = document.activeElement?.classList.contains('atlas-pin');
    landmarks = available ? world.getLandmarks().filter(item => item && typeof item.id === 'string' && Number.isFinite(item.x) && Number.isFinite(item.z)) : [];
    $('.atlas-terrain').innerHTML = terrain[theme] || terrain.anthill;
    const route = document.createElementNS('http://www.w3.org/2000/svg','path');
    route.setAttribute('class','atlas-route');
    route.setAttribute('d',landmarks.filter(item=>!isStudio(item)).map(item=>{const p=point(item);return `M150 90Q${150+(p.x*3-150)*.4} ${p.y*1.8} ${p.x*3} ${p.y*1.8}`;}).join(''));
    $('.atlas-terrain').append(route); pins.replaceChildren(); destinations.replaceChildren();
    let number = 0;
    for (const item of landmarks) {
      const studio = isStudio(item), index = studio ? '⌂' : String(++number), p = point(item);
      const pin = document.createElement('button'); pin.type = 'button'; pin.className = `atlas-pin${studio?' atlas-studio-pin':''}`; pin.dataset.landmark = item.id; pin.style.left = `${p.x}%`; pin.style.top = `${p.y}%`; pin.innerHTML = studio ? studioIcon : `<span aria-hidden="true">${index}</span>`; pins.append(pin);
      const button = document.createElement('button'); button.type = 'button'; button.className = `atlas-destination${studio?' atlas-studio-destination':''}`; button.dataset.landmark = item.id;
      button.innerHTML = `<span class="atlas-destination-index" aria-hidden="true">${studio?studioIcon:index}</span><span class="atlas-destination-label"></span><span class="atlas-destination-arrow" aria-hidden="true">↗</span>`; destinations.append(button);
    }
    refreshCopy(); updateMarker();
    if (focusId && open) {
      const group = focusOnMap ? pins : destinations;
      const replacement = [...group.querySelectorAll('[data-landmark]')].find(button=>button.dataset.landmark===focusId);
      (replacement || $('.atlas-close')).focus({preventScroll:true});
    }
  }
  function updateMarker() {
    const target = state.target || {x:0,z:0}, p = point(target);
    marker.style.left = `${p.x}%`; marker.style.top = `${p.y}%`;
    marker.style.setProperty('--atlas-bearing',`${finite(state.angle,0)*180/Math.PI}deg`);
    marker.classList.toggle('is-overview',Boolean(state.overview));
    let closest = null, distance = Infinity;
    for (const item of landmarks) { const next=Math.hypot(item.x-finite(target.x,0),item.z-finite(target.z,0));if(next<distance){distance=next;closest=item.id;} }
    for (const button of root.querySelectorAll('[data-landmark]')) {
      if (!state.overview && distance < 7 && button.dataset.landmark === closest) button.setAttribute('aria-current','location');
      else button.removeAttribute('aria-current');
    }
  }
  function closeHelp() { clearTimeout(helpTimer); helpPinned=false;helpText.hidden=true;helpButton.setAttribute('aria-expanded','false');helpButton.removeAttribute('aria-describedby'); }
  function showHelp(pinned = false) { clearTimeout(helpTimer);helpPinned=pinned;helpText.hidden=false;helpButton.setAttribute('aria-expanded','true');helpButton.setAttribute('aria-describedby',helpText.id);helpText.scrollIntoView({block:'nearest',inline:'nearest'}); }
  function setOpen(next, returnFocus = false) {
    open=next&&available; panel.hidden=!open;toggle.setAttribute('aria-expanded',String(open));root.classList.toggle('is-open',open);
    if (!open) closeHelp(); else refreshQuality();
    scheduleLayout();
    if (returnFocus) toggle.focus({preventScroll:true});
  }
  function position() {
    layoutFrame=0; if(disposed || !root.isConnected) return;
    const rect=host.getBoundingClientRect(), margin=rect.width<520?12:16;
    let top=margin, right=margin;
    for (const selector of ['.camera-controls','.world-activity']) {
      const node=host.querySelector(selector);if(!node)continue;
      const obstacle=node.getBoundingClientRect();
      if(obstacle.height && obstacle.top<rect.top+rect.height*.5) top=Math.max(top,obstacle.bottom-rect.top+10);
    }
    // In immersive mode the work dock can cover the right part of the scene.
    if(document.body.classList.contains('studio-immersive') && rect.width>=1100) {
      for (const selector of ['#studio-dock:not([hidden])','body[data-studio-panel="chat"] .chat-panel']) {
        const node=document.querySelector(selector);if(!node)continue;
        const obstacle=node.getBoundingClientRect();
        if(obstacle.width && obstacle.left>rect.left && obstacle.left<rect.right && obstacle.bottom>rect.top) right=Math.max(right,rect.right-obstacle.left+12);
      }
    }
    root.style.top=`${top}px`;root.style.right=`${right}px`;
    const width=Math.min(324,Math.max(180,rect.width-right-margin));panel.style.width=`${width}px`;
    const caption=host.querySelector('.scene-caption')?.getBoundingClientRect();
    // Keep the caption readable when a narrow viewport puts it under the atlas.
    let panelTop=42;
    if(caption?.height && caption.right>rect.right-right-width && caption.bottom>rect.top+top) panelTop=Math.max(panelTop,caption.bottom-rect.top-top+12);
    panel.style.top=`${panelTop}px`;
    let bottom=rect.bottom-margin;
    for (const selector of ['.world-dock','.scene-focus','.camera-controls']) {
      const obstacle=host.querySelector(selector)?.getBoundingClientRect();
      if(obstacle?.height && obstacle.top>rect.top+rect.height*.5) bottom=Math.min(bottom,obstacle.top-10);
    }
    panel.style.maxHeight=`${Math.max(100,bottom-rect.top-top-panelTop)}px`;
    root.classList.toggle('is-compact',rect.width<560);
  }
  function scheduleLayout() { if(!layoutFrame&&!disposed)layoutFrame=requestAnimationFrame(position); }
  root.addEventListener('click',event=>{
    const button=event.target.closest('button');if(!button)return;
    if(button===toggle){setOpen(!open);return;}
    if(button.matches('.atlas-close')){setOpen(false,true);return;}
    if(button===helpButton){if(helpPinned)closeHelp();else showHelp(true);return;}
    if(button.dataset.landmark) {
      const item=landmarks.find(item=>item.id===button.dataset.landmark);if(!item)return;
      if(world.focusLandmark(item.id)!==false){$('.atlas-announcement').textContent=t('Vista su {place}',{place:t(item.label)});if(root.classList.contains('is-compact'))setOpen(false,true);}
    }
  },eventOptions);
  qualitySelect.addEventListener('change',()=>{
    qualityMode=Object.hasOwn(QUALITY_LABELS,qualitySelect.value)?qualitySelect.value:'auto';
    try { localStorage.setItem(QUALITY_KEY,qualityMode); } catch { /* Session preference still works. */ }
    world?.setQuality?.(qualityMode);refreshQuality();
  },eventOptions);
  helpButton.addEventListener('pointerenter',event=>{if(event.pointerType!=='touch'&&!helpPinned)showHelp();},eventOptions);
  helpButton.addEventListener('pointerleave',()=>{if(!helpPinned&&document.activeElement!==helpButton)helpTimer=setTimeout(closeHelp,160);},eventOptions);
  helpButton.addEventListener('focus',()=>{if(!helpPinned)showHelp();},eventOptions);
  helpButton.addEventListener('blur',()=>{if(!helpPinned)closeHelp();},eventOptions);
  helpText.addEventListener('pointerenter',()=>clearTimeout(helpTimer),eventOptions);
  helpText.addEventListener('pointerleave',()=>{if(!helpPinned&&document.activeElement!==helpButton)closeHelp();},eventOptions);
  document.addEventListener('pointerdown',event=>{if(open&&!root.contains(event.target))setOpen(false);}, {...eventOptions,capture:true});
  document.addEventListener('focusin',event=>{if(open&&!root.contains(event.target))setOpen(false);},eventOptions);
  document.addEventListener('keydown',event=>{
    if(event.key!=='Escape'||!open)return;
    event.preventDefault();event.stopPropagation();
    if(!helpText.hidden)closeHelp();else setOpen(false,true);
  },{...eventOptions,capture:true});
  window.addEventListener('resize',scheduleLayout,eventOptions);
  document.addEventListener('fullscreenchange',scheduleLayout,eventOptions);
  window.addEventListener('storage',event=>{
    if(event.key!==QUALITY_KEY)return;
    qualityMode=Object.hasOwn(QUALITY_LABELS,event.newValue)?event.newValue:'auto';world?.setQuality?.(qualityMode);refreshQuality();
  },eventOptions);
  const resizeObserver=typeof ResizeObserver==='function'?new ResizeObserver(scheduleLayout):null;
  resizeObserver?.observe(host);
  for(const node of host.querySelectorAll('.camera-controls,.world-activity,.scene-caption,.world-dock'))resizeObserver?.observe(node);
  const bodyObserver=typeof MutationObserver==='function'?new MutationObserver(scheduleLayout):null;
  bodyObserver?.observe(document.body,{attributes:true,attributeFilter:['class','data-studio-panel']});
  const removeLanguageListener=onLanguageChange(refreshCopy);
  world?.setQuality?.(qualityMode);
  function setTheme(next) { if(disposed)return;theme=next==='mountains'?'mountain':Object.hasOwn(THEMES,next)?next:'anthill';root.dataset.landscape=theme;renderLandmarks(); }
  function updateCamera(next = {}) { if(disposed)return;state={...state,...next,target:next.target||state.target,worldBounds:next.worldBounds||state.worldBounds};updateMarker();refreshQuality(next); }
  setTheme(document.body.dataset.landscape||'anthill');
  return {updateCamera,setTheme,dispose(){if(disposed)return;disposed=true;controller.abort();resizeObserver?.disconnect();bodyObserver?.disconnect();removeLanguageListener();clearTimeout(helpTimer);cancelAnimationFrame(layoutFrame);root.remove();}};
}
