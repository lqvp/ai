export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  // Tokenize by whitespace and basic punctuation
  const tokensA = a.toLowerCase().split(/[^a-z0-9]+/);
  const tokensB = b.toLowerCase().split(/[^a-z0-9]+/);
  const setA = new Set(tokensA.filter(Boolean));
  const setB = new Set(tokensB.filter(Boolean));

  let intersection = 0;
  setA.forEach((token) => {
    if (setB.has(token)) intersection += 1;
  });

  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}