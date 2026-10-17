/**
 * Registers ordered PostgreSQL schema components owned by the active serial stage.
 * Established: 2026-10-18
 * Status: active
 * Boundary: registration validates ownership and source markers; SQL remains in postgres-schema.sql.
 */

export type MigrationDescriptor = Readonly<{
  id: string;
  order: number;
  ownerRequirementId: string;
  marker: string;
}>;

export const POSTGRES_SCHEMA_COMPONENTS: readonly MigrationDescriptor[] = Object.freeze([
  Object.freeze({
    id: "core-schema-v1",
    order: 10,
    ownerRequirementId: "legacy-core",
    marker: "migration:core-schema-v1"
  }),
  Object.freeze({
    id: "ai-audit-v1",
    order: 20,
    ownerRequirementId: "reczz28ORRaxSCBn",
    marker: "migration:ai-audit-v1"
  }),
  Object.freeze({
    id: "auth-row-v1",
    order: 30,
    ownerRequirementId: "reczz28ORRaxPAap",
    marker: "migration:auth-row-v1"
  })
]);

/**
 * Rejects duplicate, unordered, or missing schema registrations before executing SQL.
 * @since unreleased
 */
export function assertPostgresSchemaRegistry(schema: string): void {
  const ids = new Set<string>();
  let previousOrder = Number.NEGATIVE_INFINITY;
  for (const descriptor of POSTGRES_SCHEMA_COMPONENTS) {
    if (!descriptor.id || ids.has(descriptor.id)) {
      throw new Error(`Duplicate PostgreSQL schema component: ${descriptor.id}`);
    }
    if (!Number.isSafeInteger(descriptor.order) || descriptor.order <= previousOrder) {
      throw new Error(`PostgreSQL schema component order is invalid: ${descriptor.id}`);
    }
    if (!schema.includes(descriptor.marker)) {
      throw new Error(`PostgreSQL schema component marker is missing: ${descriptor.id}`);
    }
    ids.add(descriptor.id);
    previousOrder = descriptor.order;
  }
}
