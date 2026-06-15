# DM Self-Serve "Link Steam" — Design

**Date:** 2026-06-15
**Status:** Approved (design), pending implementation plan
**Requested by:** Ole

## Origin & context

Players' Discord↔Steam link lives in the website `User` table (`User.steamId`), read by
`userService.getStoredSteamId()`. Several bot features gate on it:

- **Giveaway** entry (`giveawayButtons.js`) — refuses entry if not linked.
- **Seed Tracker** progression (`seedTrackerButtons.js`) — refuses if not linked.

Today there is **no standalone way for a user to link their Steam ID.** Linking only happens as a
side effect of two larger flows:

- The **"Join RB"** prospect application modal (`prospectModals.handleModal2` → `linkSteamId`).
- **Ticket creation** (`ticketModals` → `linkSteamId`).

When DMed (with no open ticket/prospect), the bot replies with a welcome menu containing only
**Create Ticket**, **Join RB**, and **Server Info** (`messageCreate.js` `handleDM`). There is no
"Link Steam" button.

Worse, the gating features tell users to link via the **verification panel** — but the verify panel
is only a math captcha that grants a role; it does **not** collect a Steam ID. So the instruction is
a dead end.

This feature adds a dedicated, self-serve "Link Steam" action in DMs and fixes the misleading error
messages.

## Goal

Let any user link their Steam ID by DMing the bot and clicking a button, with a confirmation step,
format validation only, and safeguards against hijacking another account's Steam identity.

## Non-goals

- No live Steam Web API lookup / persona-name display (format validation only).
- No new DB tables or columns; reuse the existing website `User` table.
- No webpage UI.
- No change to the prospect/ticket linking flows (they keep working as-is).
- No re-link / overwrite UI: linked users simply don't see the button.

## Decisions (from brainstorming)

| Question | Decision |
|----------|----------|
| Entry point | DM welcome menu only |
| Modal shape | One modal: Steam ID text field + Yes/No **radio** ("Is this your Steam account?") |
| Validation depth | Format only (`validateSteamInput`) |
| Already-linked users | Don't show them the button in DMs |
| Duplicate Steam ID on another Discord account | Refuse (recommended safeguard, accepted) |

## Entry point — conditional DM button

In `messageCreate.js` `handleDM`, on the welcome-menu fallback path (after the ticket/prospect
checks), look up the caller's current link:

```js
const linkedSteamId = await getStoredSteamId(message.author.id); // website pool, try/catch → null
```

If `linkedSteamId` is falsy, append a button to the menu's action row:

- `customId: link_steam`, label **"Link Steam"**, style Secondary.

If the user is already linked, the button is omitted. Cost: one extra website-pool query on the
(low-frequency) unmatched-DM path; `getStoredSteamId` already swallows errors and returns `null`.

## The modal

Clicking **Link Steam** opens a Components-V2 modal built with `utils/modalComponents.js` (the same
helpers the prospect form uses), shown via `interaction.showModal(...)`:

- `customId: link_steam_modal`, title **"Link your Steam account"**
- **Text input** `steam_id` — short, required, placeholder
  `76561198012345678 or steamcommunity.com/profiles/...`
- **Radio group** `is_mine` — required, label **"Is this your Steam account?"**, options
  **Yes** (`value: "Yes"`) / **No** (`value: "No"`)

## Submit flow (`link_steam_modal`)

1. `interaction.deferReply({ flags: ['Ephemeral'] })`.
2. Read fields:
   - `isMine = interaction.fields.getField('is_mine').value`
   - `steamInput = interaction.fields.getTextInputValue('steam_id').trim()`
3. `validation = validateSteamInput(steamInput)` (pure, format only).
4. If validation passed, fetch the two data points the decision needs:
   - `currentLink = await getStoredSteamId(userId)`
   - `steamIdOwner = await getDiscordIdBySteamId(validation.steamId)`
   (Handler may short-circuit and skip these fetches when `isMine !== 'Yes'` or validation failed.)
5. `decision = evaluateLinkSubmission({ isMine, validation, currentLink, steamIdOwner, userId })`.
6. If `!decision.ok` → reply `errorEmbed(decision.error)`. Else → `linkSteamId(userId,
   decision.steamId, interaction.user.username)` and reply `successEmbed(...)`.

### Pure decision function

