import { agents } from '../dist/data.js';

interface Storage { read(key: string, fallback?: unknown): Promise<unknown>; write(key: string, value: unknown): Promise<unknown>; }
interface State { schemaVersion: 1; version: number; names: Record<string, string>; }
const KEY = 'team-profiles';
const defaults: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(agents.map(agent => [agent.id, agent.name])));
const ids = Object.keys(defaults);
const fail = (message: string, code = 'TEAM_INVALID', statusCode = 400) => Object.assign(Error(message), {code,statusCode});
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
function name(value: unknown): string {
  if (typeof value !== 'string' || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) throw fail('Usa un nome da 1 a 60 caratteri, senza ritorni a capo o caratteri di controllo.');
  const result = value.trim().normalize('NFC');
  if (!result || result.length > 60) throw fail('Usa un nome da 1 a 60 caratteri, senza ritorni a capo o caratteri di controllo.');
  return result;
}
function validate(value: unknown): State {
  try {
    if (!record(value) || value.schemaVersion !== 1 || !Number.isSafeInteger(value.version) || Number(value.version) < 1 || !record(value.names) || Object.keys(value.names).length !== ids.length || ids.some(id => !Object.hasOwn(value.names as object,id))) throw Error();
    const names: Record<string,string> = {};
    for (const id of ids) { names[id] = name(value.names[id]); if (names[id] !== value.names[id]) throw Error(); }
    if (new Set(Object.values(names).map(value => value.toLowerCase())).size !== ids.length) throw Error();
    return {schemaVersion:1,version:Number(value.version),names};
  } catch { throw fail('Impossibile leggere i nomi del team salvati.', 'TEAM_CORRUPT', 503); }
}
export function createTeamStore({storage}: {storage: Storage}) {
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(callback: () => Promise<T>): Promise<T> => { const operation = queue.then(callback,callback); queue = operation.catch(()=>{}); return operation; };
  const load = async () => validate(await storage.read(KEY,{schemaVersion:1,version:1,names:{...defaults}}));
  const view = (state: State) => ({version:state.version,names:{...state.names}});
  return {
    snapshot: () => serial(async () => view(await load())),
    rename: (input: unknown) => serial(async () => {
      if (!record(input) || Object.keys(input).some(key => !['id','name','expectedVersion'].includes(key)) || typeof input.id !== 'string' || !ids.includes(input.id)) throw fail('Scegli un membro valido del team.');
      if (!Number.isSafeInteger(input.expectedVersion) || Number(input.expectedVersion) < 1) throw fail('Versione del team non valida.');
      const nextName = name(input.name), state = await load();
      if (input.expectedVersion !== state.version) throw fail('I nomi sono cambiati in un’altra scheda. Ricarica e riprova.', 'TEAM_CONFLICT', 409);
      if (ids.some(id => id !== input.id && state.names[id].toLowerCase() === nextName.toLowerCase())) throw fail('Ogni membro del team deve avere un nome diverso.');
      if (state.names[input.id] === nextName) return view(state);
      if (state.version === Number.MAX_SAFE_INTEGER) throw fail('Il registro dei nomi ha raggiunto il limite di versioni.', 'TEAM_VERSION_LIMIT', 409);
      const next = {...state,version:state.version+1,names:{...state.names,[input.id]:nextName}};
      await storage.write(KEY,next);
      return view(next);
    }),
  };
}
