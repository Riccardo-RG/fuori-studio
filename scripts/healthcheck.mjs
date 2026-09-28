import { request } from 'node:http';
const port = Number(process.env.PORT || 4386);
const host = process.env.FUORI_STUDIO_MODE && process.env.FUORI_STUDIO_MODE !== 'local'
  ? new URL(process.env.FUORI_STUDIO_PUBLIC_URL).host : `127.0.0.1:${port}`;
const req = request({ hostname: '127.0.0.1', port, path: '/healthz', headers: { Host: host }, timeout: 5000 }, response => {
  let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; if (body.length > 1024) req.destroy(); });
  response.on('end', () => { try { process.exitCode = response.statusCode === 200 && JSON.parse(body).ok === true ? 0 : 1; } catch { process.exitCode = 1; } });
});
req.on('timeout', () => req.destroy()); req.on('error', () => { process.exitCode = 1; }); req.end();
