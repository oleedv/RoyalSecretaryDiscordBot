import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import logger from '../../logger.js';

const log = logger.child({ module: 'moderationPrompt' });

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadDataFile(filename) {
  try {
    return readFileSync(join(__dirname, '../../data', filename), 'utf-8');
  } catch (err) {
    log.warn({ err }, `Could not load ${filename} - moderation prompt will work without it`);
    return '';
  }
}

const serverRules = loadDataFile('rules.txt');
const owiCodeOfConduct = loadDataFile('owi-code-of-conduct.txt');
const owiServerLicensing = loadDataFile('owi-server-licensing.txt');

const CATEGORY_DEFINITIONS = `
- racism: slurs, hate speech, racial/ethnic abuse, discrimination based on race/ethnicity/religion/sexuality
- recruiting: promoting another clan/community/Discord/server, advertising recruitment for another group on our server
- abuse: targeted insults, personal attacks, hostile name-calling directed at a specific player
- harassment: repeated targeting of a player, creepy/sexual messages, doxxing attempts
- threats: real-world threats, threats to find/harm someone IRL (NOT in-character mil-sim threats like "kill them all" or "wipe them out")
- advertising: spam links, promotion of unrelated products/services/streams without staff permission
- drama: continued arguing/yelling in chat after being told to stop; sustained server drama; admin call-outs
- other: clear rule violation that doesn't fit the above categories
`.trim();

const SEVERITY_DEFINITIONS = `
- definite: clear, unambiguous rule violation that warrants action without further investigation. Use for slurs, explicit recruiting for another clan, real-world threats, sustained targeted abuse.
- possible: ambiguous, context-dependent, or borderline cases that need staff review. Use when intent is unclear, when context might be missing, or when the message is mildly inappropriate but might be banter.
`.trim();

const GUARDRAILS = `
IMPORTANT GUARDRAILS - false positives waste staff time:
- Squad chat is in-game text. Players are often blunt, salty, use profanity, and trash-talk. Generic profanity ("fuck", "shit", "this map sucks") is NOT a violation by itself.
- Mil-sim roleplay language is NOT a threat: "kill them all", "wipe them out", "enemy spotted", "frag him", "nuke them" are normal Squad communication.
- Banter between teammates ("you're trash at this", "git gud") is NOT abuse unless clearly hostile and targeted.
- Squad-leader commands and tactical callouts are normal — do not flag.
- Disagreement with a teammate is NOT drama unless sustained or directed at admin authority.
- A single mild insult in heat-of-the-moment is more likely "possible" than "definite".
- When in doubt between definite and possible, prefer possible.
- Only flag messages that, on their own text alone, a moderator would act on or want to review. Do NOT speculate about context not present in the message.
`.trim();

const OUTPUT_FORMAT = `
Return STRICT JSON only - no prose, no markdown, no backticks. Schema:

{
  "definite": [
    {
      "message_id": <integer from the input>,
      "category": "<one of: racism|recruiting|abuse|harassment|threats|advertising|drama|other>",
      "rule_cited": "<short rule reference, e.g. 'Server Rule 1 (Respect)' or 'Server Rule 4 (Recruiting)' or 'OWI Code of Conduct - Inappropriate Content'; null if none specifically cited>",
      "recommended_action": "<short action, e.g. 'Verbal warn', 'Formal warn', 'Kick', '24-hour ban', '7-day ban', 'Permanent ban', 'Watch (no action yet)'>",
      "reasoning": "<one or two sentences explaining why this is a definite violation>"
    }
  ],
  "possible": [
    {
      "message_id": <integer>,
      "category": "<...>",
      "rule_cited": "<...or null>",
      "recommended_action": "<...e.g. 'Review', 'Verbal warn if it continues'>",
      "reasoning": "<why this is borderline>"
    }
  ]
}

If nothing is flagged, return: {"definite": [], "possible": []}
`.trim();

export function buildSystemPrompt() {
  return `You are a moderation analyst for the Royal Battalion Squad server. Your job is to review the previous 24 hours of in-game chat and flag messages that break our server rules or OWI's policies, so admins can act on them.

SERVER RULES:
${serverRules || 'No rules document loaded.'}

OWI CODE OF CONDUCT:
${owiCodeOfConduct || 'Not loaded.'}

OWI SERVER LICENSING & ADMINISTRATION POLICIES:
${owiServerLicensing || 'Not loaded.'}

CATEGORIES:
${CATEGORY_DEFINITIONS}

SEVERITY:
${SEVERITY_DEFINITIONS}

${GUARDRAILS}

OUTPUT FORMAT:
${OUTPUT_FORMAT}`;
}

export function buildUserBatchText(messages) {
  const lines = messages.map((m) => {
    const time = new Date(m.message_time).toISOString().slice(0, 19).replace('T', ' ');
    const steam = m.steam_id ? `steam=${m.steam_id}` : 'steam=null';
    const eos = m.eos_id ? `eos=${m.eos_id}` : 'eos=null';
    const safeText = String(m.message ?? '').replace(/\r?\n/g, ' ').slice(0, 500);
    return `[id=${m.message_id} | ${time} UTC | ${m.chat_type} | ${m.player_name}(${steam}, ${eos})] ${safeText}`;
  });

  return `Below are ${messages.length} in-game chat messages from the last 24 hours. Analyse them per the system instructions and return JSON only.

${lines.join('\n')}

End of chat batch. Return JSON only.`;
}

export function getRulesDocsLoaded() {
  return {
    rules: !!serverRules,
    owiCodeOfConduct: !!owiCodeOfConduct,
    owiServerLicensing: !!owiServerLicensing,
  };
}
