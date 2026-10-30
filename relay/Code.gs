/**
 * Edit Mode relay — a Google Apps Script web app that opens pull requests for Edit Mode as a GitHub App
 * ("bot"), so submitters don't need a GitHub token, or a GitHub account at all.
 *
 * Every submission must identify its author in at least one of two ways:
 *  - Google: an ID token for our OAuth client from the allowed Workspace domain, whose nonce is the SHA-256
 *    of the submitted files (the same proof .github/workflows/verify-edit.yml re-checks independently).
 *  - GitHub: a short-lived session from "Sign in with GitHub" (action "github-login"). The relay uses
 *    GitHub's token once to read the user's identity, revokes it, and returns its own signed session.
 *
 * Script properties (Project Settings → Script properties):
 *   GITHUB_REPO                e.g. etruong42/bishop-pto
 *   GITHUB_BRANCH              e.g. main
 *   GITHUB_APP_CLIENT_ID       GitHub App → General → Client ID (Iv23…)
 *   GITHUB_APP_CLIENT_SECRET   GitHub App → General → Client secrets
 *   GITHUB_APP_PRIVATE_KEY     GitHub App private key in PKCS#8 form ("BEGIN PRIVATE KEY"); convert with
 *                              openssl pkcs8 -topk8 -nocrypt -in app.private-key.pem
 *   GOOGLE_CLIENT_ID           optional: OAuth client ID (same as js/edit/config.json)
 *   ALLOWED_DOMAIN             optional: Google Workspace domain (same as js/edit/config.json)
 *
 * Deploy: Deploy → New deployment → Web app; Execute as: Me; Who has access: Anyone.
 */

// Mirrors PATH_RE in js/edit/editor.js: text files only, nothing in dot-folders (.github!).
var PATH_RE = /^(?!.*(?:^|\/)\.)[\w\-/.]+\.(?:html|css|js|json|svg|txt|md)$/;
var MAX_BYTES = 2000000;
var MAX_FILES = 50;
var MAX_PER_HOUR = 10; // submissions per person
var SESSION_HOURS = 8;

