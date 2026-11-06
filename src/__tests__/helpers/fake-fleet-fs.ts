/**
 * In-memory fs implementing the synchronous surface the fleet state layer uses.
 *
 * Shared by the fleet unit tests that need a real writer/reader round-trip
 * without touching disk. The directory hierarchy is implicit: any existing file
 * under a path makes that path "exist".
 */

import { basename, dirname } from "node:path";
import type { FleetStateFs } from "../../fleet-state.js";
import { openRepoStateStore, type RepoStateStore } from "../../repo-state-store.js";

export interface FakeFleetFs extends FleetStateFs {
  files: Map<string, string>;
  /** The in-memory repo store the intent/run row lives in (bd-281). */
  store: RepoStateStore;
}

/** One throwaway store per fake fs, so cases sharing `/repo/.git` cannot leak rows. */
function openMemoryStore(): RepoStateStore {
  const opened = openRepoStateStore({ path: ":memory:" });
  if (!opened.ok) throw new Error(opened.error);
  return opened.store;
}

export function createFakeFleetFs(initial: Record<string, string> = {}): FakeFleetFs {
  const files = new Map(Object.entries(initial));
  const store = openMemoryStore();
  // bd-281: a fixture naming `<fleetDir>/fleet.json` seeds the store row instead.
  // No reader opens that file any more, so carrying it would make a seed silently
  // ineffective; a non-JSON fixture becomes a non-record row (a corrupt record).
  for (const [path, content] of [...files]) {
    if (!path.endsWith("/fleet.json")) continue;
    files.delete(path);
    let document: unknown = content;
    try {
      document = JSON.parse(content);
    } catch {
      // Keep the raw text: it is not a record, so the reader reports it as corrupt.
    }
    const fleetId = basename(dirname(path));
    const written = store.writeFleetIntent({ fleetId, intent: document });
    if (!written.ok) throw new Error(written.error);
  }
  const exists = (path: string): boolean =>
    files.has(path) || [...files.keys()].some((file) => file.startsWith(`${path}/`));
  return {
    files,
    store,
    existsSync: exists,
    readFileSync: (path) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    writeFileSync: (path, data) => {
      files.set(path, data);
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
