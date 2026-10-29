import { claimSlot, PublishConflictError } from "./publish-ledger.mjs";

try {
  claimSlot(JSON.parse(process.argv[2]));
  console.log("CLAIMED");
  if (process.argv.includes("--hold")) await new Promise(() => {});
} catch (error) {
  if (error instanceof PublishConflictError) {
    console.error(error.message);
    process.exit(3);
  }
  throw error;
}
