/**
 * 将持久待提交队列限定到实际工作区，保留对外真实账户身份。
 * 建立时间：2026-10-16
 * 状态：active
 * 边界：只改变本机队列存储命名空间，不改变业务ID、服务器账户或持久映射内容。
 */
type Row = { owner: string; [key: string]: unknown };
type Store = {
  readonly durable?: boolean;
  put(record: Row): Promise<Row>;
  get(owner: string, id: string): Promise<Row | null>;
  list(owner: string, statuses?: string[]): Promise<Row[]>;
  clear(owner: string): Promise<unknown>;
  delete?(owner: string, id: string): Promise<unknown>;
  readMappings?(owner: string): Promise<unknown[]>;
  atomicWrite?(owner: string, expected: Row[], mappings: unknown[], next: Row[], nextMappings: unknown[]): Promise<boolean>;
};
/**
 * 为已捕获工作区创建无状态存储适配；异步结束仍写原命名空间，不能跟随当前页面切换。
 * 空工作区直接复用旧存储；旧普通账户队列保持可读，历史未知测试工作区材料不自动搬迁。
 * @since unreleased
 */
export function workspaceSyncStore(store: Store, workspace: string): Store {
  if (!workspace) return store;
  const storageOwner = (owner: string) => `workspace:${JSON.stringify([owner, workspace])}`;
  const encode = (row: Row): Row => ({ ...row, owner: storageOwner(row.owner) });
  const decode = (row: Row, owner: string): Row => ({ ...row, owner });
  return {
    get durable() { return store.durable; },
    async put(row) { return decode(await store.put(encode(row)), row.owner); },
    async get(owner, id) {
      const row = await store.get(storageOwner(owner), id);
      return row ? decode(row, owner) : null;
    },
    async list(owner, statuses) {
      return (await store.list(storageOwner(owner), statuses)).map(row => decode(row, owner));
    },
    clear: owner => store.clear(storageOwner(owner)),
    ...(store.delete ? { delete: (owner: string, id: string) => store.delete!(storageOwner(owner), id) } : {}),
    ...(store.readMappings ? { readMappings: (owner: string) => store.readMappings!(storageOwner(owner)) } : {}),
    ...(store.atomicWrite ? {
      atomicWrite: (owner: string, expected: Row[], mappings: unknown[], next: Row[], nextMappings: unknown[]) =>
        store.atomicWrite!(storageOwner(owner), expected.map(encode), mappings, next.map(encode), nextMappings)
    } : {})
  };
}
