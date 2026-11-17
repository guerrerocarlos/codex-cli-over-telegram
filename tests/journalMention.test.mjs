import assert from "node:assert/strict";
import test from "node:test";
import { journalMediaMentionPrompt } from "../dist/telegram.js";

const bot = { botInfo: { username: "journal_bot" } };

function context(caption) {
  return { message: { caption } };
}

test("journal media captions only create an agent prompt for an explicit bot mention", () => {
  assert.equal(journalMediaMentionPrompt(context(undefined), bot), null);
  assert.equal(journalMediaMentionPrompt(context("Please archive this."), bot), null);
  assert.equal(journalMediaMentionPrompt(context("@journal_bot summarize this entry"), bot), "summarize this entry");
  assert.equal(journalMediaMentionPrompt(context("@journal_bot"), bot), null);
});
