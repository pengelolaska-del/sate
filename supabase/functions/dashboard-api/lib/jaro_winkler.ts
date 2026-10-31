// ─── JaroWinkler similarity ───────────────────────────────────

export function jaroWinklerSimilarity(s1: string, s2: string): number {
  if (s1 === s2) return 1.0;
  const l1 = s1.length, l2 = s2.length;
  if (l1 === 0 || l2 === 0) return 0.0;

  const md = Math.max(Math.floor(Math.max(l1, l2) / 2) - 1, 0);
  const m1 = new Array(l1).fill(false);
  const m2 = new Array(l2).fill(false);
  let mt = 0, tr = 0;

  for (let i = 0; i < l1; i++) {
    const start = Math.max(0, i - md);
    const end = Math.min(i + md + 1, l2);
    for (let j = start; j < end; j++) {
      if (m2[j] || s1[i] !== s2[j]) continue;
      m1[i] = m2[j] = true;
      mt++;
      break;
    }
  }
  if (mt === 0) return 0.0;

  let k = 0;
  for (let i = 0; i < l1; i++) {
    if (!m1[i]) continue;
    while (!m2[k]) k++;
    if (s1[i] !== s2[k]) tr++;
    k++;
  }

  const jaro = (mt / l1 + mt / l2 + (mt - tr / 2) / mt) / 3;
  let prefix = 0;
  const limit = Math.min(l1, l2, 4);
  while (prefix < limit && s1[prefix] === s2[prefix]) prefix++;

  return jaro + prefix * 0.1 * (1 - jaro);
}
