import test from "node:test";
import assert from "node:assert/strict";
import { parseEnvText, readEnabledFlag, readEnvFile, readEnvValue } from "./env.mjs";

test("process environment is the primary cloud secret source", () => {
  assert.equal(readEnvValue("TOKEN", {
    env: { TOKEN: "from-render" },
    read: () => { throw new Error("checkout .env absent"); },
  }), "from-render");
});

test("local .env remains a fallback and missing values stay empty", () => {
  assert.equal(readEnvValue("TOKEN", { env: {}, read: () => "TOKEN='local'\n" }), "local");
  assert.equal(readEnvValue("MISSING", { env: {}, read: () => "TOKEN=local\n" }), "");
});

test("missing .env is never fatal", () => {
  assert.deepEqual([...readEnvFile({ read: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); } })], []);
  assert.equal(readEnvValue("TOKEN", { env: {}, read: () => { throw new Error("missing"); } }), "");
});

test("parser handles quoted values and ignores non-assignments", () => {
  assert.deepEqual(
    Object.fromEntries(parseEnvText("A=one\n B = 'two' \n# C=three\ninvalid\n")),
    { A: "one", B: "two" },
  );
});

test("enable flags fail closed unless explicitly true", () => {
  for (const value of [undefined, "", "1", "yes", "on", "tru", "false"]) {
    assert.equal(readEnabledFlag("FLAG", { env: value === undefined ? {} : { FLAG: value }, read: () => "" }), false);
  }
  assert.equal(readEnabledFlag("FLAG", { env: { FLAG: "true" }, read: () => "" }), true);
  assert.equal(readEnabledFlag("FLAG", { env: { FLAG: " TRUE " }, read: () => "" }), true);
});

// REGRESSION (2026-08-31): getEnv only ever read the repo-root .env, while CLAUDE.md's hard rule and
// .env.example both instruct the operator to put credentials in secrets/<company>/.env. Following the
// documented instructions therefore produced "No API key configured" with the key present on disk.
test("a key in secrets/owl-standard/.env is found — the documented location must work", () => {
  const files = ["/repo/secrets/owl-standard/.env", "/repo/.env"];
  const read = (path) => {
    if (path === "/repo/secrets/owl-standard/.env") return "ANTHROPIC_API_KEY=from-secrets\n";
    throw new Error("ENOENT");
  };
  assert.equal(readEnvValue("ANTHROPIC_API_KEY", { env: {}, files, read }), "from-secrets");
});

test("secrets/<company>/.env wins over the repo-root .env", () => {
  const files = ["/repo/secrets/owl-standard/.env", "/repo/.env"];
  const read = (path) => (path.includes("secrets")
    ? "OPENAI_API_KEY=specific\n"
    : "OPENAI_API_KEY=root\nHIGGSFIELD_API_KEY_ID=only-in-root\n");
  assert.equal(readEnvValue("OPENAI_API_KEY", { env: {}, files, read }), "specific");
  // ...but the root file still contributes keys the specific one does not define.
  assert.equal(readEnvValue("HIGGSFIELD_API_KEY_ID", { env: {}, files, read }), "only-in-root");
});

test("process.env still outranks BOTH files", () => {
  const files = ["/repo/secrets/owl-standard/.env", "/repo/.env"];
  const read = () => "ANTHROPIC_API_KEY=from-file\n";
  assert.equal(
    readEnvValue("ANTHROPIC_API_KEY", { env: { ANTHROPIC_API_KEY: "from-process" }, files, read }),
    "from-process",
    "Render sets env vars in the process — a stale committed file must never shadow them",
  );
});

test("both files missing is not fatal", () => {
  const read = () => { throw new Error("ENOENT"); };
  assert.equal(readEnvValue("ANYTHING", { env: {}, files: ["/a", "/b"], read }), "");
});
