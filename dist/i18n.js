import conversationTasks from './locales/conversation-tasks.en.js';
import today from './locales/today.en.js';
import memoryReview from './locales/memory-review.en.js';
import resultInsights from './locales/result-insights.en.js';
import search from './locales/search.en.js';
import workflowFields from './locales/workflow-fields.en.js';
import budgets from './locales/budgets.en.js';
import executionPreview from './locales/execution-preview.en.js';
import githubChecks from './locales/github-checks.en.js';
import productivity from './locales/productivity.en.js';
import core from './locales/core.en.js';
import workspace from './locales/workspace.en.js';
import workflows from './locales/workflows.en.js';
import experience from './locales/experience.en.js';
import exploration from './locales/exploration.en.js';
import agentCapabilities from './locales/agent-capabilities.en.js';

// Source-language keys are application copy, never values read from the archive.
export const english = Object.freeze({...conversationTasks,...today,...memoryReview,...resultInsights,...search,...workflowFields,...budgets,...executionPreview,...githubChecks, ...productivity, ...core, ...workspace, ...workflows, ...experience, ...exploration, ...agentCapabilities});
export const LANGUAGE_KEY = 'fuori-studio-language';
export const languages = Object.freeze(['it', 'en']);
const listeners = new Set(), bindings = new Map();
let current = 'it', switching = false;
export function chooseLanguage(saved, browser = 'it') {
  return languages.includes(saved) ? saved : /^en(?:-|$)/i.test(browser) ? 'en' : 'it';
}
try { if (typeof document !== 'undefined') current = chooseLanguage(globalThis.localStorage?.getItem(LANGUAGE_KEY), globalThis.navigator?.language); } catch { current = typeof document === 'undefined' ? 'it' : chooseLanguage(null, globalThis.navigator?.language); }
export const language = () => current;
export const locale = () => current === 'en' ? 'en-GB' : 'it-IT';
export function t(source, params = {}) {
  const key = String(source ?? '');
  const text = current === 'en' && Object.hasOwn(english, key) ? english[key] : key;
  return text.replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(params, name) ? String(params[name] ?? '') : match);
}

