import { extractModuleSurface } from "./entrypoint-module-surface.mjs";
import { staticLiteralCandidates } from "./entrypoint-static-values.mjs";

function reject(message) {
  throw new Error(message);
}

function isIdentifierStart(character) {
  return character != null && /[$_\p{ID_Start}]/u.test(character);
}

function isIdentifierPart(character) {
  return character != null && /[$_\u200c\u200d\p{ID_Continue}]/u.test(character);
}

class Lexer {
  constructor(source, file) {
    this.source = source;
    this.file = file;
    this.index = 0;
    this.line = 1;
    this.tokens = [];
    this.parens = [];
  }

  advance() {
    const character = this.source[this.index++];
    if (character === "\n") this.line += 1;
    return character;
  }

  token(type, value, start, line, extra = {}) {
    this.tokens.push({ type, value, start, end: this.index, line, ...extra });
  }

  readHexEscape(length, label) {
    const value = this.source.slice(this.index, this.index + length);
    if (value.length !== length || !new RegExp(`^[0-9A-Fa-f]{${length}}$`, "u").test(value)) {
      reject(`${this.file}:${this.line}: malformed ${label} escape`);
    }
    this.index += length;
    return String.fromCodePoint(Number.parseInt(value, 16));
  }

  readUnicodeEscape() {
    if (this.source[this.index] !== "u") reject(`${this.file}:${this.line}: unsupported identifier escape`);
    this.advance();
    if (this.source[this.index] !== "{") return this.readHexEscape(4, "Unicode");
    this.advance();
    const start = this.index;
    while (/[0-9A-Fa-f]/u.test(this.source[this.index] || "")) this.advance();
    const value = this.source.slice(start, this.index);
    if (!value || value.length > 6 || this.source[this.index] !== "}") {
      reject(`${this.file}:${this.line}: malformed Unicode code point escape`);
    }
    this.advance();
    const codePoint = Number.parseInt(value, 16);
    if (codePoint > 0x10ffff) reject(`${this.file}:${this.line}: Unicode escape is outside the valid range`);
    return String.fromCodePoint(codePoint);
  }

  readStringEscape() {
    if (this.index >= this.source.length) reject(`${this.file}:${this.line}: unterminated escape sequence`);
    const escaped = this.advance();
    if (escaped === "\n") return "";
    if (escaped === "\r") {
      if (this.source[this.index] === "\n") this.advance();
      return "";
    }
    if (escaped === "x") return this.readHexEscape(2, "hex");
    if (escaped === "u") {
      this.index -= 1;
      return this.readUnicodeEscape();
    }
    if (/[1-9]/u.test(escaped) || (escaped === "0" && /[0-9]/u.test(this.source[this.index] || ""))) {
      reject(`${this.file}:${this.line}: legacy numeric escapes are unsupported`);
    }
    return ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", 0: "\0" })[escaped] ?? escaped;
  }

  readQuoted(quote) {
    const start = this.index;
    const line = this.line;
    let value = "";
    this.advance();
    while (this.index < this.source.length) {
      const character = this.advance();
      if (character === quote) {
        this.token("string", value, start, line);
        return;
      }
      if (character === "\\") {
        value += this.readStringEscape();
        continue;
      }
      if (character === "\n" || character === "\r") reject(`${this.file}:${line}: unterminated string literal`);
      value += character;
    }
    reject(`${this.file}:${line}: unterminated string literal`);
  }

  readTemplate() {
    const start = this.index;
    const line = this.line;
    const token = {
      type: "template",
      value: "",
      quasis: [""],
      expressions: [],
      start,
      end: start,
      line,
      hasExpressions: false
    };
    this.tokens.push(token);
    this.advance();
    while (this.index < this.source.length) {
      const character = this.advance();
      if (character === "`") {
        token.end = this.index;
        return;
      }
      if (character === "\\") {
        const escaped = this.readStringEscape();
        token.value += escaped;
        token.quasis[token.quasis.length - 1] += escaped;
        continue;
      }
      if (character === "$" && this.source[this.index] === "{") {
        token.hasExpressions = true;
        this.advance();
        const expressionStart = this.tokens.length;
        this.scan(true);
        token.expressions.push([expressionStart, this.tokens.length]);
        token.quasis.push("");
        continue;
      }
      token.value += character;
      token.quasis[token.quasis.length - 1] += character;
    }
    reject(`${this.file}:${line}: unterminated template literal`);
  }

