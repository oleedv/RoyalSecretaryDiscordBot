# Prospect transcript link in staff embed

## Goal

Surface a link to each prospect's website transcript page (`<webBaseUrl>/prospect/<uuid>`) inside the staff-facing prospect info embed in Discord, so mentors and voters can jump from the Discord ticket to the existing web transcript.

## Scope

In scope:

- Add a `Transcript` field to `buildProspectInfoEmbed` in `src/services/prospect/prospectEmbeds.js`.
- Add an owner-only slash command `/refresh-prospect-embeds` that re-renders the top embed of every active prospect's channel so existing tickets get the new link without waiting for a state change.

Out of scope:

- The website's `/prospect/<uuid>` page itself (already exists).
- Other prospect embeds: `buildForumIntroEmbed`, `buildVoteAnnouncementEmbed`, `buildAcceptedAnnouncementEmbed`, `buildVoteEmbed`. The user explicitly wants the link on the ticket embed only.
- Any schema change.

## Design

### Embed change

In `buildProspectInfoEmbed`, add a field rendered only when `config.webBaseUrl` is set. Place it adjacent to the existing `Forum Thread` field so the two ticket-level links sit together.

```js
if (config.webBaseUrl) {
  const host = new URL(config.webBaseUrl).host;
  const shortUuid = prospect.uuid.slice(0, 6);
  embed.addFields({
    name: 'Transcript',
    value: `[${host}/prospect/${shortUuid}](${config.webBaseUrl}/prospect/${prospect.uuid})`,
    inline: true,
  });
}
```

Rationale for the format: mirrors the existing convention in `src/handlers/ticketMessages.js:149-152` — visible text shows `host/prospect/<short>`, the full UUID lives inside the Markdown link target.

No call-site changes are needed: all five callers in `prospectService.js` (lines 527, 564, 625, 717, 1049) already pass the full `prospect` record, which includes `uuid` (column listed in `PROSPECT_COLUMNS`).

### Backfill command

New file: `src/commands/refresh-prospect-embeds.js`.

Behavior:

- Owner-only (same `OWNER_ID` guard pattern as `refresh-panels.js`).
- Slash command `/refresh-prospect-embeds`, default member permission `Administrator`.
- Defers an ephemeral reply, then iterates active prospects.
- Selection: `status = 'open' AND channel_id IS NOT NULL` (the same filter used elsewhere in `prospectService.js` to mean "live ticket"; `accepted`, `denied`, and `closed` are terminal).
- For each prospect:
  1. Fetch the staff channel by `prospect.channel_id`. Skip silently on miss.
  2. Re-fetch the prospect row plus `member` and `bmPlayerId` exactly the way `claimProspect` does (`prospectService.js:561-563`), so the rebuilt embed matches what the live code paths produce.
  3. Find the top message via `findBotMessageByCustomId(channel, client.user.id, ['prospect_claim', 'prospect_accept', 'prospect_deny'])` — same lookup `claimProspect` uses.
  4. `topMsg.edit({ embeds: [infoEmbed], components })`. Reuse `buildProspectComponents(prospect)` so we never drop buttons.
  5. Call `appendAllStatsToMessage(topMsg, …)` to keep the inline stats block consistent with other edit paths.
- Track per-prospect outcome: `refreshed`, `skipped:no-channel`, `skipped:no-top-message`, `error`. Join into an ephemeral summary like `refresh-panels`.
- Wrap the loop in try/catch so one bad prospect doesn't abort the rest.

Idempotency: editing with identical content is a no-op on Discord's side, so re-running the command is safe.

### Why these boundaries

- The embed builder stays a pure function of `(member, prospect, forumUrl, bmPlayerId)`; the link uses `config.webBaseUrl` which the module already imports.
- The backfill command does not introduce a new service — it composes existing helpers (`findBotMessageByCustomId`, `buildProspectInfoEmbed`, `buildProspectComponents`, `appendAllStatsToMessage`, `bm.resolvePlayerId`). If those helpers ever move, this command moves with them.

## Testing

Manual:

- Run the bot locally against the staging guild. Open a new prospect application; verify the staff embed shows the `Transcript` field linking to `stg.royalbattalion.xyz/prospect/<uuid>`.
- Pick one existing in-flight prospect in staging, run `/refresh-prospect-embeds`, confirm the top embed now has the field and buttons still work (claim/accept/deny).
- Re-run `/refresh-prospect-embeds` immediately; confirm summary reports `refreshed` for the same prospects and Discord shows no visible change.
- Unset `webBaseUrl` in a local config and verify the field is omitted (no crash).

## Risks

- **Rate limits during backfill**: if there are many active prospects, the loop hits Discord's edit-message endpoint repeatedly. discord.js handles the bucket internally; no extra throttling needed unless the active count exceeds ~30. Note for the implementation plan: log progress every N prospects.
- **Top-message lookup miss**: if a prospect channel's top message was manually deleted, the command reports `skipped:no-top-message` rather than silently failing. The next genuine state change won't fix it either — that's a pre-existing issue, not regression.
