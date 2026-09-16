import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ObsidianProjectionBundle } from "./types.js";

export interface FilesystemObsidianProjectionWriterOptions {
  /** Absolute or relative path to the user-owned Obsidian vault root. */
  readonly vaultRoot: string;
}

export interface ObsidianProjectionWriteResult {
  readonly memoryId: string;
  readonly canonicalRevision: number;
  readonly writtenPaths: readonly string[];
}

/**
 * Writes only DLMF-generated projection files beneath a configured vault root.
 * It never reads from the vault and never mutates Canonical Memory.
 */
export class FilesystemObsidianProjectionWriter {
  readonly #vaultRoot: string;

  constructor(options: FilesystemObsidianProjectionWriterOptions) {
    if (!options.vaultRoot.trim()) {
      throw new Error("Obsidian vaultRoot must not be empty");
    }
    this.#vaultRoot = path.resolve(options.vaultRoot);
  }

  async write(bundle: ObsidianProjectionBundle): Promise<ObsidianProjectionWriteResult> {
    const writtenPaths: string[] = [];

    for (const [index, note] of bundle.notes.entries()) {
      const targetPath = this.#resolveInsideVault(note.path);
      const targetDirectory = path.dirname(targetPath);
      await mkdir(targetDirectory, { recursive: true });

      const temporaryPath = path.join(
        targetDirectory,
        `.dlmf-${process.pid}-${bundle.commitSeq}-${index}.tmp`,
      );
      await writeFile(temporaryPath, note.content, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, targetPath);
      writtenPaths.push(targetPath);
    }

    return {
      memoryId: bundle.memoryId,
      canonicalRevision: bundle.canonicalRevision,
      writtenPaths,
    };
  }

  #resolveInsideVault(relativePath: string): string {
    if (path.isAbsolute(relativePath)) {
      throw new Error("Obsidian projection path must be relative to the vault root");
    }

    const targetPath = path.resolve(this.#vaultRoot, relativePath);
    const relative = path.relative(this.#vaultRoot, targetPath);
    if (relative === "" || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
      throw new Error("Obsidian projection path escaped the configured vault root");
    }
    return targetPath;
  }
}
