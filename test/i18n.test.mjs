import test from 'node:test';
import assert from 'node:assert/strict';
import {chooseLanguage, language, locale, setLanguage, t, ui, english} from '../dist/i18n.js';

const change = code => setLanguage(code, {persist:false});
test('language preference accepts supported locales with deterministic browser fallback', () => {
  assert.equal(chooseLanguage('it','en-US'),'it');
  assert.equal(chooseLanguage('en','it-IT'),'en');
  assert.equal(chooseLanguage('de','en-GB'),'en');
  assert.equal(chooseLanguage(null,'fr-FR'),'it');
  assert.equal(chooseLanguage(null,'en-US'),'en');
  change('it'); assert.equal(locale(),'it-IT');
  assert.equal(setLanguage('javascript:alert(1)',{persist:false}),false);
  assert.equal(language(),'it');
  change('en'); assert.equal(locale(),'en-GB');
  change('it');
});
test('UI translation preserves opaque archive values and machine attributes', () => {
  change('en');
  const savedTitle = 'Memoria', escapedText = '&lt;img src=x onerror=alert(1)&gt;';
  assert.equal(ui`<p>Memoria</p><p>${savedTitle}</p>`, '<p>Memory</p><p>Memoria</p>');
  assert.equal(ui`<option value="Memoria">Memoria</option>`, '<option value="Memoria">Memory</option>');
  assert.equal(ui`<p>${escapedText}</p>`, '<p>'+escapedText+'</p>');
  assert.equal(ui`<p>${'<b>Memoria</b>'}</p>`, '<p><b>Memoria</b></p>');
  assert.equal(ui`<p>Parla con ${'Memoria'} ↗</p>`, '<p>Talk to Memoria ↗</p>');
  assert.equal(ui`<button aria-label="Conosci ${'Riccardo'}, ${'Memoria'}">Memoria</button>`, '<button aria-label="Meet Riccardo, Memoria">Memory</button>');
  assert.equal(ui`<p> ${'\uE0000\uE001'} </p>`, '<p> \uE0000\uE001 </p>');
  change('it');
});
test('named parameters, whitespace, nested markup and missing keys remain stable', () => {
  change('en');
  assert.equal(t('{provider} collegato',{provider:'My <provider>'}),'My <provider> connected');
  assert.equal(ui`<div> Memoria <b>${ui`<span>Apri originale</span>`}</b></div>`, '<div> Memory <b><span>Open original</span></b></div>');
  assert.equal(t('Missing source key'),'Missing source key');
  assert.equal(t('__proto__'),'__proto__');
  change('it');
  assert.equal(ui`<p>Parla con ${'Riccardo'} ↗</p>`,'<p>Parla con Riccardo ↗</p>');
});
test('English catalog has non-empty translations and preserves parameter contracts', () => {
  assert.ok(Object.keys(english).length > 1000);
  const placeholders = text => [...new Set(text.match(/\{\w+\}/g) || [])].sort();
  for (const [source, translated] of Object.entries(english)) {
    assert.equal(typeof translated,'string',source);
    assert.ok(translated.trim(),source);
    assert.deepEqual(placeholders(translated),placeholders(source),source);
  }
});
