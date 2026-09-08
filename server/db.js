import { readFile } from 'node:fs/promises';
import pg from 'pg';
export async function createDatabase(config) {
  let db;
  if (config.demo) {
    const { PGlite } = await import('@electric-sql/pglite');
    db = new PGlite(config.localPath);
    await db.waitReady;
  } else {
    const connectionUrl = new URL(config.databaseUrl);
    // Keep URL query parameters from silently replacing verified TLS settings in pg.
    for (const parameter of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert'])
      connectionUrl.searchParams.delete(parameter);
    db = new pg.Pool({
      connectionString: connectionUrl.toString(),
      ssl: config.databaseSsl
        ? {
            rejectUnauthorized: true,
            ...(config.databaseCa
              ? { ca: config.databaseCa.replace(/\\n/g, '\n') }
              : {}),
          }
        : false,
      max: 8,
      connectionTimeoutMillis: 10000,
      statement_timeout: 15000,
    });
    db.on('error', () =>
      console.error(JSON.stringify({ event: 'database_connection_error' })),
    );
  }
  const query = (sql, args = []) => db.query(sql, args);
  return {
    query,
    async one(sql, args) {
      return (await query(sql, args)).rows[0];
    },
    async all(sql, args) {
      return (await query(sql, args)).rows;
    },
    async migrate() {
      const sql = await readFile(
        new URL('./schema.sql', import.meta.url),
        'utf8',
      );
      if (config.demo) await db.exec(sql);
      else await db.query(sql);
    },
    close: () => (config.demo ? db.close() : db.end()),
  };
}
