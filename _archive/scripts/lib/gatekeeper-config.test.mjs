import test from "node:test";
import assert from "node:assert/strict";
import {
  assertGatekeeperAutofixAuthorized,
  GatekeeperAutofixAuthorizationError,
  gatekeeperAgentVerifyEnabled,
  gatekeeperAutofixAuthorization,
} from "./gatekeeper-config.mjs";

const options = (value, key = "GATEKEEPER_AUTOFIX") => ({
  env: value === undefined ? {} : { [key]: value },
  read: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
});

test("gatekeeper auto-fix is unreachable without the explicit --autofix request", () => {
  assert.equal(gatekeeperAutofixAuthorization(options()), null);
  assert.equal(gatekeeperAutofixAuthorization(options("true")), null);
});

test("gatekeeper refuses the whole auto-fix request unless authorisation is confirmed", () => {
  for (const value of [undefined, "", "1", "yes", "on", "false", "tru"]) {
    assert.throws(
      () => gatekeeperAutofixAuthorization({ ...options(value), argv: ["--autofix"] }),
      GatekeeperAutofixAuthorizationError,
      String(value),
    );
  }
});

test("only explicit request plus exact authorisation creates the required capability", () => {
  const authorization = gatekeeperAutofixAuthorization({
    ...options("true"),
    argv: ["--autofix"],
  });
  assert.doesNotThrow(() => assertGatekeeperAutofixAuthorized(authorization));
  for (const invalid of [undefined, null, false, true, {}]) {
    assert.throws(
      () => assertGatekeeperAutofixAuthorized(invalid),
      GatekeeperAutofixAuthorizationError,
    );
  }
});

test("gatekeeper agent verification defaults off and requires exact true", () => {
  const agentOptions = (value) => options(value, "GATEKEEPER_AGENT_VERIFY");
  assert.equal(gatekeeperAgentVerifyEnabled(agentOptions()), false);
  for (const value of ["", "1", "yes", "on", "false", "tru"]) {
    assert.equal(gatekeeperAgentVerifyEnabled(agentOptions(value)), false, value);
  }
  assert.equal(gatekeeperAgentVerifyEnabled(agentOptions("true")), true);
});
