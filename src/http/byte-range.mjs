export function evaluateByteRange(value, total) {
  if (!Number.isSafeInteger(total) || total < 0) return { kind: "ignore" };
  const input = String(value || "").trim();
  const separator = input.indexOf("=");
  if (separator < 0 || input.slice(0, separator).toLowerCase() !== "bytes") {
    return { kind: "ignore" };
  }
  const spec = input.slice(separator + 1);
  if (spec.includes(",")) return { kind: "ignore" };
  const match = /^(\d*)-(\d*)$/.exec(spec);
  if (!match || (!match[1] && !match[2])) return { kind: "ignore" };

  const totalBytes = BigInt(total);
  if (!match[1]) {
    const suffixLength = BigInt(match[2]);
    if (suffixLength === 0n || totalBytes === 0n) return { kind: "unsatisfiable" };
    const start = suffixLength >= totalBytes ? 0n : totalBytes - suffixLength;
    return { kind: "range", start: Number(start), end: total - 1 };
  }

  const start = BigInt(match[1]);
  const requestedEnd = match[2] ? BigInt(match[2]) : null;
  if (requestedEnd !== null && requestedEnd < start) return { kind: "ignore" };
  if (start >= totalBytes) return { kind: "unsatisfiable" };
  const end = requestedEnd === null || requestedEnd >= totalBytes
    ? totalBytes - 1n
    : requestedEnd;
  return { kind: "range", start: Number(start), end: Number(end) };
}

export function parseByteRange(value, total) {
  const result = evaluateByteRange(value, total);
  return result.kind === "range" ? { start: result.start, end: result.end } : null;
}
