// The backup as a file on this device: a download, the phone's share sheet,
// or a file the user picks to restore. Nothing leaves the browser except what
// the user sends with the share sheet (to Files, email, Proton Drive, …).

/** parents-guide-backup-2026-11-02.json: the date keeps two saves apart without "(1)". */
function fileName(ext: "json" | "txt", now = new Date()): string {
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return `parents-guide-backup-${day}.${ext}`;
}

/** The save dialog of the File System Access API (Chrome and Edge on computers; not Brave, Firefox, or Safari). */
declare global {
  interface Window {
    showSaveFilePicker?(options: {
      suggestedName: string;
      types: { description: string; accept: Record<string, string[]> }[];
    }): Promise<{ name: string; createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }> }>;
  }
}

/**
 * Save the text as a .json file. With a save dialog, resolves with the name
 * the user chose, or null if the user cancelled. Without one, the browser
 * downloads the file: resolves with { downloading } because the page cannot
 * know when, or if, the browser saved it.
 * Call it directly in the click handler: the dialog needs the user's click.
 */
export async function saveBackupFile(text: string): Promise<{ saved: string } | { downloading: string } | null> {
  if (!window.showSaveFilePicker) return { downloading: downloadBackup(text) };
  let handle;
  try {
    handle = await window.showSaveFilePicker({
      suggestedName: fileName("json"),
      types: [{ description: "Parents' Guide backup", accept: { "application/json": [".json"] } }],
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") return null;
    // Blocked, e.g. in an iframe or by a browser policy: download instead.
    return { downloading: downloadBackup(text) };
  }
  const writable = await handle.createWritable();
  await writable.write(text);
  await writable.close();
  return { saved: handle.name };
}

/** Download the text as a .json file. Returns the file name. */
function downloadBackup(text: string): string {
  const name = fileName("json");
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  // The download has started; the browser keeps its own copy.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return name;
}

/**
 * The backup as a file the share sheet accepts, or null if this browser
 * cannot share files. Chrome on Android shares only some file types, and
 * .json is not one of them, so the fallback is a .txt file with the same text.
 */
function shareableFile(text: string): File | null {
  if (!navigator.canShare) return null;
  for (const [ext, type] of [["json", "application/json"], ["txt", "text/plain"]] as const) {
    const file = new File([text], fileName(ext), { type });
    if (navigator.canShare({ files: [file] })) return file;
  }
  return null;
}

/**
 * True on a touch device whose browser can share the backup file. canShare
 * checks only the file type, not if the browser allows the share: Brave on a
 * computer says yes, then share() fails with NotAllowedError. On a computer,
 * "Save to this device" does the same job, so the button shows on touch devices only.
 */
export const canShareBackup = (): boolean => matchMedia("(pointer: coarse)").matches && shareableFile("{}") !== null;

/**
 * Open the share sheet with the backup file. Call it directly in the click
 * handler: the browser allows the share only right after a user action.
 * Resolves false if the user closed the share sheet.
 */
export async function shareBackup(text: string): Promise<boolean> {
  const file = shareableFile(text);
  if (!file) throw new Error("This browser cannot share files.");
  try {
    await navigator.share({ files: [file], title: "Parents' Guide backup" });
    return true;
  } catch (err) {
    if ((err as Error).name === "AbortError") return false;
    throw err;
  }
}
