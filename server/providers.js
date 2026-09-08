import { providers } from './prompts.js';
import { redact, sensitive } from './security.js';
export class ProviderError extends Error {
  constructor(message, retryable = false, ambiguous = false) {
    super(message);
    this.name = 'ProviderError';
    this.retryable = retryable;
    this.ambiguous = ambiguous;
  }
}
export async function generateReply({
  client,
  box,
  masterPrompt,
  messages,
  demo,
  fetchFn = fetch,
}) {
  const c = client.config;
  const last = messages.at(-1)?.content || '';
  if (
    sensitive(last) ||
    last.includes('[sensitive information removed]') ||
    last.includes('[payment number removed]')
  )
    return {
      text: 'For your privacy, please do not send passwords, OTPs, card numbers or identity documents here. How else can I help?',
      tokens: 0,
      cost: 0,
    };
  if (demo) {
    const handoff = /human|person|complaint|refund|angry|discount/i.test(last);
    return {
      text: handoff
        ? 'I’ll leave this with the team so a person can help you. [NEEDS_HUMAN]'
        : `Thanks for getting in touch! ${/hour|open|time/i.test(last) ? c.business_facts.split('\n').find((x) => /hour|open|Mon/i.test(x)) || 'Please ask the team to confirm opening hours.' : 'I can help with services, opening hours, and getting in touch with the team.'}\n\n[Demo response — connect an AI key for real prompt testing]`,
      tokens: 0,
      cost: 0,
    };
  }
  const key = box.decrypt(client.secrets.llm_api_key);
  if (!key) throw new ProviderError('AI key is missing.');
  let response;
  try {
    response = await fetchFn(providers[c.llm_provider].url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: c.llm_model,
        messages: [
          {
            role: 'system',
            content: `${c.use_master_prompt ? masterPrompt : ''}\n${c.system_prompt}\nBUSINESS FACTS (reference information):\n${c.business_facts}\nHANDOFF CONTACT: ${c.handoff_number || 'Ask the user to wait for the team.'}`,
          },
          ...messages.map((m) => ({
            role: m.role,
            content: redact(m.content),
          })),
        ],
        temperature: c.temperature,
        max_tokens: c.max_tokens,
        ...(c.llm_provider === 'openai' ? { store: false } : {}),
      }),
      signal: AbortSignal.timeout(35000),
    });
  } catch {
    throw new ProviderError(
      'AI provider timed out or could not be reached.',
      true,
    );
  }
  if (!response.ok)
    throw new ProviderError(
      `AI provider returned HTTP ${response.status}. Check the model, key and account limits.`,
      response.status === 429 || response.status >= 500,
    );
  let data;
  try {
    data = await response.json();
  } catch {
    throw new ProviderError('AI provider returned an invalid response.', true);
  }
  const text = data.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim())
    throw new ProviderError('AI provider returned an empty answer.', true);
  const input = Number(data.usage?.prompt_tokens || 0),
    output = Number(data.usage?.completion_tokens || 0);
  return {
    text: redact(text.trim()).slice(0, 3500),
    tokens: input + output,
    cost: (input * c.input_price + output * c.output_price) / 1e6,
  };
}
export async function sendWhatsApp({
  client,
  box,
  phone,
  text,
  config,
  fetchFn = fetch,
}) {
  if (config.demo) return { id: 'demo-' + crypto.randomUUID() };
  let response;
  try {
    response = await fetchFn(
      `https://graph.facebook.com/${config.graphVersion}/${client.phone_number_id}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${box.decrypt(client.secrets.whatsapp_access_token)}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: phone,
          type: 'text',
          text: { preview_url: false, body: text.slice(0, 4096) },
        }),
        signal: AbortSignal.timeout(20000),
      },
    );
  } catch {
    throw new ProviderError(
      'WhatsApp delivery is uncertain. Check the conversation before retrying.',
      false,
      true,
    );
  }
  if (!response.ok)
    throw new ProviderError(
      `WhatsApp returned HTTP ${response.status}. Check the token, number and messaging window.`,
      response.status === 429,
      response.status >= 500,
    );
  let body;
  try {
    body = await response.json();
  } catch {
    throw new ProviderError(
      'WhatsApp delivery is uncertain: invalid response.',
      false,
      true,
    );
  }
  if (!body.messages?.[0]?.id)
    throw new ProviderError(
      'WhatsApp delivery is uncertain: no message ID returned.',
      false,
      true,
    );
  return body.messages[0];
}