function doPost(e) {
  var result;
  try {
    if (e.postData.contents.length > MAX_BYTES) throw new Error('Submission is too large.');
    var req = JSON.parse(e.postData.contents);
    var cfg = PropertiesService.getScriptProperties().getProperties();
    result = req.action === 'github-login' ? githubLogin(req, cfg) : submit(req, cfg);
  } catch (err) {
    result = { ok: false, error: String((err && err.message) || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------------------
// Sign in with GitHub
// ---------------------------------------------------------------------------
function githubLogin(req, cfg) {
  var res = UrlFetchApp.fetch('https://github.com/login/oauth/access_token', {
    method: 'post',
    headers: { Accept: 'application/json' },
    payload: {
      client_id: cfg.GITHUB_APP_CLIENT_ID,
      client_secret: cfg.GITHUB_APP_CLIENT_SECRET,
      code: String(req.code || ''),
      redirect_uri: String(req.redirectUri || ''),
    },
    muteHttpExceptions: true,
  });
  var data = JSON.parse(res.getContentText() || '{}');
  if (!data.access_token) throw new Error('GitHub sign-in failed: ' + (data.error_description || data.error || res.getResponseCode()));

  var user = api('get', 'https://api.github.com/user', null, 'Bearer ' + data.access_token);
  // We only needed the identity: revoke GitHub's token so it can't be used for anything else.
  UrlFetchApp.fetch('https://api.github.com/applications/' + cfg.GITHUB_APP_CLIENT_ID + '/token', {
    method: 'delete',
    contentType: 'application/json',
    payload: JSON.stringify({ access_token: data.access_token }),
    headers: {
      Authorization: 'Basic ' + Utilities.base64Encode(cfg.GITHUB_APP_CLIENT_ID + ':' + cfg.GITHUB_APP_CLIENT_SECRET),
      Accept: 'application/vnd.github+json',
    },
    muteHttpExceptions: true,
  });

  var session = {
    id: user.id,
    login: user.login,
    name: user.name || '',
    exp: Math.floor(Date.now() / 1000) + SESSION_HOURS * 3600,
  };
  return { ok: true, login: user.login, name: user.name || '', session: signSession(session, cfg) };
}

function signSession(session, cfg) {
  var body = b64url(JSON.stringify(session));
  return body + '.' + hmac(body, cfg);
}

function readSession(token, cfg) {
  var parts = String(token || '').split('.');
  if (parts.length !== 2 || hmac(parts[0], cfg) !== parts[1]) throw new Error('GitHub sign-in is invalid. Please sign in again.');
  var padded = parts[0] + '==='.slice((parts[0].length + 3) % 4);
  var session = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(padded)).getDataAsString());
  if (session.exp < Date.now() / 1000) throw new Error('GitHub sign-in has expired. Please sign in again.');
  return session;
}

function hmac(text, cfg) {
  return b64urlBytes(Utilities.computeHmacSha256Signature(text, 'edit-mode-session:' + cfg.GITHUB_APP_CLIENT_SECRET));
}

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------
function submit(req, cfg) {
  var files = req.files;
  if (!Array.isArray(files) || !files.length || files.length > MAX_FILES) throw new Error('Expected 1–' + MAX_FILES + ' files.');
  files = files.map(function (f) {
    if (typeof f.path !== 'string' || !PATH_RE.test(f.path)) throw new Error('Not an editable path: ' + f.path);
    if (f.content !== null && typeof f.content !== 'string') throw new Error('Bad content for ' + f.path);
    return { path: f.path, content: f.content };
  }).sort(function (a, b) { return a.path < b.path ? -1 : a.path > b.path ? 1 : 0; });

  var google = null;
  if (req.idToken) {
    google = verifyIdToken(req.idToken, cfg);
    // Canonical hash — must match contentHash() in js/edit/submit.js.
    var hash = sha256Hex(JSON.stringify(files.map(function (f) { return [f.path, f.content]; })));
    if (google.nonce !== hash) throw new Error('The Google signature does not match the submitted changes.');
    once('tok:' + sha256Hex(req.idToken), 'This submission was already received.');
  }
  var github = req.githubSession ? readSession(req.githubSession, cfg) : null;
  if (!google && !github) throw new Error('Please sign in with Google or GitHub to submit.');
  rateLimit(github ? 'gh:' + github.id : 'g:' + google.email);

  var token = installationToken(cfg);
  var auth = 'Bearer ' + token;
  var repo = 'https://api.github.com/repos/' + cfg.GITHUB_REPO;
  var branch = cfg.GITHUB_BRANCH || 'main';
  var base = /^[0-9a-f]{40}$/.test(req.baseSha || '') ? req.baseSha : api('get', repo + '/git/ref/heads/' + branch, null, auth).object.sha;
  var baseTree = api('get', repo + '/git/commits/' + base, null, auth).tree.sha;
  var tree = api('post', repo + '/git/trees', {
    base_tree: baseTree,
    tree: files.map(function (f) {
      return f.content === null
        ? { path: f.path, mode: '100644', type: 'blob', sha: null }
        : { path: f.path, mode: '100644', type: 'blob', content: f.content };
    }),
  }, auth);

  var title = clean(String(req.title || '')).trim().slice(0, 120) || 'Website edit';
  var description = clean(String(req.description || '')).trim().slice(0, 5000);
  var trailers = [];
  var credits = [];
  if (github) {
    trailers.push('Co-authored-by: ' + (github.name || github.login) + ' <' + github.id + '+' + github.login + '@users.noreply.github.com>');
    credits.push('@' + github.login + ' (signed in with GitHub)');
  }
  if (google) {
    trailers.push('Co-authored-by: ' + (google.name || google.email) + ' <' + google.email + '>');
    credits.push((google.name ? '**' + clean(google.name) + '** ' : '') + '`' + google.email + '` (Google Workspace `' + google.hd + '`; verification below)');
  }
  var commit = api('post', repo + '/git/commits', {
    message: title + '\n\n' + (description ? description + '\n\n' : '') + 'Submitted via Edit Mode.\n\n' + trailers.join('\n'),
    tree: tree.sha,
    parents: [base],
  }, auth);

  var ref = 'edit/' + Utilities.formatDate(new Date(), 'UTC', 'yyyyMMdd-HHmmss') + '-' + Utilities.getUuid().slice(0, 6);
  api('post', repo + '/git/refs', { ref: 'refs/heads/' + ref, sha: commit.sha }, auth);
  var pr = api('post', repo + '/pulls', {
    title: title,
    head: ref,
    base: branch,
    body: (description ? description + '\n\n' : '') + '---\nSubmitted with **Edit Mode** by ' + credits.join(' and ') + '.\n' +
      (google ? '\n<!-- edit-mode-id-token\n' + req.idToken + '\n-->\n' : ''),
  }, auth);
  return { ok: true, number: pr.number, url: pr.html_url };
}

function verifyIdToken(token, cfg) {
  if (!cfg.GOOGLE_CLIENT_ID || !cfg.ALLOWED_DOMAIN) throw new Error('Google sign-in is not enabled on this relay.');
  if (typeof token !== 'string' || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) throw new Error('Invalid Google sign-in.');
  // Google's tokeninfo endpoint checks the signature and expiry for us.
  var res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('Google sign-in is invalid or expired. Please sign in again.');
  var c = JSON.parse(res.getContentText());
  if (c.aud !== cfg.GOOGLE_CLIENT_ID) throw new Error('Google sign-in was for a different application.');
  if (c.iss !== 'accounts.google.com' && c.iss !== 'https://accounts.google.com') throw new Error('Unexpected token issuer.');
  if (String(c.email_verified) !== 'true') throw new Error('Google account email is not verified.');
  var domain = String(cfg.ALLOWED_DOMAIN).toLowerCase();
  if (c.hd !== domain || !String(c.email).toLowerCase().endsWith('@' + domain)) throw new Error('Please sign in with your @' + domain + ' account.');
  return c;
}

// ---------------------------------------------------------------------------
// GitHub App authentication
// ---------------------------------------------------------------------------
// Installation tokens last an hour; cache one for 50 minutes.
function installationToken(cfg) {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('installation-token');
  if (cached) return cached;
  var auth = 'Bearer ' + appJwt(cfg);
  var installation = api('get', 'https://api.github.com/repos/' + cfg.GITHUB_REPO + '/installation', null, auth);
  var token = api('post', 'https://api.github.com/app/installations/' + installation.id + '/access_tokens', {}, auth).token;
  cache.put('installation-token', token, 3000);
  return token;
}

function appJwt(cfg) {
  var now = Math.floor(Date.now() / 1000);
  var input = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' +
    b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: cfg.GITHUB_APP_CLIENT_ID }));
  return input + '.' + b64urlBytes(Utilities.computeRsaSha256Signature(input, privateKey(cfg.GITHUB_APP_PRIVATE_KEY)));
}

