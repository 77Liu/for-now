import {
  findIdempotencyResponse,
  persistenceMetadata,
  preparePersistenceDocument,
  publicPersistenceDocument,
  recordIdempotencyResponse,
  synchronizePersistenceMetadata
} from "./persistence-metadata.mjs";

const queues = new Map();

export function createJsonStoreRepository({
  getFile,
  readDocument,
  writeDocument,
  normalize,
  emptyDocument,
  clone = structuredClone,
  onCommit = async () => {},
  now = () => new Date().toISOString()
}) {
  const afterCommit = Symbol.for("for-now.after-commit");

  const runExclusive = operation => {
    const file = getFile();
    const previous = queues.get(file) || Promise.resolve();
    const current = previous.then(() => operation(file));
    queues.set(file, current.catch(() => {}));
    return current;
  };

  const readInternal = async file => preparePersistenceDocument(
    normalize(await readDocument(file, emptyDocument)),
    now
  );
  const read = async () => publicPersistenceDocument(await readInternal(getFile()));

  const transact = operation => runExclusive(async file => {
    const document = await readInternal(file);
    let before = clone(document);
    const commit = async () => {
      synchronizePersistenceMetadata(before, document, now);
      await writeDocument(file, document);
      await onCommit(publicPersistenceDocument(before), publicPersistenceDocument(document));
      before = clone(document);
    };
    return operation({ document, file, commit });
  });

  const update = mutator => transact(async ({ document, commit }) => {
    const result = await mutator(document);
    await commit();
    await result?.[afterCommit]?.();
    return result;
  });

  const executeIdempotent = (request, operation, { onReplay = value => value } = {}) => transact(async ({ document, commit }) => {
    const replay = findIdempotencyResponse(document, request, now);
    if (replay !== undefined) return clone(onReplay(clone(replay)));
    const response = await operation(document);
    recordIdempotencyResponse(document, { ...request, response }, now);
    await commit();
    return clone(response);
  });

  return {
    read,
    update,
    transact,
    executeIdempotent,
    readIdempotent: request => runExclusive(async file => {
      const replay = findIdempotencyResponse(await readInternal(file), request, now);
      return replay === undefined ? undefined : clone(replay);
    }),
    readPersistenceMetadata: () => runExclusive(async file => persistenceMetadata(await readInternal(file))),
    waitForIdle(file = getFile()) {
      return queues.get(file) || Promise.resolve();
    }
  };
}
