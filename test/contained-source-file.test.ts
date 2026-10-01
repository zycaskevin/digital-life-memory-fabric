import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  readContainedSourceFile,
  readContainedSourceFirstLine,
} from "../src/source-adapters/contained-source-file.js";

test(
  "contained source readers reject a replacement FIFO without blocking",
  { skip: process.platform !== "linux", timeout: 2000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "dlmf-contained-fifo-"));
    try {
      const path = join(root, "source.jsonl");
      await writeFile(path, "{}\n", "utf8");
      await rm(path);
      execFileSync("mkfifo", [path]);

      await assert.rejects(
        () => readContainedSourceFile(path, root),
        /regular file/,
      );
      await assert.rejects(
        () => readContainedSourceFirstLine(path, root),
        /regular file/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
