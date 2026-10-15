/**
 * 串行维护认证文档；会话有效期由认证服务处理。
 * JSON缺失仅在canInitialize证明全新实例时初始化；已观察的文档丢失不得重建。
 * onInvalid接收失败原因，交由运行时停止共享认证准入；PostgreSQL保持事务仓储契约。
 */
export function createAuthRepository({ runtime, file, readDocument, writeDocument, onCommit, onInvalid, canInitialize = async () => false }) {
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
  // 缺失不同于空库：一旦观察到真实认证文档，后续丢失禁止重新初始化。
  let observedDocument = false;
  const read = async () => {
    const value = await readDocument(file, null);
    if (value === null) {
      let bootstrap = false;
      try { bootstrap = !observedDocument && await canInitialize(); }
      catch (error) { await onInvalid(error); throw error; }
      if (bootstrap) return { version: 1, users: [], sessions: [] };
      const error = Object.assign(new Error("认证数据缺失，已保留账户数据，禁止重新初始化"), {
        code: "AUTH_STORAGE_MISSING", statusCode: 503
      });
      await onInvalid(error);
      throw error;
    }
    observedDocument = true;
    if (!Array.isArray(value.users) || !Array.isArray(value.sessions)) {
      const error = Object.assign(new Error("认证数据无法读取，已保留原文件，请联系管理员"), { code: "STORAGE_READ_FAILED", statusCode: 503 });
      await onInvalid(error);
      throw error;
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
        observedDocument = true;
        await onCommit(before, auth);
        return result;
      });
      queue = operation.catch(() => {});
      return operation;
    }
  };
}
