# Bishop Elementary PTO website

A plain static site (HTML, CSS, JS — no build step) published with GitHub Pages.

Anyone can edit the site in the browser with **Edit Mode** and propose the change as a pull request — members of
the PTO's Google Workspace with no GitHub account at all, or anyone via "Sign in with GitHub". Nothing goes live
until a maintainer merges it on GitHub.

## How it works

```
 Browser (Edit Mode)               Relay (Google Apps Script)              GitHub
 ───────────────────               ──────────────────────────              ──────
 edit page / pages / code
 optional AI (user's OpenRouter key)
 identify yourself:
  • Google, nonce = SHA-256(changes) ─► verify Google token + nonce
  • and/or Sign in with GitHub ──────► read identity, revoke GitHub token,
                                       return signed session
 submit ─────────────────────────────► as the GitHub App bot:
                                       branch + commit + PR ──────────────► PR opened
                                                                           ├─ verify-edit.yml: checks Google's
                                                                           │  signature + content hash ✅/⚠️/❌
                                                                           ├─ pages.yml: preview at /pr/<n>/, link posted on the PR
                                                                           └─ maintainer reviews & merges → live
```

| Path | Purpose |
| --- | --- |
| `js/script.js` | Site script; also shows PR-preview banners and loads Edit Mode on demand |
| `js/edit/editor.js` | Edit Mode: editing, pages, colors, source editor, review & submit |
| `js/edit/ai.js` | Optional AI assistant via OpenRouter (tool calling over the editor's tools) |
| `js/edit/submit.js` | Content hashing, Google Sign-In, Sign in with GitHub, relay calls |
| `js/edit/github-callback.html` | Return page for the "Sign in with GitHub" popup |
| `js/edit/config.json` | Settings shared by the browser and the verification Action |
| `css/edit.css` | Edit Mode styles (only loaded while editing) |
| `relay/` | Google Apps Script web app that opens PRs as the site's GitHub App |
| `.github/workflows/pages.yml` | Deploys the site at `/` and trusted open PRs at `/pr/<n>/`; comments each PR's preview link |
| `.github/workflows/verify-edit.yml` | Verifies the Google signature on Edit Mode PRs |

### Edit Mode

Click **Suggest an edit to this page** in the footer (or add `#edit` to any URL). The panel on the right can be
resized by dragging its left edge.

- **Editing: [page ▾]** in the header switches pages or starts a new one.
- **This page**: click any text and type. The click also selects that block (heading, paragraph, button, link…),
  so you can make text bold/italic/linked, move it, duplicate or delete it, add a new block below, or step out to the
  surrounding card or section. Raw HTML and the page title/description are tucked into collapsible extras.
- **Ask the assistant** (optional): paste an [OpenRouter API key](https://openrouter.ai/settings/keys) and ask for changes
  in plain language. The key stays in the browser (session-only unless "Remember on this device" is ticked) and is sent
  only to OpenRouter, which bills the key's owner. Any OpenRouter model that supports tool calling can be picked from the dropdown ("Always the latest" aliases first, with prices); the
  default is `aiModel` in `js/edit/config.json` (`~anthropic/claude-haiku-latest` follows the newest Claude Haiku).
  "Allow web search" (off by default) lets it look things up and read pages you mention, via OpenRouter's
  web search and fetch tools (about 1¢ per lookup, at most 5 searches and 5 page reads per request); sources are
  listed under the reply.
  Each reply shows its approximate cost and how much of the input came from the prompt cache (enabled for Claude
  models; most other providers cache automatically).
- **Site-wide**: banners, menu & pages (create/delete; menu links are kept in sync on every page), the site's colors,
  and "Edit source files (advanced)" for any HTML/CSS/JS file.
- **Banners** are the announcement strips at the top of every page (inside `<div class="site-banners">`). Add as
  many as you like, each with a style (Notice, Alert, Info), a bold heading, a message, and an optional link; reorder
  or remove them. Changes apply to every page, and new pages start with the current banners. Clicking a banner on the
  page opens its settings. The assistant can manage them too.
- The footer shows how many files changed, **Undo** (block edits, page changes, AI turns; Ctrl+Z undoes typing), and
  **Review & submit**, which shows a diff of every changed file and opens the pull request.
- Drafts are kept in the browser until submitted or discarded.

### Submitting a change

In **Review & submit**, add a summary and choose how to identify yourself (one or both):

- **Sign with my @domain Google account** — no GitHub account needed. Google signs your email together with a
  fingerprint of the exact changes; the proof is attached to the PR, so your email is visible on GitHub.
- **Sign in with GitHub** — a GitHub popup; you're credited on the commit and @-mentioned on the PR, so you get updates.

The PR is opened by the site's bot (`<app-name>[bot]`) from a branch in this repository.

## Setup (one time)

1. **GitHub Pages from Actions.** Repo → Settings → Pages → Source: **GitHub Actions**.
   The `github-pages` environment must allow deployments from `main` (the default).
2. **Branch protection (recommended).** Require a pull-request review before merging to `main`.
3. **GitHub App** (the bot that opens PRs, and "Sign in with GitHub"). GitHub → Settings → Developer settings →
   GitHub Apps → New GitHub App:
   - Homepage URL: the site. Webhook: uncheck *Active*.
   - **Callback URLs** (for Sign in with GitHub): `https://etruong42.github.io/bishop-pto/js/edit/github-callback.html`
     and `http://localhost:8083/js/edit/github-callback.html`.
   - Repository permissions: **Contents: Read and write**, **Pull requests: Read and write** (Metadata: read is
     automatic). No account permissions. Do *not* grant Workflows.
   - "Where can this GitHub App be installed?": *Only on this account*.
   - After creating it: note the **Client ID**, generate a **client secret**, and generate a **private key**. Convert
     the key once: `openssl pkcs8 -topk8 -nocrypt -in <downloaded>.pem -out app-pkcs8.pem`.
   - **Install App** → only this repository.
4. **Google Workspace sign-in (optional, enables no-GitHub-account submissions).** Google Cloud Console (ideally a
   project owned by the Workspace) → APIs & Services → Credentials → Create OAuth client ID → *Web application*.
   Authorized JavaScript origins: `https://etruong42.github.io` and `http://localhost:8083`. No secret is needed.
5. **Relay.** Create a project at [script.google.com](https://script.google.com) and paste `relay/Code.gs`
   (and `relay/appsscript.json` via Project Settings → "Show appsscript.json"). Under Project Settings →
   Script properties add:

   | Property | Value |
   | --- | --- |
   | `GITHUB_REPO` | `etruong42/bishop-pto` |
   | `GITHUB_BRANCH` | `main` |
   | `GITHUB_APP_CLIENT_ID` | the App's Client ID |
   | `GITHUB_APP_CLIENT_SECRET` | the App's client secret |
   | `GITHUB_APP_PRIVATE_KEY` | contents of `app-pkcs8.pem` |
   | `GOOGLE_CLIENT_ID`, `ALLOWED_DOMAIN` | optional, from step 4 (e.g. `bishopschoolpto.com`) |

   Deploy → New deployment → Web app, *Execute as: Me*, *Who has access: Anyone*; copy the `/exec` URL.
   (If your Workspace admin blocks "Anyone" access, deploy it from a personal Google account instead.)
6. **Config.** In `js/edit/config.json` set `relayUrl`, `githubAppClientId`, and (if step 4) `googleClientId` and
   `allowedDomain`.

### Maintenance

- Nothing expires: the App's private key and client secret don't, and installation tokens are minted per use.
  Rotate them in the App's settings if they're ever exposed, then update the script properties.
- Updating the relay code: paste it and create a new deployment version (Deploy → Manage deployments).
- Edit Mode saves HTML in the browser's canonical form (e.g. `—` instead of `&mdash;`). Hand-written HTML is fine,
  but the first Edit Mode change to such a file will include those formatting differences in its diff.
- Merged or closed PR branches can be deleted automatically (Settings → "Automatically delete head branches").
- To preview an Edit Mode PR that isn't Google-verified, add the **`preview`** label to it.

## Security model

- **Publishing requires GitHub.** Edit Mode can only open pull requests. Merging is done on GitHub by
  maintainers, under the repository's normal permissions and branch protection.
- **The relay is the only credential holder.** It acts as a GitHub App limited to this repository's contents and
  pull requests (no workflow permission), and it only accepts text files outside dot-folders, so submissions cannot
  touch `.github/`. Every submission must be identified (Google or GitHub), and each person is limited to
  10 submissions per hour.
- **Google proof.** The editor sets the Google Sign-In `nonce` to the SHA-256 of the exact changes, so the ID token
  that Google signs proves *who* (a verified account in the Workspace domain, `hd` claim) approved *what*. The relay
  checks it before opening the PR (each token once), and `verify-edit.yml` re-checks it independently against
  Google's public keys and the PR's actual files, commenting ✅ verified, ⚠️ changed after signing, or ❌ invalid.
- **GitHub sign-in** is used only to learn the person's GitHub identity: the relay revokes GitHub's token right
  away and gives the browser its own signed session (8 hours). No GitHub token is kept in the browser. The
  attribution on these PRs is asserted by the relay (not independently verifiable like the Google proof).
- **Previews** share the live site's origin, so they're built only for trusted PRs: branches pushed by
  collaborators, PRs whose *current* commit has a ✅ verified Workspace signature, and PRs a maintainer labels
  `preview`. PR files are copied, never executed by CI, and symlinks are dropped. Preview pages are marked
  `noindex`, and each PR gets one bot comment with its preview link (or why there isn't one yet), kept up to date.
  Only the commenting job can write to PRs; the job that copies PR files is read-only.
- **Workflows run from `main`** (`pull_request_target`), so a PR cannot change its own verification or deployment.
- **AI.** The assistant only edits the local draft; its changes go through the same review as any other edit.
