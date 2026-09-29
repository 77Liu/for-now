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
CREATE TABLE IF NOT EXISTS for_now_auth.migration_state (
  id text PRIMARY KEY CHECK (id = 'bundle'),
  source_sha256 text NOT NULL,
  content_sha256 text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);

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
    'attachment_inventory'
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
  INSERT INTO for_now.store_fields SELECT * FROM jsonb_populate_recordset(NULL::for_now.store_fields, business->'fields');
  INSERT INTO for_now.store_objects SELECT * FROM jsonb_populate_recordset(NULL::for_now.store_objects, business->'objects');
  INSERT INTO for_now.store_relations SELECT * FROM jsonb_populate_recordset(NULL::for_now.store_relations, business->'relations');
  INSERT INTO for_now.store_attachment_refs SELECT * FROM jsonb_populate_recordset(NULL::for_now.store_attachment_refs, business->'attachmentRefs');
  INSERT INTO for_now.resource_lifecycle SELECT * FROM jsonb_populate_recordset(NULL::for_now.resource_lifecycle, business->'lifecycles');
  INSERT INTO for_now.idempotency_ledger SELECT * FROM jsonb_populate_recordset(NULL::for_now.idempotency_ledger, business->'idempotency');
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
