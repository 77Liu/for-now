function staticExpressionValue(tokens, start, end, nestedIndexes) {
  const sequence = [];
  for (let index = start; index < end; index += 1) {
    if (nestedIndexes.has(index) || ["(", ")"].includes(tokens[index].value)) continue;
    sequence.push({
      token: tokens[index],
      value: staticLiteralValue(tokens, index, nestedIndexes)
    });
  }
  if (!sequence.length || sequence.length % 2 === 0) return null;
  let value = "";
  for (let index = 0; index < sequence.length; index += 1) {
    if (index % 2 === 1) {
      if (sequence[index].token.value !== "+") return null;
    } else {
      if (sequence[index].value === null) return null;
      value += sequence[index].value;
    }
  }
  return value;
}

function staticLiteralValue(tokens, index, nestedIndexes) {
  const token = tokens[index];
  if (token?.type === "string") return token.value;
  if (token?.type !== "template") return null;
  if (!token.hasExpressions) return token.value;
  if (token.expressions.length !== token.quasis.length - 1) return null;
  const expressions = token.expressions.map(([start, end]) => (
    staticExpressionValue(tokens, start, end, nestedIndexes)
  ));
  if (expressions.some(value => value === null)) return null;
  let value = token.quasis[0];
  for (let part = 0; part < expressions.length; part += 1) {
    const [start, end] = token.expressions[part];
    for (let index = start; index < end; index += 1) nestedIndexes.add(index);
    value += expressions[part] + token.quasis[part + 1];
  }
  return value;
}

export function evaluateStaticString(tokens, start, end) {
  return staticExpressionValue(tokens, start, end, new Set());
}

export function staticLiteralCandidates(tokens) {
  const nestedIndexes = new Set();
  const values = tokens.map((_, index) => staticLiteralValue(tokens, index, nestedIndexes));
  const sequence = tokens
    .map((token, index) => ({ token, index, value: values[index] }))
    .filter(item => !nestedIndexes.has(item.index) && !["(", ")"].includes(item.token.value));
  const candidates = [];
  for (let index = 0; index < sequence.length; index += 1) {
    if (sequence[index].value === null) continue;
    let value = sequence[index].value;
    let end = index;
    while (
      sequence[end + 1]?.token.value === "+"
      && sequence[end + 2]?.value !== null
    ) {
      value += sequence[end + 2].value;
      end += 2;
    }
    candidates.push({
      value,
      line: sequence[index].token.line,
      before: sequence[index - 1]?.token.value,
      after: sequence[end + 1]?.token.value
    });
    index = end;
  }
  return candidates;
}
