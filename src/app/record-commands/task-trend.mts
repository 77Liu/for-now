/**
 * 任务消费的趋势资料装配与现有领域投影。
 * 建立时间：2026-10-19
 * 状态：active
 * 边界：只读事务分页来源；不调用模型、不保存压缩记录或改动覆盖率口径。
 */
import type { ObjectRow, RecordEntity, RecordStore, StoreMapping } from "../../shared/persistence/record-command-types.mjs";
import { RECORD_QUERY_LIMITS } from "../../shared/persistence/record-query-limits.mjs";
import {
  rebuildTaskCollections, TASK_PREPARATION_COLUMNS,
  type QueryContext, type TaskPreparationReader
} from "./task-preparation.mjs";
import { materialTreeRows, readMaterialPermissions } from "./task-material-sources.mjs";
import {
  taskTrendSourcePages, taskTrendUnknownPages, readTrendHistoricalTasks, type TrendReadRequirements
} from "./task-trend-sources.mjs";

type Dependencies = {
  mapping: StoreMapping;
  permissionKeys(store: RecordStore): string[];
  project(store: RecordStore, asOf: string, inputProjection?: InputProjection): unknown;
  createInputProjection?(accountId: string, asOf: string, requirements?: TrendReadRequirements): InputProjection;
  readRequirements?(store: RecordStore, asOf: string): TrendReadRequirements;
  sourceDates?(store: RecordStore, timezone: string, asOf: string): string[];
  timezones?(): string[];
  legacySelection?(
    store: RecordStore, collection: string, purposes: string[]
  ): { complete: boolean; ids: string[] };
  now(): string;
};
type InputProjection = {
  add(store: RecordStore, permission: unknown): void;
  addUnknownSources?(store: RecordStore, ignoredRoots?: {
    resourceType: string; resourceId: string
  }[]): void;
  seal(): void;
  inputForDate(request: Record<string, unknown>): unknown;
  sourceLocalDates?(timezone: string, asOf: string): string[];
  includeDate?(timezone: string, localDate: string): void;
};
function legacyEligibility(collection: string, purposes: string[]) {
  const resourceType = ({
    checkins: "checkin",
    dailyRecords: "dailyRecord",
    captures: "capture",
    journals: "journal",
    thoughts: "thought"
  } as Record<string, string>)[collection];
  if (!resourceType) {
    return {
      resourceType: "",
      filter: collection === "analyses" ? `
        AND payload->>'reason' IN ('manual', 'weekly-background')
        AND payload->>'reviewStatus' = 'confirmed'
        AND payload->'contextReceipt'->>'permissionPurpose' = 'learning'
        AND length(trim(COALESCE(payload->>'content', ''))) > 0
      ` : collection === "actions" ? `
        AND (
          (payload->'completionFeedback'->'learningAllowed' = 'true'::jsonb
            AND (payload->'completionFeedback'->>'outcome' IN ('helpful', 'mixed', 'unhelpful', 'unsure')
              OR length(trim(COALESCE(payload->'completionFeedback'->>'note', ''))) > 0))
          OR EXISTS (
            SELECT 1 FROM jsonb_array_elements(CASE
              WHEN jsonb_typeof(payload->'statusHistory') = 'array' THEN payload->'statusHistory'
              ELSE '[]'::jsonb END) history
            WHERE history->>'to' = 'done' AND history->'feedback'->'learningAllowed' = 'true'::jsonb
              AND (history->'feedback'->>'outcome' IN ('helpful', 'mixed', 'unhelpful', 'unsure')
                OR length(trim(COALESCE(history->'feedback'->>'note', ''))) > 0)
          )
        )
      ` : ""
    };
  }
  const root = `CASE WHEN source.collection = 'thoughts' THEN
      CASE WHEN source.payload->>'type' = 'question' THEN source.id
        ELSE COALESCE(source.payload->>'relatedTo', '') END
      ELSE '' END`;
  const target = `CASE WHEN source.collection = 'thoughts' THEN
      COALESCE(source.payload->>'type', '') || ':' || source.id ELSE '' END`;
  const identity = `permission.permission_resource_type = $5
    AND permission.permission_resource_id = source.id
    AND permission.permission_root_id = ${root}
    AND permission.permission_target_key = ${target}`;
  const contextAllowed = `COALESCE((
    SELECT permission.payload->'contextAllowed' IS NOT DISTINCT FROM 'true'::jsonb
    FROM for_now.store_objects permission
    WHERE permission.account_id = $1 AND ${identity}
      AND permission.collection = 'evidencePermissions'
    LIMIT 1
  ), true)`;
  const learningAllowed = `COALESCE((
    SELECT permission.payload->'learningAllowed' IS NOT DISTINCT FROM 'true'::jsonb
    FROM for_now.store_objects permission
    WHERE permission.account_id = $1 AND ${identity}
      AND permission.collection = 'evidencePermissions'
    LIMIT 1
  ), false)`;
  const allowed = [];
  if (purposes.includes("context")) {
    const question = collection === "thoughts"
      ? "(payload->>'type' = 'question' AND author_type <> 'ai') AND " : "";
    allowed.push(question + contextAllowed);
  }
  if (purposes.includes("learning")) {
    // Learning thoughts page permission-root metadata; the domain selection
    // applies authorship, text and follow-up eligibility after the page loads.
    allowed.push(learningAllowed);
  }
  return {
    resourceType,
    filter: `
      AND payload->'contextAllowed' IS DISTINCT FROM 'false'::jsonb
      AND payload->'allowInContext' IS DISTINCT FROM 'false'::jsonb
      AND payload->>'disposition' IS DISTINCT FROM 'discarded'
      AND (${allowed.join(" OR ")})
    `
  };
}

