import { readEnabledFlag } from "./env.mjs";

const AUTOFIX_CAPABILITY = Symbol("gatekeeper-autofix-capability");

export class GatekeeperAutofixAuthorizationError extends Error {
  constructor(message) {
    super(message);
    this.name = "GatekeeperAutofixAuthorizationError";
    this.code = "GATEKEEPER_AUTOFIX_UNAUTHORIZED";
    this.kind = "authorization";
  }
}

// Live remediation requires two independent, explicit positive signals:
// the invocation requests --autofix and the deployment authorises it with exact `true`.
// A request without confirmed authorisation aborts the whole process before any scan/remediation.
export function gatekeeperAutofixAuthorization({
  argv = process.argv.slice(2),
  ...options
} = {}) {
  const requested = argv.includes("--autofix");
  if (!requested) return null;
  if (!readEnabledFlag("GATEKEEPER_AUTOFIX", options)) {
    throw new GatekeeperAutofixAuthorizationError(
      "Refusing --autofix: set GATEKEEPER_AUTOFIX=true to confirm live remediation is authorised.",
    );
  }
  return Object.freeze({ [AUTOFIX_CAPABILITY]: true });
}

export function assertGatekeeperAutofixAuthorized(authorization) {
  if (authorization?.[AUTOFIX_CAPABILITY] !== true) {
    throw new GatekeeperAutofixAuthorizationError(
      "Refusing Gatekeeper auto-fix without an explicit authorised capability.",
    );
  }
}

// Agent verification can spend time and invoke a local CLI. It is advisory, but still exact opt-in.
export const gatekeeperAgentVerifyEnabled = (options) =>
  readEnabledFlag("GATEKEEPER_AGENT_VERIFY", options);
