import { evaluateStaticString } from "./entrypoint-static-values.mjs";

function declarationEnd(tokens, start) {
  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    const value = tokens[index].value;
    if (["(", "[", "{"].includes(value)) depth += 1;
    else if ([")", "]", "}"].includes(value)) depth = Math.max(0, depth - 1);
    if (value === ";" && depth === 0) return index;
  }
  return tokens.length;
}

function matchingClose(tokens, open, left = "(", right = ")") {
  let depth = 0;
  for (let index = open; index < tokens.length; index += 1) {
    if (tokens[index].value === left) depth += 1;
    else if (tokens[index].value === right && --depth === 0) return index;
  }
  return -1;
}

function addNamedExports(tokens, open, exports) {
  let segment = [];
  let index = open + 1;
  for (; index < tokens.length; index += 1) {
    if (tokens[index].value === "}" || tokens[index].value === ",") {
      if (segment.length) {
        const as = segment.findIndex(token => token.value === "as");
        const exported = as >= 0 ? segment[as + 1] : segment[0];
        if (exported) exports.push({ name: exported.value, line: exported.line });
      }
      segment = [];
      if (tokens[index].value === "}") break;
    } else {
      segment.push(tokens[index]);
    }
  }
  return index;
}

function addVariableExports(tokens, start, end, exports, line) {
  let cursor = start;
  while (cursor < end) {
    const binding = tokens[cursor];
    if (binding?.type === "identifier") {
      exports.push({ name: binding.value, line });
    } else if (["{", "["].includes(binding?.value)) {
      exports.push({ name: "<destructured-binding>", line });
    } else {
      break;
    }
    let depth = 0;
    for (cursor += 1; cursor < end; cursor += 1) {
      const value = tokens[cursor].value;
      if (["(", "[", "{"].includes(value)) depth += 1;
      else if ([")", "]", "}"].includes(value)) depth = Math.max(0, depth - 1);
      else if (value === "," && depth === 0) {
        cursor += 1;
        break;
      }
    }
  }
}

function importBindings(tokens, start, end) {
  const bindings = [];
  let cursor = start;
  if (tokens[cursor]?.type === "identifier") {
    bindings.push({ imported: "default", local: tokens[cursor].value });
    cursor += 1;
    if (tokens[cursor]?.value === ",") cursor += 1;
  }
  if (tokens[cursor]?.value === "*") {
    if (tokens[cursor + 1]?.value === "as" && tokens[cursor + 2]?.type === "identifier") {
      bindings.push({ imported: "*", local: tokens[cursor + 2].value });
    }
    return bindings;
  }
  if (tokens[cursor]?.value !== "{") return bindings;
  let segment = [];
  for (cursor += 1; cursor < end; cursor += 1) {
    if (tokens[cursor].value === "}" || tokens[cursor].value === ",") {
      if (segment.length) {
        const as = segment.findIndex(token => token.value === "as");
        const imported = segment[0];
        const local = as >= 0 ? segment[as + 1] : imported;
        if (imported?.type === "identifier" && local?.type === "identifier") {
          bindings.push({ imported: imported.value, local: local.value });
        }
      }
      segment = [];
      if (tokens[cursor].value === "}") break;
    } else {
      segment.push(tokens[cursor]);
    }
  }
  return bindings;
}

export function extractModuleSurface(tokens) {
  const imports = [];
  const exports = [];
  const nonLiteralImports = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const previous = tokens[index - 1]?.value;
    if (token.value === "[") {
      const close = matchingClose(tokens, index, "[", "]");
      if (
        close >= 0
        && evaluateStaticString(tokens, index + 1, close) === "import"
      ) {
        nonLiteralImports.push({
          line: token.line,
          detail: "indirect import methods are forbidden in entrypoints"
        });
      }
    }
    if (token.type === "identifier" && token.value === "import") {
      if ([".", "?."].includes(previous)) {
        nonLiteralImports.push({
          line: token.line,
          detail: "indirect import methods are forbidden in entrypoints"
        });
        continue;
      }
      if (token.escaped) continue;
      const next = tokens[index + 1];
      if (next?.value === "(") {
        const argument = tokens[index + 2];
        const after = tokens[index + 3];
        const literal = argument?.type === "string" || (argument?.type === "template" && !argument.hasExpressions);
        if (!literal || ![")", ","].includes(after?.value)) {
          nonLiteralImports.push({ line: token.line });
        } else {
          imports.push({ specifier: argument.value, line: token.line, dynamic: true, bindings: [] });
        }
        continue;
      }
      if (next?.value === ".") continue;
      const end = declarationEnd(tokens, index + 1);
      const specifierIndex = tokens.findIndex((candidate, candidateIndex) => (
        candidateIndex >= index + 1
        && candidateIndex < end
        && candidate.type === "string"
        && (candidateIndex === index + 1 || tokens[candidateIndex - 1]?.value === "from")
      ));
      if (specifierIndex >= 0) {
        imports.push({
          specifier: tokens[specifierIndex].value,
          line: token.line,
          dynamic: false,
          bindings: importBindings(tokens, index + 1, specifierIndex)
        });
      }
      continue;
    }
    if (token.value !== "export" || token.escaped || [".", "?."].includes(previous)) continue;
    let cursor = index + 1;
    if (tokens[cursor]?.value === "default") {
      exports.push({ name: "default", line: token.line });
      continue;
    }
    if (tokens[cursor]?.value === "*") {
      if (tokens[cursor + 1]?.value === "as" && tokens[cursor + 2]) {
        exports.push({ name: tokens[cursor + 2].value, line: token.line });
      } else {
        exports.push({ name: "*", line: token.line });
      }
    } else if (tokens[cursor]?.value === "{") {
      cursor = addNamedExports(tokens, cursor, exports);
    } else {
      if (tokens[cursor]?.value === "async") cursor += 1;
      if (["function", "class"].includes(tokens[cursor]?.value)) {
        cursor += 1;
        if (tokens[cursor]?.value === "*") cursor += 1;
        if (tokens[cursor]?.type === "identifier") exports.push({ name: tokens[cursor].value, line: token.line });
      } else if (["const", "let", "var"].includes(tokens[cursor]?.value)) {
        addVariableExports(tokens, cursor + 1, declarationEnd(tokens, cursor + 1), exports, token.line);
      }
    }
    const end = declarationEnd(tokens, index + 1);
    for (let candidate = index + 1; candidate < end - 1; candidate += 1) {
      if (tokens[candidate].value === "from" && tokens[candidate + 1]?.type === "string") {
        imports.push({
          specifier: tokens[candidate + 1].value,
          line: token.line,
          dynamic: false,
          bindings: []
        });
        break;
      }
    }
  }
  return { imports, exports, nonLiteralImports };
}
