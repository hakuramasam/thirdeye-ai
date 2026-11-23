const projectId = process.env.NEON_PROJECT_ID;
const apiKey = process.env.NEON_API_KEY;
const branchName = process.env.NEON_BRANCH_NAME;

if (!projectId || !apiKey || !branchName) {
  throw new Error("NEON_PROJECT_ID, NEON_API_KEY, and NEON_BRANCH_NAME are required.");
}
if (!branchName.startsWith("preview/") || branchName === "preview/main") {
  throw new Error(`Refusing to expire non-preview branch: ${branchName}`);
}
if (branchName === "vercel-preview") {
  throw new Error("The persistent vercel-preview branch is explicitly excluded.");
}

const baseUrl = `https://console.neon.tech/api/v2/projects/${encodeURIComponent(projectId)}/branches`;
const headers = {
  accept: "application/json",
  authorization: `Bearer ${apiKey}`,
  "content-type": "application/json",
};

const listResponse = await fetch(`${baseUrl}?search=${encodeURIComponent(branchName)}`, { headers });
if (!listResponse.ok) {
  throw new Error(`Neon branch lookup failed (${listResponse.status}): ${await listResponse.text()}`);
}
const listing = await listResponse.json();
const matches = (listing.branches ?? []).filter((branch) => branch.name === branchName);

if (matches.length === 0) {
  console.log(`No Neon branch named ${branchName}; it may already have been removed by the Vercel integration.`);
  process.exit(0);
}
if (matches.length !== 1) {
  throw new Error(`Expected one exact Neon branch match for ${branchName}; found ${matches.length}.`);
}

const branch = matches[0];
if (branch.default || branch.protected) {
  throw new Error(`Refusing to set expiry on default/protected branch ${branchName}.`);
}

const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
const updateResponse = await fetch(`${baseUrl}/${encodeURIComponent(branch.id)}`, {
  method: "PATCH",
  headers,
  body: JSON.stringify({ branch: { expires_at: expiresAt } }),
});
if (!updateResponse.ok) {
  throw new Error(`Neon branch expiry update failed (${updateResponse.status}): ${await updateResponse.text()}`);
}

const updated = await updateResponse.json();
console.log(`Set ${updated.branch?.name ?? branchName} to expire at ${updated.branch?.expires_at ?? expiresAt}.`);
