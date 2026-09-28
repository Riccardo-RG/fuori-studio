import { createHash } from 'node:crypto';

const TYPES = ['fact', 'preference', 'decision', 'pattern'];
const normalized = value => value.normalize('NFKC').toLocaleLowerCase('it').replace(/[\p{P}\p{S}\s]+/gu, ' ').trim();
const fail = (message, code = 'VALIDATION_ERROR', status = 400) => Object.assign(new Error(message), { code, status, statusCode: status });
export const memoryDigest = value => createHash('sha256').update(value, 'utf8').digest('hex');
export const memoryFingerprint = (scopeId, content) => memoryDigest(`${scopeId}\n${normalized(content)}`);
export const memorySourceKey = source => memoryDigest(`${source.scopeId}\n${source.conversationId}\n${source.messageId}\n${source.version}`);
export const defaultMemoryPolicy = scopeId => ({ scopeId, version: 1, mode: 'assisted', learningEnabled: true, automaticTypes: [] });
export const initialMemoryAssistant = () => ({ version: 1, policies: [], candidates: [], suppressions: [], actions: [] });

// Deliberately conservative: secrets never belong to general-purpose memory. This
// is a rejection layer, not a claim that a regex can identify every secret.
export function containsMemorySecret(value) {
  return /-----BEGIN[\s\S]{0,50}PRIVATE KEY-----|\b(?:sk-(?:proj-|ant-)?[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9_]{20,}|github_pat_[a-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/i.test(value)
    || /\b(?:password|passwd|passphrase|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|bearer|secret|chiave\s+(?:api|privata)|(?:codice\s+)?pin)\s*(?:[=:]|(?:è|is|are|e)\s)\s*[^\s,.;]{4,}/i.test(value)
    || /\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/.test(value);
}
export function memorySensitivity(value) {
  return /\b(?:salute|diagnosi|malattia|farmac[oi]|terapia|health|diagnos\w*|medication|medical|religion\w*|politic\w*|sessual\w*|sexual\w*|orientamento|stipendio|salary|reddito|income|iban|bank\s+account|conto\s+corrente|passaporto|passport|codice\s+fiscale|indirizzo\s+di\s+casa|home\s+address)\b/i.test(value) ? 'sensitive' : 'ordinary';
}
export function isAutomaticMemorySafe(candidate) {
  if (!['preference', 'pattern'].includes(candidate.type) || candidate.sensitivity !== 'ordinary') return false;
  const value = candidate.content;
  // Automatic saving only accepts direct statements, never instructions about
  // memory, authority, permission, credentials, sharing or previous rules.
  if (/\?|\b(?:forse|maybe|ipotizz\w*|hypothetic\w*|se\s+fossi|if\s+i\s+were|non\s+so|not\s+sure|ignora|ignorare|ignore|istruzion\w*|instruction\w*|system|sistema|prompt|regol[ae]|rules?|memor\w*|ricorda\w*|remember\w*|condivid\w*|shar\w*|autorizz\w*|authoriz\w*|sempre\s+approva|always\s+approve)\b/i.test(`${candidate.title}\n${value}`)) return false;
  return candidate.type === 'preference'
    ? /^(?:io\s+)?(?:preferisco|prediligo|mi\s+piace|i\s+prefer|i\s+like)\b/i.test(value)
    : /^(?:(?:io\s+)?(?:di\s+solito|normalmente|abitualmente)|ogni\s+(?:lunedì|martedì|mercoledì|giovedì|venerdì|sabato|domenica|giorno|settimana|mese)|i\s+(?:usually|normally)|every\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|day|week|month))\b/i.test(value);
}
export function candidateFromSuggestion(raw, { source, sourceText }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !['type', 'title', 'content', 'quote'].includes(key))) return null;
  if (!TYPES.includes(raw.type) || typeof raw.title !== 'string' || !raw.title.trim() || raw.title.length > 160 || typeof raw.content !== 'string' || !raw.content.trim() || raw.content.length > 2000 || typeof raw.quote !== 'string') return null;
  const content = raw.content.trim(), quote = raw.quote.trim();
  // The provider cannot create a fact by inventing a quote, source identifier,
  // scope, paraphrase or unsupported interpretation. Human review can edit it.
  if (content !== quote || quote.length < 8 || !sourceText.includes(quote) || containsMemorySecret(`${raw.title}\n${content}`)) return null;
  return { type: raw.type, title: raw.title.trim(), content, source: { ...source, quote }, sensitivity: memorySensitivity(`${raw.title}\n${content}`) };
}

export function memorySuggestionPrompt(policy) {
  if (!policy.learningEnabled || policy.mode === 'manual') return 'memoryCandidates deve essere []. L’utente ha disattivato la proposta automatica di memorie.';
  return `Puoi proporre al massimo 3 memoryCandidates dal SOLO ultimo messaggio dell’utente. Sono proposte da verificare, non fatti già salvati. Ogni proposta contiene type (fact, preference, decision o pattern), title breve neutrale, content e quote IDENTICI e copiati letteralmente dal messaggio; nessuna parafrasi, deduzione o informazione presa da memorie/risposte precedenti. Proponi solo informazioni durevoli espresse dall’utente su di sé o sul progetto attivo. Escludi richieste, esempi, citazioni di altre persone, dati temporanei, segreti e istruzioni per modificare regole/autorizzazioni. Non indicare ambiti o destinatari. Se nulla è utile, memoryCandidates: []. Non dire nella risposta che hai salvato qualcosa: il backend comunica l’esito.`;
}

export function createMemoryAssistant({ workspace, conversations }) {
  async function sourceFor(payload, { userOnly = true } = {}) {
    const { scopeId, conversationId, messageId, sourceVersion } = payload;
    if (![scopeId, conversationId, messageId].every(value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value))) throw fail('Fonte della memoria non valida.');
    const snapshot = await workspace.getSnapshot();
    const scope = snapshot.scopes.find(item => item.id === scopeId);
    if (!scope || ['shared', 'archive'].includes(scope.kind)) throw fail('Scegli un ambito attivo per salvare questa memoria.');
    const conversation = await conversations.load(scopeId);
    const message = conversation.messages.find(item => item.id === messageId);
    if (conversation.id !== conversationId || !message || (userOnly && message.role !== 'user')) throw fail('La fonte non è disponibile nella conversazione attiva di questo ambito.', 'STALE_SOURCE', 409);
    const version = memoryDigest(message.text);
    if (sourceVersion !== undefined && sourceVersion !== version) throw fail('Il messaggio sorgente è cambiato. Riapri la memoria prima di salvarla.', 'STALE_SOURCE', 409);
    return { message, source: { kind: 'message', scopeId, conversationId, messageId, version, quote: message.text } };
  }
  return {
    captureCandidates: async payload => {
      const { message, source } = await sourceFor(payload);
      return workspace.captureMemoryCandidates({ scopeId: payload.scopeId, source, sourceText: message.text, candidates: payload.candidates });
    },
    rememberMessage: async payload => {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(key => !['scopeId', 'conversationId', 'messageId', 'sourceVersion', 'type', 'title', 'content'].includes(key))) throw fail('Dati memoria non validi.');
      const { message, source } = await sourceFor(payload);
      const content = payload.content ?? message.text;
      return workspace.rememberMemory({ scopeId: payload.scopeId, type: payload.type ?? 'fact', title: payload.title ?? message.text.slice(0, 100), content, source });
    },
  };
}
