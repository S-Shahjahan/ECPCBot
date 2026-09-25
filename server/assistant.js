import { retrieveKnowledge } from './knowledge.js';
import { actionInstructions, actionTools } from './google.js';
import { quoteForMessages, emailRequested } from './quotes.js';
import { fixedReply } from './reply-policy.js';

// Both the playground and WhatsApp build the same prompt and enforce the same rules.
export async function assistantReply({
  db,
  client,
  box,
  config,
  messages,
  generate,
}) {
  const fixed = fixedReply(messages);
  if (fixed) return { text: fixed, tokens: 0, cost: 0 };
  const quote = await quoteForMessages(db, client.id, messages);
  if (quote && (!emailRequested(messages) || quote.incomplete))
    return { ...quote, tokens: 0, cost: 0 };
  if (quote?.quote && emailRequested(messages)) {
    const enabled = (await actionTools(db, client.id)).some(
      (t) => t.name === 'prepare_email',
    );
    if (!enabled)
      return {
        text: 'Email is currently unavailable. Our team can help send your quotation. [NEEDS_HUMAN]',
        tokens: 0,
        cost: 0,
      };
    const address = messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content)
      .join('\n')
      .match(/[A-Z0-9.!#$%&'+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)
      ?.at(-1);
    return {
      text: address
        ? ''
        : 'What email address should I send your quotation to?',
      ...(address
        ? {
            proposedAction: {
              name: 'prepare_email',
              arguments: { email: address },
            },
          }
        : {}),
      verifiedQuote: quote.quote,
      tokens: 0,
      cost: 0,
    };
  }
  const master = await db.one(
    "SELECT value FROM settings WHERE id='master_prompt'",
  );
  const result = await generate({
    client,
    box,
    masterPrompt: master.value.text,
    knowledge: await retrieveKnowledge(
      db,
      client.id,
      messages
        .filter((m) => m.role === 'user')
        .slice(-6)
        .map((m) => m.content)
        .join(' '),
    ),
    actionGuide: await actionInstructions(db, client.id),
    actionTools: await actionTools(db, client.id),
    messages,
    demo: config.demo,
    verifyReply: true,
  });
  return { ...result, verifiedQuote: quote?.quote };
}