/** 保留来源正文、日期继承和旧增量槽未知时间计数；成本单独验收。 @since unreleased */
export function createTaskTrendAssembly(dependencies: Dependencies) {
  const { mapping, project, permissionKeys, now } = dependencies;
  async function *pages(context: QueryContext, collections: string[]) {
    for (const collection of collections) {
      let after = "";
      for (;;) {
        const page = await context.client.query<ObjectRow>(`
          SELECT ${TASK_PREPARATION_COLUMNS} FROM for_now.store_objects
          WHERE account_id = $1 AND collection = $2 AND parent_key IS NULL
            AND object_key > $3
          ORDER BY object_key LIMIT $4
        `, [context.accountId, collection, after, RECORD_QUERY_LIMITS.keyBatch]);
        if (!page.rows.length) break;
        yield await materialTreeRows(context, page.rows);
        after = page.rows.at(-1)!.objectKey;
      }
    }
  }
  async function readCollections(context: QueryContext, collections: string[]) {
    const rows: ObjectRow[] = [];
    for await (const page of pages(context, collections)) rows.push(...page);
    return rows;
  }
  async function permissions(context: QueryContext, store: RecordStore) {
    const refs = new Set(permissionKeys(store));
    const add = (resourceType: string, item: RecordEntity, rootId = "", targetKey = "") => {
      refs.add(JSON.stringify([resourceType, item.id, rootId, targetKey]));
    };
    for (const thought of store.thoughts || []) {
      add("thought", thought, thought.type === "question" ? thought.id : thought.relatedTo || "",
        `${thought.type}:${thought.id}`);
      const followUps = thought.followUps as RecordEntity[] | undefined;
      for (const followUp of followUps || []) {
        add("thought", followUp, thought.id, `followup-answer:${followUp.id}`);
      }
    }
    for (const quote of store.quotes || []) add("quote", quote);
    return readMaterialPermissions(context, store, [...refs]);
  }
  return Object.freeze({
    async trendContext(context: QueryContext, task: RecordEntity) {
      if (!["thoughtAnswer", "followUpAnswer"].includes(String(task.kind))) return null;
      const asOf = String(task.contextGeneratedAt || task.createdAt || now());
      if (!dependencies.createInputProjection || !dependencies.sourceDates || !dependencies.timezones) {
        throw new TypeError("Task trend requires its domain input projection");
      }
      const { store, requirements } = await readTrendDependencies(context, asOf);
      const plannedDates = new Set(requirements.dates.flatMap(row => row.localDates));
      const inputProjection = await readTrendInputs(context, asOf, requirements, plannedDates);
      const summaries = await context.client.query<ObjectRow>(`
        SELECT ${TASK_PREPARATION_COLUMNS} FROM for_now.store_objects
        WHERE account_id = $1 AND collection = 'recordCompressions'
          AND parent_key IS NULL AND record_local_date = ANY($2::text[])
        ORDER BY object_key LIMIT $3
      `, [context.accountId, [...plannedDates], RECORD_QUERY_LIMITS.closureRows + 1]);
      if (summaries.rows.length > RECORD_QUERY_LIMITS.closureRows) {
        throw new RangeError("Task trend summary dependency limit exceeded");
      }
      store.recordCompressions = rebuildTaskCollections(mapping, summaries.rows).recordCompressions || [];
      return project(store, asOf, inputProjection);
    },
    async legacyContext(
      context: QueryContext, reader: TaskPreparationReader, purposes = ["context", "learning"]
    ) {
      if (!dependencies.legacySelection) {
        throw new TypeError("Legacy task receipt requires its domain selection");
      }
      const scanned = new Set<string>();
      const reserve = (rows: ObjectRow[]) => {
        for (const row of rows) scanned.add(row.objectKey);
        if (scanned.size > RECORD_QUERY_LIMITS.closureRows) {
          throw new RangeError("Legacy task context closure limit exceeded");
        }
      };
      for (const purpose of [...new Set(purposes)]) {
        const collections = ["checkins", "dailyRecords", "captures", "journals", "thoughts"];
        if (purpose === "learning") collections.push("actions");
        if (purpose === "context") collections.push("analyses");
        for (const collection of collections) {
          await legacyCollection(context, reader, collection, purpose, reserve);
        }
      }
    }
  });

  function nextDate(date: string) {
    const instant = new Date(`${date}T00:00:00Z`);
    instant.setUTCDate(instant.getUTCDate() + 1);
    return instant.toISOString().slice(0, 10);
  }

  async function readTrendDependencies(context: QueryContext, asOf: string) {
    const store = rebuildTaskCollections(mapping,
      await readCollections(context, ["historicalUserSupplement"]));
    const tasks = await context.client.query<ObjectRow>(`
      SELECT ${TASK_PREPARATION_COLUMNS} FROM for_now.store_objects
      WHERE account_id = $1 AND collection = 'aiTasks'
        AND payload->>'kind' = 'recordCompression'
        AND status = 'failed'
      ORDER BY object_key LIMIT $2
    `, [context.accountId, RECORD_QUERY_LIMITS.closureRows + 1]);
    if (tasks.rows.length > RECORD_QUERY_LIMITS.closureRows) {
      throw new RangeError("Task trend compression dependency limit exceeded");
    }
    store.aiTasks = rebuildTaskCollections(mapping, tasks.rows).aiTasks || [];
    const initialRequirements = dependencies.readRequirements?.(store, asOf);
    if (!initialRequirements) throw new TypeError("Task trend requires its domain read requirements");
    const historicalTasks = await readTrendHistoricalTasks(context,
      initialRequirements.historicalTasks || []);
    const ordering = await context.client.query<{ positioned: boolean }>(`
      SELECT NOT EXISTS (
        SELECT 1 FROM for_now.store_objects
        WHERE account_id = $1 AND collection = 'aiTasks' AND parent_key IS NULL
          AND position IS NULL
      ) AS positioned
    `, [context.accountId]);
    const taskRows = [...tasks.rows, ...historicalTasks];
    store.aiTasks = rebuildTaskCollections(mapping, ordering.rows[0].positioned
      ? taskRows : taskRows.map(row => ({ ...row, position: null }))).aiTasks || [];
    const requirements = dependencies.readRequirements?.(store, asOf);
    if (!requirements) throw new TypeError("Task trend requires its domain read requirements");
    return { store, requirements };
  }

  async function readTrendInputs(
    context: QueryContext, asOf: string, requirements: TrendReadRequirements,
    plannedDates: Set<string>
  ): Promise<InputProjection> {
    const inputProjection = dependencies.createInputProjection!(context.accountId, asOf, requirements);
    const dates = new Map(requirements.dates.map(row => [row.timezone, new Set(row.localDates)]));
    for (const interval of requirements.presence) {
      for (let date = interval.startDate; date <= interval.endDate; date = nextDate(date)) {
        inputProjection.includeDate!(interval.timezone, date);
      }
    }
    const included = new Set<string>();
    const addPage = async (page: ObjectRow[]) => {
      const source = rebuildTaskCollections(mapping, page);
      await permissions(context, source);
      const fresh = page.filter(row => !included.has(row.objectKey));
      if (fresh.length) {
        for (const row of fresh) included.add(row.objectKey);
        const freshStore = rebuildTaskCollections(mapping, fresh);
        freshStore.evidencePermissions = source.evidencePermissions;
        inputProjection.add(freshStore, undefined);
      }
      return source;
    };
    for await (const page of taskTrendSourcePages(context, [...plannedDates])) {
      await addPage(page);
    }
    if (!inputProjection.addUnknownSources) {
      throw new TypeError("Task trend requires its domain unknown-source projection");
    }
    // Even an empty scan replaces counts accumulated from the dated source pages.
    inputProjection.addUnknownSources({});
    for await (const page of taskTrendUnknownPages(context)) {
      const source = rebuildTaskCollections(mapping, page.rows);
      await permissions(context, source);
      inputProjection.addUnknownSources(source, page.ignoredRoots);
    }
    for (const interval of requirements.presence) {
      for (let date = interval.startDate; date <= interval.endDate; date = nextDate(date)) {
        dates.get(interval.timezone)!.add(date);
        const witness = dependencies.createInputProjection!(context.accountId, asOf, {
          dates: [{ timezone: interval.timezone, localDates: [date] }],
          presence: []
        });
        for await (const page of taskTrendSourcePages(context, [date])) {
          witness.add(await addPage(page), undefined);
        }
        witness.seal();
        const input = witness.inputForDate({
          accountId: context.accountId,
          asOf,
          timezone: interval.timezone,
          localDate: date
        }) as {
          userSources: { sourceId: string; text?: string }[];
          sourceManifest: { sourceId: string; origin: string }[];
        };
        const originals = new Set(input.sourceManifest.filter(row => row.origin === "user_original")
          .map(row => row.sourceId));
        if (input.userSources.some(row => row.text?.trim() && originals.has(row.sourceId))) break;
      }
    }
    inputProjection.seal();
    return {
      ...inputProjection,
      sourceLocalDates: timezone => [...dates.get(timezone) || []].sort()
    };
  }

  async function legacyCollection(
    context: QueryContext,
    reader: TaskPreparationReader,
    collection: string,
    purpose: string,
    reserve: (rows: ObjectRow[]) => void
  ) {
    const { roots, rows, permissionRows, selection } = await readLegacyPrefix(
      context, collection, purpose, reserve
    );
    for (const row of permissionRows) reader.include(row);
    const selectedKeys = new Set(roots.filter(row => selection.ids.includes(row.id))
      .map(row => row.objectKey));
    for (const row of rows) {
      const rootId = JSON.parse(row.objectKey)[1];
      if (selectedKeys.has(row.objectKey) || selection.ids.includes(rootId)) reader.include(row);
    }
    if (collection !== "thoughts" || purpose !== "context") return;
    const related = await context.client.query<ObjectRow>(`
      SELECT ${TASK_PREPARATION_COLUMNS} FROM for_now.store_objects
      WHERE account_id = $1 AND collection = 'thoughts' AND object_key IN (
        SELECT object_key FROM for_now.store_relations
        WHERE account_id = $1 AND relation = 'thoughtRoot' AND target_key = ANY($2::text[])
      ) ORDER BY object_key LIMIT $3
    `, [context.accountId, [...selectedKeys], RECORD_QUERY_LIMITS.closureRows + 1]);
    reserve(related.rows);
    for (const row of related.rows) reader.include(row);
    const relatedPermissions = await permissions(
      context, rebuildTaskCollections(mapping, related.rows)
    );
    reserve(relatedPermissions);
    for (const row of relatedPermissions) reader.include(row);
  }

  async function readLegacyPrefix(
    context: QueryContext, collection: string, purpose: string,
    reserve: (rows: ObjectRow[]) => void
  ) {
    const { resourceType, filter } = legacyEligibility(collection, [purpose]);
    const ordering = await context.client.query<{ positioned: boolean }>(`
      SELECT NOT EXISTS (
        SELECT 1 FROM for_now.store_objects
        WHERE account_id = $1 AND collection = $2 AND parent_key IS NULL
          AND position IS NULL
      ) AS positioned
    `, [context.accountId, collection]);
    const positioned = ordering.rows[0].positioned;
    const time = "context_sort_time";
    let offset = 0;
    const roots: ObjectRow[] = [];
    const rows: ObjectRow[] = [];
    let permissionRows: ObjectRow[] = [];
    let selection = { complete: false, ids: [] as string[] };
    const learningThoughts = collection === "thoughts" && purpose === "learning";
    const candidates = learningThoughts ? `
      WITH learning_roots AS MATERIALIZED (
        SELECT DISTINCT '["thoughts",' || to_json(CASE
          WHEN permission_target_key LIKE 'followup-%' THEN permission_root_id
          ELSE permission_resource_id END)::text || ']' AS candidate_key
        FROM for_now.store_objects
        WHERE account_id = $1 AND collection = 'evidencePermissions'
          AND permission_resource_type = 'thought'
          AND payload->'learningAllowed' = 'true'::jsonb
      )
    ` : "";
    const source = learningThoughts ? `
      learning_roots JOIN LATERAL (
        SELECT object_key, collection, parent_key, account_id, position, context_sort_time, id
        FROM for_now.store_objects
        WHERE account_id = $1 AND object_key = learning_roots.candidate_key OFFSET 0
      ) source ON true
    ` : "for_now.store_objects source";
    do {
      const page = await context.client.query<ObjectRow>(`
        ${candidates}
        ${learningThoughts ? `, learning_page AS MATERIALIZED (
          SELECT object_key AS candidate_key FROM ${source}
          WHERE account_id = $1 AND collection = $2 AND parent_key IS NULL
          ORDER BY ${positioned ? "position, " + time + ", id" : time + " DESC, id DESC"}
          LIMIT $3 OFFSET $4
        ) SELECT ${TASK_PREPARATION_COLUMNS}
        FROM learning_page JOIN LATERAL (
          SELECT * FROM for_now.store_objects
          WHERE account_id = $1 AND object_key = learning_page.candidate_key OFFSET 0
        ) source ON true`
          : `SELECT ${TASK_PREPARATION_COLUMNS} FROM ${source}`}
        WHERE account_id = $1 AND collection = $2 AND parent_key IS NULL
          ${learningThoughts ? "" : filter}
        ORDER BY ${positioned ? "position, " + time + ", id" : time + " DESC, id DESC"}
        ${learningThoughts ? "" : "LIMIT $3 OFFSET $4"}
      `, resourceType
        ? [context.accountId, collection, 100, offset, ...(learningThoughts ? [] : [resourceType])]
        : [context.accountId, collection, 100, offset]);
      if (!page.rows.length) break;
      const orderedRoots = positioned ? page.rows
        : page.rows.map(row => ({ ...row, position: null }));
      reserve(orderedRoots);
      roots.push(...orderedRoots);
      const pageRows = collection === "thoughts"
        ? await materialTreeRows(context, orderedRoots) : orderedRoots;
      reserve(pageRows);
      rows.push(...pageRows);
      const store = rebuildTaskCollections(mapping, rows);
      permissionRows = await permissions(context, store);
      reserve(permissionRows);
      selection = dependencies.legacySelection!(store, collection, [purpose]);
      if (selection.complete || page.rows.length < 100) break;
      offset += page.rows.length;
    } while (!selection.complete);
    return { roots, rows, permissionRows, selection };
  }
}
