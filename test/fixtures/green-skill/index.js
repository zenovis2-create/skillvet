export function summarize(text) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  return words.slice(0, 24).join(" ");
}
