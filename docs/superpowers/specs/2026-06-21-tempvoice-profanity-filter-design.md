# Temp-VC Name Profanity Filter

**Date:** 2026-06-21
**Status:** Approved
**Area:** `src/services/tempvoice/`

## Goal

Block profane names on temporary voice channels using the
[`censor-text/profanity-list`](https://github.com/censor-text/profanity-list)
English word list, and log every block to the existing RB Voice log channel.

## Matching semantics

Whole-word matching **with common inflectional endings** — not substring.

- Lowercase the name and split into tokens on non-letter characters.
  `cuck_lounge` -> `["cuck", "lounge"]`; `asdcuckasd` -> `["asdcuckasd"]` (one token).
- A token is profane if it is a list word directly, **or** stripping one common
  ending yields a list word. Endings: `s, es, ed, d, ing, er, ers`.
  (`in` is deliberately excluded: with the base `cum` it would flag `cumin`.)
- Therefore, given `cuck` in the list:
  - blocked: `cuck`, `cucks`, `cucked`, `cuck lounge`
  - allowed: `asdcuckasd`, `classic`, `analysis`, `sparse`, `bass`

This is a low-effort decency filter, not an adversarial one: leetspeak /
obfuscation (`fvck`, `f u c k`) is intentionally **out of scope**, consistent
with the `asdcuckasd`-allowed rule.

## Components

### 1. Vendored word list
`src/services/tempvoice/data/profanity-en.txt` — the raw English list
(~2,900 words, one per line, Unlicense / public domain). Source URL, license,
and a regenerate note are recorded in a comment block at the top of
`contentFilter.js`. The previous hardcoded slur list is merged in as a safety net.

### 2. `contentFilter.js` (rewrite)
- Load the word file once at module init into a `Set<string>` of lowercased base words.
- `SUFFIXES = ['s', 'es', 'ed', 'd', 'ing', 'er', 'ers']` (editable constant).
- `findProfanity(name) -> string | null` — first offending base word, or null.
- `isInappropriateName(name)` keeps the existing URL / mention / excessive-caps /
  excessive-special-char checks, now backed by `findProfanity` for the word check.
- `getSafeChannelName(name) -> { safe, name, reason, matched }`
  - `reason` in `profanity | url | mention | format | length | empty`
  - `matched` is the offending word when `reason === 'profanity'`, else `null`
  - The `{ safe, name }` shape is preserved for existing callers.

### 3. Enforcement points
- **Rename button** (`handlers/tempvoiceModals.js: handleNameModal`): on block, keep
  the ephemeral "not allowed" reply **and** post a `warn` log via `logEvent`.
- **Direct rename** (new `events/channelUpdate.js` -> new
  `tempvoiceManager.handleTempChannelRename(oldChannel, newChannel)`): if a *tracked*
  temp VC's name changed and the new name is blocked, revert to the previous clean
  name (or a neutral default if the previous name was also unsafe) and post a `warn`
  log. Actor is resolved best-effort from the audit log
  (`AuditLogEvent.ChannelUpdate`, match target id + recency), falling back to the
  channel owner. No revert loop: the reverted name is clean, so the follow-up
  `channelUpdate` takes no action. Bot-initiated renames always set clean names and
  are likewise ignored.
- **Creation** (`tempvoiceManager.handleJoinTrigger`): the
  `${displayName}'s Channel` default is checked; if the display name is profane,
  fall back to a neutral name (`Voice Channel`). Preset names are already filtered
  at set-time.

### 4. Logging
Reuses `logEvent` with `kind: 'warn'` (yellow, already defined) to
`config.log_channel_id`. Title "Blocked Channel Name". Fields: user, attempted
name, matched word, source (`Rename button` | `Direct rename` | `Creation`).

### 5. Tests
`src/services/tempvoice/contentFilter.test.js` (Bun `bun test`):
- `cuck` blocked; `cucks`, `cucked`, `cuck lounge` blocked
- `asdcuckasd`, `classic`, `analysis`, `sparse`, `bass`, `grass` allowed
- a whole-word slur from the list blocked
- URL and mention names still blocked
- clean names returned unchanged by `getSafeChannelName`

## Out of scope (YAGNI)
- Leetspeak / obfuscation normalization.
- A curated false-positive allowlist (the `.txt` is hand-editable if list words
  like `abuse` / `anal` prove annoying).

## Versioning & deploy
- `feat` change -> bump bot `package.json` 2.21.1 -> 2.22.0.
- Conventional-commit messages, no AI attribution, no emojis.
- Deploy: push `main` (staging) -> verify -> merge `main` into `production` (prod)
  -> verify via `gh run list`.
