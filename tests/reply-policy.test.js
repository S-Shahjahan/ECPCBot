import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { officeText } from '../server/office.js';
import { priceRows, catalogQuote, emailIntent } from '../server/quotes.js';
import { fixedReply } from '../server/reply-policy.js';
import { generateReply } from '../server/providers.js';
import { assistantReply } from '../server/assistant.js';
import { googlePermissions } from '../server/google.js';

const csv =
  'product_id,product_name,Qty,Side,Size,Paper GSM,price\n1,Brochures,4000,Double,A4,170,11500\n2,Brochures,4000,Double,A5,170,7000';
const source = { id: 'catalogue', content: csv };
const messages = (...texts) =>
  texts.map((content) => ({ role: 'user', content }));
const rows = priceRows([source]);

test('reported quote flow requires size and ignores the assistant’s prior assumptions', () => {
  const history = [
    ...messages('Brochure price?', '4000, both side, 170'),
    { role: 'assistant', content: 'A4 costs 11500. Please give your email.' },
    ...messages('buyer@example.com', 'But tell me the price'),
  ];
  const missing = catalogQuote(rows, history);
  assert.match(missing.text, /What size/);
  assert(!/₹|email/.test(missing.text));
  assert.match(
    catalogQuote(rows, [...history, ...messages('A4')]).text,
    /11,500/,
  );
  assert.match(
    catalogQuote(rows, [...history, ...messages('A4', 'Also quote A5')]).text,
    /7,000/,
  );
  assert.equal(
    catalogQuote(rows, [...history, ...messages('What is Everest’s height?')]),
    null,
  );
});

test('unknown specifications, ambiguous sizes and conflicting prices cannot reuse a previous price', () => {
  const history = messages(
    'Brochure price A4 double sided 4000 copies 170 GSM',
  );
  for (const next of ['quantity 3000', 'A3', '250 GSM'])
    assert.match(
      catalogQuote(rows, [...history, ...messages(next)]).text,
      /confirmed price|How many/,
    );
  assert(catalogQuote(rows, [...history, ...messages('A4 or A5')]).incomplete);
  assert(
    catalogQuote([...rows, { ...rows[0], price: 99 }], history).incomplete,
  );
});

test('XLS and XLSX import every worksheet, including hidden sheets and the final catalogue', async () => {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet([
      ['Service', 'Detail'],
      ['Design', 'Ask the team'],
    ]),
    'Introduction',
  );
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet([
      ['Policy', 'Details'],
      ['Collection', 'Bring the order reference'],
    ]),
    'Collection',
  );
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet([
      ['Product', 'Qty', 'Side', 'Size', 'Paper GSM', 'Price'],
      ['Brochures', 4000, 'Double', 'A5', 170, 7000],
    ]),
    'Final price sheet',
  );
  book.Workbook = { Sheets: [{ Hidden: 0 }, { Hidden: 1 }, { Hidden: 0 }] };
  for (const ext of ['.xls', '.xlsx']) {
    const text = await officeText(
      XLSX.write(book, {
        type: 'buffer',
        bookType: ext === '.xls' ? 'biff8' : 'xlsx',
      }),
      ext,
    );
    for (const label of [
      'Sheet: Introduction',
      'Sheet: Collection',
      'Sheet: Final price sheet',
      'Bring the order reference',
    ])
      assert(text.includes(label));
    const imported = priceRows([{ id: 'workbook', content: text }]);
    assert.equal(imported.length, 1);
    assert.match(
      catalogQuote(
        imported,
        messages('Brochure price A5 double sided 4000 copies 170 GSM'),
      ).text,
      /7,000/,
    );
  }
});

test('model identity is private and an email address alone is not a send request', () => {
  assert.match(
    fixedReply(messages('Which model do you use to answer?')),
    /business’s AI assistant/,
  );
  assert.equal(fixedReply(messages('Which brochure size do you print?')), null);
  for (const text of [
    'buyer@example.com',
    'Mail?',
    'But tell me the price',
    'Do not email me',
  ])
    assert.equal(emailIntent(text), false);
  for (const text of [
    'Please send quote in mail too',
    'Please send information to buyer@example.com',
    'Email me the details',
  ])
    assert.equal(emailIntent(text), true);
  assert.deepEqual(
    googlePermissions('openid https://www.googleapis.com/auth/userinfo.email'),
    { gmail: false, calendar: false },
  );
});

