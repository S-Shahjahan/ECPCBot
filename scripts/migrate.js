import { readConfig } from '../server/config.js';
import { createDatabase } from '../server/db.js';
const db = await createDatabase(readConfig());
await db.migrate();
await db.close();
console.log('Database schema is up to date.');
