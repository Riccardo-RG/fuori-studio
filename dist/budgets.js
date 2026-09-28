import { t, ui, locale, onLanguageChange } from './i18n.js';
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const number = value => Number.isFinite(value) ? new Intl.NumberFormat(locale()).format(value) : t('Non disponibile');

export function createBudgetsPanel({ host, toast = () => {} } = {}) {
  let context = { projects: [], tasks: [], runs: [] }, snapshot = null, projectId = '', assignmentKey = '', visible = false, loading = false, saving = false, busy = false, disposed = false, error = '', dirty = false, draftLimit = '', generation = 0;
  const selectedProject = () => context.projects.find(item => item.id === projectId);
  function rootRun(run) { const seen = new Set(); let current = run; while (current.parentRunId && !seen.has(current.id)) { seen.add(current.id); const parent = context.runs.find(item => item.id === current.parentRunId); if (!parent) break; current = parent; } return current; }
  function assignments() {
    const tasks = context.tasks.filter(item => item.projectId === projectId).map(item => ({ ...item, key: `task:${item.id}`, taskId: item.id }));
    const runs = [...new Map(context.runs.filter(item => item.projectId === projectId).map(item => { const root = rootRun(item); return [root.id, { ...root, key: `run:${root.id}`, runId: root.id }]; })).values()];
    return [...tasks, ...runs];
  }
  function report(assignment) {
    const project = selectedProject();
    const entry = snapshot?.entries?.find(item => item.projectId === project?.id && (assignment ? assignment.taskId ? item.taskId === assignment.taskId : item.runId === assignment.runId : !item.taskId && !item.runId));
    return entry || { callLimit: assignment ? snapshot?.defaults?.assignmentCallLimit : snapshot?.defaults?.projectCallLimit, version: 0, used: 0, remaining: assignment ? snapshot?.defaults?.assignmentCallLimit : snapshot?.defaults?.projectCallLimit, usage: { inputTokens: null, outputTokens: null, unknownInputCount: 0, unknownOutputCount: 0 } };
  }
  async function request(body) {
    const response = await fetch('/api/budgets', body ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Fuori-Studio': 'local' }, body: JSON.stringify(body) } : { cache: 'no-store' });
    let value; try { value = await response.json(); } catch { throw Error(t('I dati dei budget non sono disponibili.')); }
    if (!response.ok) throw Error(value.error || t('Operazione non riuscita.'));
    if (!value?.defaults || !Array.isArray(value.entries)) throw Error(t('I dati dei budget non sono validi.'));
    return value;
  }
  function locks() { host.querySelectorAll('button,input,select').forEach(element => { element.disabled = busy || loading || saving || disposed; }); }
  function summary(label, value) {
    return ui`<article class="budget-summary"><span>${escape(label)}</span><strong>${number(value.used)} / ${number(value.callLimit)}</strong><small>${number(value.remaining)} chiamate residue</small></article>`;
  }
  function render() {
    if (!visible || disposed) return;
    if (!snapshot) { host.innerHTML = ui`<p class="budget-notice" role="status">${error ? escape(error) : t('Caricamento dei budget…')}</p><button class="ops-button" type="button" data-budget-refresh>Ricarica budget</button>`; locks(); return; }
    if (!selectedProject()) projectId = context.projects[0]?.id || '';
    const project = selectedProject(), options = assignments(), assignment = options.find(item => item.key === assignmentKey);
    if (!assignment) assignmentKey = '';
    const current = report(assignment), projectBudget = report();
    host.innerHTML = ui`<section class="budgets-panel" aria-labelledby="budget-title"><div class="budget-heading"><div><h3 id="budget-title">Budget di progetto e incarico</h3><p>Limiti di chiamate AI applicati dal server. Non sono importi in denaro.</p></div><button class="ops-button" type="button" data-budget-refresh>Ricarica budget</button></div><p class="budget-notice">I limiti di progetto e incarico valgono per tutta la loro durata, senza reset giornaliero. Tentativi falliti, annullati e revisioni consumano lo stesso budget. Il limite generale giornaliero resta valido.</p>${error ? ui`<p class="ops-error" role="alert">${escape(error)}</p>` : ''}${project ? ui`<div class="ops-form-grid"><div class="ops-field"><label for="budget-project">Progetto</label><select id="budget-project">${context.projects.map(item => `<option value="${escape(item.id)}"${item.id === projectId ? ' selected' : ''}>${escape(item.title)}</option>`).join('')}</select></div><div class="ops-field"><label for="budget-assignment">Incarico o repository</label><select id="budget-assignment"><option value="">${t('Tutto il progetto')}</option>${options.map(item => `<option value="${escape(item.key)}"${item.key === assignmentKey ? ' selected' : ''}>${escape(item.taskId ? t('Incarico') : t('Repository'))} · ${escape(item.title)}</option>`).join('')}</select></div></div><div class="budget-summaries">${summary(t('Intero progetto'), projectBudget)}${assignment ? summary(t('Incarico e revisioni'), current) : ''}${summary(t('Oggi · tutti gli ambiti'), { used: snapshot.daily.calls, callLimit: snapshot.daily.callLimit, remaining: snapshot.daily.remaining })}</div><form data-budget-form><div class="ops-field"><label for="budget-limit">${assignment ? t('Limite totale dell’incarico') : t('Limite totale del progetto')}</label><input id="budget-limit" name="callLimit" type="number" min="0" max="50000" step="1" value="${escape(dirty ? draftLimit : current.callLimit)}" required><p class="ops-hint">Il limite include le chiamate già usate. Zero blocca nuovi avvii. Aumentarlo non azzera il conteggio.</p></div><button class="ops-button is-primary" type="submit">Salva budget</button></form><div class="budget-tokens"><p>Token riportati dai servizi: ingresso ${number(current.usage.inputTokens)} · uscita ${number(current.usage.outputTokens)}.</p><p>Dati mancanti: ingresso ${number(current.usage.unknownInputCount)} chiamate · uscita ${number(current.usage.unknownOutputCount)} chiamate. Dati mancanti non equivalgono a zero; i totali possono essere parziali.</p></div>` : ui`<p class="budget-notice">Crea un progetto per impostarne il budget.</p>`}<p class="budget-footnote">Chat senza progetto, test delle connessioni e chiamate storiche senza progetto usano solo il limite generale. Chiamate registrate senza progetto: ${number(snapshot.unattributedCalls)}.</p></section>`;
    host.querySelector('#budget-project')?.addEventListener('change', event => { projectId = event.target.value; assignmentKey = ''; dirty = false; render(); });
    host.querySelector('#budget-assignment')?.addEventListener('change', event => { assignmentKey = event.target.value; dirty = false; render(); });
    const form = host.querySelector('[data-budget-form]');
    form?.addEventListener('input', () => { dirty = true; draftLimit = form.elements.callLimit.value; });
    form?.addEventListener('submit', async event => {
      event.preventDefault(); if (busy || saving || disposed || !form.reportValidity()) return;
      const payload = { projectId, ...(assignment?.taskId ? { taskId: assignment.taskId } : {}), ...(assignment?.runId ? { runId: assignment.runId } : {}), callLimit: Number(new FormData(form).get('callLimit')), expectedVersion: current.version };
      saving = true; locks();
      try { const value = await request({ action: 'configureBudget', payload }); if (disposed) return; snapshot = value; error = ''; dirty = false; toast(t('Budget aggiornato. I conteggi precedenti sono conservati.')); }
      catch (cause) { error = cause.message; } finally { saving = false; render(); }
    }); locks();
  }
  async function load() { if (disposed || loading) return; const current = ++generation; loading = true; error = ''; render(); try { const value = await request(); if (current !== generation || disposed) return; snapshot = value; dirty = false; } catch (cause) { if (current === generation) error = cause.message; } finally { if (current === generation) { loading = false; render(); } } }
  const click = event => { if (event.target.closest('[data-budget-refresh]') && !loading && !saving && !busy) void load(); };
  const stopLanguage = onLanguageChange(render);
  const expire = () => { disposed = true; generation++; locks(); };
  host.addEventListener('click', click); window.addEventListener('studio-session-expired', expire);
  return { load, setContext(value) { context = { ...context, ...value }; if (!dirty) render(); }, setVisible(value) { const next = Boolean(value), changed = next && !visible; visible = next; host.hidden = !visible; if (!dirty) render(); if (changed) void load(); }, setBusy(value) { busy = Boolean(value); locks(); }, dispose() { expire(); stopLanguage(); host.removeEventListener('click', click); window.removeEventListener('studio-session-expired', expire); } };
}
