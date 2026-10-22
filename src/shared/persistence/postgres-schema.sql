-- migration:core-schema-v1
CREATE SCHEMA IF NOT EXISTS for_now;

CREATE TABLE IF NOT EXISTS for_now.accounts (
  account_id text PRIMARY KEY,
  source_created_at timestamptz,
  imported_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS for_now.migration_runs (
  run_id uuid PRIMARY KEY,
  account_id text NOT NULL,
  source_format text NOT NULL,
  source_version integer NOT NULL,
  source_sha256 text NOT NULL,
  source_counts jsonb NOT NULL,
  target_counts jsonb,
  status text NOT NULL CHECK (status IN ('running', 'verified', 'failed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS for_now.account_snapshots (
  account_id text PRIMARY KEY REFERENCES for_now.accounts(account_id) ON DELETE CASCADE,
  schema_version integer NOT NULL,
  source_sha256 text NOT NULL,
  snapshot jsonb NOT NULL,
  migration_run_id uuid NOT NULL REFERENCES for_now.migration_runs(run_id),
  imported_at timestamptz NOT NULL DEFAULT now()
);

-- Relational business store: one row per domain object or nested content item.
-- Snapshots above are evidence only; rebuilding uses these fields and objects.
CREATE TABLE IF NOT EXISTS for_now.store_fields (
  account_id text NOT NULL REFERENCES for_now.accounts(account_id),
  field text NOT NULL,
  shape text NOT NULL CHECK (shape IN ('array', 'object', 'value')),
  payload jsonb,
  PRIMARY KEY (account_id, field)
);

CREATE TABLE IF NOT EXISTS for_now.store_objects (
  account_id text NOT NULL,
  object_key text NOT NULL,
  collection text NOT NULL,
  kind text NOT NULL,
  id text NOT NULL,
  parent_key text,
  field text NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  child_fields jsonb NOT NULL CHECK (jsonb_typeof(child_fields) = 'array'),
  content text NOT NULL,
  status text NOT NULL,
  author_type text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  lifecycle text NOT NULL DEFAULT 'formal' CHECK (lifecycle IN ('draft', 'formal')),
  tombstone boolean NOT NULL DEFAULT false,
  deleted_at text,
  PRIMARY KEY (account_id, object_key),
  UNIQUE (account_id, object_key, collection),
  FOREIGN KEY (account_id, collection) REFERENCES for_now.store_fields(account_id, field),
  FOREIGN KEY (account_id, parent_key, collection)
    REFERENCES for_now.store_objects(account_id, object_key, collection) DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX IF NOT EXISTS store_objects_position_idx
  ON for_now.store_objects(account_id, COALESCE(parent_key, ''), field, position);
CREATE INDEX IF NOT EXISTS store_objects_domain_idx
  ON for_now.store_objects(account_id, collection, kind, status);
ALTER TABLE for_now.store_objects ADD COLUMN IF NOT EXISTS lifecycle text NOT NULL DEFAULT 'formal';
ALTER TABLE for_now.store_objects ADD COLUMN IF NOT EXISTS tombstone boolean NOT NULL DEFAULT false;
ALTER TABLE for_now.store_objects ADD COLUMN IF NOT EXISTS deleted_at text;
ALTER TABLE for_now.store_objects DROP CONSTRAINT IF EXISTS store_objects_lifecycle_check;
ALTER TABLE for_now.store_objects ADD CONSTRAINT store_objects_lifecycle_check CHECK (lifecycle IN ('draft', 'formal'));
CREATE INDEX IF NOT EXISTS store_objects_lifecycle_idx
  ON for_now.store_objects(account_id, lifecycle, tombstone, collection);

CREATE TABLE IF NOT EXISTS for_now.store_relations (
  account_id text NOT NULL,
  object_key text NOT NULL,
  relation text NOT NULL,
  target_key text,
  target_collection text NOT NULL,
  target_id text NOT NULL,
  resolution text NOT NULL CHECK (resolution IN ('live', 'historical')),
  PRIMARY KEY (account_id, object_key, relation),
  FOREIGN KEY (account_id, object_key) REFERENCES for_now.store_objects(account_id, object_key),
  FOREIGN KEY (account_id, target_key) REFERENCES for_now.store_objects(account_id, object_key),
  CHECK ((resolution = 'live') = (target_key IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS for_now.store_attachment_refs (
  account_id text NOT NULL,
  owner_key text,
  field_name text NOT NULL,
  value_path text NOT NULL,
  path text NOT NULL CHECK (path ~ '^/attachments/[A-Za-z0-9_.-]+$'),
  FOREIGN KEY (account_id, owner_key) REFERENCES for_now.store_objects(account_id, object_key),
  FOREIGN KEY (account_id, field_name) REFERENCES for_now.store_fields(account_id, field)
);
CREATE UNIQUE INDEX IF NOT EXISTS store_attachment_refs_identity_idx
  ON for_now.store_attachment_refs(account_id, COALESCE(owner_key, ''), field_name, value_path);
CREATE INDEX IF NOT EXISTS store_attachment_refs_path_idx
  ON for_now.store_attachment_refs(account_id, path);

CREATE TABLE IF NOT EXISTS for_now.resource_lifecycle (
  account_id text NOT NULL REFERENCES for_now.accounts(account_id),
  position integer NOT NULL CHECK (position >= 0),
  resource_key text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  lifecycle text NOT NULL CHECK (lifecycle IN ('draft', 'formal')),
  state text NOT NULL CHECK (state IN ('active', 'deleted', 'formalized', 'purged')),
  tombstone boolean NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  deleted_at text NOT NULL,
  restored_at text NOT NULL,
  purged_at text NOT NULL,
  trash_id text NOT NULL,
  history jsonb NOT NULL CHECK (jsonb_typeof(history) = 'array'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  PRIMARY KEY (account_id, resource_key)
);
CREATE INDEX IF NOT EXISTS resource_lifecycle_state_idx
  ON for_now.resource_lifecycle(account_id, state, resource_type);

CREATE TABLE IF NOT EXISTS for_now.idempotency_ledger (
  account_id text NOT NULL REFERENCES for_now.accounts(account_id),
  position integer NOT NULL CHECK (position >= 0),
  scope text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  response jsonb,
  created_at text NOT NULL,
  expires_at text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  PRIMARY KEY (account_id, scope, idempotency_key)
);
ALTER TABLE for_now.resource_lifecycle ADD COLUMN IF NOT EXISTS position integer;
ALTER TABLE for_now.resource_lifecycle ADD COLUMN IF NOT EXISTS payload jsonb;
UPDATE for_now.store_fields field
SET payload = (snapshot.snapshot->'_persistence') - 'lifecycles' - 'idempotency'
FROM for_now.account_snapshots snapshot
WHERE field.account_id = snapshot.account_id
  AND field.field = '_persistence'
  AND jsonb_typeof(snapshot.snapshot->'_persistence') = 'object'
  AND field.payload = jsonb_build_object('version', field.payload->'version');
UPDATE for_now.resource_lifecycle item
SET position = source.ordinality - 1,
    payload = source.value
FROM for_now.account_snapshots snapshot
CROSS JOIN LATERAL jsonb_array_elements(
  COALESCE(snapshot.snapshot #> '{_persistence,lifecycles}', '[]'::jsonb)
) WITH ORDINALITY source(value, ordinality)
WHERE item.account_id = snapshot.account_id
  AND item.resource_key = source.value->>'resourceKey'
  AND (item.position IS NULL OR item.payload IS NULL);
ALTER TABLE for_now.resource_lifecycle ALTER COLUMN position SET NOT NULL;
ALTER TABLE for_now.resource_lifecycle ALTER COLUMN payload SET NOT NULL;
ALTER TABLE for_now.resource_lifecycle DROP CONSTRAINT IF EXISTS resource_lifecycle_position_check;
ALTER TABLE for_now.resource_lifecycle
  ADD CONSTRAINT resource_lifecycle_position_check CHECK (position >= 0);
ALTER TABLE for_now.resource_lifecycle DROP CONSTRAINT IF EXISTS resource_lifecycle_payload_check;
ALTER TABLE for_now.resource_lifecycle
  ADD CONSTRAINT resource_lifecycle_payload_check CHECK (jsonb_typeof(payload) = 'object');
CREATE UNIQUE INDEX IF NOT EXISTS resource_lifecycle_position_idx
  ON for_now.resource_lifecycle(account_id, position);

ALTER TABLE for_now.idempotency_ledger ADD COLUMN IF NOT EXISTS position integer;
ALTER TABLE for_now.idempotency_ledger ADD COLUMN IF NOT EXISTS payload jsonb;
ALTER TABLE for_now.idempotency_ledger ALTER COLUMN response DROP NOT NULL;
UPDATE for_now.idempotency_ledger item
SET position = source.ordinality - 1,
    payload = source.value
FROM for_now.account_snapshots snapshot
CROSS JOIN LATERAL jsonb_array_elements(
  COALESCE(snapshot.snapshot #> '{_persistence,idempotency}', '[]'::jsonb)
) WITH ORDINALITY source(value, ordinality)
WHERE item.account_id = snapshot.account_id
  AND item.scope = source.value->>'scope'
  AND item.idempotency_key = source.value->>'key'
  AND (item.position IS NULL OR item.payload IS NULL);
ALTER TABLE for_now.idempotency_ledger ALTER COLUMN position SET NOT NULL;
ALTER TABLE for_now.idempotency_ledger ALTER COLUMN payload SET NOT NULL;
ALTER TABLE for_now.idempotency_ledger DROP CONSTRAINT IF EXISTS idempotency_ledger_position_check;
ALTER TABLE for_now.idempotency_ledger
  ADD CONSTRAINT idempotency_ledger_position_check CHECK (position >= 0);
ALTER TABLE for_now.idempotency_ledger DROP CONSTRAINT IF EXISTS idempotency_ledger_payload_check;
ALTER TABLE for_now.idempotency_ledger
  ADD CONSTRAINT idempotency_ledger_payload_check CHECK (jsonb_typeof(payload) = 'object');
CREATE UNIQUE INDEX IF NOT EXISTS idempotency_ledger_position_idx
  ON for_now.idempotency_ledger(account_id, position);

CREATE TABLE IF NOT EXISTS for_now.account_documents (
  account_id text NOT NULL REFERENCES for_now.accounts(account_id),
  document text NOT NULL CHECK (document IN ('settings', 'usage', 'costPlan')),
  PRIMARY KEY (account_id, document)
);
CREATE TABLE IF NOT EXISTS for_now.document_fields (
  account_id text NOT NULL,
  document text NOT NULL,
  field text NOT NULL,
  shape text NOT NULL CHECK (shape IN ('array', 'object', 'value', 'secret')),
  payload jsonb,
  PRIMARY KEY (account_id, document, field),
  FOREIGN KEY (account_id, document) REFERENCES for_now.account_documents(account_id, document) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS for_now.document_records (
  account_id text NOT NULL,
  document text NOT NULL,
  field text NOT NULL,
  key text NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  model text NOT NULL,
  scene text NOT NULL,
  status text NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (account_id, document, field, key),
  UNIQUE (account_id, document, field, position),
  FOREIGN KEY (account_id, document, field) REFERENCES for_now.document_fields(account_id, document, field) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS document_records_usage_idx
  ON for_now.document_records(account_id, document, scene, model, status);
CREATE TABLE IF NOT EXISTS for_now.document_secrets (
  account_id text NOT NULL,
  document text NOT NULL,
  field text NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (account_id, document, field),
  FOREIGN KEY (account_id, document, field) REFERENCES for_now.document_fields(account_id, document, field) ON DELETE CASCADE
);

-- migration:ai-audit-v1
CREATE TABLE IF NOT EXISTS for_now.ai_request_audit (
  account_id text NOT NULL REFERENCES for_now.accounts(account_id) ON DELETE CASCADE,
  call_id text PRIMARY KEY,
  call_group_id text NOT NULL,
  trace_id text NOT NULL,
  provider text NOT NULL,
  service text NOT NULL,
  scene text NOT NULL,
  action text NOT NULL,
  trigger_type text NOT NULL CHECK (trigger_type IN ('user_explicit', 'user_action_auto', 'scheduled', 'system_internal')),
  result_audience text NOT NULL CHECK (result_audience IN ('user', 'internal')),
  reasoning_visibility text NOT NULL CHECK (reasoning_visibility IN ('user_viewable', 'privileged_only')),
  persistence_mode text NOT NULL CHECK (persistence_mode IN ('business_result', 'live_only', 'audit_only')),
  contract_schema_version integer NOT NULL CHECK (contract_schema_version > 0),
  attempt integer NOT NULL CHECK (attempt > 0),
  max_attempts integer NOT NULL CHECK (max_attempts >= attempt),
  status text NOT NULL CHECK (status IN ('started', 'success', 'failed', 'timeout', 'cancelled', 'interrupted')),
  dispatch_state text NOT NULL CHECK (dispatch_state IN ('pending', 'invoked', 'not_invoked')),
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  request_payload jsonb NOT NULL CHECK (jsonb_typeof(request_payload) = 'object'),
  response_payload jsonb NOT NULL CHECK (jsonb_typeof(response_payload) = 'object'),
  error_payload jsonb,
  usage_payload jsonb,
  truncation jsonb NOT NULL CHECK (jsonb_typeof(truncation) = 'object'),
  schema_version integer NOT NULL CHECK (schema_version > 0),
  CHECK ((status = 'started') = (completed_at IS NULL)),
  CHECK ((status = 'started') = (dispatch_state = 'pending'))
);
CREATE INDEX IF NOT EXISTS ai_request_audit_account_started_idx
  ON for_now.ai_request_audit(account_id, started_at DESC, call_id);
CREATE INDEX IF NOT EXISTS ai_request_audit_stale_idx
  ON for_now.ai_request_audit(account_id, started_at, call_id)
  WHERE status = 'started';

CREATE TABLE IF NOT EXISTS for_now.ai_usage_attempts (
  account_id text NOT NULL REFERENCES for_now.accounts(account_id) ON DELETE CASCADE,
  call_id text NOT NULL,
  provider text NOT NULL,
  service text NOT NULL,
  scene text NOT NULL,
  model text NOT NULL,
  status text NOT NULL,
  occurred_at timestamptz NOT NULL,
  usage_known boolean NOT NULL,
  cost_known boolean NOT NULL,
  cost_micros bigint NOT NULL CHECK (cost_micros >= 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  PRIMARY KEY (account_id, call_id)
);
CREATE INDEX IF NOT EXISTS ai_usage_attempts_account_time_idx
  ON for_now.ai_usage_attempts(account_id, occurred_at, call_id);
CREATE INDEX IF NOT EXISTS ai_usage_attempts_account_scene_time_idx
  ON for_now.ai_usage_attempts(account_id, scene, occurred_at);

CREATE TABLE IF NOT EXISTS for_now.ai_usage_aggregates (
  account_id text NOT NULL REFERENCES for_now.accounts(account_id) ON DELETE CASCADE,
  period_date date NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  calls integer NOT NULL CHECK (calls >= 0),
  known_cost_micros bigint NOT NULL CHECK (known_cost_micros >= 0),
  unknown_cost_calls integer NOT NULL CHECK (unknown_cost_calls >= 0),
  PRIMARY KEY (account_id, period_date, provider, model)
);
CREATE INDEX IF NOT EXISTS ai_usage_aggregates_account_period_idx
  ON for_now.ai_usage_aggregates(account_id, period_date);

CREATE TABLE IF NOT EXISTS for_now.attachment_inventory (
  account_id text NOT NULL REFERENCES for_now.accounts(account_id),
  path text NOT NULL CHECK (path ~ '^/attachments/[A-Za-z0-9_.-]+$'),
  storage text NOT NULL,
  object_key text NOT NULL,
  bytes bigint,
  sha256 text,
  state text NOT NULL,
  PRIMARY KEY (account_id, path),
  CONSTRAINT attachment_inventory_value_check CHECK ((state IN ('uploading', 'verified') AND bytes IS NOT NULL AND sha256 IS NOT NULL AND bytes >= 0 AND sha256 ~ '^[a-f0-9]{64}$')
    OR (state = 'missing_cleanup' AND bytes IS NULL AND sha256 IS NULL))
);
ALTER TABLE for_now.attachment_inventory DROP CONSTRAINT IF EXISTS attachment_inventory_state_check;
ALTER TABLE for_now.attachment_inventory DROP CONSTRAINT IF EXISTS attachment_inventory_check;
ALTER TABLE for_now.attachment_inventory DROP CONSTRAINT IF EXISTS attachment_inventory_value_check;
ALTER TABLE for_now.attachment_inventory ADD CONSTRAINT attachment_inventory_value_check
  CHECK ((state IN ('uploading', 'verified') AND bytes IS NOT NULL AND sha256 IS NOT NULL AND bytes >= 0 AND sha256 ~ '^[a-f0-9]{64}$')
    OR (state = 'missing_cleanup' AND bytes IS NULL AND sha256 IS NULL));

-- Site budget state is deliberately outside account RLS. Only the dedicated
-- runtime budget role receives SELECT/UPDATE on this singleton.
CREATE TABLE IF NOT EXISTS for_now.site_ai_budget (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  record_compression_quota jsonb NOT NULL DEFAULT '{"days":[]}'::jsonb
);
ALTER TABLE for_now.site_ai_budget
  ADD COLUMN IF NOT EXISTS record_compression_quota jsonb NOT NULL DEFAULT '{"days":[]}'::jsonb;
INSERT INTO for_now.site_ai_budget(id, document) VALUES (true, '{}'::jsonb)
ON CONFLICT (id) DO NOTHING;
REVOKE ALL ON TABLE for_now.site_ai_budget FROM PUBLIC;

-- Authentication must look up identities before a tenant is known. It has a
-- separate schema and role; never grant this schema to the tenant data role.
CREATE SCHEMA IF NOT EXISTS for_now_auth;
REVOKE ALL ON SCHEMA for_now_auth FROM PUBLIC;
CREATE TABLE IF NOT EXISTS for_now_auth.document_fields (
  field text PRIMARY KEY,
  payload jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS for_now_auth.users (
  id text PRIMARY KEY,
  username text NOT NULL,
  username_key text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  position integer NOT NULL UNIQUE CHECK (position >= 0),
  payload jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS for_now_auth.sessions (
  token_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES for_now_auth.users(id),
  position integer NOT NULL UNIQUE CHECK (position >= 0),
  payload jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON for_now_auth.sessions(user_id);

-- migration:auth-row-v1
ALTER TABLE for_now_auth.users ADD COLUMN IF NOT EXISTS role text;
ALTER TABLE for_now_auth.users ADD COLUMN IF NOT EXISTS session_version integer;
ALTER TABLE for_now_auth.users ADD COLUMN IF NOT EXISTS record_timezone text;
ALTER TABLE for_now_auth.users ADD COLUMN IF NOT EXISTS created_at timestamptz;
ALTER TABLE for_now_auth.users ADD COLUMN IF NOT EXISTS updated_at timestamptz;
UPDATE for_now_auth.users
SET role = CASE
      WHEN payload->>'role' IN ('user', 'owner') THEN payload->>'role'
      WHEN position = 0 THEN 'owner'
      ELSE 'user'
    END,
    session_version = CASE
      WHEN payload->>'sessionVersion' ~ '^[1-9][0-9]*$'
        THEN (payload->>'sessionVersion')::integer
      ELSE 1
    END,
    record_timezone = COALESCE(NULLIF(payload->>'recordTimezone', ''), 'Asia/Shanghai'),
    created_at = COALESCE(NULLIF(payload->>'createdAt', '')::timestamptz, to_timestamp(0)),
    updated_at = NULLIF(payload->>'updatedAt', '')::timestamptz
WHERE role IS NULL
   OR session_version IS NULL
   OR record_timezone IS NULL
   OR created_at IS NULL;
ALTER TABLE for_now_auth.users ALTER COLUMN role SET NOT NULL;
ALTER TABLE for_now_auth.users ALTER COLUMN session_version SET NOT NULL;
ALTER TABLE for_now_auth.users ALTER COLUMN record_timezone SET NOT NULL;
ALTER TABLE for_now_auth.users ALTER COLUMN created_at SET NOT NULL;
ALTER TABLE for_now_auth.users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE for_now_auth.users
  ADD CONSTRAINT users_role_check CHECK (role IN ('user', 'owner'));
ALTER TABLE for_now_auth.users DROP CONSTRAINT IF EXISTS users_session_version_check;
ALTER TABLE for_now_auth.users
  ADD CONSTRAINT users_session_version_check CHECK (session_version > 0);

ALTER TABLE for_now_auth.sessions ADD COLUMN IF NOT EXISTS session_version integer;
ALTER TABLE for_now_auth.sessions ADD COLUMN IF NOT EXISTS created_at timestamptz;
ALTER TABLE for_now_auth.sessions ADD COLUMN IF NOT EXISTS expires_at timestamptz;
UPDATE for_now_auth.sessions session
SET session_version = COALESCE(
      CASE
        WHEN session.payload->>'sessionVersion' ~ '^[1-9][0-9]*$'
          THEN (session.payload->>'sessionVersion')::integer
        ELSE NULL
      END,
      users.session_version
    ),
    created_at = COALESCE(NULLIF(session.payload->>'createdAt', '')::timestamptz, to_timestamp(0)),
    expires_at = NULLIF(session.payload->>'expiresAt', '')::timestamptz
FROM for_now_auth.users users
WHERE users.id = session.user_id
  AND (
    session.session_version IS NULL
    OR session.created_at IS NULL
    OR session.expires_at IS NULL
  );
ALTER TABLE for_now_auth.sessions ALTER COLUMN session_version SET NOT NULL;
ALTER TABLE for_now_auth.sessions ALTER COLUMN created_at SET NOT NULL;
ALTER TABLE for_now_auth.sessions ALTER COLUMN expires_at SET NOT NULL;
ALTER TABLE for_now_auth.sessions DROP CONSTRAINT IF EXISTS sessions_session_version_check;
ALTER TABLE for_now_auth.sessions
  ADD CONSTRAINT sessions_session_version_check CHECK (session_version > 0);

ALTER TABLE for_now_auth.users DROP CONSTRAINT IF EXISTS users_position_key;
ALTER TABLE for_now_auth.users ALTER COLUMN position DROP NOT NULL;
ALTER TABLE for_now_auth.sessions DROP CONSTRAINT IF EXISTS sessions_position_key;
ALTER TABLE for_now_auth.sessions ALTER COLUMN position DROP NOT NULL;
UPDATE for_now_auth.users SET position = NULL WHERE position IS NOT NULL;
UPDATE for_now_auth.sessions SET position = NULL WHERE position IS NOT NULL;
CREATE INDEX IF NOT EXISTS auth_users_page_idx
  ON for_now_auth.users(created_at, id);
CREATE INDEX IF NOT EXISTS auth_users_role_page_idx
  ON for_now_auth.users(role, created_at, id);
CREATE INDEX IF NOT EXISTS auth_sessions_expiry_idx
  ON for_now_auth.sessions(expires_at, token_hash);
CREATE INDEX IF NOT EXISTS auth_sessions_user_created_idx
  ON for_now_auth.sessions(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS for_now_auth.migration_state (
  id text PRIMARY KEY CHECK (id = 'bundle'),
  source_sha256 text NOT NULL,
  content_sha256 text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);

-- migration:record-commands-v1
DROP INDEX IF EXISTS for_now.store_objects_position_idx;
ALTER TABLE for_now.store_objects ALTER COLUMN position DROP NOT NULL;
ALTER TABLE for_now.store_objects DROP CONSTRAINT IF EXISTS store_objects_position_check;
CREATE INDEX IF NOT EXISTS store_objects_stable_order_idx
  ON for_now.store_objects(
    account_id,
    collection,
    COALESCE(parent_key, ''),
    COALESCE(payload->>'occurredAt', payload->>'createdAt', ''),
    id
  );

DROP INDEX IF EXISTS for_now.resource_lifecycle_position_idx;
ALTER TABLE for_now.resource_lifecycle ALTER COLUMN position DROP NOT NULL;
CREATE INDEX IF NOT EXISTS resource_lifecycle_stable_order_idx
  ON for_now.resource_lifecycle(account_id, updated_at, resource_key);
CREATE INDEX IF NOT EXISTS store_objects_identity_idx
  ON for_now.store_objects(account_id, id);
CREATE INDEX IF NOT EXISTS resource_lifecycle_identity_idx
  ON for_now.resource_lifecycle(account_id, resource_id);

DROP INDEX IF EXISTS for_now.idempotency_ledger_position_idx;
ALTER TABLE for_now.idempotency_ledger ALTER COLUMN position DROP NOT NULL;
CREATE INDEX IF NOT EXISTS idempotency_ledger_expiry_idx
  ON for_now.idempotency_ledger(account_id, expires_at, scope, idempotency_key);

CREATE TABLE IF NOT EXISTS for_now.account_sync_heads (
  account_id text PRIMARY KEY REFERENCES for_now.accounts(account_id) ON DELETE CASCADE,
  current_cursor bigint NOT NULL DEFAULT 0 CHECK (current_cursor >= 0)
);
INSERT INTO for_now.account_sync_heads(account_id)
SELECT account_id FROM for_now.accounts
ON CONFLICT (account_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS for_now.record_changes (
  account_id text NOT NULL REFERENCES for_now.accounts(account_id) ON DELETE CASCADE,
  cursor bigint NOT NULL CHECK (cursor > 0),
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  command_id text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  parent_type text,
  parent_id text,
  entity_version integer NOT NULL CHECK (entity_version > 0),
  operation text NOT NULL CHECK (operation IN ('create', 'update', 'delete')),
  changed_fields jsonb NOT NULL CHECK (jsonb_typeof(changed_fields) = 'array'),
  scope_keys jsonb NOT NULL CHECK (jsonb_typeof(scope_keys) = 'array'),
  summary jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, cursor, ordinal),
  CHECK ((parent_type IS NULL) = (parent_id IS NULL)),
  CHECK (summary IS NULL OR jsonb_typeof(summary) = 'object')
);
CREATE INDEX IF NOT EXISTS record_changes_entity_idx
  ON for_now.record_changes(account_id, entity_type, entity_id, cursor DESC);
CREATE INDEX IF NOT EXISTS record_changes_created_idx
  ON for_now.record_changes(account_id, created_at, cursor);

CREATE INDEX IF NOT EXISTS migration_runs_account_started_idx
  ON for_now.migration_runs (account_id, started_at DESC);

ALTER TABLE for_now.accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE for_now.accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE for_now.migration_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE for_now.migration_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE for_now.account_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE for_now.account_snapshots FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  target_table text;
BEGIN
  FOREACH target_table IN ARRAY ARRAY[
    'accounts',
    'migration_runs',
    'account_snapshots',
    'store_fields',
    'store_objects',
    'store_relations',
    'store_attachment_refs',
    'resource_lifecycle',
    'idempotency_ledger',
    'account_documents',
    'document_fields',
    'document_records',
    'document_secrets',
    'ai_request_audit',
    'ai_usage_attempts',
    'ai_usage_aggregates',
    'attachment_inventory',
    'account_sync_heads',
    'record_changes'
  ]
  LOOP
    EXECUTE format('ALTER TABLE for_now.%I ENABLE ROW LEVEL SECURITY', target_table);
    EXECUTE format('ALTER TABLE for_now.%I FORCE ROW LEVEL SECURITY', target_table);
    IF NOT EXISTS (
      SELECT 1
      FROM pg_policies
      WHERE schemaname = 'for_now'
        AND tablename = target_table
        AND policyname = 'account_isolation'
    ) THEN
      EXECUTE format(
        'CREATE POLICY account_isolation ON for_now.%I USING (account_id = current_setting(''app.account_id'', true)) WITH CHECK (account_id = current_setting(''app.account_id'', true))',
        target_table
      );
    END IF;
  END LOOP;
END
$$;

-- These were pre-runtime migration projections. The mapped business rows and
-- immutable migration snapshots already contain their source data.
DROP TABLE IF EXISTS for_now.entry_blocks, for_now.thought_follow_ups,
  for_now.thought_remarks, for_now.annotations;
DROP TABLE IF EXISTS for_now.entries;
ALTER TABLE for_now.accounts ADD COLUMN IF NOT EXISTS runtime_started_at timestamptz;
ALTER TABLE for_now.accounts ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS for_now_auth.runtime_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  started_at timestamptz NOT NULL DEFAULT now()
);

-- Only the auth role may EXECUTE this function. It can initialize a newly
-- registered identity, but cannot read or replace any existing tenant data.
CREATE OR REPLACE FUNCTION for_now_auth.provision_account(owner_id text, business jsonb, documents jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE item jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM for_now_auth.users WHERE id = owner_id) THEN
    RAISE EXCEPTION 'Identity must exist before provisioning';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(
      COALESCE(business->'fields','[]') || COALESCE(business->'objects','[]') ||
      COALESCE(business->'relations','[]') || COALESCE(business->'attachmentRefs','[]') ||
      COALESCE(business->'lifecycles','[]') || COALESCE(business->'idempotency','[]')
    ) row WHERE row->>'account_id' IS DISTINCT FROM owner_id
  ) THEN RAISE EXCEPTION 'Provisioning account mismatch'; END IF;
  PERFORM set_config('app.account_id', owner_id, true);
  INSERT INTO for_now.accounts(account_id, runtime_started_at) VALUES (owner_id, now());
  INSERT INTO for_now.account_sync_heads(account_id) VALUES (owner_id);
  INSERT INTO for_now.store_fields SELECT * FROM jsonb_populate_recordset(NULL::for_now.store_fields, business->'fields');
  INSERT INTO for_now.store_objects(
    account_id, object_key, collection, kind, id, parent_key, field, position,
    child_fields, content, status, author_type, version, payload, lifecycle, tombstone, deleted_at
  ) SELECT account_id, object_key, collection, kind, id, parent_key, field, position,
    child_fields, content, status, author_type, version, payload, lifecycle, tombstone, deleted_at
    FROM jsonb_populate_recordset(NULL::for_now.store_objects, business->'objects');
  INSERT INTO for_now.store_relations SELECT * FROM jsonb_populate_recordset(NULL::for_now.store_relations, business->'relations');
  INSERT INTO for_now.store_attachment_refs SELECT * FROM jsonb_populate_recordset(NULL::for_now.store_attachment_refs, business->'attachmentRefs');
  INSERT INTO for_now.resource_lifecycle SELECT * FROM jsonb_populate_recordset(NULL::for_now.resource_lifecycle, business->'lifecycles');
  INSERT INTO for_now.idempotency_ledger SELECT * FROM jsonb_populate_recordset(NULL::for_now.idempotency_ledger, business->'idempotency');
  IF business ? 'projectionVersion' THEN
    INSERT INTO for_now.record_projection_status(account_id,schema_version)
      VALUES (owner_id,(business->>'projectionVersion')::integer);
  END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(documents) LOOP
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(item->'fields' || item->'records' || item->'secrets') row
      WHERE row->>'account_id' IS DISTINCT FROM owner_id
    ) THEN RAISE EXCEPTION 'Provisioning document account mismatch'; END IF;
    INSERT INTO for_now.account_documents(account_id, document) VALUES (owner_id, item->>'document');
    INSERT INTO for_now.document_fields SELECT * FROM jsonb_populate_recordset(NULL::for_now.document_fields, item->'fields');
    INSERT INTO for_now.document_records SELECT * FROM jsonb_populate_recordset(NULL::for_now.document_records, item->'records');
    INSERT INTO for_now.document_secrets SELECT * FROM jsonb_populate_recordset(NULL::for_now.document_secrets, item->'secrets');
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION for_now_auth.provision_account(text, jsonb, jsonb) FROM PUBLIC;

-- migration:thought-chain-index-v1
CREATE TABLE IF NOT EXISTS for_now.thought_chain_index (
  account_id text NOT NULL REFERENCES for_now.accounts(account_id) ON DELETE CASCADE,
  root_id text NOT NULL,
  source_version integer NOT NULL CHECK(source_version>0),
  projection_version bigint NOT NULL CHECK(projection_version>0),
  index_schema_version integer NOT NULL,
  search_mode text NOT NULL DEFAULT 'normalized_index' CHECK(search_mode='normalized_index'),
  occurred_at text NOT NULL,
  created_at text NOT NULL,
  tags text[] NOT NULL,
  search_text text NOT NULL,
  search_grams text[] NOT NULL,
  summary jsonb NOT NULL,
  projection_hash text NOT NULL,
  speech_sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  discovery_sort_time bigint NOT NULL,
  discovery_search jsonb NOT NULL,
  discovery_status jsonb NOT NULL,
  PRIMARY KEY(account_id,root_id)
);
CREATE INDEX IF NOT EXISTS thought_chain_occurred_idx ON for_now.thought_chain_index
  (account_id,occurred_at DESC,created_at DESC,root_id DESC);
CREATE INDEX IF NOT EXISTS thought_chain_created_idx ON for_now.thought_chain_index
  (account_id,created_at DESC,root_id DESC);
CREATE INDEX IF NOT EXISTS thought_chain_discovery_idx ON for_now.thought_chain_index
  (account_id,discovery_sort_time DESC,root_id DESC);
CREATE INDEX IF NOT EXISTS thought_chain_tags_idx ON for_now.thought_chain_index USING gin(tags);
CREATE INDEX IF NOT EXISTS thought_chain_search_idx ON for_now.thought_chain_index USING gin(search_grams) WITH (fastupdate=off);
CREATE INDEX IF NOT EXISTS thought_owned_parent_idx ON for_now.store_objects(account_id,parent_key)
  WHERE collection='thoughts';
CREATE TABLE IF NOT EXISTS for_now.thought_tag_counts (
  account_id text NOT NULL REFERENCES for_now.accounts(account_id) ON DELETE CASCADE,
  tag text NOT NULL,
  uses bigint NOT NULL CHECK(uses>=0),
  PRIMARY KEY(account_id,tag)
);
CREATE TABLE IF NOT EXISTS for_now.record_projection_status (
  account_id text PRIMARY KEY REFERENCES for_now.accounts(account_id) ON DELETE CASCADE,
  schema_version integer NOT NULL
);
ALTER TABLE for_now.thought_chain_index ENABLE ROW LEVEL SECURITY;
ALTER TABLE for_now.thought_chain_index FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS thought_chain_account ON for_now.thought_chain_index;
CREATE POLICY thought_chain_account ON for_now.thought_chain_index
  USING(account_id=current_setting('app.account_id',true))
  WITH CHECK(account_id=current_setting('app.account_id',true));
ALTER TABLE for_now.thought_tag_counts ENABLE ROW LEVEL SECURITY;
ALTER TABLE for_now.thought_tag_counts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS thought_tag_account ON for_now.thought_tag_counts;
CREATE POLICY thought_tag_account ON for_now.thought_tag_counts
  USING(account_id=current_setting('app.account_id',true))
  WITH CHECK(account_id=current_setting('app.account_id',true));
ALTER TABLE for_now.record_projection_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE for_now.record_projection_status FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS record_projection_status_account ON for_now.record_projection_status;
CREATE POLICY record_projection_status_account ON for_now.record_projection_status
  USING(account_id=current_setting('app.account_id',true))
  WITH CHECK(account_id=current_setting('app.account_id',true));

-- migration:record-closure-index-v1
ALTER TABLE for_now.store_objects
  ADD COLUMN IF NOT EXISTS trash_type text GENERATED ALWAYS AS (payload->>'type') STORED,
  ADD COLUMN IF NOT EXISTS trash_resource_id text GENERATED ALWAYS AS (payload->>'resourceId') STORED,
  ADD COLUMN IF NOT EXISTS trash_parent_id text GENERATED ALWAYS AS (payload->'location'->>'parentId') STORED,
  ADD COLUMN IF NOT EXISTS record_local_date text GENERATED ALWAYS AS (
    COALESCE(payload->'payload'->>'localDate', payload->>'localDate')
  ) STORED,
  ADD COLUMN IF NOT EXISTS record_window_start text GENERATED ALWAYS AS (
    payload->'payload'->>'windowStart'
  ) STORED,
  ADD COLUMN IF NOT EXISTS record_window_end text GENERATED ALWAYS AS (
    payload->'payload'->>'windowEnd'
  ) STORED;
CREATE INDEX IF NOT EXISTS store_objects_parent_idx
  ON for_now.store_objects(account_id, parent_key)
  WHERE parent_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS store_relations_target_idx
  ON for_now.store_relations(account_id, target_key, relation, object_key)
  WHERE target_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS store_relations_historical_target_idx
  ON for_now.store_relations(account_id, target_collection, target_id, relation, object_key)
  WHERE resolution = 'historical';
CREATE INDEX IF NOT EXISTS store_objects_trash_resource_idx
  ON for_now.store_objects(
    account_id, trash_type, trash_resource_id, deleted_at DESC, id DESC
  ) WHERE collection = 'trash';
CREATE INDEX IF NOT EXISTS store_objects_local_date_idx
  ON for_now.store_objects(
    account_id, collection, record_local_date, status
  ) WHERE parent_key IS NULL;
CREATE INDEX IF NOT EXISTS store_objects_date_window_idx
  ON for_now.store_objects(account_id, collection, record_window_end, record_window_start)
  WHERE parent_key IS NULL;

-- migration:task-request-index-v1
ALTER TABLE for_now.store_objects
  ADD COLUMN IF NOT EXISTS task_client_request_id text GENERATED ALWAYS AS (
    payload->>'clientRequestId'
  ) STORED,
  ADD COLUMN IF NOT EXISTS task_retry_of text GENERATED ALWAYS AS (
    payload->>'retryOf'
  ) STORED;
CREATE INDEX IF NOT EXISTS store_objects_task_request_idx
  ON for_now.store_objects(account_id, task_client_request_id)
  WHERE collection = 'aiTasks';
CREATE INDEX IF NOT EXISTS store_objects_task_retry_idx
  ON for_now.store_objects(account_id, task_retry_of)
  WHERE collection = 'aiTasks';

-- migration:task-recovery-index-v1
CREATE INDEX IF NOT EXISTS store_objects_task_recovery_idx
  ON for_now.store_objects(account_id, id, status)
  WHERE collection = 'aiTasks' AND parent_key IS NULL
    AND status IN ('queued', 'running', 'cancelling', 'waiting_for_user_model');

-- migration:task-model-input-index-v1
CREATE INDEX IF NOT EXISTS store_objects_task_model_input_idx
  ON for_now.store_objects(
    account_id, (payload->>'inputHash'),
    (COALESCE(payload->>'createdAt', '')) DESC, position ASC NULLS LAST, id
  )
  WHERE collection = 'aiTasks' AND kind = 'aiTask'
    AND payload->>'kind' = 'onboardingClaimExtraction'
    AND payload->>'targetId' = 'onboarding-v2';

-- migration:task-context-order-index-v1
ALTER TABLE for_now.store_objects
  ADD COLUMN IF NOT EXISTS context_sort_time text GENERATED ALWAYS AS (
    COALESCE(NULLIF(payload->>'occurredAt', ''), NULLIF(payload->>'occurredOn', ''),
      NULLIF(payload->>'createdAt', ''), NULLIF(payload->>'updatedAt', ''), '')
  ) STORED;
CREATE INDEX IF NOT EXISTS store_objects_context_recent_idx
  ON for_now.store_objects(account_id, collection, context_sort_time DESC, id DESC)
  WHERE parent_key IS NULL;
CREATE INDEX IF NOT EXISTS store_objects_context_position_idx
  ON for_now.store_objects(account_id, collection, position, context_sort_time, id)
  WHERE parent_key IS NULL;
CREATE INDEX IF NOT EXISTS store_objects_context_unpositioned_idx
  ON for_now.store_objects(account_id, collection)
  WHERE parent_key IS NULL AND position IS NULL;
ALTER TABLE for_now.store_objects
  ADD COLUMN IF NOT EXISTS permission_resource_type text GENERATED ALWAYS AS (
    CASE WHEN collection = 'evidencePermissions' THEN (id::jsonb)->>0 END
  ) STORED,
  ADD COLUMN IF NOT EXISTS permission_resource_id text GENERATED ALWAYS AS (
    CASE WHEN collection = 'evidencePermissions' THEN (id::jsonb)->>1 END
  ) STORED,
  ADD COLUMN IF NOT EXISTS permission_root_id text GENERATED ALWAYS AS (
    CASE WHEN collection = 'evidencePermissions' THEN (id::jsonb)->>2 END
  ) STORED,
  ADD COLUMN IF NOT EXISTS permission_target_key text GENERATED ALWAYS AS (
    CASE WHEN collection = 'evidencePermissions' THEN (id::jsonb)->>3 END
  ) STORED;
CREATE INDEX IF NOT EXISTS store_objects_context_permission_idx
  ON for_now.store_objects(account_id, permission_resource_type,
    permission_resource_id, permission_root_id, permission_target_key)
  WHERE collection = 'evidencePermissions';

-- migration:task-learning-source-index-v1
CREATE INDEX IF NOT EXISTS store_objects_learning_permission_idx
  ON for_now.store_objects(account_id, permission_resource_type,
    permission_resource_id, permission_root_id, permission_target_key)
  WHERE collection = 'evidencePermissions' AND payload->'learningAllowed' = 'true'::jsonb;

-- migration:task-material-candidate-index-v1
CREATE INDEX IF NOT EXISTS store_objects_material_candidate_idx
  ON for_now.store_objects(account_id, collection, object_key)
  WHERE parent_key IS NULL
    AND payload->'contextAllowed' IS DISTINCT FROM 'false'::jsonb
    AND payload->'allowInContext' IS DISTINCT FROM 'false'::jsonb
    AND payload->>'disposition' IS DISTINCT FROM 'discarded'
    AND COALESCE(payload->'deletedAt'
      IN ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb), true);

-- migration:task-source-calendar-index-v1
-- A conservative calendar lookup only. Domain builders remain authoritative
-- for occurrence, permissions, authorship, sampling and fingerprints.
CREATE OR REPLACE FUNCTION for_now.source_calendar_hints(document jsonb)
RETURNS text[] LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  candidate text;
  local_day date;
  result text[] := ARRAY[]::text[];
BEGIN
  FOR candidate IN
    SELECT entry.value #>> '{}'
    FROM jsonb_path_query(document, '$.** ? (@.type() == "object")') node
    CROSS JOIN LATERAL jsonb_each(node) entry
    WHERE entry.key IN ('occurredAt', 'occurredOn', 'createdAt', 'updatedAt',
      'generatedAt', 'questionOccurredAt', 'answerOccurredAt', 'answeredAt')
  LOOP
    candidate := btrim(candidate,
      U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');
    IF candidate ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN
      BEGIN
        local_day := substring(candidate, 1, 10)::date;
        IF to_char(local_day, 'YYYY-MM-DD') = substring(candidate, 1, 10) THEN
          FOR day_offset IN -2..2 LOOP
            result := array_append(result, to_char(local_day + day_offset, 'YYYY-MM-DD'));
          END LOOP;
        ELSIF candidate ~ '([Zz]|[+-][0-9]{2}:?[0-9]{2})$' THEN
          result := result || ARRAY['*', '0000-00-00', '9999-99-99'];
        END IF;
      EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
        IF candidate ~ '([Zz]|[+-][0-9]{2}:?[0-9]{2})$' THEN
          result := result || ARRAY['*', '0000-00-00', '9999-99-99'];
        END IF;
      END;
    ELSIF candidate ~ '([Zz]|[+-][0-9]{2}:?[0-9]{2})$' THEN
      result := result || ARRAY['*', '0000-00-00', '9999-99-99'];
    END IF;
  END LOOP;
  RETURN ARRAY(SELECT DISTINCT item FROM unnest(result) item ORDER BY item);
END $$;
CREATE OR REPLACE FUNCTION for_now.source_occurrence_may_be_unknown(document jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  candidate text;
BEGIN
  IF document->>'eventTimePrecision' = 'unknown' THEN RETURN true; END IF;
  candidate := document->>'occurredAt';
  IF candidate ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T.*([Zz]|[+-][0-9]{2}:?[0-9]{2})$'
    AND COALESCE(document->>'eventTimePrecision', '') NOT IN ('date', 'day', 'date_only') THEN
    BEGIN
      PERFORM candidate::timestamptz;
      RETURN false;
    EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
      NULL;
    END;
  END IF;
  candidate := document->>'occurredOn';
  IF candidate ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
    BEGIN
      RETURN to_char(candidate::date, 'YYYY-MM-DD') <> candidate;
    EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
      NULL;
    END;
  END IF;
  RETURN true;
END
$$;
CREATE OR REPLACE FUNCTION for_now.source_has_text(value jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT jsonb_typeof(value) = 'string' AND length(btrim(value #>> '{}',
    U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')) > 0
$$;
CREATE OR REPLACE FUNCTION for_now.source_unknown_candidate(document jsonb, source_field text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
BEGIN
  IF source_field = 'followUps' THEN
    RETURN (
      for_now.source_has_text(document->'question')
      AND for_now.source_occurrence_may_be_unknown(document || jsonb_build_object('occurredAt',
        COALESCE(NULLIF(document->>'questionOccurredAt', ''), document->>'occurredAt', '')))
    ) OR (
      for_now.source_has_text(document->'answer')
      AND for_now.source_occurrence_may_be_unknown(document || jsonb_build_object('occurredAt',
        COALESCE(NULLIF(document->>'answerOccurredAt', ''), NULLIF(document->>'answeredAt', ''), '')))
    );
  ELSIF source_field = 'reflections' THEN
    RETURN for_now.source_occurrence_may_be_unknown(document || jsonb_build_object('occurredAt',
      COALESCE(NULLIF(document->>'occurredAt', ''), document->>'generatedAt', '')));
  END IF;
  RETURN for_now.source_occurrence_may_be_unknown(document);
END $$;
-- Only candidate existence and occurrence/validity metadata cross this boundary.
-- The domain collector still applies parent permissions and counts each candidate.
CREATE OR REPLACE FUNCTION for_now.source_unknown_projection(document jsonb, source_field text)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  result jsonb;
  entry record;
BEGIN
  SELECT COALESCE(jsonb_object_agg(key, value), '{}'::jsonb) INTO result
  FROM jsonb_each(document)
  WHERE key IN ('id', 'type', 'occurredAt', 'occurredOn', 'eventTimePrecision',
    'questionOccurredAt', 'answerOccurredAt', 'answeredAt', 'generatedAt',
    'deleted', 'tombstone', 'status', 'validationState',
    'contextAllowed', 'allowInContext', 'disposition');
  IF document->'deletedAt' NOT IN ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb) THEN
    result := result || '{"deletedAt":true}'::jsonb;
  END IF;
  FOR entry IN SELECT key, value FROM jsonb_each(document) LOOP
    IF source_field <> 'reflections'
      AND entry.key IN ('question', 'answer', 'recognitionDescription', 'trendAnalysis', 'verification') THEN
      IF for_now.source_has_text(entry.value) THEN
        result := result || jsonb_build_object(entry.key, 'present');
      END IF;
    ELSIF source_field = 'reflections' AND entry.key IN ('content', 'answer', 'text') THEN
      IF entry.value NOT IN ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb) THEN
        result := result || jsonb_build_object(entry.key,
          CASE WHEN for_now.source_has_text(entry.value)
            THEN '"present"'::jsonb ELSE 'true'::jsonb END);
      END IF;
    ELSIF entry.key = 'transcription' AND entry.value->>'status' = 'ready' THEN
      result := result || jsonb_build_object('transcription',
        '{"status":"ready"}'::jsonb || for_now.source_unknown_projection(entry.value, 'transcription'));
    ELSIF source_field = 'transcription' AND entry.key IN ('rawText', 'polishedText', 'condensedText') THEN
      IF for_now.source_has_text(entry.value) THEN
        result := result || jsonb_build_object(entry.key, 'present');
      END IF;
    ELSIF entry.key = 'imageUnderstandings' AND jsonb_typeof(entry.value) = 'array' THEN
      result := result || jsonb_build_object('imageUnderstandings', (
        SELECT COALESCE(jsonb_agg(for_now.source_unknown_projection(item, 'image')), '[]'::jsonb)
        FROM jsonb_array_elements(entry.value) item
      ));
    ELSIF source_field = 'image' AND entry.key IN ('text', 'summary', 'description') THEN
      IF entry.value NOT IN ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb) THEN
        result := result || jsonb_build_object(entry.key,
          CASE WHEN for_now.source_has_text(entry.value)
            THEN '"present"'::jsonb ELSE 'true'::jsonb END);
      END IF;
    END IF;
  END LOOP;
  RETURN result;
END $$;
ALTER TABLE for_now.store_objects
  ADD COLUMN IF NOT EXISTS source_calendar_hints text[] GENERATED ALWAYS AS (
    CASE WHEN collection IN ('checkins', 'dailyRecords', 'thoughts', 'journals', 'captures', 'quotes', 'keepsakes')
      AND (parent_key IS NULL OR field IN ('remarks', 'followUps', 'reflections'))
      THEN for_now.source_calendar_hints(payload) ELSE ARRAY[]::text[] END
  ) STORED,
  ADD COLUMN IF NOT EXISTS source_occurrence_may_be_unknown boolean GENERATED ALWAYS AS (
    CASE WHEN collection IN ('checkins', 'dailyRecords', 'thoughts', 'journals', 'captures', 'quotes', 'keepsakes')
      AND (parent_key IS NULL OR field IN ('remarks', 'followUps', 'reflections'))
      THEN COALESCE(for_now.source_unknown_candidate(payload, field), true) ELSE false END
  ) STORED,
  ADD COLUMN IF NOT EXISTS source_unknown_projection jsonb GENERATED ALWAYS AS (
    CASE WHEN collection IN ('checkins', 'dailyRecords', 'thoughts', 'journals', 'captures', 'quotes', 'keepsakes')
      AND (parent_key IS NULL OR field IN ('remarks', 'followUps', 'reflections'))
      THEN for_now.source_unknown_projection(payload, field) ELSE '{}'::jsonb END
  ) STORED,
  ADD COLUMN IF NOT EXISTS source_calendar_first text GENERATED ALWAYS AS (
    (for_now.source_calendar_hints(payload))[1]
  ) STORED,
  ADD COLUMN IF NOT EXISTS source_calendar_last text GENERATED ALWAYS AS (
    (for_now.source_calendar_hints(payload))[cardinality(for_now.source_calendar_hints(payload))]
  ) STORED;
CREATE INDEX IF NOT EXISTS store_objects_source_calendar_idx
  ON for_now.store_objects USING gin(source_calendar_hints)
  WHERE collection IN ('checkins', 'dailyRecords', 'thoughts', 'journals', 'captures', 'quotes', 'keepsakes');
CREATE INDEX IF NOT EXISTS store_objects_unknown_occurrence_idx
  ON for_now.store_objects(account_id, object_key)
  WHERE source_occurrence_may_be_unknown;
CREATE INDEX IF NOT EXISTS store_objects_source_calendar_bounds_idx
  ON for_now.store_objects(account_id, source_calendar_last, source_calendar_first, object_key)
  WHERE collection IN ('checkins', 'dailyRecords', 'thoughts', 'journals', 'captures', 'quotes', 'keepsakes');
CREATE INDEX IF NOT EXISTS store_objects_compression_state_idx
  ON for_now.store_objects(account_id, status, object_key)
  WHERE collection = 'aiTasks' AND payload->>'kind' = 'recordCompression';

CREATE OR REPLACE FUNCTION for_now.compression_task_range(document jsonb)
RETURNS text[] LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  candidate text;
  start_day date;
  end_day date;
BEGIN
  FOREACH candidate IN ARRAY ARRAY[document->>'windowEnd', document->>'localDate'] LOOP
    IF candidate ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
      BEGIN
        end_day := candidate::date;
        IF to_char(end_day, 'YYYY-MM-DD') = candidate THEN EXIT; END IF;
        end_day := NULL;
      EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
        end_day := NULL;
      END;
    END IF;
  END LOOP;
  IF end_day IS NULL THEN RETURN NULL; END IF;
  candidate := document->>'windowStart';
  IF candidate ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
    BEGIN
      start_day := candidate::date;
      IF to_char(start_day, 'YYYY-MM-DD') <> candidate THEN start_day := NULL; END IF;
    EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
      start_day := NULL;
    END;
  END IF;
  start_day := COALESCE(start_day, end_day - 6);
  IF start_day > end_day OR end_day - start_day >= 365 THEN RETURN NULL; END IF;
  RETURN ARRAY[to_char(start_day, 'YYYY-MM-DD'), to_char(end_day, 'YYYY-MM-DD')];
END $$;
ALTER TABLE for_now.store_objects
  ADD COLUMN IF NOT EXISTS compression_task_timezone text GENERATED ALWAYS AS (
    CASE WHEN collection = 'aiTasks' THEN payload->'payload'->>'timezone' END
  ) STORED,
  ADD COLUMN IF NOT EXISTS compression_task_prompt_version text GENERATED ALWAYS AS (
    CASE WHEN collection = 'aiTasks' THEN payload->'payload'->>'promptVersion' END
  ) STORED,
  ADD COLUMN IF NOT EXISTS compression_task_range_start text GENERATED ALWAYS AS (
    CASE WHEN collection = 'aiTasks' AND payload->'payload'->>'operation' = 'historicalSupplement'
      THEN (for_now.compression_task_range(payload->'payload'))[1] END
  ) STORED,
  ADD COLUMN IF NOT EXISTS compression_task_range_end text GENERATED ALWAYS AS (
    CASE WHEN collection = 'aiTasks' AND payload->'payload'->>'operation' = 'historicalSupplement'
      THEN (for_now.compression_task_range(payload->'payload'))[2] END
  ) STORED;
CREATE INDEX IF NOT EXISTS store_objects_historical_task_range_idx
  ON for_now.store_objects(account_id, compression_task_timezone,
    compression_task_range_start, compression_task_range_end, compression_task_prompt_version, object_key)
  WHERE collection = 'aiTasks' AND payload->>'kind' = 'recordCompression'
    AND status = 'succeeded' AND payload->'payload'->>'operation' = 'historicalSupplement';
CREATE INDEX IF NOT EXISTS store_objects_historical_task_coverage_idx
  ON for_now.store_objects(account_id, compression_task_timezone,
    compression_task_prompt_version, compression_task_range_start, object_key)
  WHERE collection = 'aiTasks' AND payload->>'kind' = 'recordCompression'
    AND status = 'succeeded' AND payload->'payload'->>'operation' = 'historicalSupplement';

-- migration:task-importance-score-index-v1
-- Retain the original field for lossless legacy reads. Only writes to that
-- field maintain this query index; ordinary answer preparation never expands it.
CREATE TABLE IF NOT EXISTS for_now.importance_score_index (
  account_id text NOT NULL,
  field text NOT NULL DEFAULT 'importanceScores' CHECK (field = 'importanceScores'),
  ordinal bigint NOT NULL CHECK (ordinal > 0),
  source_key text,
  source_version jsonb,
  content_sha256 jsonb,
  payload jsonb NOT NULL,
  PRIMARY KEY (account_id, ordinal),
  FOREIGN KEY (account_id, field) REFERENCES for_now.store_fields(account_id, field)
    ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS importance_score_source_idx
  ON for_now.importance_score_index(account_id, source_key, source_version, content_sha256);
ALTER TABLE for_now.importance_score_index ENABLE ROW LEVEL SECURITY;
ALTER TABLE for_now.importance_score_index FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'for_now'
      AND tablename = 'importance_score_index' AND policyname = 'account_isolation'
  ) THEN
    CREATE POLICY account_isolation ON for_now.importance_score_index
      USING (account_id = current_setting('app.account_id', true))
      WITH CHECK (account_id = current_setting('app.account_id', true));
  END IF;
END $$;
CREATE OR REPLACE FUNCTION for_now.refresh_importance_score_index()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  scores jsonb;
BEGIN
  scores := CASE WHEN jsonb_typeof(NEW.payload) = 'array'
    THEN NEW.payload ELSE '[]'::jsonb END;
  INSERT INTO for_now.importance_score_index(
    account_id, ordinal, source_key, source_version, content_sha256, payload
  )
  SELECT NEW.account_id, score.ordinal, score.value->>'sourceKey',
    score.value->'sourceVersion', score.value->'contentSha256', score.value
  FROM jsonb_array_elements(scores) WITH ORDINALITY score(value, ordinal)
  ON CONFLICT (account_id, ordinal) DO UPDATE SET
    source_key = EXCLUDED.source_key,
    source_version = EXCLUDED.source_version,
    content_sha256 = EXCLUDED.content_sha256,
    payload = EXCLUDED.payload
  WHERE importance_score_index.payload IS DISTINCT FROM EXCLUDED.payload;
  DELETE FROM for_now.importance_score_index
  WHERE account_id = NEW.account_id AND ordinal > jsonb_array_length(scores);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS importance_score_index_write ON for_now.store_fields;
CREATE TRIGGER importance_score_index_write
  AFTER INSERT OR UPDATE OF payload ON for_now.store_fields
  FOR EACH ROW WHEN (NEW.field = 'importanceScores')
  EXECUTE FUNCTION for_now.refresh_importance_score_index();
INSERT INTO for_now.importance_score_index(
  account_id, ordinal, source_key, source_version, content_sha256, payload
)
SELECT configuration.account_id, score.ordinal, score.value->>'sourceKey',
  score.value->'sourceVersion', score.value->'contentSha256', score.value
FROM for_now.store_fields configuration
CROSS JOIN LATERAL jsonb_array_elements(CASE
  WHEN jsonb_typeof(configuration.payload) = 'array' THEN configuration.payload
  ELSE '[]'::jsonb END) WITH ORDINALITY score(value, ordinal)
WHERE configuration.field = 'importanceScores'
ON CONFLICT (account_id, ordinal) DO UPDATE SET
  source_key = EXCLUDED.source_key,
  source_version = EXCLUDED.source_version,
  content_sha256 = EXCLUDED.content_sha256,
  payload = EXCLUDED.payload
WHERE importance_score_index.payload IS DISTINCT FROM EXCLUDED.payload;
