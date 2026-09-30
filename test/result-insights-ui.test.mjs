import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateResultInsights } from '../lib/result-insights.ts';
import { resultInsightsHTML } from '../dist/result-insights.js';
import { setLanguage } from '../dist/i18n.js';

const insights = aggregateResultInsights({scopeId:'scope-a',operations:{projects:[{id:'a',scopeId:'scope-a',title:'Memoria <img src=x onerror=alert(1)>'}],tasks:[{id:'task-a',scopeId:'scope-a',projectId:'a',status:'completed',artifacts:[{decision:'approved'}]}]}});

test('result cards escape archive titles and preserve unknown savings and explicit feedback coverage', () => {
  setLanguage('it',{persist:false});
  const markup = resultInsightsHTML(insights,{scopeId:'scope-a'});
  assert.match(markup,/Memoria &lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(markup,/<img/);
  assert.match(markup,/Non ancora valutata/);
  assert.match(markup,/1 risultati approvati da valutare/);
  assert.match(markup,/Minuti risparmiati dichiarati<\/dt><dd>Non disponibile/);
});

test('late or failed scope results never display another scope’s project title', () => {
  assert.doesNotMatch(resultInsightsHTML(insights,{scopeId:'scope-b'}),/Memoria/);
  const failed = resultInsightsHTML(insights,{scopeId:'scope-b',failed:true});
  assert.doesNotMatch(failed,/Memoria/);
  assert.match(failed,/Risultati dell’ambito non disponibili/);
});

test('English results translate interface copy without translating saved project titles', () => {
  setLanguage('en',{persist:false});
  try {
    const markup = resultInsightsHTML(insights,{scopeId:'scope-a'});
    assert.match(markup,/Where the work is useful/);
    assert.match(markup,/By project/);
    assert.match(markup,/Not yet rated/);
    assert.match(markup,/Memoria &lt;img/);
    assert.doesNotMatch(markup,/Dove il lavoro|Consegne valutate|Non ancora valutata/);
  } finally { setLanguage('it',{persist:false}); }
});
