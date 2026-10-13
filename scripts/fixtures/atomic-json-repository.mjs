export function createAtomicRepository(initial = {}) {
  let document = structuredClone(initial);
  let queue = Promise.resolve();

  return {
    async read() {
      await queue;
      return structuredClone(document);
    },
    update(mutator) {
      const operation = queue.then(async () => {
        const working = structuredClone(document);
        const result = await mutator(working);
        document = structuredClone(working);
        return structuredClone(result);
      });
      queue = operation.catch(() => {});
      return operation;
    }
  };
}
