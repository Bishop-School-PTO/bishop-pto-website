// Signing and submitting Edit Mode changes.
//
// The user signs in with Google Identity Services. The ID token's `nonce` is set to a SHA-256
// hash of the exact changes, so the Google-signed token proves both *who* (Workspace email,
// `hd` claim) and *what* (these files). The GitHub Action recomputes the same hash from the PR.

// Canonical form shared with .github/scripts/verify-edit.mjs — keep in sync.
// `files` must be sorted by path; content is null for deletions.
export async function contentHash(files) {
  const canonical = JSON.stringify(files.map((f) => [f.path, f.content]));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function decodeJwt(token) {
  const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

let gisReady;
function loadGoogleSignIn() {
  gisReady ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.onload = resolve;
    script.onerror = () => { gisReady = null; reject(new Error('Could not load Google Sign-In.')); };
    document.head.append(script);
  });
  return gisReady;
}

// Renders a "Sign in with Google" button into `container`; resolves with the ID token.
export async function signInWithGoogle(container, { clientId, domain, nonce }) {
  await loadGoogleSignIn();
  return new Promise((resolve) => {
    google.accounts.id.initialize({
      client_id: clientId,
      nonce,
      hd: domain,
      auto_select: false,
      callback: (response) => resolve(response.credential),
    });
    google.accounts.id.renderButton(container, { theme: 'outline', size: 'large', text: 'continue_with' });
  });
}

// The relay (relay/Code.gs) opens pull requests as the site's GitHub App, so submitters need no GitHub token.
// text/plain keeps this a CORS "simple request", which Apps Script web apps accept.
export async function sendToRelay(relayUrl, payload) {
  const res = await fetch(relayUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({ error: `The submission service responded with ${res.status}.` }));
  if (!data.ok) throw new Error(data.error || 'Submission failed.');
  return data;
}

// "Sign in with GitHub": GitHub's authorization page opens in a popup and returns to github-callback.html,
// which hands the one-time code back over a BroadcastChannel. The relay exchanges it for the user's identity
// and returns a signed session; no GitHub token is kept in the browser. `cancel` is an AbortSignal.
export function signInWithGitHub({ clientId, relayUrl, cancel }) {
  const state = crypto.randomUUID();
  const redirectUri = new URL('github-callback.html', import.meta.url).href;
  const popup = open(`https://github.com/login/oauth/authorize?${new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, state })}`,
    'pto-github-signin', 'popup,width=640,height=760');
  if (!popup) return Promise.reject(new Error('Please allow pop-ups for this site to sign in with GitHub.'));

  return new Promise((resolve, reject) => {
    const channel = new BroadcastChannel('pto-github-signin');
    const finish = () => channel.close();
    cancel?.addEventListener('abort', () => { finish(); reject(new Error('GitHub sign-in was cancelled.')); });
    channel.onmessage = async ({ data }) => {
      if (data?.state !== state) return;
      finish();
      if (!data.code) return reject(new Error(data.error === 'access_denied' ? 'GitHub sign-in was cancelled.' : `GitHub sign-in failed (${data.error}).`));
      try {
        resolve(await sendToRelay(relayUrl, { action: 'github-login', code: data.code, redirectUri }));
      } catch (err) {
        reject(err);
      }
    };
  });
}
