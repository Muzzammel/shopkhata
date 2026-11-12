import { describe, expect, it } from "vitest";
import { LOCAL_ONLY_STORAGE, toleratedLocalOnlyStorage } from "../../scripts/backup-local-storage.mjs";

// A production backup's Storage inventory (hosted, multitenant: no iceberg tables) and a local restore of it
// (single-tenant: the same tables plus the two empty iceberg tables).
const prodStorage = {
  "storage.buckets": "1:4bfa4adb0617ccb2aa812c36f94216e1",
  "storage.objects": "0:",
  "storage.bucket_lifecycle_states": "0:",
  "storage.lifecycle_abandoned_artifacts": "0:",
};
const expected = () => ({ tables: { shops: "2:aa" }, auth_users: "1:bb", storage: { ...prodStorage } });
const restored = (extra: Record<string, unknown> = {}) => ({
  tables: { shops: "2:aa" }, auth_users: "1:bb",
  storage: { ...prodStorage, "storage.iceberg_namespaces": "0:", "storage.iceberg_tables": "0:", ...extra },
});
type Fp = ReturnType<typeof restored>;
const storageOf = (fp: unknown) => (fp as Fp).storage;

describe("toleratedLocalOnlyStorage", () => {
  it("covers exactly the two iceberg tables", () => {
    expect(LOCAL_ONLY_STORAGE).toEqual(["storage.iceberg_namespaces", "storage.iceberg_tables"]);
    expect(Object.isFrozen(LOCAL_ONLY_STORAGE)).toBe(true);
  });

  it("tolerates both iceberg tables when absent from the backup and exactly 0: locally; the result then equals the backup", () => {
    const exp = expected();
    const { compared, tolerated } = toleratedLocalOnlyStorage(exp, restored());
    expect(tolerated).toEqual(["storage.iceberg_namespaces", "storage.iceberg_tables"]);
    expect(compared).toEqual(exp);
  });

  it("tolerates one table and keeps the other when only one qualifies", () => {
    const { compared, tolerated } = toleratedLocalOnlyStorage(expected(), restored({ "storage.iceberg_tables": "1:abc" }));
    expect(tolerated).toEqual(["storage.iceberg_namespaces"]);
    expect(storageOf(compared)["storage.iceberg_tables"]).toBe("1:abc");
  });

  it("never modifies the expected or the restored fingerprint", () => {
    const exp = expected(), res = restored();
    const before = { exp: structuredClone(exp), res: structuredClone(res) };
    toleratedLocalOnlyStorage(exp, res);
    expect(exp).toEqual(before.exp);
    expect(res).toEqual(before.res);
  });

  it.each([
    ["non-empty", "1:0123456789abcdef0123456789abcdef"],
    ["unreadable", "unreadable"],
    ["count without separator", "0"],
    ["padded", " 0:"],
    ["zero rows with a hash", "0:abc"],
    ["number", 0],
    ["null", null],
    ["object", { count: 0 }],
  ])("keeps a %s local iceberg value in the comparison", (_name, value) => {
    const res = restored({ "storage.iceberg_namespaces": value, "storage.iceberg_tables": value });
    const { compared, tolerated } = toleratedLocalOnlyStorage(expected(), res);
    expect(tolerated).toEqual([]);
    expect(compared).toBe(res);
  });

  it("does nothing when the backup itself lists the iceberg tables (local-to-local rehearsal compares normally)", () => {
    const exp = { ...expected(), storage: { ...prodStorage, "storage.iceberg_namespaces": "0:", "storage.iceberg_tables": "1:x" } };
    const res = restored();
    const { compared, tolerated } = toleratedLocalOnlyStorage(exp, res);
    expect(tolerated).toEqual([]);
    expect(compared).toBe(res);
  });

  it("does not hide a missing local iceberg table that the backup lists", () => {
    const exp = { ...expected(), storage: { ...prodStorage, "storage.iceberg_namespaces": "0:" } };
    const res = { ...restored(), storage: { ...prodStorage } };
    const { compared, tolerated } = toleratedLocalOnlyStorage(exp, res);
    expect(tolerated).toEqual([]);
    expect(storageOf(compared)).not.toHaveProperty("storage.iceberg_namespaces");
    expect(compared).not.toEqual(exp);
  });

  it("does not tolerate an unexpected extra empty Storage table", () => {
    const { compared, tolerated } = toleratedLocalOnlyStorage(expected(), restored({ "storage.iceberg_catalogs": "0:", "storage.surprise": "0:" }));
    expect(tolerated).toEqual(["storage.iceberg_namespaces", "storage.iceberg_tables"]);
    expect(storageOf(compared)).toMatchObject({ "storage.iceberg_catalogs": "0:", "storage.surprise": "0:" });
    expect(compared).not.toEqual(expected());
  });

  it("does not hide a production Storage table missing locally", () => {
    const res = restored();
    delete (res.storage as Record<string, unknown>)["storage.bucket_lifecycle_states"];
    const { compared } = toleratedLocalOnlyStorage(expected(), res);
    expect(storageOf(compared)).not.toHaveProperty("storage.bucket_lifecycle_states");
    expect(compared).not.toEqual(expected());
  });

  it("leaves differences in shared Storage, public and auth sections untouched", () => {
    const res = { ...restored({ "storage.buckets": "2:changed", "storage.objects": "unreadable" }), tables: { shops: "3:zz" }, auth_users: "0:" };
    const { compared, tolerated } = toleratedLocalOnlyStorage(expected(), res);
    expect(tolerated).toHaveLength(2);
    expect(compared).toMatchObject({ tables: { shops: "3:zz" }, auth_users: "0:", storage: { "storage.buckets": "2:changed", "storage.objects": "unreadable" } });
  });

  it.each([
    ["expected without storage", { tables: {} }, restored()],
    ["expected storage null", { storage: null }, restored()],
    ["expected storage array", { storage: ["storage.iceberg_namespaces"] }, restored()],
    ["expected storage string", { storage: "0:" }, restored()],
    ["expected null", null, restored()],
    ["expected undefined", undefined, restored()],
    ["restored without storage", expected(), { tables: {} }],
    ["restored storage array", expected(), { storage: ["0:"] }],
    ["restored null", expected(), null],
  ])("tolerates nothing for a malformed fingerprint: %s", (_name, exp, res) => {
    const { compared, tolerated } = toleratedLocalOnlyStorage(exp, res);
    expect(tolerated).toEqual([]);
    expect(compared).toBe(res);
  });

  it("ignores an inherited key: only the backup's own inventory counts", () => {
    const storage = Object.assign(Object.create({ "storage.iceberg_namespaces": "1:x" }), prodStorage);
    const { tolerated } = toleratedLocalOnlyStorage({ storage }, restored());
    expect(tolerated).toEqual(["storage.iceberg_namespaces", "storage.iceberg_tables"]);
  });
});
