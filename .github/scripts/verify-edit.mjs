// Verifies the Google-signed identity attached to an Edit Mode pull request.
//
// Checks that the ID token in the PR body (1) is signed by Google (RS256, Google's published keys),
// (2) was issued for our OAuth client to a verified account in the allowed Workspace domain, and
// (3) has a nonce equal to the SHA-256 of the PR's current changes — binding the person to the content.
// Posts the result as a PR comment; a verified result carries a `verified-sha` marker that
// pages.yml uses to decide whether the PR may get a preview. No dependencies; runs on the Node version preinstalled on runners.
import { readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync(new URL('../../js/edit/config.json', import.meta.url), 'utf8'));
const { GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, GITHUB_STEP_SUMMARY } = process.env;
const MARKER = '<!-- edit-mode-verification -->';

async function api(path, { headers, ...init } = {}) {
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${GITHUB_TOKEN}`, accept: 'application/vnd.github+json', ...headers },
  });
  if (!res.ok) throw new Error(`GitHub ${path}: ${res.status} ${await res.text()}`);
  return res;
}

class Inconclusive extends Error {}

async function verifyGoogleIdToken(token) {
  const [h, p, s] = token.split('.');
  const header = JSON.parse(Buffer.from(h, 'base64url'));
  const claims = JSON.parse(Buffer.from(p, 'base64url'));
  if (header.alg !== 'RS256') throw new Error(`unexpected algorithm ${header.alg}`);

  const { keys } = await (await fetch('https://www.googleapis.com/oauth2/v3/certs')).json();
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Inconclusive('Google has retired the key that signed this token, so it can no longer be checked. It was checked when the PR was opened — see this comment\'s edit history.');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, Buffer.from(s, 'base64url'), Buffer.from(`${h}.${p}`));
  if (!valid) throw new Error('the signature is not valid');

  const domain = config.allowedDomain.toLowerCase();
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss)) throw new Error(`unexpected issuer ${claims.iss}`);
  if (claims.aud !== config.googleClientId) throw new Error('the token was issued for a different application');
  if (claims.email_verified !== true) throw new Error('the email address is not verified by Google');
  if (claims.hd !== domain || !claims.email.toLowerCase().endsWith(`@${domain}`)) {
    throw new Error(`${claims.email} is not an @${domain} Google Workspace account`);
  }
  return claims;
}

// Must match contentHash() in js/edit/submit.js.
async function prContentHash(pr) {
  const files = [];
  for (let page = 1; ; page++) {
    const batch = await (await api(`/pulls/${pr.number}/files?per_page=100&page=${page}`)).json();
    for (const f of batch) {
      if (f.status === 'renamed') files.push({ path: f.previous_filename, content: null });
      const content = f.status === 'removed' ? null : await (await api(
        `/contents/${f.filename.split('/').map(encodeURIComponent).join('/')}?ref=${pr.head.sha}`,
        { headers: { accept: 'application/vnd.github.raw+json' } },
      )).text();
      files.push({ path: f.filename, content });
    }
    if (batch.length < 100) break;
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const canonical = JSON.stringify(files.map((f) => [f.path, f.content]));
  return Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))).toString('hex');
}

async function upsertComment(body) {
  const comments = await (await api(`/issues/${PR_NUMBER}/comments?per_page=100`)).json();
  const existing = comments.find((c) => c.body.includes(MARKER));
  await api(existing ? `/issues/comments/${existing.id}` : `/issues/${PR_NUMBER}/comments`, {
    method: existing ? 'PATCH' : 'POST',
    body: JSON.stringify({ body: `${MARKER}\n${body}` }),
  });
}

const pr = await (await api(`/pulls/${PR_NUMBER}`)).json();
const token = [...(pr.body || '').matchAll(/edit-mode-id-token\s+([\w-]+\.[\w-]+\.[\w-]+)/g)].at(-1)?.[1];
if (!token) {
  console.log('No Edit Mode signature in this PR; nothing to verify.');
  process.exit(0);
}

let message;
let failed = false;
try {
  const claims = await verifyGoogleIdToken(token);
  const who = `${claims.name ? `${claims.name} ` : ''}\`${claims.email}\``;
  const signedAt = new Date(claims.iat * 1000).toISOString();
  message = claims.nonce === (await prContentHash(pr))
    ? `✅ **Verified Edit Mode submission** by ${who} (Google Workspace \`${claims.hd}\`, signed ${signedAt}).\n\nGoogle's signature was checked against its published keys, and the signed content hash matches this PR's changes at ${pr.head.sha.slice(0, 7)}.\n<!-- verified-sha: ${pr.head.sha} -->`
    : `⚠️ **Identity verified, content changed.** ${who} (Google Workspace \`${claims.hd}\`) signed this submission at ${signedAt}, but the PR's changes at ${pr.head.sha.slice(0, 7)} no longer match what they signed — commits were added or changed after submission. Review the extra commits separately.`;
} catch (err) {
  if (err instanceof Inconclusive) message = `ℹ️ **Verification inconclusive.** ${err.message}`;
  else { message = `❌ **Not verified:** ${err.message}. Do not trust the claimed author of this PR.`; failed = true; }
}

console.log(message);
if (GITHUB_STEP_SUMMARY) await import('node:fs').then((fs) => fs.appendFileSync(GITHUB_STEP_SUMMARY, `${message}\n`));
await upsertComment(message);
if (failed) process.exit(1);
