import { t } from './i18n.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const definitions = [
  { key: 'materials', label: 'Materiali', required: false },
  { key: 'objective', label: 'Obiettivo', required: true },
  { key: 'constraints', label: 'Vincoli', required: false },
  { key: 'deliverable', label: 'Consegna attesa', required: true },
];
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
function label(field) {
  const builtIn = definitions.find(item => item.key === field.key);
  return field.label === builtIn?.label ? t(builtIn.label) : field.label;
}

/** Archive labels and values are escaped opaque text. Only built-in copy is translated. */
export function workflowFieldEditorHTML(fields = []) {
  return `<fieldset class="workflow-fields-editor"><legend>${escape(t('Campi da compilare a ogni utilizzo'))}</legend><p class="form-note">${escape(t('Scegli fino a quattro campi, rendili obbligatori e aggiungi eventuali valori predefiniti.'))}</p>${definitions.map(definition => {
    const saved = fields.find(field => field.key === definition.key), field = saved || { ...definition, defaultValue: '' };
    return `<div class="workflow-field-editor" data-workflow-field="${definition.key}"><label class="checkbox-label"><input type="checkbox" name="workflow-field-${definition.key}-enabled" data-field-enabled${saved ? ' checked' : ''}> ${escape(t('Usa il campo'))}: ${escape(t(definition.label))}</label><label>${escape(t('Nome del campo'))}<input name="workflow-field-${definition.key}-label" data-field-label maxlength="100" value="${escape(field.label)}" aria-label="${escape(t('Nome del campo'))}: ${escape(t(definition.label))}"></label><label class="checkbox-label"><input type="checkbox" name="workflow-field-${definition.key}-required" data-field-required${field.required ? ' checked' : ''}> ${escape(t('Obbligatorio'))}</label><label>${escape(t('Valore predefinito · facoltativo'))}<textarea name="workflow-field-${definition.key}-default" data-field-default maxlength="4000" rows="2" aria-label="${escape(t('Valore predefinito'))}: ${escape(t(definition.label))}">${escape(field.defaultValue)}</textarea></label><small>${escape(t('Segnaposto'))}: <code>{{${definition.key}}}</code></small></div>`;
  }).join('')}<p class="form-note">${escape(t('Puoi inserire i segnaposto nei materiali, nei passaggi e nella consegna. I valori restano dati del singolo utilizzo.'))}</p></fieldset>`;
}
export function readWorkflowFieldEditor(form) {
  const fields = [...form.querySelectorAll('[data-workflow-field]')].filter(row => row.querySelector('[data-field-enabled]').checked).map(row => ({
    key: row.dataset.workflowField,
    label: row.querySelector('[data-field-label]').value.trim(),
    required: row.querySelector('[data-field-required]').checked,
    defaultValue: row.querySelector('[data-field-default]').value,
  }));
  if (fields.some(field => !field.label || field.label.length > 100 || field.defaultValue.length > 4000)) throw Error(t('Controlla nomi e valori dei campi della procedura.'));
  if (fields.reduce((sum, field) => sum + field.defaultValue.length, 0) > 12000) throw Error(t('I valori dei campi superano il limite complessivo di 12.000 caratteri.'));
  return fields;
}
export function workflowInputFormHTML(workflow, values = {}) {
  if (!workflow?.inputFields?.length) return '';
  return `<fieldset class="workflow-input-form" data-workflow-inputs data-workflow-id="${escape(workflow.id)}" data-workflow-version="${workflow.version}"><legend>${escape(t('Compila la procedura'))}</legend><p class="form-note">${escape(t('Questi valori si applicano soltanto a questo utilizzo. Massimo 4.000 caratteri per campo e 12.000 in totale.'))}</p>${workflow.inputFields.map(field => `<label>${escape(label(field))} · ${escape(t(field.required ? 'Obbligatorio' : 'Facoltativo'))}<textarea name="workflow-input-${escape(field.key)}" data-workflow-input-key="${escape(field.key)}" maxlength="4000" rows="3"${field.required ? ' required' : ''} aria-label="${escape(label(field))}">${escape(own(values, field.key) ? values[field.key] : field.defaultValue)}</textarea></label>`).join('')}</fieldset>`;
}
export function readWorkflowInputValues(form) {
  const controls = [...form.querySelectorAll('[data-workflow-input-key]')];
  const values = Object.fromEntries(controls.map(control => {
    if ((control.required && !control.value.trim()) || control.value.length > 4000) throw Error(t('Compila tutti i campi obbligatori della procedura.'));
    return [control.dataset.workflowInputKey, control.value];
  }));
  if (Object.values(values).reduce((sum, value) => sum + value.length, 0) > 12000) throw Error(t('I valori dei campi superano il limite complessivo di 12.000 caratteri.'));
  return values;
}
export function workflowInputSummaryHTML(task) {
  const snapshot = task?.workflowInputs;
  if (!snapshot?.fields?.length) return '';
  return `<details class="workflow-input-summary"><summary>${escape(t('Valori usati per la procedura'))} · v${snapshot.workflowVersion}</summary><dl>${snapshot.fields.map(field => `<dt>${escape(label(field))}</dt><dd translate="no"><pre>${escape(snapshot.values[field.key]) || '—'}</pre></dd>`).join('')}</dl></details>`;
}
