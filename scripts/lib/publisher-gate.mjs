export const stripPublisherComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

export function publisherGateFailures({ source, relativePath, approvalExempt = false } = {}) {
  const src = stripPublisherComments(source || "");
  const failures = [];
  if (!/\bassertNotFrozen\s*\(/.test(src)) failures.push("no assertNotFrozen() call");
  if (!approvalExempt && !/\b(?:isPublishable|isApproved)\s*\(/.test(src)) failures.push("no approval call");
  const directClaim = /\bpublishClaimed\s*\(/.test(src);
  const guardedCoreCaller = relativePath !== "lib/fb-post.mjs" && /\bpostOne\s*\(/.test(src);
  if (!directClaim && !guardedCoreCaller) failures.push("no publishClaimed() boundary");
  if (/new URL\([^)]*\.\.[^)]*(?:weeks|captions|posters|topics-ledger|topic-coverage)/.test(src)) {
    failures.push("repo-relative mutable state path");
  }
  return failures;
}
