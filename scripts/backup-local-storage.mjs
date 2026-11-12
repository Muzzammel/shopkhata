// Local restore rehearsal only: Storage tables that the local (single-tenant) Storage service creates and hosted
// (multitenant) Storage never does. The storage-api tenant migrations skip the iceberg tables when
// storage.multitenant, so a production backup has no fingerprint entry for them, while every local restore target has
// them, empty. Without this, `pnpm backup:verify --from <production backup>` can never reconcile.
//
// A table is tolerated ONLY when (a) it is one of LOCAL_ONLY_STORAGE, (b) the backup's storage inventory is a real
// inventory that has NO entry for it, and (c) its restored value is exactly "0:" (backup-fingerprint.sql: the table
// exists, is readable, and has zero rows). Anything else stays in the comparison and fails it. The inputs are never
// modified; the caller keeps the full restored fingerprint as evidence.
export const LOCAL_ONLY_STORAGE = Object.freeze(["storage.iceberg_namespaces", "storage.iceberg_tables"]);

const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function toleratedLocalOnlyStorage(expected, restored) {
  if (!plain(expected?.storage) || !plain(restored?.storage)) return { compared: restored, tolerated: [] };
  const tolerated = LOCAL_ONLY_STORAGE.filter((key) => !Object.hasOwn(expected.storage, key) && restored.storage[key] === "0:");
  if (!tolerated.length) return { compared: restored, tolerated };
  const storage = Object.fromEntries(Object.entries(restored.storage).filter(([key]) => !tolerated.includes(key)));
  return { compared: { ...restored, storage }, tolerated };
}
