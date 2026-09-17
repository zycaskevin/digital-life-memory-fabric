import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type {
  MemoryId,
  MemoryRevision,
  MemoryScope,
  MemoryStatus,
} from "../domain/types.js";
import type { CanonicalMemoryStore } from "../store/canonical-memory-store.js";

export const OBSIDIAN_PROJECTION_CONTRACT = "dlmf/obsidian-readonly-projection/v1";

export type ObsidianProjectionEdgeType =
  | "related_to"
  | "supports"
  | "contradicts"
  | "supersedes"
  | "belongs_to_project"
  | "concerns"
  | "derived_from";

export interface ObsidianProjectionEdge {
  type: ObsidianProjectionEdgeType;
  target: string;
}

export interface ObsidianProjectionManifestNote {
  memoryId: MemoryId;
  revision: number;
  status: MemoryStatus;
  path: string;
  noteHash: string;
  edges: ObsidianProjectionEdge[];
}

export interface ObsidianSupportingNoteManifest {
  kind: "concept" | "person" | "project" | "source";
  key: string;
  path: string;
  noteHash: string;
  edges: ObsidianProjectionEdge[];
}

export interface ObsidianProjectionManifest {
  contract: typeof OBSIDIAN_PROJECTION_CONTRACT;
  scope: MemoryScope;
  maxCommitSeq: number;
  activeMemoryCount: number;
  excluded: Array<{ memoryId: MemoryId; revision: number; status: MemoryStatus }>;
  edgeTypes: ObsidianProjectionEdgeType[];
  notes: ObsidianProjectionManifestNote[];
  supportingNotes: ObsidianSupportingNoteManifest[];
}

export interface ObsidianProjectionResult {
  manifest: ObsidianProjectionManifest;
  written: string[];
  unchanged: string[];
  removed: string[];
}

export type ObsidianProjectionSource = Pick<
  CanonicalMemoryStore,
  "listChangesAfter" | "getHeads" | "getRevisions"
>;

export interface ObsidianMemoryProjectionOptions {
  store: ObsidianProjectionSource;
  scope: MemoryScope;
  vaultRoot: string;
  pageSize?: number;
}

interface RenderedNote {
  path: string;
  content: string;
}

interface SupportingNode {
  kind: ObsidianSupportingNoteManifest["kind"];
  key: string;
  path: string;
  title: string;
  metadata: Record<string, string>;
  incoming: Array<{ type: ObsidianProjectionEdgeType; memoryPath: string }>;
}

const GENERATED_ROOTS = ["Memories/", "Concepts/", "People/", "Projects/", "Sources/"];
const EDGE_TYPES: ObsidianProjectionEdgeType[] = [
  "related_to",
  "supports",
  "contradicts",
  "supersedes",
  "belongs_to_project",
  "concerns",
  "derived_from",
];

export class ObsidianMemoryProjection {
  private readonly pageSize: number;
  private readonly vaultRoot: string;

  constructor(private readonly options: ObsidianMemoryProjectionOptions) {
    this.pageSize = Math.max(1, Math.min(options.pageSize ?? 500, 2000));
    this.vaultRoot = resolve(options.vaultRoot);
  }

