import assert from "node:assert/strict";
import test from "node:test";
import { parseMultipart } from "../dist/journalIngest.js";

test("parses the journal daemon multipart wire format", () => {
  const boundary = "JournalDaemon-test";
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n{"version":1}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="DJI.WAV"\r\nContent-Type: application/octet-stream\r\n\r\nabc\r\n`),
    Buffer.from(`--${boundary}--\r\n`),
  ]);

  const parts = parseMultipart(body, boundary);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].headers["content-disposition"], 'form-data; name="metadata"');
  assert.equal(parts[1].body.toString(), "abc");
});
