CREATE TABLE IF NOT EXISTS clients (
 id text PRIMARY KEY, client_name text NOT NULL, phone_number_id text NOT NULL UNIQUE,
 config jsonb NOT NULL DEFAULT '{}', secrets jsonb NOT NULL DEFAULT '{}', is_active boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS settings (id text PRIMARY KEY, value jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS prompt_history (
 id text PRIMARY KEY, client_id text REFERENCES clients(id) ON DELETE CASCADE,
 prompt text NOT NULL, facts text NOT NULL DEFAULT '', reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS conversations (
 id text PRIMARY KEY, client_id text NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
 phone_hash text NOT NULL, phone_encrypted text NOT NULL, phone_label text NOT NULL,
 status text NOT NULL DEFAULT 'bot' CHECK(status IN ('bot','human')), last_user_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(client_id, phone_hash)
);
CREATE TABLE IF NOT EXISTS message_logs (
 id text PRIMARY KEY, client_id text NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
 conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 direction text NOT NULL CHECK(direction IN ('inbound','outbound','system')), body text,
 status text NOT NULL, meta_id text, tokens integer NOT NULL DEFAULT 0, cost numeric NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS message_meta_id ON message_logs(meta_id) WHERE meta_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS message_conversation_time ON message_logs(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS message_client_time ON message_logs(client_id, created_at);
CREATE TABLE IF NOT EXISTS delivery_receipts (
 meta_id text PRIMARY KEY, client_id text NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
 conversation_id text REFERENCES conversations(id) ON DELETE CASCADE,
 status text NOT NULL, rank integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS llm_usage (
 id text PRIMARY KEY, client_id text NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
 conversation_id text REFERENCES conversations(id) ON DELETE CASCADE,
 source text NOT NULL, tokens integer NOT NULL, cost numeric NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS usage_client_time ON llm_usage(client_id,created_at);
CREATE TABLE IF NOT EXISTS jobs (
 id text PRIMARY KEY, meta_id text NOT NULL UNIQUE, client_id text NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
 conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, body text,
 message_type text NOT NULL DEFAULT 'text', state text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
 reply text, tokens integer NOT NULL DEFAULT 0, cost numeric NOT NULL DEFAULT 0,
 available_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS job_pending ON jobs(state, available_at, created_at);
CREATE TABLE IF NOT EXISTS alerts (
 id text PRIMARY KEY, client_id text REFERENCES clients(id) ON DELETE CASCADE,
 conversation_id text REFERENCES conversations(id) ON DELETE CASCADE, kind text NOT NULL, message text NOT NULL,
 resolved boolean NOT NULL DEFAULT false, email_state text NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (sid text PRIMARY KEY, data jsonb NOT NULL, expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS worker_lock (id integer PRIMARY KEY, owner text, expires_at timestamptz NOT NULL DEFAULT now());
INSERT INTO worker_lock(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS login_attempts (ip_hash text PRIMARY KEY, count integer NOT NULL DEFAULT 0, expires_at timestamptz NOT NULL);
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
CREATE TABLE IF NOT EXISTS knowledge_sources (
 id text PRIMARY KEY, client_id text NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
 title text NOT NULL, origin text NOT NULL DEFAULT '', content text NOT NULL,
 approved boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS knowledge_client ON knowledge_sources(client_id);
CREATE TABLE IF NOT EXISTS knowledge_chunks (
 source_id text NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
 ordinal integer NOT NULL, content text NOT NULL,
 search tsvector GENERATED ALWAYS AS (to_tsvector('simple',content)) STORED,
 PRIMARY KEY(source_id,ordinal)
);
CREATE INDEX IF NOT EXISTS knowledge_search ON knowledge_chunks USING gin(search);
CREATE TABLE IF NOT EXISTS google_connections (
 client_id text PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
 tokens text NOT NULL, scopes text NOT NULL, settings jsonb NOT NULL DEFAULT '{}', updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS google_oauth_states (
 state_hash text PRIMARY KEY, session_hash text NOT NULL, client_id text NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
 verifier text NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS customer_actions (
 id text PRIMARY KEY, client_id text NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
 conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 job_id text NOT NULL UNIQUE, kind text NOT NULL, payload text NOT NULL,
 code text NOT NULL, state text NOT NULL DEFAULT 'pending', result text,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customer_actions_conversation ON customer_actions(conversation_id,created_at);
ALTER TABLE customer_actions ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS lead_stage text NOT NULL DEFAULT 'new';
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS lead_name text NOT NULL DEFAULT '';
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS lead_notes text NOT NULL DEFAULT '';
ALTER TABLE knowledge_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE google_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE google_oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE prompt_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_lock ENABLE ROW LEVEL SECURITY;
ALTER TABLE login_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE llm_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_receipts ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
  REVOKE ALL ON clients,settings,prompt_history,conversations,message_logs,jobs,alerts,sessions,worker_lock,login_attempts,llm_usage,delivery_receipts FROM anon, authenticated;
  REVOKE ALL ON knowledge_sources,knowledge_chunks,google_connections,google_oauth_states,customer_actions FROM anon, authenticated;
 END IF;
END $$;
