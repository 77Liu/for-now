import {
  findIdempotencyResponse,
  persistenceMetadata,
  preparePersistenceDocument,
  publicPersistenceDocument,
  recordIdempotencyResponse,
  synchronizePersistenceMetadata
} from "./persistence-metadata.mjs";

import { bindBusinessIdResponse, withBusinessIdTransaction } from "../../../.build/typescript/backend/shared/persistence/business-identifiers.mjs";

const queues = new Map();

/**
 * 维护同一真实文件的串行账户仓储。
 * 新增onCommitted（unreleased）只在落盘成功后、审计前提供best-effort提示，失败不改提交结果。
 */
export function createJsonStoreRepository({
  getFile,
  readDocument,
  writeDocument,
  normalize,
  emptyDocument,
  clone = structuredClone,
  onCommit = async () => {},
  onCommitted = () => {},
  now = () => new Date().toISOString(),
  getContext = () => ({}),
  authorize = () => {},
  assertCommit = () => {}
}) {
  const afterCommit = Symbol.for("for-now.after-commit");
  const hintCommitted = (file, document) => {
    try { void Promise.resolve(onCommitted({ storageScope: file, cursor: document._persistence?.sync?.cursor })).catch(() => {}); } catch {}
  };

  const runExclusive = operation => {
    const file = getFile();
    const previous = queues.get(file) || Promise.resolve();
    authorize();
    const current = previous.then(() => { authorize(); return operation(file); });
    queues.set(file, current.catch(() => {}));
    return current;
  };

  const readInternal = async file => {
    authorize();
    const value = await readDocument(file, emptyDocument);
    authorize();
    return preparePersistenceDocument(normalize(value), now);
  };
  const read = async () => publicPersistenceDocument(await readInternal(getFile()));

  const transact = operation => runExclusive(async file => {
    const document = await readInternal(file);
    let before = clone(document);
    const commit = async () => {
      assertCommit(before, document);
      synchronizePersistenceMetadata(before, document, now, { context: getContext() || {} });
      await writeDocument(file, document);
      hintCommitted(file, document);
      const context = getContext();
      if (context?.clientOperationId) context.operationCommitted = true;
      await onCommit(publicPersistenceDocument(before), publicPersistenceDocument(document));
      before = clone(document);
    };
    return withBusinessIdTransaction(document, () => operation({ document, file, commit }));
  });

  const update = mutator => transact(async ({ document, commit }) => {
    const result = bindBusinessIdResponse(await mutator(document), getContext() || {});
    await commit();
    await result?.[afterCommit]?.();
    return result;
  });
  const replace = (value, { beforeWrite = async () => {} } = {}) => runExclusive(async file => {
    const before = await readInternal(file);
    await beforeWrite(publicPersistenceDocument(before), file);
    const document = preparePersistenceDocument(normalize(clone(value)), now, { force: true });
    assertCommit(before, document);
    await writeDocument(file, document);
    hintCommitted(file, document);
    await onCommit(publicPersistenceDocument(before), publicPersistenceDocument(document));
    return publicPersistenceDocument(document);
  });

  const executeIdempotent = (request, operation, { onReplay = value => value } = {}) => transact(async ({ document, commit }) => {
    const replay = findIdempotencyResponse(document, request, now);
    if (replay !== undefined) {
      const context = getContext() || {};
      const result = bindBusinessIdResponse(onReplay(clone(replay)), context);
      context.operationCommitted = true;
      return clone(result);
    }
    const response = bindBusinessIdResponse(await operation(document), getContext() || {});
    recordIdempotencyResponse(document, { ...request, response }, now);
    await commit();
    return clone(response);
  });

  return {
    /** 当前受信数据文件作用域，包含local-test独立工作目录。 @since unreleased */
    syncScope: () => getFile(),
    read,
    update,
    replace,
    transact,
    withExclusive(operation) {
      return runExclusive(async file => operation({
        file,
        document: publicPersistenceDocument(await readInternal(file))
      }));
    },
    executeIdempotent,
    readIdempotent: request => runExclusive(async file => {
      const replay = findIdempotencyResponse(await readInternal(file), request, now);
      return replay === undefined ? undefined : clone(replay);
    }),
    readPersistenceMetadata: () => runExclusive(async file => persistenceMetadata(await readInternal(file))),
    /** JSON兼容同步端口，仍读取完整文件，不模拟SQL局部读取。 @since unreleased */
    readSyncChanges: () => runExclusive(async file => {
      const document = await readInternal(file);
      return { document: publicPersistenceDocument(document), metadata: persistenceMetadata(document) };
    }),
    /** 从真实同步元数据查询操作回执；与幂等ledger分离。 @since unreleased */
    readOperationReceipt: operationId => runExclusive(async file => {
      const metadata = persistenceMetadata(await readInternal(file));
      return clone(metadata.sync.operations.find(item => item.operationId === operationId));
    }),
    readSyncSnapshot: () => runExclusive(async file => {
      const document = await readInternal(file);
      return {
        document: publicPersistenceDocument(document),
        metadata: persistenceMetadata(document)
      };
    }),
    waitForIdle(file = getFile()) {
      return queues.get(file) || Promise.resolve();
    }
  };
}
