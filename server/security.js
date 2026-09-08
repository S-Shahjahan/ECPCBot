import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHmac,
  timingSafeEqual,
  scryptSync,
} from 'node:crypto';
export function secretBox(hexKey) {
  const key = Buffer.from(hexKey, 'hex');
  return {
    encrypt(value) {
      if (!value) return '';
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', key, iv);
      const bytes = Buffer.concat([c.update(value, 'utf8'), c.final()]);
      return [iv, c.getAuthTag(), bytes]
        .map((b) => b.toString('base64url'))
        .join('.');
    },
    decrypt(value) {
      if (!value) return '';
      const [iv, tag, bytes] = value
        .split('.')
        .map((x) => Buffer.from(x, 'base64url'));
      const d = createDecipheriv('aes-256-gcm', key, iv);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(bytes), d.final()]).toString('utf8');
    },
    phoneHash(value) {
      return createHmac('sha256', key).update(value).digest('hex');
    },
  };
}
export function safeEqual(a, b) {
  const x = Buffer.from(a || '');
  const y = Buffer.from(b || '');
  return x.length === y.length && timingSafeEqual(x, y);
}
export function verifySignature(raw, signature, secret) {
  return Boolean(
    secret &&
    /^sha256=[a-f0-9]{64}$/.test(signature || '') &&
    safeEqual(
      signature,
      'sha256=' + createHmac('sha256', secret).update(raw).digest('hex'),
    ),
  );
}
export function passwordVerifier(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(
    password || randomBytes(32).toString('hex'),
    salt,
    64,
  );
  return (candidate) =>
    typeof candidate === 'string' &&
    candidate.length <= 256 &&
    timingSafeEqual(scryptSync(candidate, salt, 64), hash);
}
export function redact(text = '') {
  return String(text)
    .replace(/\b(?:\d[ -]*?){13,19}\b/g, '[payment number removed]')
    .replace(
      /\b(?:otp|password|passcode|pin|verification code)\s*(?:is|:|=)?\s*\S+/gi,
      '[sensitive information removed]',
    );
}
export function sensitive(text) {
  return (
    /\b(?:otp|password|passcode|pin|verification code)\s*(?:is|:|=)?\s*\S+/i.test(
      text,
    ) || /\b(?:\d[ -]*?){13,19}\b/.test(text)
  );
}
