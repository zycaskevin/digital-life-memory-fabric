import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { OBSIDIAN_PROJECTION_CONTRACT } from "../../dist/index.js";

const repoRoot = resolve(dirname(dirname(dirname(import.meta.filename))));
const vaultRoot = resolve(
  process.env.DLMF_OBSIDIAN_VAULT
    || `${repoRoot}/obsidian-vault`,
);
const manifest = JSON.parse(await readFile(resolve(vaultRoot, "dlmf-manifest.json"), "utf8"));
if (manifest.contract !== OBSIDIAN_PROJECTION_CONTRACT) {
  throw new Error(`unexpected Obsidian projection contract: ${manifest.contract}`);
}
if (manifest.activeMemoryCount !== manifest.notes.length) {
  throw new Error("activeMemoryCount does not match manifest notes");
}

const notePaths = new Set();
const memoryIds = new Set();
const supportingPaths = new Set();
const edgeCounts = Object.fromEntries(manifest.edgeTypes.map((type) => [type, 0]));
const supportingKinds = { concept: 0, person: 0, project: 0, source: 0 };

for (const note of manifest.notes) {
  if (memoryIds.has(note.memoryId)) throw new Error(`duplicate memory ID: ${note.memoryId}`);
  if (notePaths.has(note.path)) throw new Error(`duplicate note path: ${note.path}`);
  memoryIds.add(note.memoryId);
  notePaths.add(note.path);
  if (note.path !== `Memories/${note.memoryId}.md`) {
    throw new Error(`unstable memory filename: ${note.memoryId} -> ${note.path}`);
  }
  await access(resolve(vaultRoot, note.path));
  const content = await readFile(resolve(vaultRoot, note.path), "utf8");
  if (!content.includes(`dlmf_id: ${JSON.stringify(note.memoryId)}`)) {
    throw new Error(`memory note identity mismatch: ${note.memoryId}`);
  }
  if (!content.includes(`revision: ${note.revision}`)) {
    throw new Error(`memory note revision mismatch: ${note.memoryId}`);
  }
  for (const edge of note.edges) {
    if (!(edge.type in edgeCounts)) throw new Error(`unregistered edge type: ${edge.type}`);
    edgeCounts[edge.type] += 1;
    await access(resolve(vaultRoot, `${edge.target}.md`));
  }
}

for (const note of manifest.supportingNotes) {
  if (supportingPaths.has(note.path)) throw new Error(`duplicate supporting path: ${note.path}`);
  supportingPaths.add(note.path);
  if (!(note.kind in supportingKinds)) throw new Error(`unknown supporting kind: ${note.kind}`);
  supportingKinds[note.kind] += 1;
  await access(resolve(vaultRoot, note.path));
  for (const edge of note.edges ?? []) {
    if (!(edge.type in edgeCounts)) throw new Error(`unregistered edge type: ${edge.type}`);
    edgeCounts[edge.type] += 1;
    await access(resolve(vaultRoot, `${edge.target}.md`));
  }
}

for (const excluded of manifest.excluded) {
  if (excluded.status === "active") throw new Error(`active memory listed as excluded: ${excluded.memoryId}`);
  if (memoryIds.has(excluded.memoryId)) {
    throw new Error(`inactive memory leaked into active graph: ${excluded.memoryId}`);
  }
}

console.log(JSON.stringify({
  contract: manifest.contract,
  vaultRoot,
  activeMemoryCount: manifest.activeMemoryCount,
  excludedCount: manifest.excluded.length,
  supportingNoteCount: manifest.supportingNotes.length,
  supportingKinds,
  edgeCounts,
  maxCommitSeq: manifest.maxCommitSeq,
  duplicateMemoryIds: false,
  duplicateNotePaths: false,
  missingTargets: false,
  inactiveMemoryLeak: false,
  status: "PASS",
}, null, 2));