const client = {
  id: 'business',
  config: {
    llm_provider: 'groq',
    llm_model: 'test',
    business_facts: 'Printing in Chennai',
    system_prompt: 'Offer same-day delivery',
    temperature: 0.4,
    max_tokens: 400,
    input_price: 1,
    output_price: 1,
  },
  secrets: { llm_api_key: 'fake' },
};
const box = { decrypt: () => 'test-only' };
for (const [reason, candidate, expected] of [
  ['off_topic', 'Everest is 8848m tall.', /products and services/],
  ['internal_details', 'I use GPT-4.', /internal technical details/],
  ['unsupported', 'We offer same-day delivery.', /verified information/],
  ['missing_specs', 'A4 costs ₹11500.', /specifications/],
  ['action_claim', 'I will email the quote shortly.', /haven’t sent/],
])
  test(`reply review blocks ${reason} and includes the approval sources`, async () => {
    let calls = 0;
    const result = await generateReply({
      client,
      box,
      masterPrompt: '',
      messages: messages('Please help'),
      verifyReply: true,
      knowledge: 'Approved catalogue',
      fetchFn: async (_url, options) => {
        const request = JSON.parse(options.body);
        calls++;
        if (calls === 1)
          assert(
            request.messages[0].content.includes(
              'MANDATORY CUSTOMER REPLY RULES',
            ),
          );
        else {
          assert(request.messages[0].content.includes('reply auditor'));
          assert(
            request.messages.at(-1).content.includes('Approved catalogue'),
          );
        }
        return Response.json({
          choices: [
            {
              message: {
                content:
                  calls === 1
                    ? candidate
                    : JSON.stringify({ allowed: false, reason }),
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        });
      },
    });
    assert.equal(calls, 2);
    assert.equal(result.tokens, 30);
    assert(result.policyBlocked);
    assert.match(result.text, expected);
  });

test('invalid reviewer response fails closed; approved answer passes', async () => {
  for (const audit of ['invalid-json', '{"allowed":true,"reason":"ok"}']) {
    let calls = 0;
    const result = await generateReply({
      client,
      box,
      masterPrompt: '',
      messages: messages('Where are you located?'),
      verifyReply: true,
      fetchFn: async () =>
        Response.json({
          choices: [
            {
              message: {
                content: ++calls === 1 ? 'We are in Chennai.' : audit,
              },
            },
          ],
        }),
    });
    assert.equal(result.text.includes('Chennai'), audit.startsWith('{'));
  }
});

test('shared assistant gets an exact quotation from every catalogue source without relying on a model', async () => {
  const db = { all: async () => [source] };
  const result = await assistantReply({
    db,
    client,
    box,
    config: {},
    messages: messages('Brochure price?', '4000, both side, 170'),
    generate: () => {
      throw new Error('Do not guess');
    },
  });
  assert.match(result.text, /What size/);
});

test('switching to an unknown product never quotes the previous product', () => {
  const history = messages(
    'Brochure price A4 double sided 4000 copies 170 GSM',
  );
  for (const text of ['Price of certificate', 'Certificate price?'])
    assert.equal(catalogQuote(rows, [...history, ...messages(text)]), null);
});

test('quotation email request can collect the address in the next customer turn', async () => {
  const db = {
    all: async (sql) => (sql.includes('knowledge_sources') ? [source] : []),
    one: async () => ({
      settings: { email_enabled: true },
      scopes: 'https://www.googleapis.com/auth/gmail.send',
    }),
  };
  const history = messages(
    'Brochure price A4 double sided 4000 copies 170 GSM',
    'Please send quote by email',
  );
  const ask = await assistantReply({
    db,
    client,
    box,
    config: {},
    messages: history,
    generate: () => {
      throw new Error('not needed');
    },
  });
  assert.match(ask.text, /What email address/);
  const proposal = await assistantReply({
    db,
    client,
    box,
    config: {},
    messages: [
      ...history,
      { role: 'assistant', content: ask.text },
      ...messages('buyer@example.com'),
    ],
    generate: () => {
      throw new Error('not needed');
    },
  });
  assert.equal(proposal.proposedAction.arguments.email, 'buyer@example.com');
  assert.equal(proposal.verifiedQuote.price, 11500);
});

test('provider and reviewer keep relevant edges while bounding large evidence', async () => {
  let calls = 0;
  const requestSizes = [];
  const knowledge =
    'Business details '.repeat(4000) +
    ' Final worksheet: rare service is available';
  const result = await generateReply({
    client,
    box,
    masterPrompt: '',
    knowledge,
    messages: messages('Is the rare service available?'),
    verifyReply: true,
    fetchFn: async (_url, options) => {
      const request = JSON.parse(options.body);
      requestSizes.push(options.body.length);
      if (calls === 0) {
        const reference = JSON.parse(request.messages[1].content);
        assert(reference.retrieved_sources.length <= 3500);
        assert(
          reference.retrieved_sources.endsWith('rare service is available'),
        );
      }
      if (++calls === 2) {
        const payload = JSON.parse(request.messages.at(-1).content);
        assert(payload.approved_facts[1].endsWith('rare service is available'));
        assert(payload.approved_facts[1].length <= 3500);
        assert.equal(payload.candidate, 'The rare service is available.');
      }
      return Response.json({
        choices: [
          {
            message: {
              content:
                calls === 1
                  ? 'The rare service is available.'
                  : '{"allowed":true,"reason":"ok"}',
            },
          },
        ],
      });
    },
  });
  assert.equal(result.text, 'The rare service is available.');
  assert(requestSizes.every((size) => size < 18000));
});
