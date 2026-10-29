import test from "node:test";
import assert from "node:assert/strict";
import { fetchWithDeadline } from "./http-deadline.mjs";

test("a transport that never settles rejects within its deadline", async () => {
  const startedAt = Date.now();
  await assert.rejects(
    fetchWithDeadline("https://example.invalid/hang", {}, {
      fetchImpl: () => new Promise(() => {}),
      timeoutMs: 20,
      label: "hung fake transport",
    }),
    (error) => error.kind === "deadline" && /hung fake transport/.test(error.message),
  );
  assert.ok(Date.now() - startedAt < 500, "deadline should reject without waiting for the fake transport");
});
