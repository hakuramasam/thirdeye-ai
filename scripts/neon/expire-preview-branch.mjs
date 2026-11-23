const projectId = process.env.NEON_PROJECT_ID;
const apiKey = process.env.NEON_API_KEY;
const branchName = process.env.NEON_BRANCH_NAME;
const action = process.env.NEON_BRANCH_ACTION ?? "expire";

if (!projectId || !apiKey || !branchName) {
  throw new Error("NEON_PROJECT_ID, NEON_API_KEY, and NEON_BRANCH_NAME are required.");
}
if (!["expire", "clear"].includes(action)) {
  throw new Error(`Unsupported Neon branch lifecycle action: ${action}`);
}
if (branchName === "vercel-preview" || !branchName.startsWith("preview/") || branchName === "preview/main") {
  throw new Error(`Refusing to modify non-preview branch: ${branchName}`);
}

const baseUrl = `https://console.neon.tech/api/v2/projects/${encodeURIComponent(projectId)}/branches`;
const headers = {
  accept: "application/json",
  authorization: `Bearer ${apiKey}`,
  "content-type": "application/json",
};

// Neon paginates branch listings. Follow every cursor so an older preview branch is
// never mistaken for an already-deleted branch just because it is not on page one.
const matches = [];
const seenCursors = new Set();
let cursor;
do {
  const pageUrl = new URL(baseUrl);
  pageUrl.searchParams.set("limit", "100");
  if (cursor) pageUrl.searchParams.set("cursor", cursor);

  const listResponse = await fetch(pageUrl, { headers });
  if (!listResponse.ok) {
    throw new Error(`Neon branch lookup failed (${listResponse.status}): ${await listResponse.text()}`);
  }

  const listing = await listResponse.json();
  matches.push(...(listing.branches ?? []).filter((branch) => branch.name === branchName));

  const nextCursor = listing.pagination?.next ?? null;
  if (nextCursor && (typeof nextCursor !== "string" || seenCursors.has(nextCursor))) {
    throw new Error("Neon branch listing returned an invalid or repeated pagination cursor.");
  }
  if (nextCursor) seenCursors.add(nextCursor);
  cursor = nextCursor;
} while (cursor);

if (matches.length === 0) {
  console.log(`No Neon branch named ${branchName}; it may already have been removed by the Vercel integration.`);
  process.exit(0);
}
if (matches.length !== 1) {
  throw new Error(`Expected one exact Neon branch match for ${branchName}; found ${matches.length}.`);
}

const branch = matches[0];
if (branch.default || branch.protected) {
  throw new Error(`Refusing to modify default/protected branch ${branchName}.`);
}

const expiresAt = action === "expire"
  ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
  : null;

if (action === "clear" && !branch.expires_at) {
  console.log(`No expiry is set for ${branchName}; nothing to clear.`);
  process.exit(0);
}

const updateResponse = await fetch(`${baseUrl}/${encodeURIComponent(branch.id)}`, {
  method: "PATCH",
  headers,
  body: JSON.stringify({ branch: { expires_at: expiresAt } }),
});
if (!updateResponse.ok) {
  throw new Error(`Neon branch lifecycle update failed (${updateResponse.status}): ${await updateResponse.text()}`);
}

const updated = await updateResponse.json();
if (action === "expire") {
  console.log(`Set ${updated.branch?.name ?? branchName} to expire at ${updated.branch?.expires_at ?? expiresAt}.`);
} else {
  console.log(`Cleared the scheduled expiry for ${updated.branch?.name ?? branchName}.`);
}
