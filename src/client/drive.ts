// Google Drive backup, all in the browser: the server never sees the token or
// the file. The drive.appdata scope gives access to one hidden app folder only,
// not to the user's other files. Google's sign-in script loads on the first
// click, so visitors who do not use the backup get no request to Google.

declare const __GOOGLE_CLIENT_ID__: string;

/** Empty when the build has no GOOGLE_CLIENT_ID; then the backup is not offered. */
export const driveClientId = __GOOGLE_CLIENT_ID__;

const SCOPE = "https://www.googleapis.com/auth/drive.appdata";
const FILE_NAME = "parents-guide-backup.json";
const FILES = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

interface TokenClient {
  requestAccessToken(overrides?: { prompt?: string }): void;
}

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient(config: {
            client_id: string;
            scope: string;
            callback: (response: TokenResponse) => void;
            error_callback?: (error: { type: string; message?: string }) => void;
          }): TokenClient;
          revoke(token: string, done?: () => void): void;
        };
      };
    };
  }
}

let script: Promise<void> | null = null;

function loadGoogle(): Promise<void> {
  script ??= new Promise<void>((resolve, reject) => {
    const el = document.createElement("script");
    el.src = "https://accounts.google.com/gsi/client";
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => {
      script = null;
      reject(new Error("Could not load Google sign-in"));
    };
    document.head.append(el);
  });
  return script;
}

/** The access token, in memory only. It lasts about one hour. */
let token: { value: string; expires: number } | null = null;

async function accessToken(): Promise<string> {
  if (token && Date.now() < token.expires) return token.value;
  await loadGoogle();
  return new Promise((resolve, reject) => {
    const client = window.google!.accounts.oauth2.initTokenClient({
      client_id: driveClientId,
      scope: SCOPE,
      callback: (r) => {
        if (!r.access_token) return reject(new Error(r.error_description || r.error || "Google sign-in failed"));
        // Renew a minute early, so a request does not start with a token about to expire.
        token = { value: r.access_token, expires: Date.now() + ((r.expires_in ?? 3600) - 60) * 1000 };
        resolve(r.access_token);
      },
      error_callback: (e) =>
        reject(new Error(e.type === "popup_closed" ? "Google sign-in was closed" : e.message || "Google sign-in failed")),
    });
    // An empty prompt asks only the first time; later the popup closes by itself.
    client.requestAccessToken({ prompt: "" });
  });
}

async function drive(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${await accessToken()}`);
  const res = await fetch(url, { ...init, headers });
  if (res.status === 401) token = null;
  if (!res.ok) throw new Error(`Google Drive error ${res.status}`);
  return res;
}

/** The backup files, newest first. Normally one; two saves at the same time can make two. */
async function findFiles(): Promise<{ id: string; modifiedTime: string }[]> {
  const q = encodeURIComponent(`name = '${FILE_NAME}'`);
  const res = await drive(`${FILES}?spaces=appDataFolder&q=${q}&fields=files(id,modifiedTime)&orderBy=modifiedTime desc`);
  return ((await res.json()) as { files: { id: string; modifiedTime: string }[] }).files;
}

async function findFile(): Promise<{ id: string; modifiedTime: string } | null> {
  return (await findFiles())[0] ?? null;
}

/** Write the text to the backup file, or create the file. */
export async function saveToDrive(text: string): Promise<void> {
  const file = await findFile();
  if (file) {
    await drive(`${UPLOAD}/${file.id}?uploadType=media`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: text,
    });
    return;
  }
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify({ name: FILE_NAME, parents: ["appDataFolder"] })], { type: "application/json" }));
  form.append("file", new Blob([text], { type: "application/json" }));
  await drive(`${UPLOAD}?uploadType=multipart`, { method: "POST", body: form });
}

/**
 * Delete every backup file, then remove the site's access to the user's Drive,
 * so the next backup asks for permission again. Returns the number of files deleted.
 */
export async function deleteFromDrive(): Promise<number> {
  const files = await findFiles();
  for (const file of files) await drive(`${FILES}/${file.id}`, { method: "DELETE" });
  if (token) {
    const value = token.value;
    token = null;
    await new Promise<void>((resolve) => window.google!.accounts.oauth2.revoke(value, resolve));
  }
  return files.length;
}

/** The backup file's text, or null if there is no backup. */
export async function loadFromDrive(): Promise<string | null> {
  const file = await findFile();
  if (!file) return null;
  return (await drive(`${FILES}/${file.id}?alt=media`)).text();
}
