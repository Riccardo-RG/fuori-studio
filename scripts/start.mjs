import { loadSecretEnvironment } from '../lib/deployment.ts';
await loadSecretEnvironment();
await import('../server.mjs');
