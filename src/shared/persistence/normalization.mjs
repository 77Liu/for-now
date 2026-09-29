// Schema normalization may add defaults/change known values, but must not
// silently discard extensions carried through a lossless database migration.
export function preserveDocumentExtensions(source, normalized) {
  if (Array.isArray(source) && Array.isArray(normalized)) {
    if (normalized.length < source.length) throw new Error("Normalization would discard migrated array elements");
    const identity = row => row && typeof row === "object" ? row.id ?? row.scene : undefined;
    const keyed = source.length && source.every(row => identity(row) !== undefined);
    if (keyed && source.some(row => !normalized.some(value => identity(value) === identity(row)))) {
      throw new Error("Normalization would discard migrated records");
    }
    return normalized.map((row, index) => preserveDocumentExtensions(
      keyed ? source.find(value => identity(value) === identity(row)) : source[index], row
    ));
  }
  if (source && normalized && typeof source === "object" && typeof normalized === "object"
    && !Array.isArray(source) && !Array.isArray(normalized)) {
    const result = structuredClone(source);
    for (const [key, value] of Object.entries(normalized)) {
      Object.defineProperty(result, key, {
        value: preserveDocumentExtensions(source[key], value), enumerable: true, configurable: true, writable: true
      });
    }
    return result;
  }
  return structuredClone(normalized);
}

export const normalizePersistedDocument = (source, normalize) =>
  preserveDocumentExtensions(source, normalize(structuredClone(source)));