// Translate the developer's literal segments before substituting any opaque values.
// This boundary also prevents markup inside a document/user name from becoming copy.
export function ui(parts, ...values) {
  if (typeof parts === 'string') parts = [parts];
  const marker = index => `\uE000${index}\uE001`;
  const template = parts.reduce((result, part, index) => result + part + (index < values.length ? marker(index) : ''), '');
  function segment(value) {
    const leading = value.match(/^\s*/)[0], trailing = value.match(/\s*$/)[0], trimmed = value.trim();
    if (!trimmed) return value;
    const slots = [];
    const key = trimmed.replace(/\uE000(\d+)\uE001/g, match => `{${slots.push(match) - 1}}`);
    if (current !== 'en') return value;
    if (Object.hasOwn(english, key)) return leading + english[key].replace(/\{(\d+)\}/g, (match, index) => slots[index] ?? match) + trailing;
    // Useful for independently marked emphasis and existing split captions.
    return value.split(/(\uE000\d+\uE001)/).map(part => {
      if (/^\uE000/.test(part) || !part.trim()) return part;
      const key = part.trim();
      return Object.hasOwn(english, key) ? part.match(/^\s*/)[0] + english[key] + part.match(/\s*$/)[0] : part;
    }).join('');
  }
  const result = template.split(/(<!--[\s\S]*?-->|<\/?[a-zA-Z][^>]*>)/g).map(part => {
    if (part.startsWith('<!--')) return part;
    if (/^<\/?[a-zA-Z]/.test(part)) return part.replace(/\b(aria-label|aria-description|title|placeholder|alt|data-chat-prompt)=(['"])([\s\S]*?)\2/g, (_all, name, quote, value) => `${name}=${quote}${segment(value).replace(quote === '"' ? /"/g : /'/g, quote === '"' ? '&quot;' : '&#39;')}${quote}`);
    return segment(part);
  }).join('');
  return result.replace(/\uE000(\d+)\uE001/g, (_match, index) => String(values[Number(index)] ?? ''));
}
export function onLanguageChange(callback) { listeners.add(callback); return () => listeners.delete(callback); }
export function bindText(element, source, params = {}) {
  if (!element) return;
  bindings.set(element, {source, params});
  element.textContent = t(source, params);
}
// For immutable shell markup only, before attaching archive contents. No observer
// walks arbitrary rendered text or tries to recognize a user's words.
export function bindTranslations(root) {
  if (!root || typeof document === 'undefined') return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode, key = node.data.trim();
    if (!key || node.parentElement?.closest('script,style,[translate="no"]')) continue;
    if (Object.hasOwn(english, key)) {
      const before = node.data.match(/^\s*/)[0], after = node.data.match(/\s*$/)[0];
      const update = () => { if (node.isConnected) node.data = before + t(key) + after; };
      listeners.add(update); update();
    }
  }
  for (const element of [root, ...root.querySelectorAll('*')]) {
    if (element.closest?.('[translate="no"],script,style')) continue;
    for (const attr of ['aria-label','aria-description','title','placeholder','alt','data-chat-prompt']) {
      const source = element.getAttribute?.(attr);
      if (source && Object.hasOwn(english, source)) {
        const update = () => { if (element.isConnected) element.setAttribute(attr, t(source)); };
        listeners.add(update); update();
      }
    }
  }
}
function nodeKey(element) {
  if (element.id) return `#${CSS.escape(element.id)}`;
  const parts = [];
  for (let node = element; node && node !== document.body; node = node.parentElement) {
    if (node.id) { parts.unshift(`#${CSS.escape(node.id)}`); break; }
    const siblings = [...(node.parentElement?.children || [])].filter(item => item.tagName === node.tagName);
    parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(node) + 1})`);
  }
  return parts.join(' > ');
}
function rememberForms() {
  return [...document.querySelectorAll('input,textarea,select,details')].filter(node => !node.matches('[data-studio-language]')).map(node => ({
    node, key: nodeKey(node), value: node.value, checked: node.checked, open: node.open,
    selection: node.matches('textarea,input[type="text"],input:not([type])') ? [node.selectionStart,node.selectionEnd,node.selectionDirection] : null,
    focus: node === document.activeElement, scrollTop: node.scrollTop,
  }));
}
function restoreForms(saved) {
  for (const item of saved) {
    const node = item.node.isConnected ? item.node : document.querySelector(item.key);
    if (!node || node.tagName !== item.node.tagName) continue;
    if (node.type === 'file') { if (node !== item.node) node.replaceWith(item.node); continue; }
    if (node.tagName === 'DETAILS') node.open = item.open;
    else if (node.type === 'checkbox' || node.type === 'radio') node.checked = item.checked;
    else if (node.tagName !== 'SELECT' || [...node.options].some(option => option.value === item.value)) node.value = item.value;
    if (item.focus) node.focus({preventScroll:true});
    if (item.selection) try { node.setSelectionRange(...item.selection); } catch { /* Non-text input. */ }
    node.scrollTop = item.scrollTop;
  }
}
export function refreshUI() {
  if (switching) return;
  const saved = typeof document === 'undefined' ? [] : rememberForms();
  switching = true;
  try {
    if (typeof document !== 'undefined') document.documentElement.lang = current;
    for (const [element, item] of bindings) {
      if (!element.isConnected) { bindings.delete(element); continue; }
      element.textContent = t(item.source, item.params);
    }
    for (const callback of listeners) { try { callback(current); } catch (error) { console.error('Language update failed:', error); } }
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('studio-language-change',{detail:{language:current,locale:locale()}}));
    if (typeof document !== 'undefined') { restoreForms(saved); updateSelectors(); }
  } finally { switching = false; }
}
export function setLanguage(next, {persist = true} = {}) {
  if (!languages.includes(next) || switching) return false;
  if (persist) try { localStorage.setItem(LANGUAGE_KEY, next); } catch { /* Session-only preference in private/blocked storage. */ }
  if (next === current) { updateSelectors(); return true; }
  current = next; refreshUI(); return true;
}
function updateSelectors() {
  if (typeof document === 'undefined') return;
  document.querySelectorAll('[data-studio-language]').forEach(select => {
    select.value = current; select.setAttribute('aria-label', t('Lingua dell’interfaccia'));
    select.title = t('Cambia lingua · i tuoi contenuti restano invariati');
  });
}
function addSelector(host) {
  if (!host || host.querySelector('[data-studio-language]')) return;
  const label = document.createElement('label'); label.className = 'language-control';
  label.innerHTML = '<span aria-hidden="true">◎</span><select data-studio-language><option value="it" lang="it">Italiano</option><option value="en" lang="en">English</option></select>';
  host.append(label); updateSelectors();
}
export function initLanguage() {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = current;
  bindTranslations(document.body);
  const title = document.title; onLanguageChange(() => { document.title = t(title); }); document.title = t(title);
  addSelector(document.querySelector('.topbar-right'));
  const gate = document.querySelector('#access-gate');
  const updateGate = () => addSelector(gate?.querySelector('.access-gate-card'));
  if (gate) new MutationObserver(updateGate).observe(gate,{childList:true});
  updateGate();
  document.addEventListener('change', event => { if (event.target.matches('[data-studio-language]')) setLanguage(event.target.value); });
  window.addEventListener('storage', event => { if (event.key === LANGUAGE_KEY && languages.includes(event.newValue)) setLanguage(event.newValue,{persist:false}); });
}
if (typeof document !== 'undefined') initLanguage();
