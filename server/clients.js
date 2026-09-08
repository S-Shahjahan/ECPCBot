import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { MASTER_PROMPT } from './prompts.js';
const schema = z.object({
  client_name: z.string().trim().min(2).max(120),
  phone_number_id: z.string().regex(/^\d{5,30}$/),
  waba_id: z.string().max(40).default(''),
  llm_provider: z
    .enum(['openai', 'gemini', 'deepseek', 'glm'])
    .default('gemini'),
  llm_model: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(
      /^\S+$/,
      'Enter the exact API model ID without spaces, for example gemini-3.1-flash-lite.',
    ),
  system_prompt: z.string().max(30000).default(''),
  business_facts: z.string().max(40000).default(''),
  use_master_prompt: z.boolean().default(true),
  welcome_message: z.string().max(1000).default(''),
  fallback_message: z
    .string()
    .min(1)
    .max(1000)
    .default(
      'Sorry, I could not answer just now. Please try again shortly or contact our team.',
    ),
  handoff_number: z
    .string()
    .regex(/^\+?[0-9]{7,15}$|^$/)
    .default(''),
  handoff_enabled: z.boolean().default(true),
  temperature: z.number().min(0).max(1.5).default(0.4),
  max_tokens: z.number().int().min(64).max(2000).default(400),
  input_price: z.number().min(0).max(1000).default(0),
  output_price: z.number().min(0).max(1000).default(0),
  is_active: z.boolean().default(false),
  onboarding: z.array(z.string().max(100)).max(20).default([]),
  whatsapp_access_token: z.string().max(4000).optional(),
  llm_api_key: z.string().max(4000).optional(),
  meta_app_secret: z.string().max(4000).optional(),
  change_reason: z.string().max(500).default('Profile updated'),
});
export function publicClient(row) {
  if (!row) return null;
  const { secrets, config, ...rest } = row;
  return {
    ...rest,
    ...config,
    has_whatsapp_access_token: Boolean(secrets.whatsapp_access_token),
    has_llm_api_key: Boolean(secrets.llm_api_key),
    has_meta_app_secret: Boolean(secrets.meta_app_secret),
  };
}
export async function saveClient(db, box, input, id, config) {
  const data = schema.parse(input);
  const old = id
    ? await db.one('SELECT * FROM clients WHERE id=$1', [id])
    : null;
  if (id && !old)
    throw Object.assign(new Error('Client not found.'), { status: 404 });
  const secrets = { ...(old?.secrets || {}) };
  for (const key of [
    'whatsapp_access_token',
    'llm_api_key',
    'meta_app_secret',
  ]) {
    if (data[key]?.trim()) secrets[key] = box.encrypt(data[key].trim());
    delete data[key];
  }
  if (
    data.is_active &&
    !config.demo &&
    (!secrets.whatsapp_access_token ||
      !secrets.llm_api_key ||
      !(secrets.meta_app_secret || config.metaSecret))
  )
    throw Object.assign(
      new Error(
        'Add WhatsApp credentials, an AI key and a Meta app secret before activating.',
      ),
      { status: 400 },
    );
  const { client_name, phone_number_id, is_active, change_reason, ...profile } =
    data;
  id ||= randomUUID();
  const row = await db.one(
    `INSERT INTO clients(id,client_name,phone_number_id,is_active,config,secrets) VALUES($1,$2,$3,$4,$5,$6)
 ON CONFLICT(id) DO UPDATE SET client_name=$2,phone_number_id=$3,is_active=$4,config=$5,secrets=$6,updated_at=now() RETURNING *`,
    [
      id,
      client_name,
      phone_number_id,
      is_active,
      JSON.stringify(profile),
      JSON.stringify(secrets),
    ],
  );
  if (
    !old ||
    old.config.system_prompt !== profile.system_prompt ||
    old.config.business_facts !== profile.business_facts ||
    old.config.use_master_prompt !== profile.use_master_prompt
  )
    await db.query(
      'INSERT INTO prompt_history(id,client_id,prompt,facts,reason) VALUES($1,$2,$3,$4,$5)',
      [
        randomUUID(),
        id,
        profile.use_master_prompt
          ? '[Shared master rules]\n' + profile.system_prompt
          : profile.system_prompt,
        profile.business_facts,
        change_reason,
      ],
    );
  return publicClient(row);
}
export async function initSettings(db) {
  await db.query(
    'INSERT INTO settings(id,value) VALUES($1,$2) ON CONFLICT DO NOTHING',
    ['master_prompt', JSON.stringify({ text: MASTER_PROMPT })],
  );
}
