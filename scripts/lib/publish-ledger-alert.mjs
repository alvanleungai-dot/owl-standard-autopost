import { escalate } from "./alert.mjs";
import { alertStaleUncertainSlots } from "./publish-ledger.mjs";

export async function reapPublishLedger() {
  return alertStaleUncertainSlots({ alert: escalate });
}
