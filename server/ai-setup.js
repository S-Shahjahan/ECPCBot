import { z } from 'zod';
import { providers } from './prompts.js';
import { externalUrl, publicFetch, badRequest } from './outbound.js';
import { randomUUID } from 'node:crypto';

export const effectiveBase = (provider, base) =>
  (base || providers[provider]?.baseUrl || '').replace(/\/+$/, '');

export function mountAISetup(app, { db, box, config, generate, limiter }) {
  async function draft(body) {
    const input = z
      .object({
        client_id: z.string().nullable().optional(),
        provider: z.enum(Object.keys(providers)),
        base_url: z.string().max(500).default(''),
        api_key: z.string().max(4000).default(''),
        model: z.string().max(200).default(''),
      })
      .parse(body);
    const base = effectiveBase(input.provider, input.base_url),
      url = externalUrl(base);
    if (url.search)
      throw badRequest('Base URL must not contain query parameters.');
    const old = input.client_id
      ? await db.one('SELECT * FROM clients WHERE id=$1', [input.client_id])
      : null;
    if (input.client_id && !old) throw badRequest('Client not found.');
    let encrypted = input.api_key.trim()
      ? box.encrypt(input.api_key.trim())
      : null;
    if (
      !encrypted &&
      old?.config.llm_provider === input.provider &&
      effectiveBase(old.config.llm_provider, old.config.llm_base_url) === base
    )
      encrypted = old.secrets.llm_api_key;
    if (!encrypted && !config.demo)
      throw badRequest('Enter an API key for this provider and base URL.');
    return {
      id: old?.id,
      secrets: { llm_api_key: encrypted },
      config: {
        ...old?.config,
        llm_provider: input.provider,
        llm_base_url: base,
        llm_model: input.model,
        system_prompt: 'Answer connection tests briefly.',
        business_facts: '',
        use_master_prompt: false,
        max_tokens: 256,
        temperature: 0.2,
        input_price: old?.config.input_price || 0,
        output_price: old?.config.output_price || 0,
      },
    };
  }
  app.post('/api/ai/models', limiter, async (req, res) => {
    const row = await draft(req.body),
      p = providers[row.config.llm_provider];
    if (config.demo)
      return res.json({ models: [p.model].filter(Boolean), demo: true });
    const key = box.decrypt(row.secrets.llm_api_key);
    const response = await publicFetch(row.config.llm_base_url + '/models', {
      headers:
        row.config.llm_provider === 'anthropic'
          ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
          : { Authorization: `Bearer ${key}` },
    });
    if (!response.ok)
      throw badRequest(
        `Model discovery returned HTTP ${response.status}. Check the URL and key, or enter a model ID manually.`,
      );
    const data = await response.json();
    const models = [
      ...new Set(
        (data.data || [])
          .map((m) => m.id)
          .filter((id) => typeof id === 'string' && id.length < 200),
      ),
    ].sort();
    if (!models.length)
      throw badRequest(
        'No model list was returned. Enter your model ID manually, then test it.',
      );
    res.json({ models });
  });
  app.post('/api/ai/test', limiter, async (req, res) => {
    const row = await draft(req.body);
    if (!row.config.llm_model || /\s/.test(row.config.llm_model))
      throw badRequest('Select or enter an exact model ID first.');
    const result = await generate({
      client: row,
      box,
      masterPrompt: '',
      messages: [
        { role: 'user', content: 'Reply with: Connection successful.' },
      ],
      demo: config.demo,
    });
    if (row.id)
      await db.query(
        'INSERT INTO llm_usage(id,client_id,source,tokens,cost) VALUES($1,$2,$3,$4,$5)',
        [randomUUID(), row.id, 'connection-test', result.tokens, result.cost],
      );
    res.json({
      message: config.demo
        ? 'Demo only: no provider request was made.'
        : 'API and selected model are working. Save to apply this configuration.',
      demo: config.demo,
    });
  });
}
