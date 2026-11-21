// A line diff of two versions of a spec file, for the editor's "Spec diff".

export type DiffLine = { kind: " " | "+" | "-"; text: string; line: number };

/** Lines of `before` and `after` in order, each kept, added or removed (longest common subsequence). */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;
  // lcs[i][j]: length of the LCS of a[i..] and b[j..].
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      out.push({ kind: " ", text: a[i]!, line: j + 1 });
      i++;
      j++;
    } else if (i < n && (j >= m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      out.push({ kind: "-", text: a[i]!, line: j + 1 });
      i++;
    } else {
      out.push({ kind: "+", text: b[j]!, line: j + 1 });
      j++;
    }
  }
  return out;
}

/** The changed lines with `context` unchanged lines around each run; `null` marks a gap. */
export function hunks(lines: DiffLine[], context = 1): (DiffLine | null)[] {
  const keep = lines.map((l) => l.kind !== " ");
  const near = lines.map((_, i) => {
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) if (keep[k]) return true;
    return false;
  });
  const out: (DiffLine | null)[] = [];
  lines.forEach((l, i) => {
    if (near[i]) out.push(l);
    else if (out.length && out[out.length - 1] !== null) out.push(null);
  });
  if (out[out.length - 1] === null) out.pop();
  return out;
}
