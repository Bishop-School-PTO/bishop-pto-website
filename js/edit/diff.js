// Minimal line diffs: `lineDiff` for the "Submit" review list, `unifiedDiff` for exporting a patch, and
// `parsePatch` + `applyHunks` for importing one.

// Edit script between two line arrays as [[op, line], ...] with op ' ' (same), '+' (added) or '-' (removed),
// or null if the changed region is too large to diff.
function diffOps(a, b) {
  // Trim the common prefix/suffix so the LCS table only covers the changed region.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }

  const x = a.slice(start, endA);
  const y = b.slice(start, endB);
  if (x.length * y.length > 4e6) return null;

  const lcs = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const ops = a.slice(0, start).map((line) => [' ', line]);
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) { ops.push([' ', x[i++]]); j++; }
    else if (i < x.length && (j >= y.length || lcs[i + 1][j] >= lcs[i][j + 1])) ops.push(['-', x[i++]]);
    else ops.push(['+', y[j++]]);
  }
  for (let k = endA; k < a.length; k++) ops.push([' ', a[k]]);
  return ops;
}

// Marks the ops that are changes or within `context` lines of one.
function nearChanges(ops, context) {
  const near = new Uint8Array(ops.length);
  ops.forEach(([op], k) => {
    if (op !== ' ') for (let d = -context; d <= context; d++) if (ops[k + d]) near[k + d] = 1;
  });
  return near;
}

// Returns [[op, line], ...] where op is ' ', '+', '-' or '…' (skipped unchanged lines), or null if too large.
export function lineDiff(before, after, context = 3) {
  const ops = diffOps(before == null ? [] : before.split('\n'), after == null ? [] : after.split('\n'));
  if (!ops) return null;

  // Keep only changed lines plus a little context around them.
  const near = nearChanges(ops, context);
  const out = [];
  ops.forEach((op, k) => {
    if (near[k]) out.push(op);
    else if (out.at(-1)?.[0] !== '…') out.push(['…', '']);
  });
  return out;
}

// Lines with their '\n' kept, so a missing newline at the end of the file shows up in the diff.
const linesOf = (text) => (text ? text.match(/[^\n]*\n|[^\n]+$/g) : []);

// A git-style unified diff of one file (before/after null = file doesn't exist), usable with `git apply`.
export function unifiedDiff(path, before, after, context = 3) {
  const a = linesOf(before);
  const b = linesOf(after);
  // Too large for the LCS table: replace the whole file, which is still a valid patch.
  const ops = diffOps(a, b) || [...a.map((l) => ['-', l]), ...b.map((l) => ['+', l])];
  const near = nearChanges(ops, context);

  const out = [`diff --git a/${path} b/${path}`];
  if (before == null) out.push('new file mode 100644');
  if (after == null) out.push('deleted file mode 100644');
  out.push(`--- ${before == null ? '/dev/null' : `a/${path}`}`, `+++ ${after == null ? '/dev/null' : `b/${path}`}`);

  let oldLine = 0;
  let newLine = 0;
  for (let k = 0; k < ops.length;) {
    if (!near[k]) {
      if (ops[k][0] !== '+') oldLine++;
      if (ops[k][0] !== '-') newLine++;
      k++;
      continue;
    }
    const body = [];
    let oldCount = 0;
    let newCount = 0;
    for (; k < ops.length && near[k]; k++) {
      const [op, line] = ops[k];
      if (op !== '+') oldCount++;
      if (op !== '-') newCount++;
      body.push(op + line.replace(/\n$/, ''));
      if (!line.endsWith('\n')) body.push('\\ No newline at end of file');
    }
    // An empty range is numbered by the line before it.
    out.push(`@@ -${oldCount ? oldLine + 1 : oldLine},${oldCount} +${newCount ? newLine + 1 : newLine},${newCount} @@`, ...body);
    oldLine += oldCount;
    newLine += newCount;
  }
  return `${out.join('\n')}\n`;
}

