import { promises as fs } from "node:fs";

// The domain supplies normalization and upgrade policy; the adapter owns I/O and serialization.
export function createAccountDocumentRepository({
  runtime, name, getFile, readDocument, writeDocument, normalize, emptyDocument,
  onCommit = null, now = () => new Date().toISOString()
}) {
  const queues = new Map();
  const exclusive = operation => {
    const file = getFile(), previous = queues.get(file) || Promise.resolve();
    const current = previous.then(() => operation(file));
    const settled = current.catch(() => {});
    queues.set(file, settled);
    void settled.then(() => { if (queues.get(file) === settled) queues.delete(file); });
    return current;
  };
  const read = async () => normalize(runtime
    ? await runtime.documents.read(name, emptyDocument)
    : await readDocument(getFile(), emptyDocument));
  const update = async mutator => {
    if (runtime) {
      let before, after;
      const result = await runtime.documents.update(name, emptyDocument, async document => {
        if (onCommit) before = structuredClone(document);
        const value = await mutator(document);
        if (onCommit) after = structuredClone(document);
        return value;
      }, normalize);
      await onCommit?.(before, after);
      return result;
    }
    return exclusive(async file => {
      const document = normalize(await readDocument(file, emptyDocument)), before = onCommit ? structuredClone(document) : null;
      const result = await mutator(document);
      await writeDocument(file, document);
      await onCommit?.(before, document);
      return result;
    });
  };
  const write = async (value, normalizeBefore = normalize) => {
    if (runtime) {
      const before = await normalizeBefore(await read());
      await runtime.documents.write(name, value);
      await onCommit?.(before, value);
      return;
    }
    return exclusive(async file => {
      const before = await normalizeBefore(await readDocument(file, emptyDocument));
      await writeDocument(file, value);
      await onCommit?.(before, value);
    });
  };
  const ensure = async (version, needsBackup) => {
    if (runtime) return runtime.documents.update(name, emptyDocument, () => {}, normalize);
    return exclusive(async file => {
      const original = await readDocument(file, null);
      if (original && needsBackup(original)) {
        const backup = `${file}.v${Number(original.version || 1)}-pre-v${version}.${now().replace(/\D/g, "").slice(0, 14)}.bak`;
        await fs.copyFile(file, backup);
        await fs.chmod(backup, 0o600);
      }
      const normalized = normalize(original || {});
      await writeDocument(file, normalized);
      if (onCommit) await onCommit(normalize(original || {}), normalized);
    });
  };
  return { read, write, update, ensure };
}
