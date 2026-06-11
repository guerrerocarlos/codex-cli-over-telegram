export function chunkText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxChars) {
    const window = remaining.slice(0, maxChars);
    const splitAt = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "));
    const index = splitAt > Math.floor(maxChars * 0.6) ? splitAt : maxChars;
    chunks.push(remaining.slice(0, index).trimEnd());
    remaining = remaining.slice(index).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 20)).trimEnd()}\n...truncated...`;
}

export function codeBlock(text: string, language = ""): string {
  const body = text.trimEnd() || " ";
  return `\`\`\`${language}\n${body}\n\`\`\``;
}
