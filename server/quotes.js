import * as XLSX from 'xlsx';
import { createHash } from 'node:crypto';

export const sourceHash = (text) =>
  createHash('sha256').update(text).digest('hex');
const normal = (value) =>
  String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
const aliases = {
  product: ['productname', 'product', 'item', 'service'],
  quantity: ['qty', 'quantity'],
  side: ['side', 'sides'],
  size: ['size', 'papersize'],
  gsm: ['papergsm', 'gsm', 'paperweight'],
  price: ['price', 'amount', 'totalprice'],
};
const field = (key) =>
  Object.keys(aliases).find((name) => aliases[name].includes(normal(key)));
function rowRecord(values, source) {
  const row = Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      field(key),
      String(value).trim(),
    ]),
  );
  if (!Object.keys(aliases).every((key) => row[key])) return null;
  const quantity = Number(row.quantity.replaceAll(',', '')),
    gsm = Number(row.gsm.replace(/\s*gsm/i, '')),
    price = Number(row.price.replace(/[₹, ]|Rs\.?|INR/gi, ''));
  const side = /double|both|2/i.test(row.side)
    ? 'double'
    : /single|1/i.test(row.side)
      ? 'single'
      : '';
  if (!quantity || !gsm || !side || !Number.isFinite(price) || price < 0)
    return null;
  return {
    product: row.product,
    quantity,
    gsm,
    price,
    side,
    size: row.size.toUpperCase(),
    sourceId: source.id,
    sourceHash: source.fingerprint,
  };
}
export function priceRows(sources) {
  const rows = [];
  for (const input of sources) {
    const source = { ...input, fingerprint: sourceHash(input.content) };
    const content = source.content;
    if (/^(?:\uFEFF)?[^\n]*product[^\n]*price/i.test(content)) {
      try {
        const book = XLSX.read(content, { type: 'string', raw: true });
        for (const name of book.SheetNames)
          for (const values of XLSX.utils.sheet_to_json(book.Sheets[name], {
            raw: false,
          })) {
            const row = rowRecord(values, source);
            if (row) rows.push(row);
          }
      } catch {
        /* Other documents remain available through text retrieval. */
      }
    } else {
      // Excel imports preserve headings on every row, across every worksheet.
      for (const line of content.split('\n')) {
        const values = Object.fromEntries(
          line.split('; ').map((cell) => {
            const at = cell.indexOf(':');
            return at < 0
              ? ['', '']
              : [cell.slice(0, at), cell.slice(at + 1).trim()];
          }),
        );
        const row = rowRecord(values, source);
        if (row) rows.push(row);
      }
    }
  }
  return rows;
}
export const emailIntent = (text) =>
  ((/\b(?:send|share)\b/i.test(text) &&
    /\b(?:email|e-mail|mail)\b|[^\s@]+@[^\s@]+\.[^\s@]+/i.test(text)) ||
    /\b(?:email|e-mail|mail)\s+(?:me|it|the|a|our|this|my)\b/i.test(text)) &&
  !/\b(?:don'?t|do not|no|stop|cancel)\b/i.test(text);
export function emailRequested(messages) {
  const users = messages.filter((m) => m.role === 'user');
  const last = users.at(-1)?.content || '';
  return (
    emailIntent(last) ||
    (/^[^\s@]+@[^\s@]+\.[^\s@]+[.!]?$/.test(last.trim()) &&
      users.slice(-3, -1).some((m) => emailIntent(m.content)))
  );
}
export function catalogQuote(rows, messages) {
  if (!rows.length) return null;
  const users = messages.filter((m) => m.role === 'user').map((m) => m.content);
  const last = users.at(-1) || '';
  const products = [...new Set(rows.map((r) => r.product))];
  let chosen = {},
    priceRequested = false;
  for (const raw of users) {
    const text = raw
      .toLowerCase()
      .replace(/(?<=\d),(?=\d{3}\b)/g, '')
      .replace(/\b(\d+)k\b/g, (_, n) => String(Number(n) * 1000));
    const product = products.find((p) =>
      new RegExp(
        '\\b' +
          p
            .toLowerCase()
            .replace(/s$/, '')
            .replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
          's?\\b',
      ).test(text),
    );
    if (product && product !== chosen.product) {
      chosen = { product };
      priceRequested = false;
    }
    if (
      !product &&
      /\b(?:price|quote|cost|rate)\s+(?:of|for)\s+(?!a\d\b|it\b|that\b|this\b|the same\b)[a-z]+/i.test(
        text,
      )
    ) {
      chosen = {};
      priceRequested = false;
    }
    const namedPrice = text.match(
      /\b([a-z][a-z-]*)\s+(?:price|pricing|cost)\b/i,
    );
    if (
      !product &&
      namedPrice &&
      ![
        'the',
        'a',
        'its',
        'that',
        'this',
        'your',
        'my',
        'same',
        'final',
        'total',
        'unit',
        'best',
        'printing',
      ].includes(namedPrice[1])
    ) {
      chosen = {};
      priceRequested = false;
    }
    if (!chosen.product) continue;
    if (/\b(?:price|quote|cost|rate|how much)\b/i.test(text))
      priceRequested = true;
    const options = rows.filter((r) => r.product === chosen.product);
    const size = [...new Set(options.map((r) => r.size))].filter((value) =>
      new RegExp(
        '\\b' + value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b',
        'i',
      ).test(text),
    );
    if (size.length === 1) chosen.size = size[0];
    else if (size.length > 1) delete chosen.size;
    const anySize = text.match(/\ba\d\b/gi);
    if (anySize && !size.length) chosen.size = anySize.at(-1).toUpperCase();
    if (/\b(?:double|both|two)[ -]*(?:sides?|sided?)\b/i.test(text))
      chosen.side = 'double';
    else if (/\bsingle[ -]*(?:sides?|sided?)\b/i.test(text))
      chosen.side = 'single';
    const qty = text.match(
      /\b(?:qty|quantity)\s*[:=]?\s*(\d+)\b|\b(\d+)\s*(?:copies|pieces|pcs)\b|^\s*(\d+)\b/i,
    );
    if (qty) chosen.quantity = Number(qty[1] || qty[2] || qty[3]);
    if (
      /^\s*\d+\s*$/.test(text) &&
      !options.some((r) => r.gsm === Number(text))
    )
      chosen.quantity = Number(text);
    const explicitGsm = text.match(/\b(\d+)\s*gsm\b/);
    if (explicitGsm) chosen.gsm = Number(explicitGsm[1]);
    else
      for (const n of [...new Set(options.map((r) => r.gsm))])
        if (new RegExp('(?:^|[,;]\\s*)' + n + '(?:[,.!?]|$)').test(text.trim()))
          chosen.gsm = n;
    if (/\b(?:not|haven'?t|didn'?t|did not)\b/.test(text) && size.length)
      delete chosen.size;
  }
  if (!chosen.product || !priceRequested) return null;
  const lastIsRelevant =
    /\b(price|quote|cost|rate|how much|a\d|qty|quantity|copies|gsm|sides?|sided|mail|email)\b|^\s*\d[\d, ]*/i.test(
      last,
    );
  if (!lastIsRelevant && !emailRequested(messages)) return null;
  for (const [key, question] of [
    ['size', 'What size would you like'],
    ['quantity', 'How many would you like'],
    ['side', 'Would you like single-sided or double-sided printing'],
    ['gsm', 'Which paper weight (GSM) would you like'],
  ]) {
    if (!chosen[key])
      return {
        text: `${question} for the ${chosen.product.toLowerCase()}?`,
        incomplete: true,
      };
  }
  const matching = rows.filter((r) =>
    ['product', 'size', 'quantity', 'side', 'gsm'].every(
      (key) => r[key] === chosen[key],
    ),
  );
  if (!matching.length || new Set(matching.map((r) => r.price)).size > 1)
    return {
      text: 'I don’t have a confirmed price for those exact specifications. Our team can provide a quote. [NEEDS_HUMAN]',
      incomplete: true,
    };
  const quote = { ...matching[0] };
  quote.summary = `${quote.quantity.toLocaleString('en-IN')} ${quote.product.toLowerCase()}, ${quote.size}, ${quote.side}-sided, ${quote.gsm} GSM: ₹${quote.price.toLocaleString('en-IN')}.`;
  return { text: quote.summary, quote };
}
export async function quoteForMessages(db, clientId, messages) {
  const sources = await db.all(
    "SELECT id,content FROM knowledge_sources WHERE client_id=$1 AND approved AND (content ILIKE '%price%' OR content ILIKE '%amount%')",
    [clientId],
  );
  return catalogQuote(priceRows(sources), messages);
}
