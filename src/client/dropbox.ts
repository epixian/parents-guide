// Dropbox backup, all in the browser: the server never sees the token or the
// file. The Dropbox app has "App folder" access, so it can use only its own
// folder (Apps, then the app's name), not the user's other files.
//
// Sign-in is OAuth with PKCE in the same tab, not a popup: Dropbox's login
// page cuts the link to a popup (Cross-Origin-Opener-Policy), so the page
// could not see a closed popup. The tab goes to Dropbox and comes back to
// /dropbox-auth.html, which saves the answer in sessionStorage and opens
// /preferences. There, resume() gets the token, and main.ts runs the action again.

import type { CloudBackup } from "./backup.js";

declare const __DROPBOX_APP_KEY__: string;

/** Empty when the build has no DROPBOX_APP_KEY; then the backup is not offered. */
const appKey = __DROPBOX_APP_KEY__;

const FILE_PATH = "/parents-guide-backup.json";
const API = "https://api.dropboxapi.com";
const CONTENT = "https://content.dropboxapi.com";
const SCOPE = "files.content.read files.content.write";
/** sessionStorage: the PKCE verifier and state while the tab is at Dropbox. */
const SIGN_IN_KEY = "dropboxSignIn";
/** sessionStorage: the query that Dropbox sent to dropbox-auth.html. Same name there. */
const ANSWER_KEY = "dropboxAnswer";
const redirectUri = () => `${location.origin}/dropbox-auth.html`;

function base64url(data: Uint8Array): string {
  return btoa(String.fromCharCode(...data)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Random text for the PKCE verifier and the state. */
const randomText = (bytes: number) => base64url(crypto.getRandomValues(new Uint8Array(bytes)));

/** The access token, in memory only. It lasts about four hours. */
let token: { value: string; expires: number } | null = null;

/** The access token. Without one, the tab goes to Dropbox to sign in, and this never resolves. */
async function accessToken(): Promise<string> {
  if (token && Date.now() < token.expires) return token.value;
  const verifier = randomText(48);
  const state = randomText(16);
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  try {
    sessionStorage.setItem(SIGN_IN_KEY, JSON.stringify({ verifier, state }));
  } catch {
    throw new Error("Dropbox sign-in needs site storage, which this browser blocks");
  }
  const url = new URL("https://www.dropbox.com/oauth2/authorize");
  url.search = new URLSearchParams({
    client_id: appKey,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    redirect_uri: redirectUri(),
    token_access_type: "online",
    scope: SCOPE,
    state,
  }).toString();
  location.assign(url);
  return new Promise<never>(() => {});
}

/** Finish a sign-in that came back from Dropbox. True if there was one and it worked. */
async function resume(): Promise<boolean> {
  let saved: string | null, answer: string | null;
  try {
    saved = sessionStorage.getItem(SIGN_IN_KEY);
    answer = sessionStorage.getItem(ANSWER_KEY);
    sessionStorage.removeItem(SIGN_IN_KEY);
    sessionStorage.removeItem(ANSWER_KEY);
  } catch {
    return false;
  }
  if (!saved || answer === null) return false;
  const { verifier, state } = JSON.parse(saved) as { verifier: string; state: string };
  const params = new URLSearchParams(answer);
  if (params.get("state") !== state) throw new Error("Dropbox sign-in failed");
  const code = params.get("code");
  if (!code) throw new Error(params.get("error") === "access_denied" ? "Dropbox sign-in was cancelled" : "Dropbox sign-in failed");
  const res = await fetch(`${API}/oauth2/token`, {
    method: "POST",
    body: new URLSearchParams({ code, grant_type: "authorization_code", client_id: appKey, code_verifier: verifier, redirect_uri: redirectUri() }),
  });
  const r = (await res.json()) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !r.access_token) throw new Error(r.error_description || "Dropbox sign-in failed");
  // Renew a minute early, so a request does not start with a token about to expire.
  token = { value: r.access_token, expires: Date.now() + ((r.expires_in ?? 14400) - 60) * 1000 };
  return true;
}

/** A Dropbox API call. Returns null for a 409 "not found" error. */
async function dropbox(url: string, init: RequestInit): Promise<Response | null> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${await accessToken()}`);
  const res = await fetch(url, { ...init, headers });
  if (res.status === 401) token = null;
  if (res.status === 409) {
    const summary = ((await res.json()) as { error_summary?: string }).error_summary ?? "";
    if (/not_found/.test(summary)) return null;
  }
  if (!res.ok) throw new Error(`Dropbox error ${res.status}`);
  return res;
}

/** The Dropbox-API-Arg header of a content call. */
const arg = (value: object) => ({ "dropbox-api-arg": JSON.stringify(value) });

async function saveToDropbox(text: string): Promise<void> {
  await dropbox(`${CONTENT}/2/files/upload`, {
    method: "POST",
    headers: { ...arg({ path: FILE_PATH, mode: "overwrite", mute: true }), "content-type": "application/octet-stream" },
    body: text,
  });
}

async function loadFromDropbox(): Promise<string | null> {
  const res = await dropbox(`${CONTENT}/2/files/download`, { method: "POST", headers: arg({ path: FILE_PATH }) });
  return res ? res.text() : null;
}

/** Delete the backup file, then revoke the token. Returns the number of files deleted. */
async function deleteFromDropbox(): Promise<number> {
  const res = await dropbox(`${API}/2/files/delete_v2`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: FILE_PATH }),
  });
  if (token) {
    const value = token.value;
    token = null;
    await fetch(`${API}/2/auth/token/revoke`, { method: "POST", headers: { authorization: `Bearer ${value}` } });
  }
  return res ? 1 : 0;
}

/** Null when the build has no DROPBOX_APP_KEY. */
export const dropboxBackup: CloudBackup | null = appKey
  ? {
      id: "dropbox",
      name: "Dropbox",
      about: "Save to this app's own folder in your Dropbox. The app cannot see your other files.",
      icon: `<svg viewBox="0 0 43 40" aria-hidden="true"><path fill="#0061ff" d="m12.5 0-12.5 8.1 8.7 7 12.5-7.8zm-12.5 21.9 12.5 8.2 8.7-7.3-12.5-7.7zm21.2.9 8.8 7.3 12.4-8.1-8.6-6.9zm21.2-14.7-12.4-8.1-8.8 7.3 12.6 7.8zm-21.1 16.3-8.8 7.3-3.7-2.5v2.8l12.5 7.5 12.5-7.5v-2.8l-3.8 2.5z"/></svg>`,
      save: saveToDropbox,
      load: loadFromDropbox,
      remove: deleteFromDropbox,
      resume,
    }
  : null;
