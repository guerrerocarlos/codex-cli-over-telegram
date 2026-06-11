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

const codeBlockStart = "\u001eCODE_BLOCK:";
const codeBlockSeparator = "\u001f";
const codeBlockEnd = "\u001e";

export function codeBlock(text: string, language = ""): string {
  const body = text.trimEnd() || " ";
  return `${codeBlockStart}${language}${codeBlockSeparator}${body}${codeBlockEnd}`;
}

export function markdownV2Chunks(text: string, maxChars: number): string[] {
  const rendered = renderMarkdownV2(text);
  if (rendered.length <= maxChars) {
    return [rendered];
  }

  const chunks: string[] = [];
  for (const segment of parseMarkdownSegments(text)) {
    if (segment.type === "text") {
      chunks.push(...chunkEscapedText(escapeMarkdownV2Text(segment.text), maxChars));
    } else {
      chunks.push(...chunkCodeBlock(segment.body, segment.language, maxChars));
    }
  }

  return chunks.filter((chunk) => chunk.trim().length > 0);
}

function renderMarkdownV2(text: string): string {
  return parseMarkdownSegments(text)
    .map((segment) => {
      if (segment.type === "text") {
        return escapeMarkdownV2Text(segment.text);
      }
      return renderCodeBlock(segment.body, segment.language);
    })
    .join("");
}

type MarkdownSegment =
  | { type: "text"; text: string }
  | { type: "code"; language: string; body: string };

function parseMarkdownSegments(text: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const start = text.indexOf(codeBlockStart, cursor);
    if (start === -1) {
      appendTextSegments(segments, text.slice(cursor));
      break;
    }

    appendTextSegments(segments, text.slice(cursor, start));

    const languageStart = start + codeBlockStart.length;
    const separator = text.indexOf(codeBlockSeparator, languageStart);
    if (separator === -1) {
      appendTextSegments(segments, text.slice(start));
      break;
    }

    const end = text.indexOf(codeBlockEnd, separator + codeBlockSeparator.length);
    if (end === -1) {
      appendTextSegments(segments, text.slice(start));
      break;
    }

    segments.push({
      type: "code",
      language: text.slice(languageStart, separator),
      body: text.slice(separator + codeBlockSeparator.length, end),
    });
    cursor = end + codeBlockEnd.length;
  }

  return segments;
}

function appendTextSegments(segments: MarkdownSegment[], text: string): void {
  const fencePattern = /```([A-Za-z0-9_-]*)\n([\s\S]*?)\n```/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = fencePattern.exec(text)) !== null) {
    if (match.index > cursor) {
      segments.push({ type: "text", text: text.slice(cursor, match.index) });
    }
    segments.push({ type: "code", language: match[1] ?? "", body: match[2] ?? "" });
    cursor = fencePattern.lastIndex;
  }

  if (cursor < text.length) {
    segments.push({ type: "text", text: text.slice(cursor) });
  }
}

function escapeMarkdownV2Text(text: string): string {
  return text.replace(/([\\_*\[\]()~`>#+\-=|{}.!])/g, "\\$1");
}

function escapeMarkdownV2Code(text: string): string {
  return text.replace(/([\\`])/g, "\\$1");
}

function renderCodeBlock(body: string, language: string): string {
  return `\`\`\`${sanitizeCodeLanguage(language)}\n${escapeMarkdownV2Code(body)}\n\`\`\``;
}

function sanitizeCodeLanguage(language: string): string {
  return language.replace(/[^A-Za-z0-9_-]/g, "");
}

function chunkEscapedText(text: string, maxChars: number): string[] {
  const chunks = chunkText(text, maxChars);
  const safeChunks: string[] = [];
  let carry = "";

  for (const chunk of chunks) {
    let next = carry + chunk;
    carry = "";
    if (endsWithDanglingEscape(next)) {
      carry = "\\";
      next = next.slice(0, -1);
    }
    if (next.length > 0) {
      safeChunks.push(next);
    }
  }

  if (carry) {
    safeChunks.push("\\\\");
  }

  return safeChunks;
}

function endsWithDanglingEscape(text: string): boolean {
  let slashCount = 0;
  for (let index = text.length - 1; index >= 0 && text[index] === "\\"; index -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function chunkCodeBlock(body: string, language: string, maxChars: number): string[] {
  const header = `\`\`\`${sanitizeCodeLanguage(language)}\n`;
  const footer = "\n```";
  const maxBodyChars = Math.max(1, maxChars - header.length - footer.length);
  const chunks: string[] = [];
  let current = "";

  for (const line of body.split(/(?<=\n)/)) {
    if (escapeMarkdownV2Code(line).length > maxBodyChars) {
      if (current.length > 0) {
        chunks.push(`${header}${escapeMarkdownV2Code(current.trimEnd() || " ")}${footer}`);
        current = "";
      }
      chunks.push(...chunkLongCodeLine(line, header, footer, maxBodyChars));
      continue;
    }

    const candidate = current + line;
    if (escapeMarkdownV2Code(candidate).length > maxBodyChars && current.length > 0) {
      chunks.push(`${header}${escapeMarkdownV2Code(current.trimEnd() || " ")}${footer}`);
      current = line;
    } else {
      current = candidate;
    }
  }

  if (current.length > 0 || chunks.length === 0) {
    chunks.push(`${header}${escapeMarkdownV2Code(current.trimEnd() || " ")}${footer}`);
  }

  return chunks;
}

function chunkLongCodeLine(line: string, header: string, footer: string, maxBodyChars: number): string[] {
  const chunks: string[] = [];
  let current = "";

  for (const char of line) {
    const candidate = current + char;
    if (escapeMarkdownV2Code(candidate).length > maxBodyChars && current.length > 0) {
      chunks.push(`${header}${escapeMarkdownV2Code(current)}${footer}`);
      current = char;
    } else {
      current = candidate;
    }
  }

  if (current.length > 0) {
    chunks.push(`${header}${escapeMarkdownV2Code(current.trimEnd() || " ")}${footer}`);
  }

  return chunks;
}
