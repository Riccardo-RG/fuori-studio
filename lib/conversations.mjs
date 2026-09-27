import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const greeting = 'Raccontami il risultato che vuoi ottenere. Useremo la memoria di questo ambito e le informazioni che hai scelto di condividere.';
const fresh = scopeId => ({ id: randomUUID(), scopeId, projectId: 'portfolio', createdAt: new Date().toISOString(), messages: [{ id: randomUUID(), role: 'assistant', agentId: 'nova', text: greeting, createdAt: new Date().toISOString(), welcome: true }] });

// Each scope has its own conversation. The original mixed chat is only imported into legacy.
export function createConversationStore({ directory }) {
  let queue = Promise.resolve();
  const serial = operation => {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };
  const validId = id => {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw Error('Ambito non valido.');
    return id;
  };
  const fileFor = id => resolve(directory, 'conversations', `${validId(id)}.json`);
  async function readJSON(file) {
    try { return JSON.parse(await readFile(file, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return undefined;
      throw Error('La conversazione salvata non è leggibile. Il file originale è stato conservato.');
    }
  }
  async function atomic(file, value) {
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
    await rename(temp, file);
  }
  function checked(value, scopeId) {
    if (!value || typeof value.id !== 'string' || !Array.isArray(value.messages) || value.messages.some(m => !m || typeof m.id !== 'string' || typeof m.text !== 'string' || !['user', 'assistant'].includes(m.role))) throw Error('La conversazione salvata non è valida. Il file originale è stato conservato.');
    if (value.scopeId && value.scopeId !== scopeId) throw Error('La conversazione appartiene a un altro ambito.');
    return { ...value, scopeId };
  }
  async function readConversation(scopeId) {
    const file = fileFor(scopeId);
    await mkdir(resolve(directory, 'conversations'), { recursive: true, mode: 0o700 });
    const existing = await readJSON(file);
    if (existing !== undefined) return checked(existing, scopeId);
    const legacy = scopeId === 'legacy' ? await readJSON(resolve(directory, 'chat.json')) : undefined;
    const value = legacy !== undefined ? checked(legacy, scopeId) : fresh(scopeId);
    await atomic(file, value);
    return value;
  }
  return {
    load: scopeId => serial(() => readConversation(scopeId)),
    save: value => serial(async () => {
      checked(value, value.scopeId);
      await mkdir(resolve(directory, 'conversations'), { recursive: true, mode: 0o700 });
      await atomic(fileFor(value.scopeId), value);
      return value;
    }),
    selection: () => serial(async () => {
      const selected = await readJSON(resolve(directory, 'chat-selection.json'));
      if(selected === undefined) return 'business';
      if(!selected || typeof selected !== 'object') throw Error('Selezione ambito non valida. Il file originale è stato conservato.');
      return validId(selected.scopeId);
    }),
    select: scopeId => serial(async () => {
      validId(scopeId);
      const value = await readConversation(scopeId);
      await atomic(resolve(directory, 'chat-selection.json'), { scopeId });
      return value;
    }),
    reset: scopeId => serial(async () => {
      const old = await readConversation(scopeId);
      await mkdir(resolve(directory, 'history'), { recursive: true, mode: 0o700 });
      await atomic(resolve(directory, 'history', `${validId(old.id)}.json`), old);
      const value = fresh(scopeId);
      await atomic(fileFor(scopeId), value);
      return value;
    })
  };
}
