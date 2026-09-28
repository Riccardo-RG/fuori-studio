import { t, onLanguageChange, locale } from './i18n.js';
const html = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
const kindLabels = { conversation:'Conversazioni', memory:'Memorie', decision:'Decisioni', document:'Documenti', task:'Incarichi', deliverable:'Consegne', repository:'Lavori repository', workflow:'Procedure' };
const blockLabels = { content:'Contenuto', source:'Provenienza', brief:'Obiettivo e vincoli', result:'Risultato del lavoro', review:'Revisione', decision:'Decisione', passage:'Passaggio', message:'Messaggio' };
const statusLabels = { confirmed:'Confermata', proposed:'Proposta', ready:'Pronta', draft:'Bozza', current:'Aggiornata', stale:'Da aggiornare', queued:'In coda', running:'In corso', review:'Da revisionare', completed:'Completato', failed:'Non riuscito', paused:'In pausa', approved:'Approvata', pending:'In attesa', changes_requested:'Modifiche richieste' };
const date = value => { const parsed = new Date(value); return value && Number.isFinite(parsed.getTime()) ? new Intl.DateTimeFormat(locale(), { dateStyle:'medium', timeStyle:'short' }).format(parsed) : ''; };
const safeURL = value => { try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : null; } catch { return null; } };
export function highlightSearchText(text, query) {
  const terms = [...new Set(String(query).match(/[\p{L}\p{N}_-]+/gu) || [])].sort((a, b) => b.length - a.length).slice(0, 32);
  if (!terms.length) return html(text);
  // Literal expressions only; all matched and unmatched text crosses the HTML boundary.
  const expression = new RegExp(`(${terms.map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'giu');
  return String(text).split(expression).map((part, index) => index % 2 ? `<mark>${html(part)}</mark>` : html(part)).join('');
}
export function createSearchPanel({ onOpenOriginal = null } = {}) {
  const dialog = document.createElement('dialog'); dialog.className = 'studio-search-dialog'; dialog.id = 'studio-search-dialog'; dialog.setAttribute('aria-labelledby', 'studio-search-title'); document.body.append(dialog);
  let context = { scopeId:'business', scopes:[] }, query = '', selectedScope = 'business', selectedKind = '', data = null, original = null, loading = false, error = '', timer, controller, revision = 0, returnFocus, disposed = false;
  async function request(url, signal) {
    const response = await fetch(url, { signal, headers:{ Accept:'application/json' } });
    if (response.status === 401 || response.status === 403) { window.dispatchEvent(new CustomEvent('studio-session-expired')); throw Error(t('La sessione è scaduta. Accedi di nuovo.')); }
    const value = await response.json(); if (!response.ok) throw Error(value.error ? t(value.error) : t('La ricerca non è disponibile. Riprova.')); return value;
  }
  function scopeLabel(scope) { return context.scopes.find(item => item.id === scope)?.name || scope; }
  function provenance(result) {
    const source = result.provenance || {}, parts = [scopeLabel(result.scopeId) || result.scopeName, source.archived ? t('Conversazione archiviata') : result.kind === 'conversation' ? t('Conversazione attuale') : ''];
    if (source.sharing === 'shared') parts.push(t('Profilo condiviso'));
    if (source.sharing === 'explicit') parts.push(t('Condivisa esplicitamente con questo ambito'));
    if (source.projectTitle) parts.push(source.projectTitle);
    if (source.filename) parts.push(source.filename);
    if (source.page) parts.push(t('Pagina {0}', { 0:source.page }));
    if (source.lineStart) parts.push(t('Righe {0}–{1}', { 0:source.lineStart, 1:source.lineEnd || source.lineStart }));
    if (result.version) parts.push(`v${result.version}`);
    if (result.status) parts.push(t(statusLabels[result.status] || result.status));
    if (result.updatedAt) parts.push(date(result.updatedAt));
    return parts.filter(Boolean).map(html).join(' · ');
  }
  function header() { return `<header class="studio-search-heading"><div><p class="studio-search-eyebrow">${html(t('Il tuo archivio, ritrovato'))}</p><h2 id="studio-search-title">${html(t(original ? 'Originale salvato' : 'Cerca nello studio'))}</h2></div><button type="button" data-search-close aria-label="${html(t('Chiudi ricerca'))}">✕</button></header>`; }
  function controls() { return `<form class="studio-search-form"><label class="studio-search-query"><span>${html(t('Parole da cercare'))}</span><div><input type="search" id="studio-search-query" name="query" maxlength="300" autocomplete="off" placeholder="${html(t('Una decisione, un messaggio, una consegna…'))}" value="${html(query)}"><button type="submit">${html(t('Cerca'))}</button></div></label><div class="studio-search-filters"><label><span>${html(t('Ambito della ricerca'))}</span><select name="scopeId">${context.scopes.map(scope => `<option value="${html(scope.id)}"${selectedScope === scope.id ? ' selected' : ''}>${html(scope.name)}</option>`).join('')}<option value="*"${selectedScope === '*' ? ' selected' : ''}>${html(t('Tutti gli ambiti'))}</option></select></label><label><span>${html(t('Tipo di contenuto'))}</span><select name="kind"><option value="">${html(t('Tutti i contenuti'))}</option>${Object.entries(kindLabels).map(([id, label]) => `<option value="${id}"${selectedKind === id ? ' selected' : ''}>${html(t(label))}</option>`).join('')}</select></label></div></form><p class="studio-search-privacy">${html(t(selectedScope === '*' ? 'Stai cercando esplicitamente in tutti gli ambiti dello studio.' : 'Cerca in questo ambito e nelle memorie e procedure condivise con esso.'))} ${html(t('Ricerca locale: nessuna chiamata AI, nessun costo a consumo.'))}</p>`; }
  function resultList() {
    if (loading) return `<p class="studio-search-empty" role="status">${html(t('Ricerca nell’archivio…'))}</p>`;
    if (error) return `<p class="studio-search-error" role="alert">${html(error)}</p><button class="studio-search-button" type="button" data-search-retry>${html(t('Riprova'))}</button>`;
    if (!data) return `<div class="studio-search-empty"><span aria-hidden="true">⌕</span><h3>${html(t('Ritrova il lavoro, con la sua origine.'))}</h3><p>${html(t('Cerca anche nelle conversazioni archiviate. Tutte le parole inserite devono essere presenti; gli accenti non cambiano i risultati.'))}</p></div>`;
    if (!data.results.length) return `${data.partial ? `<p class="studio-search-warning">${html(t('Lo storico è molto ampio: la ricerca include una parte delle conversazioni. Restringi l’ambito per cercare più a fondo.'))}</p>` : ''}<div class="studio-search-empty"><h3>${html(t('Nessun risultato in questo ambito.'))}</h3><p>${html(t('Prova meno parole, un altro tipo di contenuto o scegli esplicitamente un altro ambito.'))}</p></div>`;
    return `<div class="studio-search-summary" role="status">${html(t('{0} risultati · {1}–{2}', { 0:data.total, 1:data.offset + 1, 2:data.offset + data.results.length }))}</div>${data.partial ? `<p class="studio-search-warning">${html(t('Lo storico è molto ampio: la ricerca include una parte delle conversazioni. Restringi l’ambito per cercare più a fondo.'))}</p>` : ''}<ol class="studio-search-results">${data.results.map((result, index) => `<li><button type="button" class="studio-search-result" data-search-result="${index}"><span class="studio-search-kind">${html(t(kindLabels[result.kind] || result.kind))}${result.provenance.archived ? ` <span>· ${html(t('Archiviata'))}</span>` : ''}</span><strong>${highlightSearchText(result.title, query)}</strong><span class="studio-search-snippet">${highlightSearchText(result.snippet, query)}</span><span class="studio-search-provenance">${provenance(result)}</span><span class="studio-search-open">${html(t('Leggi l’originale'))} ↗</span></button></li>`).join('')}</ol><nav class="studio-search-paging" aria-label="${html(t('Pagine dei risultati'))}"><button type="button" data-search-page="${Math.max(0, data.offset - data.limit)}"${data.offset === 0 ? ' disabled' : ''}>← ${html(t('Precedenti'))}</button><button type="button" data-search-page="${data.offset + data.limit}"${!data.hasMore ? ' disabled' : ''}>${html(t('Successivi'))} →</button></nav>`;
  }
  function originalView() {
    const result = original.result, target = result.target, source = result.provenance || {}, url = safeURL(source.url);
    return `<div class="studio-search-original"><button type="button" class="studio-search-back" data-search-back>← ${html(t('Torna ai risultati'))}</button><div class="studio-search-original-heading"><span class="studio-search-kind">${html(t(kindLabels[result.kind] || result.kind))}</span><h3>${html(result.title)}</h3><p class="studio-search-provenance">${provenance(result)}</p></div>${source.source ? `<p class="studio-search-source"><strong>${html(t('Provenienza'))}:</strong> ${html(source.source)}</p>` : ''}${source.commit ? `<p class="studio-search-source">${html(t('Commit di origine'))}: <code>${html(source.commit)}</code></p>` : ''}${source.conversationId ? `<p class="studio-search-source">${html(t('Conversazione'))}: <code>${html(source.conversationId)}</code> · ${html(t('Messaggio'))}: <code>${html(source.messageId)}</code></p>` : ''}${source.archived ? `<p class="studio-search-privacy">${html(t('Questa conversazione è archiviata. La lettura conserva la chat attuale e non avvia alcuna attività.'))}</p>` : ''}${original.truncated ? `<p class="studio-search-warning">${html(t('Anteprima parziale: sono mostrati i passaggi vicini al risultato o i primi 120.000 caratteri.'))}</p>` : ''}<div class="studio-search-original-blocks">${original.blocks.map(block => `<article${block.id === target.messageId ? ' class="is-match"' : ''}><header><strong>${html(t(block.label === 'message' ? block.role === 'user' ? 'Tu' : 'Studio' : blockLabels[block.label] || block.label))}</strong>${block.page ? `<span>${html(t('Pagina {0}', { 0:block.page }))}</span>` : ''}${block.lineStart ? `<span>${html(t('Righe {0}–{1}', { 0:block.lineStart, 1:block.lineEnd || block.lineStart }))}</span>` : ''}${block.createdAt ? `<span>${html(date(block.createdAt))}</span>` : ''}</header><p>${highlightSearchText(block.text, query)}</p></article>`).join('')}</div><footer class="studio-search-original-actions">${onOpenOriginal && !target.archived ? `<button type="button" class="studio-search-button" data-search-navigate>${html(t('Apri nello studio'))} ↗</button>` : ''}${url ? `<a class="studio-search-button" href="${html(url)}" target="_blank" rel="noopener noreferrer">${html(t('Apri fonte esterna'))} ↗</a>` : ''}<button type="button" class="studio-search-button" data-search-back>${html(t('Torna ai risultati'))}</button></footer></div>`;
  }
  function render() {
    const focus = dialog.contains(document.activeElement) ? { id:document.activeElement.id, start:document.activeElement.selectionStart } : null;
    dialog.innerHTML = header() + (original ? originalView() : controls() + `<section class="studio-search-content" aria-label="${html(t('Risultati della ricerca'))}" aria-busy="${loading}">${resultList()}</section>`);
    if (focus?.id) { const input = dialog.querySelector(`#${focus.id}`); input?.focus({ preventScroll:true }); if (input?.type === 'search' && Number.isInteger(focus.start)) input.setSelectionRange(focus.start, focus.start); }
  }
  async function search(offset = 0) {
    clearTimeout(timer); controller?.abort(); controller = new AbortController(); const requestId = ++revision;
    original = null; error = ''; data = null;
    if (!query.trim()) { loading = false; render(); return; }
    loading = true; render();
    const params = new URLSearchParams({ q:query, scopeId:selectedScope, offset:String(offset), limit:'30' }); if (selectedKind) params.set('kinds', selectedKind);
    try { const value = await request(`/api/search?${params}`, controller.signal); if (requestId !== revision || disposed) return; data = value; }
    catch (failure) { if (requestId !== revision || failure.name === 'AbortError' || disposed) return; error = failure.message; }
    finally { if (requestId === revision && !disposed) { loading = false; render(); } }
  }
  async function showOriginal(result) {
    clearTimeout(timer); controller?.abort(); controller = new AbortController(); const requestId = ++revision; loading = true; error = ''; render();
    // Construct a same-origin endpoint from typed fields, never follow stored links.
    const params = new URLSearchParams({ scopeId:selectedScope, sourceScopeId:result.scopeId, kind:result.kind, id:result.target.id });
    if (result.target.conversationId) params.set('conversationId', result.target.conversationId);
    try { const value = await request(`/api/search/original?${params}`, controller.signal); if (requestId !== revision || disposed) return; original = value; }
    catch (failure) { if (requestId !== revision || failure.name === 'AbortError' || disposed) return; error = failure.message; }
    finally { if (requestId === revision && !disposed) { loading = false; render(); if (original) { dialog.querySelector('[data-search-back]')?.focus(); dialog.querySelector('.is-match')?.scrollIntoView({ block:'nearest' }); } } }
  }
  function close() { clearTimeout(timer); controller?.abort(); revision++; loading = false; if (dialog.open) dialog.close(); }
  function open(value = {}) {
    context = { ...context, ...value }; if (document.querySelector('dialog[open]') && !dialog.open) return;
    selectedScope = value.scopeId || context.scopeId; query = value.query ?? query; original = null; error = ''; data = null;
    returnFocus = document.activeElement; render(); if (!dialog.open) dialog.showModal(); dialog.querySelector('input')?.focus(); if (query.trim()) void search();
  }
  dialog.addEventListener('submit', event => { event.preventDefault(); query = dialog.querySelector('[name=query]').value; void search(); });
  dialog.addEventListener('input', event => { if (event.target.name !== 'query') return; query = event.target.value; controller?.abort(); revision++; clearTimeout(timer); timer = setTimeout(() => void search(), 300); });
  dialog.addEventListener('change', event => { if (event.target.name === 'scopeId') selectedScope = event.target.value; else if (event.target.name === 'kind') selectedKind = event.target.value; else return; void search(); });
  dialog.addEventListener('click', async event => {
    const button = event.target.closest('button'); if (!button || button.disabled) return;
    if (button.hasAttribute('data-search-close')) close();
    else if (button.hasAttribute('data-search-result')) void showOriginal(data.results[Number(button.dataset.searchResult)]);
    else if (button.hasAttribute('data-search-page')) { void search(Number(button.dataset.searchPage)); dialog.scrollTop = 0; }
    else if (button.hasAttribute('data-search-retry')) void search();
    else if (button.hasAttribute('data-search-back')) { original = null; render(); dialog.querySelector('input')?.focus(); }
    else if (button.hasAttribute('data-search-navigate') && original) { button.disabled = true; try { const opened = await onOpenOriginal(original.result); if (opened !== false) close(); else { button.disabled = false; } } catch (failure) { button.disabled = false; const message = document.createElement('p'); message.className = 'studio-search-error'; message.setAttribute('role', 'alert'); message.textContent = failure.message; button.parentElement.append(message); } }
  });
  dialog.addEventListener('keydown', event => {
    if (original || !['ArrowDown', 'ArrowUp'].includes(event.key) || event.target.matches('select')) return;
    const results = [...dialog.querySelectorAll('[data-search-result]')]; if (!results.length) return;
    event.preventDefault(); const at = results.indexOf(document.activeElement), next = at < 0 ? event.key === 'ArrowDown' ? 0 : results.length - 1 : (at + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length; results[next].focus();
  });
  dialog.addEventListener('cancel', () => { controller?.abort(); clearTimeout(timer); revision++; loading = false; });
  dialog.addEventListener('close', () => { if (!document.querySelector('dialog[open]')) returnFocus?.focus({ preventScroll:true }); });
  const keyboard = event => { if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'f' && !event.altKey && !event.isComposing && !document.querySelector('dialog[open]')) { event.preventDefault(); open(); } };
  const expire = () => { close(); data = null; original = null; query = ''; dialog.replaceChildren(); };
  document.addEventListener('keydown', keyboard); window.addEventListener('studio-session-expired', expire);
  const stopLanguage = onLanguageChange(() => { if (dialog.open) render(); });
  return { open, close, setContext(value) { context = { ...context, ...value }; if (dialog.open && value.scopeId && selectedScope !== '*' && selectedScope !== value.scopeId) { selectedScope = value.scopeId; original = null; void search(); } }, dispose() { disposed = true; close(); stopLanguage(); document.removeEventListener('keydown', keyboard); window.removeEventListener('studio-session-expired', expire); dialog.remove(); } };
}
