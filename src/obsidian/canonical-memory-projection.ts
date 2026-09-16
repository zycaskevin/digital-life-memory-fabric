import type { MemoryRevision } from "../domain/types.js";
import {
  OBSIDIAN_PROJECTION_SCHEMA_VERSION,
  type ObsidianCanonicalProjectionOptions,
  type ObsidianProjectionBundle,
  type ObsidianProjectionNodeKind,
  type ObsidianProjectionNote,
} from "./types.js";

const DEFAULT_MANAGED_ROOT = "90 DLMF";

interface GraphNodeSpec {
  readonly nodeKind: Exclude<ObsidianProjectionNodeKind, "memory">;
  readonly directory: string;
  readonly label: string;
  readonly value: string;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function normalizeManagedRoot(value: string | undefined): string {
  const root = (value ?? DEFAULT_MANAGED_ROOT).trim().replace(/^\/+|\/+$/g, "");
  if (!root) {
    throw new Error("Obsidian managedRoot must not be empty");
  }

  const segments = root.split("/");
  if (segments.some((segment) => segment === "." || segment === ".." || segment.length === 0)) {
    throw new Error("Obsidian managedRoot must be a relative vault path without traversal");
  }
  return segments.map(safePathSegment).join("/");
}

function safePathSegment(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .trim()
    .replace(/[\\/:*?"<>|#^[\]]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/\.+$/g, "")
    .trim();

  return normalized || "unknown";
}

function graphNodePath(root: string, node: GraphNodeSpec): string {
  return `${root}/${node.directory}/${safePathSegment(node.value)}.md`;
}

function graphNodeLink(root: string, node: GraphNodeSpec): string {
  const path = graphNodePath(root, node).slice(0, -3);
  return `[[${path}|${node.label}: ${node.value}]]`;
}

function renderGraphNode(root: string, node: GraphNodeSpec): ObsidianProjectionNote {
  const content = [
    "---",
    "dlmf_managed: true",
    `dlmf_projection_schema: ${yamlString(OBSIDIAN_PROJECTION_SCHEMA_VERSION)}`,
    `dlmf_node_kind: ${yamlString(node.nodeKind)}`,
    `dlmf_node_value: ${yamlString(node.value)}`,
    "---",
    "",
    `# ${node.label}: ${node.value}`,
    "",
    "Generated graph node for DLMF Canonical Memory navigation.",
    "",
    "> This file is a rebuildable DLMF projection, not Canonical Memory authority.",
    "",
  ].join("\n");

  return {
    path: graphNodePath(root, node),
    content,
    managed: true,
    nodeKind: node.nodeKind,
  };
}

function renderMemoryNote(
  root: string,
  revision: MemoryRevision,
  graphNodes: readonly GraphNodeSpec[],
): ObsidianProjectionNote {
  const sourceType = revision.provenance.sourceType;
  const links = graphNodes.map((node) => `- ${graphNodeLink(root, node)}`);
  const content = [
    "---",
    "dlmf_managed: true",
    `dlmf_projection_schema: ${yamlString(OBSIDIAN_PROJECTION_SCHEMA_VERSION)}`,
    `dlmf_memory_id: ${yamlString(revision.memoryId)}`,
    `dlmf_revision: ${revision.revision}`,
    `dlmf_commit_seq: ${revision.commitSeq}`,
    `dlmf_status: ${yamlString(revision.status)}`,
    `dlmf_memory_class: ${yamlString(revision.memoryClass)}`,
    `dlmf_memory_type: ${yamlString(revision.memoryType)}`,
    `dlmf_memory_kind: ${yamlString(revision.memoryKind)}`,
    `dlmf_epistemic_status: ${yamlString(revision.epistemicStatus)}`,
    `dlmf_semantic_key: ${yamlString(revision.semanticKey)}`,
    `dlmf_tenant_id: ${yamlString(revision.scope.tenantId)}`,
    `dlmf_life_did: ${yamlString(revision.scope.lifeDid)}`,
    `dlmf_namespace: ${yamlString(revision.scope.memoryNamespace)}`,
    `dlmf_source_type: ${yamlString(sourceType)}`,
    `dlmf_committed_at: ${yamlString(revision.committedAt)}`,
    "---",
    "",
    `# ${revision.memoryId}`,
    "",
    revision.canonicalContent.text,
    "",
    "## Connections",
    "",
    ...links,
    "",
    "## Canonical reference",
    "",
    `- Revision: ${revision.revision}`,
    `- Commit sequence: ${revision.commitSeq}`,
    `- Semantic key: \`${revision.semanticKey}\``,
    `- Source type: \`${sourceType}\``,
    "",
    "> Managed by Digital Life Memory Fabric. Edit the source note or Canonical Memory workflow instead of this generated file.",
    "",
  ].join("\n");

  return {
    path: `${root}/Memories/${revision.memoryId}.md`,
    content,
    managed: true,
    nodeKind: "memory",
    sourceMemoryId: revision.memoryId,
  };
}

/**
 * Pure, deterministic Canonical Memory -> Obsidian projection.
 *
 * This class deliberately has no filesystem or Obsidian dependency. DLS does
 * not need to know it exists, and deleting its output never deletes or edits
 * Canonical Memory.
 */
export class ObsidianCanonicalMemoryProjection {
  readonly #managedRoot: string;

  constructor(options: ObsidianCanonicalProjectionOptions = {}) {
    this.#managedRoot = normalizeManagedRoot(options.managedRoot);
  }

  project(revision: MemoryRevision): ObsidianProjectionBundle {
    const graphNodes: readonly GraphNodeSpec[] = [
      {
        nodeKind: "memory_class",
        directory: "Memory Classes",
        label: "Memory class",
        value: revision.memoryClass,
      },
      {
        nodeKind: "memory_type",
        directory: "Memory Types",
        label: "Memory type",
        value: revision.memoryType,
      },
      {
        nodeKind: "namespace",
        directory: "Namespaces",
        label: "Namespace",
        value: revision.scope.memoryNamespace,
      },
      {
        nodeKind: "source_type",
        directory: "Source Types",
        label: "Source type",
        value: revision.provenance.sourceType,
      },
    ];

    return {
      schemaVersion: OBSIDIAN_PROJECTION_SCHEMA_VERSION,
      memoryId: revision.memoryId,
      canonicalRevision: revision.revision,
      commitSeq: revision.commitSeq,
      notes: [
        renderMemoryNote(this.#managedRoot, revision, graphNodes),
        ...graphNodes.map((node) => renderGraphNode(this.#managedRoot, node)),
      ],
    };
  }
}