  async export(): Promise<ObsidianProjectionResult> {
    const changes = await this.listAllChanges();
    const memoryIds = [...new Set(changes.map((change) => change.memoryId))].sort();
    const maxCommitSeq = changes.reduce((max, change) => Math.max(max, change.commitSeq), 0);
    const heads = await this.options.store.getHeads(memoryIds);
    const presentHeads = heads.filter((head) => head !== undefined);
    const revisionRefs = presentHeads.map((head) => ({
      memoryId: head.memoryId,
      revision: head.currentRevision,
    }));
    const revisions = await this.options.store.getRevisions(revisionRefs);
    const current = revisions.filter((revision) => revision !== undefined);

    const active = current
      .filter((revision) => revision.status === "active")
      .sort(compareRevision);
    const excluded = current
      .filter((revision) => revision.status !== "active")
      .map((revision) => ({
        memoryId: revision.memoryId,
        revision: revision.revision,
        status: revision.status,
      }))
      .sort((a, b) => a.memoryId.localeCompare(b.memoryId));

    const supporting = new Map<string, SupportingNode>();
    const renderedMemories: Array<RenderedNote & { manifest: ObsidianProjectionManifestNote }> = [];
    for (const revision of active) {
      const path = memoryPath(revision.memoryId);
      const edges = this.edgesFor(revision, path, supporting);
      const content = renderMemoryNote(revision, edges);
      renderedMemories.push({
        path,
        content,
        manifest: {
          memoryId: revision.memoryId,
          revision: revision.revision,
          status: revision.status,
          path,
          noteHash: sha256Text(content),
          edges,
        },
      });
    }

    const renderedSupporting = [...supporting.values()]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((node) => {
        const content = renderSupportingNote(node);
        return {
          path: node.path,
          content,
          manifest: {
            kind: node.kind,
            key: node.key,
            path: node.path,
            noteHash: sha256Text(content),
            edges: dedupeEdges(node.incoming.map((incoming) => ({
              type: incoming.type,
              target: wikilinkTarget(incoming.memoryPath),
            }))).sort(compareEdge),
          } satisfies ObsidianSupportingNoteManifest,
        };
      });

    const manifest: ObsidianProjectionManifest = {
      contract: OBSIDIAN_PROJECTION_CONTRACT,
      scope: this.options.scope,
      maxCommitSeq,
      activeMemoryCount: renderedMemories.length,
      excluded,
      edgeTypes: [...EDGE_TYPES],
      notes: renderedMemories.map((note) => note.manifest),
      supportingNotes: renderedSupporting.map((note) => note.manifest),
    };
    const manifestPath = "dlmf-manifest.json";
    const desired = new Map<string, string>([
      ...renderedMemories.map((note) => [note.path, note.content] as const),
      ...renderedSupporting.map((note) => [note.path, note.content] as const),
      [manifestPath, `${JSON.stringify(manifest, null, 2)}\n`],
    ]);

    const previous = await this.readPreviousManifest();
    const removed: string[] = [];
    for (const path of previousGeneratedPaths(previous)) {
      if (desired.has(path) || !isSafeGeneratedPath(path)) continue;
      await rm(join(this.vaultRoot, path), { force: true });
      removed.push(path);
    }

    const written: string[] = [];
    const unchanged: string[] = [];
    for (const [path, content] of [...desired.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const absolute = join(this.vaultRoot, path);
      const existing = await readTextIfPresent(absolute);
      if (existing === content) {
        unchanged.push(path);
        continue;
      }
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, content, "utf8");
      written.push(path);
    }

    return {
      manifest,
      written: written.sort(),
      unchanged: unchanged.sort(),
      removed: removed.sort(),
    };
  }

  private async listAllChanges() {
    const changes = [];
    let after = 0;
    for (;;) {
      const page = await this.options.store.listChangesAfter(
        this.options.scope,
        after,
        this.pageSize,
      );
      if (page.length === 0) break;
      changes.push(...page);
      const next = page[page.length - 1]?.commitSeq ?? after;
      if (next <= after) throw new Error("obsidian_projection_non_monotonic_commit_sequence");
      after = next;
      if (page.length < this.pageSize) break;
    }
    return changes;
  }