// Parses a unified diff (`git diff`, `git format-patch`, a GitHub pull request's diff, or plain `diff -u`) into
// [{ from, to, hunks, binary }]. `from`/`to` are paths, null when the file is new/deleted; each hunk is
// { oldStart, old, new } with old/new as lines that keep their '\n' (like `linesOf`).
export function parsePatch(text) {
  // A patch file saved with Windows line endings throughout.
  if (!/(^|[^\r])\n/.test(text)) text = text.replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const files = [];
  let file = null;
  const path = (raw, prefix) => {
    const p = raw.replace(/\t.*$/, ''); // `diff -u` appends a timestamp after a tab
    return p === '/dev/null' ? null : p.startsWith(prefix) ? p.slice(prefix.length) : p;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if ((m = line.match(/^diff --git a\/(\S+) b\/(\S+)$/))) {
      file = { from: m[1], to: m[2], hunks: [], git: true };
      files.push(file);
    } else if (line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
      // Belongs to the preceding `diff --git` header, or starts a file in a plain diff.
      if (!file?.git || file.named || file.hunks.length) files.push(file = { hunks: [] });
      file.from = path(line.slice(4), 'a/');
      file.to = path(lines[++i].slice(4), 'b/');
      file.named = true;
    } else if (!file?.git || file.named) {
      if ((m = line.match(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@/)) && file) i = readHunk(lines, i, m, file);
    } else if (line.startsWith('new file mode')) file.from = null;
    else if (line.startsWith('deleted file mode')) file.to = null;
    else if (line.startsWith('rename from ')) file.from = line.slice(12);
    else if (line.startsWith('rename to ')) file.to = line.slice(10);
    else if (line.startsWith('Binary files') || line === 'GIT binary patch') file.binary = true;
  }
  if (!files.length) throw new Error('No file changes were found. Paste a diff like the one `git diff` prints.');
  return files.map(({ from, to, hunks, binary = false }) => ({ from, to, hunks, binary }));
}

// Reads the hunk whose header is lines[i] into `file`; returns the index of its last line.
function readHunk(lines, i, [header, oldStart, oldCount = '1', newCount = '1'], file) {
  const hunk = { oldStart: Number(oldStart), old: [], new: [] };
  let oldLeft = Number(oldCount);
  let newLeft = Number(newCount);
  while (oldLeft > 0 || newLeft > 0) {
    const line = lines[++i];
    if (line === undefined) throw new Error(`The patch ends in the middle of a change (${header}).`);
    if (line.startsWith('\\')) continue;
    const op = line[0] ?? ' '; // some tools strip the space from empty context lines
    const touched = { ' ': [hunk.old, hunk.new], '-': [hunk.old], '+': [hunk.new] }[op];
    if (!touched) throw new Error(`Unexpected line in the patch (${header}): ${line}`);
    // "\ No newline at end of file" after a line means that line has no '\n'.
    const text = line.slice(1) + (lines[i + 1]?.startsWith('\\') ? '' : '\n');
    for (const side of touched) side.push(text);
    if (op !== '+') oldLeft--;
    if (op !== '-') newLeft--;
  }
  file.hunks.push(hunk);
  return i;
}

// Applies parsed hunks to `text` (null = the file doesn't exist) and returns the result. Hunks are matched
// exactly, but may have moved up or down, e.g. when the patch was made against an older version of the file.
export function applyHunks(text, hunks) {
  const lines = linesOf(text);
  const out = [];
  let pos = 0; // first line not yet copied to `out`
  let offset = 0; // how far the previous hunk was from where the patch placed it
  for (const hunk of hunks) {
    // A hunk that only adds lines is numbered by the line before it.
    const expected = (hunk.old.length ? hunk.oldStart - 1 : hunk.oldStart) + offset;
    const at = findLines(lines, hunk.old, expected, pos);
    if (at < 0) throw new Error(`the change near line ${hunk.oldStart} doesn't match the current file`);
    offset += at - expected;
    out.push(...lines.slice(pos, at), ...hunk.new);
    pos = at + hunk.old.length;
  }
  return [...out, ...lines.slice(pos)].join('');
}

// Index (>= min) where `needle` occurs in `lines`, searching outward from `expected`; -1 if nowhere.
function findLines(lines, needle, expected, min) {
  const last = lines.length - needle.length;
  if (!needle.length) return Math.min(Math.max(expected, min), lines.length);
  const matches = (at) => at >= min && at <= last && needle.every((line, k) => lines[at + k] === line);
  for (let d = 0; expected - d >= min || expected + d <= last; d++) {
    if (matches(expected + d)) return expected + d;
    if (d && matches(expected - d)) return expected - d;
  }
  return -1;
}
