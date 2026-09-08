export function readConfig(env = process.env) {
  const demo = env.DEMO_MODE === 'true';
  const production = env.NODE_ENV === 'production';
  if (demo && production)
    throw new Error('Demo mode cannot run in production.');
  const config = {
    demo,
    production,
    port: Number(env.PORT || 3000),
    appUrl: env.APP_URL || 'http://localhost:3000',
    databaseUrl: env.DATABASE_URL,
    databaseSsl: env.DATABASE_SSL !== 'false',
    databaseCa: env.DATABASE_CA,
    encryptionKey: env.ENCRYPTION_KEY,
    sessionSecret: env.SESSION_SECRET,
    password: env.ADMIN_PASSWORD,
    verifyToken: env.WEBHOOK_VERIFY_TOKEN,
    metaSecret: env.META_APP_SECRET || '',
    graphVersion: env.META_GRAPH_VERSION || 'v23.0',
    trustProxy: Number(env.TRUST_PROXY || 0),
    localPath: env.LOCAL_DATABASE_PATH || '.local/database',
    smtp: {
      host: env.SMTP_HOST,
      port: Number(env.SMTP_PORT || 587),
      user: env.SMTP_USER,
      pass: env.SMTP_PASSWORD,
      from: env.ALERT_FROM,
      to: env.ALERT_TO,
    },
  };
  if (!/^[a-f0-9]{64}$/i.test(config.encryptionKey || ''))
    throw new Error('ENCRYPTION_KEY must contain 64 hex characters.');
  if ((config.sessionSecret || '').length < 32)
    throw new Error('SESSION_SECRET must contain at least 32 characters.');
  if (!demo) {
    if (!config.databaseUrl)
      throw new Error(
        'DATABASE_URL is required. Use npm run demo for the local demo.',
      );
    if ((config.password || '').length < 16)
      throw new Error('ADMIN_PASSWORD must contain at least 16 characters.');
    if ((config.verifyToken || '').length < 24)
      throw new Error(
        'WEBHOOK_VERIFY_TOKEN must contain at least 24 characters.',
      );
  }
  if (production && !config.appUrl.startsWith('https://'))
    throw new Error('Production APP_URL must use HTTPS.');
  const origin = new URL(config.appUrl);
  if (
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  )
    throw new Error(
      'APP_URL must be an origin without credentials, path or query.',
    );
  config.appUrl = origin.origin;
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535)
    throw new Error('PORT must be a valid TCP port.');
  if (!/^v\d+\.\d+$/.test(config.graphVersion))
    throw new Error('Invalid META_GRAPH_VERSION.');
  if (![0, 1].includes(config.trustProxy))
    throw new Error('TRUST_PROXY must be 0 or 1.');
  return config;
}