`evaluateLinkSubmission({ isMine, validation, currentLink, steamIdOwner, userId })` →
`{ ok, steamId?, error? }`. No async, no Discord deps — unit-testable. Lives in
`src/services/steamLink.js`.

Branch order:

1. `isMine !== 'Yes'` → `{ ok: false, error: 'Please confirm the Steam ID is yours (select **Yes**) and try again.' }`
2. `!validation.valid` → `{ ok: false, error: validation.reason }`
3. `currentLink && currentLink === validation.steamId` → `{ ok: false, error: 'You're already linked to that Steam ID.' }`
4. `currentLink && currentLink !== validation.steamId` → `{ ok: false, error: 'Your Discord is already linked to Steam ID \`<currentLink>\`. Open a ticket if you need to change it.' }` (race-safe; button is normally hidden for linked users)
5. `steamIdOwner && steamIdOwner !== userId` → `{ ok: false, error: 'That Steam ID is already linked to another Discord account. Open a ticket if that's a mistake.' }`
6. else → `{ ok: true, steamId: validation.steamId }`

Success reply: `successEmbed('Linked! Your Steam ID \`<steamId>\` is now connected. You can now enter the giveaway and earn seed rewards.')`.

## Error-message updates (verify panel → DM the bot)

| File:line | Old | New |
|-----------|-----|-----|
| `giveawayButtons.js:32` | "You need to link your Steam account first using the verify panel." | "You need to link your Steam account first. **DM me and click Link Steam**, then try again." |
| `seedTrackerButtons.js:16` | "No Steam ID linked. Please verify your account first." | "No Steam ID linked. **DM me and click Link Steam** to connect your account." |

`aiService.js:131` ("No Steam ID linked to this user...") is an internal AI-context string, **not**
changed.

## Routing

In `src/events/interactionCreate.js`:

- `import * as steamLinkButtons from '../handlers/steamLinkButtons.js';`
- Add to the exact-match `buttonHandlers` map: `link_steam: steamLinkButtons.handleLinkStart`
- Add to the exact-match `modalHandlers` map: `link_steam_modal: steamLinkButtons.handleLinkSubmit`

No prefix matching needed (custom IDs carry no arguments).

## Files touched

| File | Change |
|------|--------|
| `src/handlers/steamLinkButtons.js` | **New.** `handleLinkStart` (render modal), `handleLinkSubmit` (process submit). |
| `src/services/steamLink.js` | **New.** Pure `evaluateLinkSubmission(...)`. |
| `src/events/interactionCreate.js` | Register button + modal handlers. |
| `src/events/messageCreate.js` | Conditionally add the Link Steam button to the DM welcome menu. |
| `src/handlers/giveawayButtons.js` | Update error message. |
| `src/handlers/seedTrackerButtons.js` | Update error message. |
| `tests/unit/steamLink/evaluateLinkSubmission.test.js` | **New.** |
| `package.json` | Version bump (minor — new feature). |

## Testing

Unit tests for `evaluateLinkSubmission` covering each branch:

- confirm = "No" → rejected (confirm error)
- invalid format → rejected (passes through `validation.reason`)
- already linked to the same ID → rejected (idempotent message)
- already linked to a different ID → rejected (change-via-ticket message)
- Steam ID owned by another Discord user → rejected (duplicate message)
- happy path (confirm Yes, valid, unlinked, unowned) → `{ ok: true, steamId }`

Discord I/O in the handlers is thin orchestration and is not unit-tested (matches the codebase's
pattern of testing pure logic only — cf. `giveawayMath`, `giveawayDraw`).

Manual check after deploy: DM the bot as an unlinked user → button appears → modal → link → button
disappears on next DM; verify giveaway/seed errors now say "DM me and click Link Steam".

## Edge cases & notes

- **`linkSteamId` is first-write-wins** (`ON DUPLICATE KEY UPDATE steamId = IF(steamId IS NULL,
  VALUES(steamId), steamId)`). Combined with hiding the button for linked users, overwrite is a
  non-path; the race-safe branches in `evaluateLinkSubmission` cover the rare concurrent case.
- **Cooldown:** button interactions already pass through the 2s per-user cooldown in
  `interactionCreate.js`; no extra rate-limiting needed.
- **"Q" test shorthand:** `validateSteamInput` accepts `"Q"` in non-production; `linkSteamId`
  already no-ops on `"Q"`. Harmless; left as-is for parity with other flows.
