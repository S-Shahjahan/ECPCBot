import { randomUUID } from 'node:crypto';
import { saveClient } from './clients.js';
export async function seedDemo(db, box, config) {
  const seeded = await db.one("SELECT id FROM settings WHERE id='demo_seeded'");
  if (seeded) return;
  const names = [
    [
      'Bloom Dental',
      'Healthcare',
      'gemini',
      'gemini-2.5-flash',
      'Hours: Monday–Saturday, 9am–6pm.\nServices: dental checkups, cleaning and cosmetic consultations.\nConsultation: ₹500.\nBooking: ask for a preferred day, then the reception team confirms.\nDo not provide clinical advice.',
    ],
    [
      'The Sunday Studio',
      'Wellness',
      'openai',
      'gpt-4o-mini',
      'Hours: Monday–Sunday, 7am–8pm.\nServices: yoga and pilates.\nTrial class: ₹350.\nBooking: the team confirms availability.',
    ],
    [
      'Oak & Key Realty',
      'Real estate',
      'deepseek',
      'deepseek-chat',
      'Hours: Monday–Friday, 10am–6pm.\nServices: property viewings and rental enquiries.\nDo not invent availability or property prices.',
    ],
  ];
  const clients = [];
  for (let i = 0; i < names.length; i++) {
    const [name, industry, provider, model, facts] = names[i];
    clients.push(
      await saveClient(
        db,
        box,
        {
          client_name: name,
          phone_number_id: '10000000000000' + i,
          llm_provider: provider,
          llm_model: model,
          business_facts: facts,
          system_prompt: `Use a friendly, thoughtful tone for this ${industry.toLowerCase()} business.`,
          is_active: i < 2,
          welcome_message: `Welcome to ${name}.`,
          onboarding: ['business', 'facts', 'review'],
        },
        null,
        config,
      ),
    );
  }
  for (let i = 0; i < 8; i++) {
    const client = clients[i % 3],
      id = randomUUID(),
      phone = '91900000000' + i;
    const when = new Date(Date.now() - i * 3 * 3600000);
    await db.query(
      'INSERT INTO conversations(id,client_id,phone_hash,phone_encrypted,phone_label,status,last_user_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        id,
        client.id,
        box.phoneHash(phone),
        box.encrypt(phone),
        '•••• ' + phone.slice(-4),
        i === 0 ? 'human' : 'bot',
        when,
      ],
    );
    const question =
      i === 0
        ? 'Can someone help me reschedule my appointment?'
        : 'Hi! What time are you open?';
    await db.query(
      "INSERT INTO message_logs(id,client_id,conversation_id,direction,body,status,created_at) VALUES($1,$2,$3,'inbound',$4,'received',$5)",
      [randomUUID(), client.id, id, question, when],
    );
    await db.query(
      "INSERT INTO message_logs(id,client_id,conversation_id,direction,body,status,created_at) VALUES($1,$2,$3,'outbound',$4,'read',$5)",
      [
        randomUUID(),
        client.id,
        id,
        i === 0
          ? 'Of course. I’ll leave this with the reception team to help you reschedule.'
          : client.business_facts.split('\n')[0] + ' How can we help?',
        new Date(when.getTime() + 5000),
      ],
    );
    if (i === 0)
      await db.query(
        "INSERT INTO alerts(id,client_id,conversation_id,kind,message) VALUES($1,$2,$3,'handoff','A customer would like to reschedule. The conversation is waiting for your team.')",
        [randomUUID(), client.id, id],
      );
  }
  await db.query("INSERT INTO settings(id,value) VALUES('demo_seeded','true')");
}
