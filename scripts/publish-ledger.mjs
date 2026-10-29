// publish-ledger.mjs — deliberately loud human escape hatch for a blocked publish slot.
// Usage: node scripts/publish-ledger.mjs --force-release <brand> <slug> <fb|ig> <YYYY-MM-DD>
import { forceReleaseSlot } from "./lib/publish-ledger.mjs";

const index = process.argv.indexOf("--force-release");
if (index < 0 || process.argv.length < index + 5) {
  console.error("Usage: node scripts/publish-ledger.mjs --force-release <brand> <slug> <fb|ig> <YYYY-MM-DD>");
  process.exit(2);
}

const [brand, slug, channel, planned_date] = process.argv.slice(index + 1, index + 5);
const result = forceReleaseSlot({ brand, slug, channel, planned_date });
if (!result.released) {
  console.error(`FORCE RELEASE REFUSED: no identity exists for ${brand}/${slug}/${channel}.`);
  process.exit(1);
}
console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
console.error(`FORCE RELEASED ${brand}/${slug}/${channel} (planned date was ${planned_date})`);
console.error(`Previous status: ${result.previous?.status || "uncertain"}`);
console.error("A human must verify Meta before this slot is allowed to publish again.");
console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
