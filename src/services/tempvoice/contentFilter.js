const BLACKLIST = [
  'nigger', 'nigga', 'faggot', 'fag', 'retard', 'kike', 'chink', 'spic',
  'tranny', 'coon', 'wetback', 'beaner', 'gook', 'dyke',
];

const URL_PATTERN = /https?:\/\/\S+|discord\.gg\/\S+|www\.\S+/i;
const MENTION_PATTERN = /<@!?\d+>|<@&\d+>|<#\d+>/;

export function isInappropriateName(name) {
  if (!name || typeof name !== 'string') return true;

  const lower = name.toLowerCase().trim();
  if (!lower) return true;

  if (BLACKLIST.some((word) => lower.includes(word))) return true;
  if (URL_PATTERN.test(name)) return true;
  if (MENTION_PATTERN.test(name)) return true;

  // Excessive caps (>80% uppercase when 5+ chars)
  if (name.length > 5) {
    const upperCount = (name.match(/[A-Z]/g) || []).length;
    const letterCount = (name.match(/[a-zA-Z]/g) || []).length;
    if (letterCount > 0 && upperCount / letterCount > 0.8) return true;
  }

  // Excessive special characters (>50% non-alphanumeric/space)
  const specialCount = (name.match(/[^a-zA-Z0-9\s]/g) || []).length;
  if (name.length > 3 && specialCount / name.length > 0.5) return true;

  return false;
}

export function sanitizeChannelName(name) {
  if (!name || typeof name !== 'string') return 'Unnamed Channel';

  let sanitized = name
    .replace(URL_PATTERN, '')
    .replace(MENTION_PATTERN, '')
    .replace(/[^\w\s'-]/g, '')
    .trim();

  if (sanitized.length < 2) return 'Unnamed Channel';
  if (sanitized.length > 100) sanitized = sanitized.slice(0, 100);

  return sanitized;
}

export function getSafeChannelName(name) {
  if (isInappropriateName(name)) {
    return { safe: false, name: 'Unnamed Channel' };
  }

  const trimmed = name.trim();
  if (trimmed.length < 2) return { safe: false, name: 'Unnamed Channel' };
  if (trimmed.length > 100) return { safe: true, name: trimmed.slice(0, 100) };
  return { safe: true, name: trimmed };
}
