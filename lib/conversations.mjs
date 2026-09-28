import { mkdir, readFile, writeFile, rename, readdir, lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
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
  // Search must never create a conversation, change selection, or migrate files.
  async function readExisting(file) {
    if (storage) return storage.read(archiveKey(file));
    let handle;
    try {
      const parent = await lstat(dirname(file));
      if (!parent.isDirectory() || parent.isSymbolicLink()) throw Error('Archivio conversazioni non valido.');
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || info.size > 32 * 1024 * 1024) throw Error('Conversazione non leggibile.');
      return JSON.parse(await handle.readFile('utf8'));
    } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
    finally { await handle?.close(); }
  }
  async function existingConversations({ scopeIds, limit = 5000 } = {}) {
    if (!Array.isArray(scopeIds) || !scopeIds.length || scopeIds.length > 200 || !Number.isInteger(limit) || limit < 1 || limit > 10000) throw Error('Ricerca conversazioni non valida.');
    const allowed = new Set(scopeIds.map(validId)), conversations = [], seen = new Set();
    let truncated = false;
    const append = (value, archived) => {
      if (!value || !allowed.has(value.scopeId || 'legacy')) return;
      const conversation = checked(value, value.scopeId || 'legacy');
      validId(conversation.id);
      const key = `${conversation.scopeId}/${conversation.id}`;
      if (seen.has(key)) return;
      if (conversations.length >= limit) { truncated = true; return; }
      seen.add(key); conversations.push({ ...conversation, archived });
    };
    for (const scopeId of allowed) append(await readExisting(fileFor(scopeId)), false);
    if (allowed.has('legacy') && !conversations.some(item => item.scopeId === 'legacy')) append(await readExisting(resolve(directory, 'chat.json')), false);
    if (storage) {
      if (typeof storage.entries !== 'function') throw Error('L’archivio non supporta la lettura dello storico.');
      let offset = 0;
      do {
        const page = await storage.entries('chat/history/', { offset, limit: 200 });
        for (const entry of page.entries) { validId(entry.key.slice('chat/history/'.length)); append(entry.value, true); }
        offset += page.entries.length;
        if (!page.hasMore) break;
        // Bound archive work even when most conversations belong to other scopes.
        if (offset >= 10000 || conversations.length >= limit) { truncated = true; break; }
      } while (true);
    } else {
      const folder = resolve(directory, 'history');
      const info = await lstat(folder).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
      if (info) {
        if (!info.isDirectory() || info.isSymbolicLink()) throw Error('Archivio conversazioni non valido.');
        const names = (await readdir(folder, { withFileTypes: true })).filter(entry => entry.isFile() && entry.name.endsWith('.json')).map(entry => entry.name).sort();
        for (const name of names.slice(0, 10000)) {
          validId(name.slice(0, -5)); append(await readExisting(resolve(folder, name)), true);
          if (conversations.length >= limit) { truncated ||= names.indexOf(name) < names.length - 1; break; }
        }
        truncated ||= names.length > 10000;
      }
    }
    return { conversations, truncated };
  }
  return {
    list: options => serial(() => existingConversations(options)),
    original: ({ scopeId, conversationId }) => serial(async () => {
      validId(scopeId); validId(conversationId);
      const current = await readExisting(fileFor(scopeId));
      if (current?.id === conversationId) return { ...checked(current, scopeId), archived: false };
      const archived = await readExisting(resolve(directory, 'history', `${conversationId}.json`));
      if (archived && archived.id === conversationId && (archived.scopeId || 'legacy') === scopeId) return { ...checked(archived, scopeId), archived: true };
      if (scopeId === 'legacy' && !current) {
        const legacy = await readExisting(resolve(directory, 'chat.json'));
        if (legacy?.id === conversationId) return { ...checked(legacy, scopeId), archived: false };
      }
      throw Object.assign(Error('Conversazione non trovata in questo ambito.'), { statusCode: 404, code: 'NOT_FOUND' });
    }),
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
