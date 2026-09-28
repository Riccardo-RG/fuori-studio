import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { randomUUID } from 'node:crypto';

const greeting = 'Raccontami il risultato che vuoi ottenere. Useremo la memoria di questo ambito e le informazioni che hai scelto di condividere.';
const fresh = scopeId => ({ id: randomUUID(), scopeId, projectId: 'portfolio', createdAt: new Date().toISOString(), messages: [{ id: randomUUID(), role: 'assistant', agentId: 'nova', text: greeting, createdAt: new Date().toISOString(), welcome: true }] });

// Each scope has its own conversation. The original mixed chat is only imported into legacy.
export function createConversationStore({ directory, storage }) {
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
  const archiveKey = file => 'chat/' + relative(directory, file).replaceAll('\\', '/').replace(/\.json$/, '');
  async function readJSON(file) {
    if (storage) return storage.load(archiveKey(file), file, undefined, value => {
      if (!value || typeof value !== 'object') throw Error('Conversazione non valida.');
      if (file.endsWith('chat-selection.json')) validId(value.scopeId);
      else checked(value, value.scopeId || 'legacy');
      return value;
    });
    try { return JSON.parse(await readFile(file, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return undefined;
      throw Error('La conversazione salvata non è leggibile. Il file originale è stato conservato.');
    }
  }
  async function atomic(file, value) {
    if (storage) { await storage.write(archiveKey(file), value); return; }
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
    migrate: () => serial(async () => {
      if (!storage) return;
      for (const name of ['chat.json', 'chat-selection.json']) await readJSON(resolve(directory, name));
      for (const name of ['conversations','history']) {
        let entries; try { entries = await readdir(resolve(directory,name), {withFileTypes:true}); } catch(error) { if(error.code==='ENOENT') continue; throw error; }
        for (const entry of entries) if(entry.name.endsWith('.json')) { validId(entry.name.slice(0,-5)); await readJSON(resolve(directory,name,entry.name)); }
      }
    }),
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
      const historyFile = resolve(directory, 'history', `${validId(old.id)}.json`);
      const value = fresh(scopeId);
      if (storage) await storage.batch([{key:archiveKey(historyFile),value:old},{key:archiveKey(fileFor(scopeId)),value}]);
      else { await atomic(historyFile, old); await atomic(fileFor(scopeId), value); }
      return value;
    })
  };
}