  regexCanStart() {
    const previous = this.tokens.at(-1);
    if (!previous) return true;
    if (previous.closesControl) return true;
    return new Set([
      "(", "[", "{", ",", ";", ":", "=", "!", "?", "&", "|", "^", "~", "+", "-", "*", "%",
      "&&", "||", "??", "==", "!=", "<=", ">=", "<", ">",
      "=>", "return", "throw", "case", "delete", "void", "typeof", "instanceof", "in",
      "of", "yield", "await", "else", "do"
    ]).has(previous.value);
  }

  readRegex() {
    const start = this.index;
    const line = this.line;
    let inClass = false;
    this.advance();
    while (this.index < this.source.length) {
      const character = this.advance();
      if (character === "\\") {
        if (this.index < this.source.length) this.advance();
        continue;
      }
      if (character === "\n" || character === "\r") reject(`${this.file}:${line}: unterminated regular expression`);
      if (character === "[") inClass = true;
      else if (character === "]") inClass = false;
      else if (character === "/" && !inClass) {
        const flagsStart = this.index;
        while (/[A-Za-z]/u.test(this.source[this.index] || "")) this.advance();
        const flags = this.source.slice(flagsStart, this.index);
        if (/[^dgimsuvy]/u.test(flags) || new Set(flags).size !== flags.length || (flags.includes("u") && flags.includes("v"))) {
          reject(`${this.file}:${line}: unsupported regular expression flags ${JSON.stringify(flags)}`);
        }
        this.token("regex", this.source.slice(start, this.index), start, line);
        return;
      }
    }
    reject(`${this.file}:${line}: unterminated regular expression`);
  }

  readIdentifier() {
    const start = this.index;
    const line = this.line;
    let value = "";
    let escaped = false;
    let first = true;
    while (this.index < this.source.length) {
      let character = this.source[this.index];
      if (character === "\\") {
        escaped = true;
        this.advance();
        character = this.readUnicodeEscape();
      } else {
        const codePoint = this.source.codePointAt(this.index);
        character = String.fromCodePoint(codePoint);
        if (!(first ? isIdentifierStart(character) : isIdentifierPart(character))) break;
        this.index += character.length;
      }
      if (!(first ? isIdentifierStart(character) : isIdentifierPart(character))) {
        reject(`${this.file}:${line}: escaped character is not valid in an identifier`);
      }
      value += character;
      first = false;
    }
    this.token("identifier", value, start, line, { escaped });
  }

  scan(stopAtBrace = false) {
    let braceDepth = 0;
    while (this.index < this.source.length) {
      const character = this.source[this.index];
      if (/\s/u.test(character)) {
        this.advance();
        continue;
      }
      if (character === "/" && this.source[this.index + 1] === "/") {
        this.advance();
        this.advance();
        while (this.index < this.source.length && !/[\r\n]/u.test(this.source[this.index])) this.advance();
        continue;
      }
      if (character === "/" && this.source[this.index + 1] === "*") {
        const line = this.line;
        this.advance();
        this.advance();
        while (this.index < this.source.length && !(this.source[this.index] === "*" && this.source[this.index + 1] === "/")) {
          this.advance();
        }
        if (this.index >= this.source.length) reject(`${this.file}:${line}: unterminated block comment`);
        this.advance();
        this.advance();
        continue;
      }
      if (character === "'" || character === "\"") {
        this.readQuoted(character);
        continue;
      }
      if (character === "`") {
        this.readTemplate();
        continue;
      }
      if (character === "/" && this.regexCanStart()) {
        this.readRegex();
        continue;
      }
      if (isIdentifierStart(character) || character === "\\") {
        this.readIdentifier();
        continue;
      }
      if (/[0-9]/u.test(character)) {
        const start = this.index;
        const line = this.line;
        this.advance();
        while (/[0-9A-Za-z_.]/u.test(this.source[this.index] || "")) this.advance();
        this.token("number", this.source.slice(start, this.index), start, line);
        continue;
      }
      const start = this.index;
      const line = this.line;
      this.advance();
      if (character === "}" && stopAtBrace && braceDepth === 0) return this.tokens;
      if (character === "{") braceDepth += 1;
      else if (character === "}" && braceDepth > 0) braceDepth -= 1;
      const pair = character + (this.source[this.index] || "");
      if (["=>", "?.", "&&", "||", "??", "==", "!=", "<=", ">=", "++", "--"].includes(pair)) this.advance();
      const value = this.source.slice(start, this.index);
      const extra = {};
      if (value === "(") {
        const previous = this.tokens.at(-1);
        this.parens.push(Boolean(previous?.type === "identifier" && !previous.escaped
          && ["if", "while", "for", "with", "switch", "catch"].includes(previous.value)));
      } else if (value === ")") {
        extra.closesControl = this.parens.pop() || false;
      }
      this.token("punctuator", value, start, line, extra);
    }
    if (stopAtBrace) reject(`${this.file}:${this.line}: unterminated template expression`);
    return this.tokens;
  }
}

