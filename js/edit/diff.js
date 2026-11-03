// Minimal line diffs: `lineDiff` for the "Submit" review list, `unifiedDiff` for exporting a patch.

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