  private edgesFor(
    revision: MemoryRevision,
    memoryNotePath: string,
    nodes: Map<string, SupportingNode>,
  ): ObsidianProjectionEdge[] {
    const edges: ObsidianProjectionEdge[] = [];
    const add = (
      type: ObsidianProjectionEdgeType,
      node: Omit<SupportingNode, "incoming">,
    ) => {
      const existing = nodes.get(node.path) ?? { ...node, incoming: [] };
      existing.incoming.push({ type: reverseEdge(type), memoryPath: memoryNotePath });
      existing.incoming.sort((a, b) =>
        a.memoryPath.localeCompare(b.memoryPath) || a.type.localeCompare(b.type),
      );
      nodes.set(node.path, existing);
      edges.push({ type, target: wikilinkTarget(node.path) });
    };

    add("concerns", conceptNode(`memory-type:${revision.memoryType}`, `Memory Type — ${revision.memoryType}`));
    add("concerns", conceptNode(`memory-class:${revision.memoryClass}`, `Memory Class — ${revision.memoryClass}`));
    add("related_to", conceptNode(`memory-kind:${revision.memoryKind}`, `Memory Kind — ${revision.memoryKind}`));

    if (revision.speakerProvenance !== "unknown" && revision.speakerProvenance !== "mixed") {
      add("concerns", personNode(revision.speakerProvenance));
    }
    if (revision.memoryType === "project_state") {
      add("belongs_to_project", projectNode(revision.memoryKind));
    }
    for (const source of [...revision.sourceExperienceRefs].sort(compareSourceRef)) {
      add("derived_from", sourceNode(source.sourceType, source.sourceId));
    }

    return dedupeEdges(edges).sort(compareEdge);
  }

  private async readPreviousManifest(): Promise<ObsidianProjectionManifest | undefined> {
    const text = await readTextIfPresent(join(this.vaultRoot, "dlmf-manifest.json"));
    if (text === undefined) return undefined;
    try {
      const parsed = JSON.parse(text);
      return parsed?.contract === OBSIDIAN_PROJECTION_CONTRACT
        ? parsed as ObsidianProjectionManifest
        : undefined;
    } catch {
      return undefined;
    }
  }
}

function memoryPath(memoryId: MemoryId): string {
  return `Memories/${memoryId}.md`;
}

function conceptNode(key: string, title: string): Omit<SupportingNode, "incoming"> {
  const id = stableNodeId(key);
  return {
    kind: "concept",
    key,
    path: `Concepts/${id}.md`,
    title,
    metadata: { concept_key: key },
  };
}

function personNode(speaker: string): Omit<SupportingNode, "incoming"> {
  const key = `speaker:${speaker}`;
  return {
    kind: "person",
    key,
    path: `People/${stableNodeId(key)}.md`,
    title: `Speaker — ${speaker}`,
    metadata: { speaker_provenance: speaker },
  };
}

function projectNode(memoryKind: string): Omit<SupportingNode, "incoming"> {
  const key = `project-kind:${memoryKind}`;
  return {
    kind: "project",
    key,
    path: `Projects/${stableNodeId(key)}.md`,
    title: `Project grouping — ${memoryKind}`,
    metadata: {
      project_grouping_basis: "memory_kind",
      memory_kind: memoryKind,
    },
  };
}

function sourceNode(sourceType: string, sourceId: string): Omit<SupportingNode, "incoming"> {
  const key = `${sourceType}\u0000${sourceId}`;
  return {
    kind: "source",
    key,
    path: `Sources/src_${sha256Text(key).slice(0, 20)}.md`,
    title: `Source — ${sourceType}`,
    metadata: {
      source_type: sourceType,
      source_id: sourceId,
    },
  };
}

function stableNodeId(key: string): string {
  const slug = key
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "node";
  return `${slug}-${sha256Text(key).slice(0, 8)}`;
}

