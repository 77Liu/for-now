// The service owns session expiry; this adapter owns the serialized document write.
export function createAuthRepository({ runtime, file, readDocument, writeDocument, onCommit, onInvalid }) {
  if (runtime) {
    return {
      read: runtime.auth.read,
      provision: runtime.auth.provision,
      async update(mutator) {
        let before, after;
        const result = await runtime.auth.update(async auth => {
          before = structuredClone(auth);
          const value = await mutator(auth);
          after = structuredClone(auth);
          return value;
        });
        await onCommit(before, after);
        return result;
      }
    };
  }
  let queue = Promise.resolve();
  const read = async () => {
    const value = await readDocument(file, { version: 1, users: [], sessions: [] });
    if (!Array.isArray(value.users) || !Array.isArray(value.sessions)) {
      await onInvalid();
      throw Object.assign(new Error("认证数据无法读取，已保留原文件，请联系管理员"), { code: "STORAGE_READ_FAILED" });
    }
    return value;
  };
  return {
    read,
    update(mutator) {
      const operation = queue.then(async () => {
        const auth = await read(), before = structuredClone(auth);
        const result = await mutator(auth);
        await writeDocument(file, auth);
        await onCommit(before, auth);
        return result;
      });
      queue = operation.catch(() => {});
      return operation;
    }
  };
}
