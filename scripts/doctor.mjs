import { deploymentSnapshot, loadSecretEnvironment } from '../lib/deployment.ts';
try {
  await loadSecretEnvironment();
  const report = deploymentSnapshot();
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    console.log('Fuori Studio — configuration diagnosis (no AI calls or data changes)');
    for (const item of report.checks) console.log(`[${item.status}] ${item.label}: ${item.detail}`);
    console.log('Archive, login, worker and backup evidence are available in Accesso → Preparazione after startup.');
  }
  if (report.checks.some(item => ['runtime', 'mode', 'identity', 'https'].includes(item.id) && item.status === 'action')) process.exitCode = 1;
} catch (error) { console.error(error.message); process.exitCode = 1; }