// Script properties may flatten newlines; rebuild a well-formed PKCS#8 PEM.
function privateKey(value) {
  value = String(value || '');
  if (value.indexOf('RSA PRIVATE KEY') !== -1) {
    throw new Error('GITHUB_APP_PRIVATE_KEY must be PKCS#8 ("BEGIN PRIVATE KEY"): openssl pkcs8 -topk8 -nocrypt -in app.private-key.pem');
  }
  var body = value.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  return '-----BEGIN PRIVATE KEY-----\n' + body.match(/.{1,64}/g).join('\n') + '\n-----END PRIVATE KEY-----\n';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function api(method, url, payload, auth) {
  var options = {
    method: method,
    muteHttpExceptions: true,
    headers: { Authorization: auth, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  };
  if (payload) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(payload);
  }
  var res = UrlFetchApp.fetch(url, options);
  var data = JSON.parse(res.getContentText() || '{}');
  if (res.getResponseCode() >= 300) throw new Error('GitHub: ' + (data.message || res.getResponseCode()));
  return data;
}

function once(key, message) {
  var cache = CacheService.getScriptCache();
  if (cache.get(key)) throw new Error(message);
  cache.put(key, '1', 21600);
}

function rateLimit(who) {
  var cache = CacheService.getScriptCache();
  var key = 'rate:' + sha256Hex(who);
  var count = Number(cache.get(key) || 0) + 1;
  if (count > MAX_PER_HOUR) throw new Error('Too many submissions — please try again in an hour.');
  cache.put(key, String(count), 3600);
}

function sha256Hex(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8)
    .map(function (b) { return ((b + 256) % 256).toString(16).padStart(2, '0'); })
    .join('');
}

function b64url(text) {
  return b64urlBytes(Utilities.newBlob(text).getBytes());
}

function b64urlBytes(bytes) {
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}

// Keep user text from breaking out of the HTML comment that carries the Google token.
function clean(text) {
  return text.replace(/<!--|-->/g, '');
}
