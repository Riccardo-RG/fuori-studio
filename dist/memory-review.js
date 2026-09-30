import { t, ui, locale, onLanguageChange } from './i18n.js';
import { agents } from './data.js';

const html = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const date = value => { const parsed = new Date(value); return Number.isFinite(parsed.getTime()) ? new Intl.DateTimeFormat(locale(), {day:'numeric',month:'short',year:'numeric'}).format(parsed) : '—'; };
const short = value => value.length > 420 ? value.slice(0, 420).trimEnd() + '…' : value;

/** A read-only review surface. Every correction goes through the existing editor. */
export function createMemoryReviewPanel({host, onOpenMemory = async () => {}, onVisibility = () => {}, toast = () => {}}) {
  let context = {scopeId:'business',scopes:[]}, snapshot = null, visible = false, loading = false, busy = false, opening = false, disposed = false;
  let error = '', stamp = '', generation = 0, controller = null;
  const locked = () => busy || loading || opening || disposed;
  function locks() {
    host.querySelectorAll('[data-memory-review-action="edit"]').forEach(button => button.disabled = locked());
    host.querySelectorAll('[data-memory-review-action="reload"]').forEach(button => button.disabled = loading || opening);
    host.setAttribute('aria-busy', String(loading || opening));
  }
  function card(item, aging = false) {
    const audience = item.agentIds.length ? item.agentIds.map(id => agents.find(agent => agent.id === id)?.name || id).join(', ') : t('Tutti gli agenti');
    return ui`<article class="memory-review-card"><div class="memory-review-card-heading"><h5>${html(item.title)}</h5><span class="knowledge-state${item.status === 'confirmed' ? '' : ' is-proposed'}">${item.status === 'confirmed' ? t('Confermata') : t('Da confermare')}</span></div><p>${html(short(item.content))}</p><dl><div><dt>Versione</dt><dd>${html(item.version)}</dd></div><div><dt>Ultimo aggiornamento</dt><dd>${html(date(item.updatedAt))}${aging ? ` · ${html(t('{days} giorni fa', {days:item.ageDays}))}` : ''}</dd></div><div><dt>Fonte</dt><dd>${html(item.source || t('Annotazione manuale'))}</dd></div><div><dt>Disponibilità</dt><dd>${html(audience)} · ${html(t('{count} collegamenti ad altri ambiti', {count:item.sharedWith.length}))}</dd></div></dl><button type="button" class="knowledge-button" data-memory-review-action="edit" data-id="${html(item.id)}">Apri / modifica</button></article>`;
  }
  function render() {
    if (!visible || disposed) return;
    const scope = context.scopes.find(item => item.id === context.scopeId), summary = snapshot?.summary;
    host.innerHTML = ui`<div class="memory-review-heading"><div><span class="eyebrow">CURA DELLA MEMORIA</span><h3>Una memoria utile anche domani.</h3><p>Controlla i contenuti ripetuti e le note che meritano una nuova lettura. Ogni modifica resta una tua scelta.</p></div><button type="button" class="knowledge-text-button" data-memory-review-action="close">Chiudi</button></div><div class="memory-review-tools"><span>${html(scope?.name || context.scopeId)}</span><button type="button" class="knowledge-button" data-memory-review-action="reload">Aggiorna</button></div><p class="memory-review-scope">La revisione include soltanto le memorie salvate in questo ambito. Per il profilo comune e le note collegate, apri il loro ambito di origine.</p>${error ? ui`<p class="memory-review-notice is-error" role="alert">${html(error)}</p>` : ''}${loading ? ui`<p class="memory-review-empty" role="status">Preparazione della revisione…</p>` : summary ? ui`<div class="memory-review-summary"><div><strong>${summary.total}</strong><span>Memorie nell’ambito</span></div><div><strong>${summary.duplicateGroups}</strong><span>Gruppi con contenuto uguale</span></div><div><strong>${summary.agingMemories}</strong><span>Da rileggere dopo 90 giorni</span></div></div>${summary.reviewMemories ? ui`<section class="memory-review-section"><h4>Contenuti ripetuti</h4><p>Stesso tipo e stesso contenuto. Fonti e autorizzazioni possono essere diverse: confrontale prima di decidere.</p>${snapshot.duplicates.map(group => ui`<div class="memory-review-group"><p class="memory-review-group-label">${html(t('{count} memorie da confrontare', {count:group.memories.length}))}</p><div class="memory-review-cards">${group.memories.map(item => card(item)).join('')}</div></div>`).join('') || ui`<p class="memory-review-empty">Nessun contenuto ripetuto rilevato.</p>`}</section><section class="memory-review-section"><h4>Da rileggere</h4><p>Memorie confermate non aggiornate da almeno 90 giorni. L’età non indica che una memoria sia errata: resta disponibile agli agenti.</p><div class="memory-review-cards">${snapshot.aging.map(item => card(item, true)).join('') || ui`<p class="memory-review-empty">Nessuna memoria supera la soglia di 90 giorni.</p>`}</div></section>` : ui`<div class="memory-review-empty"><strong>Nessuna revisione suggerita.</strong><p>In questo ambito non ci sono contenuti ripetuti né memorie confermate non aggiornate da almeno 90 giorni.</p></div>`}<p class="memory-review-footnote">Controllo locale senza chiamate AI. Non vengono unite, eliminate o modificate memorie.</p>` : ''}`;
    locks();
  }
  async function load() {
    if (disposed || loading || opening) return;
    const revision = ++generation, scopeId = context.scopeId;
    controller?.abort(); controller = new AbortController(); loading = true; snapshot = null; error = ''; render();
    try {
      const response = await fetch(`/api/memory/review?scopeId=${encodeURIComponent(scopeId)}`, {cache:'no-store',signal:controller.signal});
      let value;
      try { value = await response.json(); } catch { throw Error(t('La revisione della memoria non è disponibile. Riprova.')); }
      if (!response.ok) throw Error(t(value.error || 'La revisione della memoria non è disponibile. Riprova.'));
      if (value.scopeId !== scopeId || !value.summary || !Array.isArray(value.duplicates) || !Array.isArray(value.aging)) throw Error(t('La revisione della memoria non è disponibile. Riprova.'));
      if (revision === generation && !disposed) snapshot = value;
    } catch (failure) {
      if (revision === generation && failure.name !== 'AbortError') error = t(failure.message || 'La revisione della memoria non è disponibile. Riprova.');
    } finally { if (revision === generation) { loading = false; render(); } }
  }
  function setVisible(value) {
    if (disposed) return;
    visible = Boolean(value); host.hidden = !visible; onVisibility(visible);
    if (visible) { render(); void load(); }
    else { generation++; controller?.abort(); loading = false; }
  }
  async function click(event) {
    const button = event.target.closest('[data-memory-review-action]');
    if (!button || button.disabled) return;
    const action = button.dataset.memoryReviewAction;
    if (action === 'close') { setVisible(false); return; }
    if (action === 'reload') { void load(); return; }
    if (action !== 'edit' || locked() || !snapshot) return;
    const item = [...snapshot.aging, ...snapshot.duplicates.flatMap(group => group.memories)].find(item => item.id === button.dataset.id);
    if (!item || item.scopeId !== context.scopeId) return;
    opening = true; locks();
    try { await onOpenMemory({id:item.id,version:item.version,scopeId:item.scopeId}); }
    catch (failure) { toast(failure.message); }
    finally { opening = false; locks(); if (visible && !snapshot) void load(); }
  }
  function clear() { generation++; controller?.abort(); loading = false; snapshot = null; error = ''; }
  function expire() { disposed = true; clear(); host.replaceChildren(); host.hidden = true; }
  host.addEventListener('click', click);
  window.addEventListener('studio-session-expired', expire);
  const unsubscribe = onLanguageChange(() => { host.setAttribute('aria-label', t('Revisione della memoria')); render(); });
  return {
    open() { setVisible(true); }, toggle() { setVisible(!visible); }, setBusy(value) { busy = Boolean(value); locks(); },
    setContext(value) {
      const nextStamp = JSON.stringify([value.scopeId, (value.memories || []).filter(item => item.scopeId === value.scopeId).map(item => [item.id,item.version,item.updatedAt])]);
      context = {...context,...value};
      if (nextStamp !== stamp) { stamp = nextStamp; clear(); if (visible && !opening) void load(); }
      render();
    },
    dispose() { unsubscribe(); expire(); host.removeEventListener('click', click); window.removeEventListener('studio-session-expired', expire); },
  };
}