function callName(tokens, index) {
  const token = tokens[index];
  let before = index - 1;
  let after = index + 1;
  const computed = ["string", "template"].includes(token?.type)
    && !token.hasExpressions
    && tokens[before]?.value === "["
    && tokens[after]?.value === "]";
  if (computed) {
    before -= 1;
    after += 1;
  } else if (token?.type !== "identifier") {
    return "";
  }
  while (tokens[before]?.value === "(" && tokens[after]?.value === ")") {
    before -= 1;
    after += 1;
  }
  if (tokens[after]?.value === "?.") after += 1;
  if (tokens[after]?.value !== "(") return "";
  const parts = [token.value];
  let cursor = before;
  if (computed && tokens[cursor]?.value === "?.") cursor -= 1;
  if (computed && tokens[cursor]?.type === "identifier") {
    parts.unshift(tokens[cursor].value);
    cursor -= 1;
  }
  while (tokens[cursor]?.value === "." || tokens[cursor]?.value === "?.") {
    if (tokens[cursor - 1]?.type !== "identifier") break;
    parts.unshift(tokens[cursor - 1].value);
    cursor -= 2;
  }
  return parts.join(".");
}

function syntaxMatches(tokens, value) {
  if (value === "template-literal") return tokens.filter(token => token.type === "template");
  if (value === "regex-literal") return tokens.filter(token => token.type === "regex");
  if (value === "arrow-function") return tokens.filter(token => token.value === "=>");
  if (value === "variable-declaration") return tokens.filter(token => ["const", "let", "var"].includes(token.value));
  if (value === "computed-global-access") {
    return tokens.filter((token, index) => {
      if (token.type !== "identifier" || !["globalThis", "window", "self"].includes(token.value)) return false;
      let cursor = index + 1;
      while (tokens[cursor]?.value === ")") cursor += 1;
      if (tokens[cursor]?.value === "?.") cursor += 1;
      return tokens[cursor]?.value === "[";
    });
  }
  return tokens.filter(token => token.value === value);
}

function literalMatches(value, candidate, match, flags) {
  if (match === "exact") return candidate === value;
  if (match === "includes") return candidate.includes(value);
  if (match === "startsWith") return candidate.startsWith(value);
  if (match === "endsWith") return candidate.endsWith(value);
  return new RegExp(value, flags).test(candidate);
}

function tokenScopes(tokens) {
  const scopes = [];
  const stack = [];
  let nextScope = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    scopes.push(stack.join("."));
    if (tokens[index].value === "{") stack.push(nextScope++);
    else if (tokens[index].value === "}") stack.pop();
  }
  return scopes;
}

function callSurface(tokens, scopes) {
  const calls = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (!["identifier", "string", "template"].includes(tokens[index].type)) continue;
    const name = callName(tokens, index);
    if (name) calls.push({ name, line: tokens[index].line, index, scope: scopes[index] });
  }
  return calls;
}

