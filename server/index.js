import { readConfig } from './config.js';
import { createDatabase } from './db.js';
import { createApp } from './app.js';
import { initSettings } from './clients.js';
import { createWorker } from './worker.js';
import { createCrawlWorker } from './crawls.js';
import { seedDemo } from './seed.js';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
const config = readConfig();
const db = await createDatabase(config);
await db.migrate();
await initSettings(db);
const { app, box } = createApp({ db, config });
if (config.demo) await seedDemo(db, box, config);
const root = fileURLToPath(new URL('../dist', import.meta.url));
if (!existsSync(root))
  throw new Error('Build the dashboard first with npm run build.');
app.use(
  express.static(root, { index: false, maxAge: config.production ? '1h' : 0 }),
);
app.get('/{*path}', (_req, res) => res.sendFile(root + '/index.html'));
const worker = createWorker({ db, box, config });
const server = app.listen(
  config.port,
  config.demo ? '127.0.0.1' : '0.0.0.0',
  () => {
    console.log(
      `Relay is running at ${config.appUrl}${config.demo ? ' (local demo; no external messages)' : ''}`,
    );
  },
);
worker.start();
const crawler = createCrawlWorker({ db });
crawler.start();
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  await worker.stop();
  await crawler.stop();
  await db.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
