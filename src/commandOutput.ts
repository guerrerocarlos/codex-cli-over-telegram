export function describeCommandOutput(item: any): string | null {
  const output = collectCommandOutput(item);
  const exitCode = commandExitCode(item);
  const parts: string[] = [];

  if (typeof exitCode === "number" && exitCode !== 0) {
    parts.push(`exit ${exitCode}`);
  }
  if (output) {
    parts.push(output);
  }

  return parts.length > 0 ? parts.join("\n\n") : null;
}

function commandExitCode(item: any): number | null {
  if (typeof item?.exitCode === "number") {
    return item.exitCode;
  }
  if (typeof item?.exit_code === "number") {
    return item.exit_code;
  }
  return null;
}

function collectCommandOutput(item: any): string {
  const stdout = commandText(item?.stdout);
  const stderr = commandText(item?.stderr);

  if (stdout && stderr) {
    return [`stdout:\n${stdout}`, `stderr:\n${stderr}`].join("\n\n");
  }
  if (stdout || stderr) {
    return stdout || stderr;
  }

  const fields = [
    item?.output,
    item?.aggregatedOutput,
    item?.formattedOutput,
    item?.text,
    item?.result,
  ];
  const values = uniqueText(fields.map(commandText).filter(Boolean));
  return values.join("\n\n").trim();
}

function commandText(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (Array.isArray(value)) {
    return value.map(commandText).filter(Boolean).join("\n").trim();
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return commandText(record.text ?? record.output ?? record.stdout ?? record.stderr ?? record.value);
  }
  return "";
}

function uniqueText(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}
