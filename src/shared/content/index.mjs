function inlineMarkdownText(value) {
  return String(value || "")
    .replace(/\\\((.+?)\\\)/g, "$1")
    .replace(/(^|[^\\])\$([^$\n]+)\$/g, "$1$2")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g, "$1")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/~~([^~\n]+)~~/g, "$1")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2")
    .replace(/(^|[^_])_([^_\n]+)_/g, "$1$2");
}

export function markdownText(value) {
  const displayMath = [];
  const source = String(value || "").replace(/\\\[([\s\S]*?)\\\]|\$\$([\s\S]*?)\$\$/g, (_, bracket, dollars) => {
    const token = `\n\u0000DISPLAY${displayMath.length}\u0000\n`;
    displayMath.push((bracket ?? dollars ?? "").trim());
    return token;
  });
  const lines = source.replace(/\r\n?/g, "\n").split("\n"), output = [];
  let paragraph = [], listItems = [], quote = [], code = [], inCode = false;
  const flushParagraph = () => { if (paragraph.length) { output.push(inlineMarkdownText(paragraph.join(""))); paragraph = []; } };
  const flushList = () => { if (listItems.length) { output.push(listItems.map(inlineMarkdownText).join("")); listItems = []; } };
  const flushQuote = () => { if (quote.length) { output.push(markdownText(quote.join("\n"))); quote = []; } };
  const flushAll = () => { flushParagraph(); flushList(); flushQuote(); };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const display = line.match(/^\u0000DISPLAY(\d+)\u0000$/);
    if (display) { flushAll(); output.push(displayMath[Number(display[1])] || ""); continue; }
    if (/^```\s*[\w-]*\s*$/.test(line)) { if (inCode) { output.push(code.join("\n")); code = []; inCode = false; } else { flushAll(); inCode = true; } continue; }
    if (inCode) { code.push(line); continue; }
    const next = lines[index + 1] || "";
    if (line.includes("|") && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(next)) {
      flushAll(); const headers = line.replace(/^\s*\||\|\s*$/g, "").split("|").map(cell => cell.trim()), rows = []; index += 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) { rows.push(lines[index].replace(/^\s*\||\|\s*$/g, "").split("|").map(cell => cell.trim())); index += 1; }
      index -= 1; output.push(headers.map(inlineMarkdownText).join("") + rows.map(row => headers.map((_, cellIndex) => inlineMarkdownText(row[cellIndex] || "")).join("")).join("")); continue;
    }
    if (!line.trim()) { flushAll(); continue; }
    const heading = line.match(/^(#{1,6})\s+(.+)$/); if (heading) { flushAll(); output.push(inlineMarkdownText(heading[2])); continue; }
    if (/^\s*(---+|___+|\*\*\*+)\s*$/.test(line)) { flushAll(); continue; }
    const unordered = line.match(/^\s*[-+*]\s+(.+)$/), ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unordered || ordered) { flushParagraph(); flushQuote(); listItems.push((unordered || ordered)[1]); continue; }
    const quoted = line.match(/^\s*>\s?(.*)$/); if (quoted) { flushParagraph(); flushList(); quote.push(quoted[1]); continue; }
    flushList(); flushQuote(); paragraph.push(line);
  }
  if (inCode) output.push(code.join("\n")); else flushAll();
  return output.join("");
}
