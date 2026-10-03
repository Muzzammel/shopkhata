import Dexie, { type Table } from "dexie";

import { draftKey, isStaleDraft, normalizeStoredDraft, type StoredDraft } from "./draft-state";

/** Who last had a live session in this browser. Lets the offline shell open that user's draft; holds no token. */
export type SessionMarker = {
  userId: string; name: string; role: string; shops: { id: string; name: string }[]; shopId: string; savedAt: string;
};

class LocalDatabase extends Dexie {
  drafts!: Table<StoredDraft, string>;
  meta!: Table<{ key: string; value: unknown }, string>;

  constructor() {
    super("shopkhata-local");
    // Add a new .version(n) with an upgrade() when the stored shape changes;
    // normalizeStoredDraft already ignores records it does not understand.
    this.version(1).stores({ drafts: "key, userId", meta: "key" });
  }
}

let database: LocalDatabase | null = null;
function db(): LocalDatabase {
  return database ??= new LocalDatabase();
}

// Every function fails soft: without IndexedDB the app still works, it just
// cannot keep a draft across a reload, and the caller says so.

export async function loadDraft(userId: string, shopId: string): Promise<{ draft: StoredDraft | null; available: boolean }> {
  try {
    const key = draftKey(userId, shopId);
    const draft = normalizeStoredDraft(await db().drafts.get(key), { userId, shopId });
    if (draft && isStaleDraft(draft, new Date())) {
      await db().drafts.delete(key);
      return { draft: null, available: true };
    }
    return { draft, available: true };
  } catch {
    return { draft: null, available: false };
  }
}

export async function saveDraft(draft: StoredDraft): Promise<boolean> {
  try { await db().drafts.put(draft); return true; } catch { return false; }
}

export async function deleteDraft(userId: string, shopId: string): Promise<boolean> {
  try { await db().drafts.delete(draftKey(userId, shopId)); return true; } catch { return false; }
}

/** Shop IDs with a stored draft for this user only. */
export async function listDraftShopIds(userId: string): Promise<string[]> {
  try { return (await db().drafts.where("userId").equals(userId).toArray()).map((draft) => draft.shopId); } catch { return []; }
}

export async function deleteUserDrafts(userId: string): Promise<void> {
  try { await db().drafts.where("userId").equals(userId).delete(); } catch { /* nothing stored */ }
}

export async function readSessionMarker(): Promise<SessionMarker | null> {
  try {
    const value = (await db().meta.get("session"))?.value as SessionMarker | undefined;
    return value && typeof value.userId === "string" && Array.isArray(value.shops) ? value : null;
  } catch { return null; }
}

export async function writeSessionMarker(marker: SessionMarker): Promise<void> {
  try { await db().meta.put({ key: "session", value: marker }); } catch { /* offline shell stays unavailable */ }
}

export async function clearSessionMarker(): Promise<void> {
  try { await db().meta.delete("session"); } catch { /* nothing stored */ }
}
