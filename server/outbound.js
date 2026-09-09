import https from 'node:https';
import dns from 'node:dns/promises';
import ipaddr from 'ipaddr.js';

export const badRequest = (message) =>
  Object.assign(new Error(message), { status: 400 });
export function publicAddress(address) {
  try {
    return ipaddr.process(address).range() === 'unicast';
  } catch {
    return false;
  }
}
export function externalUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw badRequest('Enter a valid public HTTPS URL.');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    url.hash ||
    url.hostname === 'localhost'
  )
    throw badRequest(
      'Use a public HTTPS URL without credentials, fragments or custom ports.',
    );
  return url;
}
// Resolve and pin the connection to a public IP. Redirects never receive credentials.
export async function publicFetch(value, options = {}) {
  const url = externalUrl(value);
  const addresses = await dns.lookup(url.hostname.replace(/^\[|\]$/g, ''), {
    all: true,
  });
  if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
    throw badRequest('Private and reserved network addresses are not allowed.');
  const address = addresses[0];
  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: options.method || 'GET',
        headers: options.headers,
        lookup: (_host, opts, cb) =>
          opts.all
            ? cb(null, [address])
            : cb(null, address.address, address.family),
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > (options.limit || 2_000_000))
            request.destroy(badRequest('The remote response is too large.'));
          else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          const body = Buffer.concat(chunks);
          try {
            resolve(
              new Response(
                [204, 205, 304].includes(response.statusCode) ? null : body,
                {
                  status: response.statusCode,
                  headers: response.headers,
                },
              ),
            );
          } catch {
            reject(
              badRequest('The remote server returned an invalid response.'),
            );
          }
        });
      },
    );
    const timeout = setTimeout(
      () =>
        request.destroy(
          badRequest('The remote server took too long to respond.'),
        ),
      25000,
    );
    request.on('error', reject);
    request.on('close', () => clearTimeout(timeout));
    if (options.body) request.write(options.body);
    request.end();
  });
}
