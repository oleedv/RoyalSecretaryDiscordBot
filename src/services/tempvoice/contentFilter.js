import { readFileSync } from 'node:fs';

// Profanity word list sourced from the public-domain (Unlicense) project:
//   https://github.com/censor-text/profanity-list  (list/en.txt)
// Vendored as ./data/profanity-en.txt. To refresh:
//   curl -fsSL https://raw.githubusercontent.com/censor-text/profanity-list/main/list/en.txt \
//     -o src/services/tempvoice/data/profanity-en.txt
//
// Matching is whole-word (token-based) plus a small set of common English
// inflectional endings. It is a low-effort decency filter, NOT an adversarial
// one: embedded substrings (e.g. "asdcuckasd") and leetspeak ("fvck") are
// intentionally allowed.

// Legacy hardcoded slurs kept as a safety net in case the list ever changes.
const LEGACY_WORDS = [
  'nigger', 'nigga', 'faggot', 'fag', 'retard', 'kike', 'chink', 'spic',
  'tranny', 'coon', 'wetback', 'beaner', 'gook', 'dyke',
];

// Common inflectional endings. A token is profane if it is a list word, or if
// stripping one of these endings yields a list word. Two endings are
// deliberately excluded:
//   - 'in'  -> with the base "cum" it would flag "cumin".
//   - 'd'   -> too collision-prone (any word ending in d); e.g. "squad" -> "squa"
//             (a truncated entry in the upstream list) would wrongly match.
const SUFFIXES = ['ers', 'ing', 'es', 'ed', 'er', 's'];

const URL_PATTERN = /https?:\/\/\S+|discord\.gg\/\S+|www\.\S+/i;
const MENTION_PATTERN = /<@!?\d+>|<@&\d+>|<#\d+>/;

// Lowercase, strip diacritics, drop any non a-z character.
function normalizeWord(s) {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
}

function loadWordSet() {
  const set = new Set();
  try {
    const raw = readFileSync(new URL('./data/profanity-en.txt', import.meta.url), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const w = normalizeWord(line);
      if (w) set.add(w);
    }
  } catch {
    // Fall back to the legacy list if the file is missing.
  }
  for (const w of LEGACY_WORDS) set.add(normalizeWord(w));
  return set;
}

const BANNED = loadWordSet();

// Split a name into comparable letter-only tokens (diacritics stripped).
function tokenize(name) {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
}

/**
 * Returns the offending base word if the name contains profanity, else null.
 * Whole-word matching plus common inflectional endings.
 */
export function findProfanity(name) {
  if (!name || typeof name !== 'string') return null;

  for (const token of tokenize(name)) {
    if (BANNED.has(token)) return token;
    for (const suffix of SUFFIXES) {
      if (token.length > suffix.length && token.endsWith(suffix)) {
        const stem = token.slice(0, -suffix.length);
        if (BANNED.has(stem)) return stem;
      }
    }
  }
  return null;
}

export function isInappropriateName(name) {
  if (!name || typeof name !== 'string') return true;

  const trimmed = name.trim();
  if (!trimmed) return true;

  if (findProfanity(trimmed)) return true;
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

/**
 * Validates a requested channel name.
 * Returns { safe, name, reason, matched } where:
 *   - reason is one of: profanity | url | mention | caps | special | length | empty
 *   - matched is the offending word when reason === 'profanity', else null
 * The { safe, name } shape is preserved for existing callers.
 */
export function getSafeChannelName(name) {
  if (!name || typeof name !== 'string' || !name.trim()) {
    return { safe: false, name: 'Unnamed Channel', reason: 'empty', matched: null };
  }

  const matched = findProfanity(name);
  if (matched) {
    return { safe: false, name: 'Unnamed Channel', reason: 'profanity', matched };
  }

  if (URL_PATTERN.test(name)) {
    return { safe: false, name: 'Unnamed Channel', reason: 'url', matched: null };
  }
  if (MENTION_PATTERN.test(name)) {
    return { safe: false, name: 'Unnamed Channel', reason: 'mention', matched: null };
  }

  if (name.length > 5) {
    const upperCount = (name.match(/[A-Z]/g) || []).length;
    const letterCount = (name.match(/[a-zA-Z]/g) || []).length;
    if (letterCount > 0 && upperCount / letterCount > 0.8) {
      return { safe: false, name: 'Unnamed Channel', reason: 'caps', matched: null };
    }
  }

  const specialCount = (name.match(/[^a-zA-Z0-9\s]/g) || []).length;
  if (name.length > 3 && specialCount / name.length > 0.5) {
    return { safe: false, name: 'Unnamed Channel', reason: 'special', matched: null };
  }

  const trimmed = name.trim();
  if (trimmed.length < 2) return { safe: false, name: 'Unnamed Channel', reason: 'length', matched: null };
  if (trimmed.length > 100) return { safe: true, name: trimmed.slice(0, 100), reason: null, matched: null };
  return { safe: true, name: trimmed, reason: null, matched: null };
}
