/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


export interface LineDiff {
  added: number;
  removed: number;
  lines: { t: '+' | '-' | ' '; s: string }[];
}

/** LCS line diff with +/- counts and a capped, rendered hunk list. */
export function lineDiff(before: string, after: string, cap = 400): LineDiff {
  const a = before ? before.split('\n') : [];
  const b = after ? after.split('\n') : [];
  const n = a.length;
  const m = b.length;
  const clip = (s: string): string => (s.length > 500 ? s.slice(0, 500) + '…' : s);
  const lines: { t: '+' | '-' | ' '; s: string }[] = [];
  // Guard the O(n*m) LCS against pathologically large files.
  if (n * m > 1_500_000) {
    for (const s of a.slice(0, cap / 2)) {lines.push({ t: '-', s: clip(s) });}
    for (const s of b.slice(0, cap / 2)) {lines.push({ t: '+', s: clip(s) });}
    return { added: m, removed: n, lines };
  }
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    {for (let j = m - 1; j >= 0; j--)
      {dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);}}
  let i = 0;
  let j = 0;
  let added = 0;
  let removed = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push({ t: ' ', s: clip(a[i]) });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push({ t: '-', s: clip(a[i]) });
      removed++;
      i++;
    } else {
      lines.push({ t: '+', s: clip(b[j]) });
      added++;
      j++;
    }
  }
  while (i < n) {
    lines.push({ t: '-', s: clip(a[i]) });
    removed++;
    i++;
  }
  while (j < m) {
    lines.push({ t: '+', s: clip(b[j]) });
    added++;
    j++;
  }
  return { added, removed, lines: lines.slice(0, cap) };
}