function closingParen(tokens, open) {
  let depth = 0;
  for (let index = open; index < tokens.length; index += 1) {
    if (tokens[index].value === "(") depth += 1;
    else if (tokens[index].value === ")" && --depth === 0) return index;
  }
  return -1;
}

function factoryAssignmentSurface(tokens, scopes) {
  const assignments = [];
  for (let index = 0; index < tokens.length - 4; index += 1) {
    if (!["const", "let", "var"].includes(tokens[index].value)) continue;
    const result = tokens[index + 1];
    if (result?.type !== "identifier" || tokens[index + 2]?.value !== "=") continue;
    let factoryIndex = index + 3;
    if (tokens[factoryIndex]?.value === "await") factoryIndex += 1;
    const factory = callName(tokens, factoryIndex);
    if (!factory) continue;
    let open = factoryIndex + 1;
    if (tokens[open]?.value === "?.") open += 1;
    const close = tokens[open]?.value === "(" ? closingParen(tokens, open) : -1;
    const argumentTokens = close < 0 ? [] : tokens.slice(open + 1, close);
    const argumentsUsed = close < 0
      ? []
      : [...new Set(argumentTokens
        .filter((token, argumentIndex) => (
          token.type === "identifier"
          && argumentTokens[argumentIndex + 1]?.value !== ":"
          && ![".", "?."].includes(argumentTokens[argumentIndex - 1]?.value)
        ))
        .map(token => token.value))];
    assignments.push({
      result: result.value,
      factory,
      argumentsUsed,
      line: result.line,
      index,
      scope: scopes[index]
    });
  }
  return assignments;
}

function forbiddenViolations(rules, tokens) {
  const violations = [];
  const literals = staticLiteralCandidates(tokens);
  for (const rule of rules) {
    if (rule.kind === "identifier") {
      for (const token of tokens) {
        if (token.type === "identifier" && rule.values.includes(token.value)) {
          violations.push({ ruleId: rule.id, line: token.line, detail: `forbidden identifier ${JSON.stringify(token.value)}` });
        }
      }
      for (const literal of literals) {
        if (literal.before === "[" && literal.after === "]" && rule.values.includes(literal.value)) {
          violations.push({
            ruleId: rule.id,
            line: literal.line,
            detail: `forbidden identifier ${JSON.stringify(literal.value)}`
          });
        }
      }
    } else if (rule.kind === "call") {
      for (let index = 0; index < tokens.length; index += 1) {
        if (!["identifier", "string", "template"].includes(tokens[index].type)) continue;
        const name = callName(tokens, index);
        const matched = name && rule.values.find(value => (
          value === name || (!value.includes(".") && name.endsWith(`.${value}`))
        ));
        if (matched) {
          violations.push({ ruleId: rule.id, line: tokens[index].line, detail: `forbidden call ${matched}()` });
        }
      }
    } else if (rule.kind === "literal") {
      for (const token of literals) {
        for (const value of rule.values) {
          if (literalMatches(value, token.value, rule.match ?? "exact", rule.flags ?? "u")) {
            violations.push({ ruleId: rule.id, line: token.line, detail: `forbidden literal matched ${JSON.stringify(value)}` });
          }
        }
      }
    } else {
      for (const value of rule.values) {
        for (const token of syntaxMatches(tokens, value)) {
          violations.push({ ruleId: rule.id, line: token.line, detail: `forbidden syntax ${value}` });
        }
      }
    }
  }
  return violations;
}

export function analyzeEntrypointSource(source, file, forbiddenRules) {
  const tokens = new Lexer(source, file).scan();
  const scopes = tokenScopes(tokens);
  return {
    surface: {
      ...extractModuleSurface(tokens),
      calls: callSurface(tokens, scopes),
      factoryAssignments: factoryAssignmentSurface(tokens, scopes),
      identifiers: tokens
        .filter(token => token.type === "identifier")
        .map(token => ({ name: token.value, line: token.line }))
    },
    lineCount: source ? source.split(/\r\n|\r|\n/u).length - (/(?:\r\n|\r|\n)$/u.test(source) ? 1 : 0) : 0,
    violations: forbiddenViolations(forbiddenRules, tokens)
  };
}
