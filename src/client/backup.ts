// The user's choices as one JSON file, for the Google Drive backup. The file
// holds the raw localStorage values, so a restore needs no conversion and the
// load functions in prefs.ts still check each value.

/** The localStorage keys in a backup. Not the first-visit tip: it is not a choice. */
export const BACKUP_KEYS = [
  "hiddenCategories",
  "concernLimits",
  "hiddenProviders",
  "watchlist",
  "thumbs",
  "notInterested",
  "searchFilter",
] as const;

export interface Backup {
  app: "parents-guide";
  version: 1;
  /** ISO time the backup was made. */
  savedAt: string;
  /** Key → raw localStorage value. Keys that were not set are left out. */
  data: Partial<Record<(typeof BACKUP_KEYS)[number], string>>;
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function makeBackup(storage: Store, now = new Date()): Backup {
  const data: Backup["data"] = {};
  for (const key of BACKUP_KEYS) {
    const value = storage.getItem(key);
    if (value !== null) data[key] = value;
  }
  return { app: "parents-guide", version: 1, savedAt: now.toISOString(), data };
}

/** The backup in the text, or null if it is not a backup from this app. */
export function parseBackup(text: string): Backup | null {
  try {
    const b = JSON.parse(text) as Partial<Backup> | null;
    if (b?.app !== "parents-guide" || b.version !== 1 || typeof b.savedAt !== "string") return null;
    if (typeof b.data !== "object" || b.data === null) return null;
    const data: Backup["data"] = {};
    for (const key of BACKUP_KEYS) {
      const value = (b.data as Record<string, unknown>)[key];
      if (typeof value === "string") data[key] = value;
    }
    return { app: "parents-guide", version: 1, savedAt: b.savedAt, data };
  } catch {
    return null;
  }
}

/** Replace the stored choices with the backup. A key that is not in the backup is removed. */
export function restoreBackup(storage: Store, backup: Backup): void {
  for (const key of BACKUP_KEYS) {
    const value = backup.data[key];
    if (value === undefined) storage.removeItem(key);
    else storage.setItem(key, value);
  }
}

/**
 * A cloud service that keeps one backup file for the user. Each service runs
 * in the browser only, with access to its own app folder only. To add a
 * service, implement this and add it to backupServices.ts.
 */
export interface CloudBackup {
  /** Short id for the buttons and the "<id>Backup" flag in prefs.ts. */
  id: string;
  /** The name in the buttons and messages, e.g. "Google Drive". */
  name: string;
  /** One sentence under the buttons: where the file goes and what the site can see. */
  about: string;
  /** The service's logo, as inline SVG, for the backup picker. */
  icon: string;
  /** Write the text to the backup file, or create the file. */
  save(text: string): Promise<void>;
  /** The backup file's text, or null if there is no backup. */
  load(): Promise<string | null>;
  /** Delete the backup file, and remove the site's access. Returns the number of files deleted. */
  remove(): Promise<number>;
  /**
   * For a service whose sign-in leaves the page: finish the sign-in after the
   * page comes back. True if it did; then main.ts runs the action again.
   */
  resume?(): Promise<boolean>;
}
