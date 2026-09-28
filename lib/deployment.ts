import { open } from 'node:fs/promises';
import { constants } from 'node:fs';

type Environment = Record<string, string | undefined>;
const secretNames = ['FUORI_STUDIO_MASTER_KEY', 'FUORI_STUDIO_OIDC_CLIENT_SECRET'] as const;

/** Load explicit secret mounts before importing modules that capture process.env. */
export async function loadSecretEnvironment(env: Environment = process.env) {
  const loaded: Record<string, string> = {};
  for (const name of secretNames) {
    const filename = env[`${name}_FILE`];
    if (!filename) continue;
    if (env[name]) throw Error(`Configura solo ${name} oppure ${name}_FILE.`);
    let handle;
    try {
      handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || info.size < 1 || info.size > 16384) throw Error();
      const value = (await handle.readFile('utf8')).trim();
      if (!value || value.includes('\0') || value.includes('\n') || value.includes('\r')) throw Error();
      loaded[name] = value;
    } catch { throw Error(`Il file ${name}_FILE non è un segreto leggibile e valido.`); }
    finally { await handle?.close(); }
  }
  Object.assign(env, loaded);
}

type Verification = { verifiedAt: string; records: number; ok?: boolean };
type Maintenance = { backups: Array<{ verifiedAt?: string }>; lastVerification?: Verification | null };
type Check = { id: string; label: string; status: 'ready' | 'action' | 'unknown'; detail: string };
type Worker = { online?: boolean; repositories?: unknown[] };
const validHttps = (value?: string, originOnly = false) => {
  try { const u = new URL(value || ''); return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash && (!originOnly || u.pathname === '/'); } catch { return false; }
};

/** Reports evidence available locally, never probes an AI runtime or claims public reachability. */
export function deploymentSnapshot({ env = process.env, nodeVersion = process.versions.node, storage,
  authenticated = false, workers = [], maintenance = { backups: [] },
}: { env?: Environment; nodeVersion?: string; storage?: { encrypted: boolean; keySource: string }; authenticated?: boolean; workers?: Worker[]; maintenance?: Maintenance } = {}) {
  const mode = env.FUORI_STUDIO_MODE || 'local', local = mode === 'local';
  const checks: Check[] = [];
  const add = (id: string, label: string, ready: boolean, detail: string, unknown = false) => checks.push({ id, label, status: ready ? 'ready' : unknown ? 'unknown' : 'action', detail });
  add('runtime', 'Runtime supportato', nodeVersion.split('.')[0] === '24', `Node ${nodeVersion}. Questa versione dello studio richiede Node 24.`);
  add('mode', 'Modalità di installazione', ['local', 'hybrid', 'online'].includes(mode), local ? 'Accesso limitato a questo computer. Per accedere da altri dispositivi prepara un’installazione ibrida con HTTPS.' : 'Accesso remoto protetto dall’identità del proprietario; i repository vengono eseguiti su computer autorizzati.');
  const configured = validHttps(env.FUORI_STUDIO_PUBLIC_URL, true);
  add('https', 'Indirizzo e HTTPS', local, local ? 'Il server locale ascolta solo sul loopback.' : configured ? 'Indirizzo HTTPS configurato. Certificato, DNS e raggiungibilità da un altro dispositivo devono essere verificati sul dominio.' : 'Configura FUORI_STUDIO_PUBLIC_URL con l’origine HTTPS del dominio.', configured);
  const identityConfigured = validHttps(env.FUORI_STUDIO_OIDC_ISSUER) && Boolean(env.FUORI_STUDIO_OIDC_CLIENT_ID && env.FUORI_STUDIO_OIDC_CLIENT_SECRET && env.FUORI_STUDIO_OWNER_SUBJECT);
  add('identity', 'Accesso del proprietario', local || (identityConfigured && authenticated), local ? 'L’installazione locale non usa un account remoto.' : authenticated && identityConfigured ? 'Sessione autenticata del proprietario riconosciuta dal server.' : identityConfigured ? 'OIDC configurato. Completa un accesso con il proprietario per verificarlo.' : 'Configura issuer, client ID, client secret e subject esatto del proprietario.', identityConfigured);
  add('encryption', 'Archivio cifrato', storage?.encrypted === true && (local || storage.keySource === 'environment'), storage ? storage.keySource === 'environment' ? 'L’archivio usa una chiave esterna. Conservala separatamente dai backup.' : 'L’archivio usa archive.key nella cartella privata. Conserva separatamente una copia della chiave.' : 'L’apertura dell’archivio non è verificata da questa diagnosi di configurazione.', !storage);
  const online = workers.filter(item => item.online).length;
  const repositoryReady = workers.filter(item => item.online && item.repositories?.length).length;
  add('workers', 'Computer per i repository', repositoryReady > 0, repositoryReady ? `${repositoryReady} computer online con repository autorizzati. La compatibilità del runtime AI si verifica eseguendo un incarico revisionabile.` : local ? 'Puoi usare repository locali o collegare un computer a un’installazione online. Non è stata verificata una sessione AI su questo host.' : 'Collega un computer e registra dalla sua CLI i repository, gli ambiti e i comandi consentiti.', local);
  const backup = maintenance.backups.some(item => Boolean(item.verifiedAt));
  add('backup', 'Backup verificato', backup, backup ? 'È presente una copia verificata. Scaricala fuori dal server e prova il ripristino in una cartella nuova.' : 'Crea e scarica un backup cifrato; conserva la chiave separatamente.');
  add('integrity', 'Verifica dell’archivio', Boolean(maintenance.lastVerification), maintenance.lastVerification ? `Ultima verifica: ${maintenance.lastVerification.verifiedAt}. Lo stato si riferisce a quel momento.` : 'Avvia la verifica del database e dell’autenticazione dei record cifrati.');
  return { mode, publicUrl: configured ? new URL(env.FUORI_STUDIO_PUBLIC_URL!).origin : null, checks,
    summary: { ready: checks.filter(item => item.status === 'ready').length, total: checks.length },
    storage: storage || { encrypted: false, keySource: 'unknown' }, workers: { online, repositoryReady }, maintenance };
}
