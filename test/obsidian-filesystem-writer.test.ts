import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ObsidianProjectionBundle } from "../src/obsidian/types.js";
import { FilesystemObsidianProjectionWriter } from "../src/obsidian/filesystem-projection-writer.js";

function bundle(notePath = "90 DLMF/Memories/mem_writer_test.md"): ObsidianProjectionBundle {
  return {
    schemaVersion: "1",
    memoryId: "mem_writer_test",
    canonicalRevision: 2,
    commitSeq: 17,
    notes: [
      {
        path: notePath,
        content: "# projected memory\n",
        managed: true,
        nodeKind: "memory",
        sourceMemoryId: "mem_writer_test",
      },
    ],
  };
}

test("filesystem Obsidian writer writes only beneath the configured vault root", async (t) => {
  const vaultRoot = await mkdtemp(path.join(tmpdir(), "dlmf-obsidian-"));
  t.after(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  const writer = new FilesystemObsidianProjectionWriter({ vaultRoot });
  const result = await writer.write(bundle());
  const expectedPath = path.join(vaultRoot, "90 DLMF", "Memories", "mem_writer_test.md");

  assert.deepEqual(result.writtenPaths, [expectedPath]);
  assert.equal(await readFile(expectedPath, "utf8"), "# projected memory\n");
});

test("filesystem Obsidian writer rejects projection path traversal", async (t) => {
  const vaultRoot = await mkdtemp(path.join(tmpdir(), "dlmf-obsidian-"));
  t.after(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  const writer = new FilesystemObsidianProjectionWriter({ vaultRoot });
  await assert.rejects(
    writer.write(bundle("../outside.md")),
    /escaped the configured vault root/,
  );
});