function renderMemoryNote(revision: MemoryRevision, edges: ObsidianProjectionEdge[]): string {
  const title = titleFromText(revision.canonicalContent.text, revision.memoryKind);
  const frontmatter = [
    "---",
    `dlmf_projection: ${yaml(OBSIDIAN_PROJECTION_CONTRACT)}`,
    `dlmf_id: ${yaml(revision.memoryId)}`,
    `revision: ${revision.revision}`,
    `status: ${yaml(revision.status)}`,
    `class: ${yaml(revision.memoryClass)}`,
    `kind: ${yaml(revision.memoryKind)}`,
    `type: ${yaml(revision.memoryType)}`,
    `epistemic: ${yaml(revision.epistemicStatus)}`,
    `speaker: ${yaml(revision.speakerProvenance)}`,
    `semantic_key: ${yaml(revision.semanticKey)}`,
    `commit_seq: ${revision.commitSeq}`,
    `committed_at: ${yaml(revision.committedAt)}`,
    `content_hash: ${yaml(revision.contentHash)}`,
    "dlmf_edges:",
    ...edges.flatMap((edge) => [
      `  - type: ${yaml(edge.type)}`,
      `    target: ${yaml(edge.target)}`,
    ]),
    "---",
  ];
  const relations = edges.length === 0
    ? "- none"
    : edges.map((edge) => `- \`${edge.type}\` [[${edge.target}]]`).join("\n");
  return `${frontmatter.join("\n")}\n\n# ${title}\n\n${revision.canonicalContent.text.trim()}\n\n## Relations\n\n${relations}\n`;
}

function renderSupportingNote(node: SupportingNode): string {
  const frontmatter = [
    "---",
    `dlmf_projection: ${yaml(OBSIDIAN_PROJECTION_CONTRACT)}`,
    `dlmf_node_kind: ${yaml(node.kind)}`,
    `dlmf_node_key: ${yaml(node.key)}`,
    ...Object.entries(node.metadata)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}: ${yaml(value)}`),
    "---",
  ];
  const links = node.incoming.length === 0
    ? "- none"
    : node.incoming
      .map((incoming) => `- \`${incoming.type}\` [[${wikilinkTarget(incoming.memoryPath)}]]`)
      .join("\n");
  return `${frontmatter.join("\n")}\n\n# ${node.title}\n\n## Linked Canonical Memories\n\n${links}\n`;
}

function reverseEdge(type: ObsidianProjectionEdgeType): ObsidianProjectionEdgeType {
  return type === "derived_from" ? "supports" : type;
}

function titleFromText(text: string, fallback: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return fallback;
  const sentence = normalized.split(/[。！？.!?]/u, 1)[0]?.trim() || fallback;
  return sentence.length > 72 ? `${sentence.slice(0, 69)}…` : sentence;
}

function wikilinkTarget(path: string): string {
  return path.endsWith(".md") ? path.slice(0, -3) : path;
}

function yaml(value: string): string {
  return JSON.stringify(value);
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function dedupeEdges(edges: ObsidianProjectionEdge[]): ObsidianProjectionEdge[] {
  const map = new Map<string, ObsidianProjectionEdge>();
  for (const edge of edges) map.set(`${edge.type}\u0000${edge.target}`, edge);
  return [...map.values()];
}

function compareEdge(a: ObsidianProjectionEdge, b: ObsidianProjectionEdge): number {
  return a.type.localeCompare(b.type) || a.target.localeCompare(b.target);
}

function compareRevision(a: MemoryRevision, b: MemoryRevision): number {
  return a.commitSeq - b.commitSeq || a.memoryId.localeCompare(b.memoryId);
}

function compareSourceRef(
  a: MemoryRevision["sourceExperienceRefs"][number],
  b: MemoryRevision["sourceExperienceRefs"][number],
): number {
  return a.sourceType.localeCompare(b.sourceType) || a.sourceId.localeCompare(b.sourceId);
}

function previousGeneratedPaths(manifest: ObsidianProjectionManifest | undefined): string[] {
  if (manifest === undefined) return [];
  return [
    ...manifest.notes.map((note) => note.path),
    ...manifest.supportingNotes.map((note) => note.path),
  ];
}

function isSafeGeneratedPath(path: string): boolean {
  return !path.includes("..") && GENERATED_ROOTS.some((prefix) => path.startsWith(prefix));
}

async function readTextIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
