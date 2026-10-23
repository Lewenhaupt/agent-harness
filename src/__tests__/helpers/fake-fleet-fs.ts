/**
 * In-memory fs implementing the synchronous surface the fleet state layer uses.
 *
 * Shared by the fleet unit tests that need a real writer/reader round-trip
 * without touching disk. The directory hierarchy is implicit: any existing file
 * under a path makes that path "exist".
 */

import { basename } from "node:path";
import type { FleetStateFs } from "../../fleet-state.js";

export interface FakeFleetFs extends FleetStateFs {
  files: Map<string, string>;
}

export function createFakeFleetFs(initial: Record<string, string> = {}): FakeFleetFs {
  const files = new Map(Object.entries(initial));
  const exists = (path: string): boolean =>
    files.has(path) || [...files.keys()].some((file) => file.startsWith(`${path}/`));
  return {
    files,
    existsSync: exists,
    readFileSync: (path) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    statSync: (path) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return { size: Buffer.byteLength(content), mtimeMs: 0 };
    },
    writeFileSync: (path, data) => {
      files.set(path, data);
    },
    appendFileSync: (path, data) => {
      files.set(path, `${files.get(path) ?? ""}${data}`);
    },
    renameSync: (oldPath, newPath) => {
      const content = files.get(oldPath);
      if (content === undefined) throw new Error(`ENOENT: ${oldPath}`);
      files.delete(oldPath);
      files.set(newPath, content);
    },
    mkdirSync: () => {
      // The in-memory fs has no directory hierarchy to create.
    },
    unlinkSync: (path) => {
      files.delete(path);
    },
    rmdirSync: () => {
      // Directories are implicit in the in-memory fs; the lock primitive is
      // exercised against a real temp dir in `fleet-merge.test.ts` instead.
    },
    readdirSync: (path) => {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const names = new Set<string>();
      for (const file of files.keys()) {
        if (!file.startsWith(prefix)) continue;
        const head = file.slice(prefix.length).split("/")[0];
        if (head !== undefined && head !== "") names.add(head);
      }
      return [...names];
    },
  };
}

/** Files directly inside `dir`, ignoring the fake-directory bookkeeping file. */
export function childrenOf(fs: FakeFleetFs, dir: string): string[] {
  const prefix = dir.endsWith("/") ? dir : `${dir}/`;
  return [...fs.files.keys()]
    .filter((path) => path.startsWith(prefix))
    .map((path) => basename(path));
}
