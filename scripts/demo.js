import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
await mkdir('.local', { recursive: true });
let keys;
try {
  keys = JSON.parse(await readFile('.local/demo-keys.json', 'utf8'));
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
  keys = {
    ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    SESSION_SECRET: randomBytes(32).toString('hex'),
    WEBHOOK_VERIFY_TOKEN: randomBytes(24).toString('hex'),
  };
  await writeFile('.local/demo-keys.json', JSON.stringify(keys), {
    mode: 0o600,
  });
}
Object.assign(process.env, keys, {
  DEMO_MODE: 'true',
  NODE_ENV: 'development',
  APP_URL: `http://localhost:${process.env.PORT || 3000}`,
});
await import('../server/index.js');
