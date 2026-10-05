function matchingOpenParen(tokens, close) {
  let depth = 0;
  for (let index = close; index >= 0; index -= 1) {
    if (tokens[index].value === ")") depth += 1;
    else if (tokens[index].value === "(" && --depth === 0) return index;
  }
  return -1;
}

function matchingCloseParen(tokens, open) {
  let depth = 0;
  for (let index = open; index < tokens.length; index += 1) {
    if (tokens[index].value === "(") depth += 1;
    else if (tokens[index].value === ")" && --depth === 0) return index;
  }
  return -1;
}

function functionDeclarationForBrace(tokens, brace) {
  const close = brace - 1;
  if (tokens[close]?.value !== ")") return null;
  const open = matchingOpenParen(tokens, close);
  if (open < 2 || tokens[open - 1]?.type !== "identifier" || tokens[open - 2]?.value !== "function") {
    return null;
  }
  let prefix = open - 3;
  while (["async", "default"].includes(tokens[prefix]?.value)) prefix -= 1;
  return {
    name: tokens[open - 1].value,
    exported: tokens[prefix]?.value === "export"
  };
}

export function tokenContexts(tokens) {
  const contexts = [];
  const stack = [];
  let nextScope = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const activeFunction = [...stack].reverse().find(entry => entry.functionName);
    contexts.push({
      scope: stack.map(entry => entry.id).join("."),
      functionName: activeFunction?.functionName || "",
      functionScope: activeFunction?.scope || "",
      functionExported: activeFunction?.functionExported || false,
      functionTopLevel: activeFunction?.functionTopLevel || false
    });
    if (tokens[index].value === "{") {
      const id = nextScope++;
      const declaration = functionDeclarationForBrace(tokens, index);
      stack.push({
        id,
        scope: [...stack.map(entry => entry.id), id].join("."),
        functionName: declaration?.name || "",
        functionExported: declaration?.exported || false,
        functionTopLevel: Boolean(declaration && stack.length === 0)
      });
    } else if (tokens[index].value === "}") {
      stack.pop();
    }
  }
  return contexts;
}

function directStatementStart(tokens, index) {
  let start = index;
  if (tokens[start - 1]?.value === "await") start -= 1;
  if (tokens[start - 1]?.value === "return") start -= 1;
  const before = tokens[start - 1]?.value;
  return before == null || [";", "{", "}"].includes(before);
}

function assignedStatementStart(tokens, index) {
  if (tokens[index - 1]?.value !== "=" || tokens[index - 2]?.type !== "identifier") return false;
  const declaration = tokens[index - 3]?.value;
  return ["const", "let", "var"].includes(declaration)
    && directStatementStart(tokens, index - 3);
}

export function directFactoryDeclaration(tokens, contexts, index) {
  return directStatementStart(tokens, index) && reachableAt(tokens, contexts, index);
}

export function directLifecycleCall(tokens, contexts, index) {
  let root = index;
  while (tokens[root - 1]?.value === "." && tokens[root - 2]?.type === "identifier") root -= 2;
  if (!directStatementStart(tokens, root) && !assignedStatementStart(tokens, root)) return false;
  const open = tokens[index + 1]?.value === "(" ? index + 1 : -1;
  const close = open < 0 ? -1 : matchingCloseParen(tokens, open);
  if (close < 0 || ![undefined, ";", "}"].includes(tokens[close + 1]?.value)) return false;
  return reachableAt(tokens, contexts, index);
}

export function reachableAt(tokens, contexts, index) {
  const executionScope = contexts[index]?.functionScope || "";
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (
      (contexts[cursor]?.functionScope || "") !== executionScope
      || !["return", "throw"].includes(tokens[cursor].value)
    ) continue;
    if (tokens[cursor].line < tokens[index].line) return false;
    if (tokens[cursor].value === "return" && tokens[cursor + 1]?.line > tokens[cursor].line) return false;
    if (tokens.slice(cursor + 1, index).some(token => token.value === ";")) return false;
  }
  return true;
}
