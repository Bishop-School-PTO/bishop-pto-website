// Minimal line diff for the "Submit" review list. Returns [[op, line], ...] where op is
// ' ' (same), '+' (added), '-' (removed) or '…' (skipped unchanged lines), or null if too large.
export function lineDiff(before, after, context = 3) {
  const a = before == null ? [] : before.split('\n');
  const b = after == null ? [] : after.split('\n');

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

  // Keep only changed lines plus a little context around them.
  const near = new Uint8Array(ops.length);
  ops.forEach(([op], k) => {
    if (op !== ' ') for (let d = -context; d <= context; d++) if (ops[k + d]) near[k + d] = 1;
  });
  const out = [];
  ops.forEach((op, k) => {
    if (near[k]) out.push(op);
    else if (out.at(-1)?.[0] !== '…') out.push(['…', '']);
  });
  return out;
}
