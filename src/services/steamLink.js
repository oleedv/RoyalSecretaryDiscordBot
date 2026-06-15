/**
 * Pure decision logic for the DM "Link Steam" flow.
 *
 * Given the user's confirmation, the result of `validateSteamInput`, and the two
 * relevant pieces of state (the user's current link + who else owns the Steam ID),
 * decide whether to link. No async, no Discord deps — fully unit-testable.
 *
 * @param {object}  args
 * @param {string}  args.isMine        Value of the "Is this your Steam account?" radio ('Yes'/'No').
 * @param {object}  args.validation    Result of `validateSteamInput` ({ valid, steamId, reason }).
 * @param {?string} args.currentLink   The user's currently stored Steam ID, or null.
 * @param {?string} args.steamIdOwner  Discord ID that already owns this Steam ID, or null.
 * @param {string}  args.userId        The acting user's Discord ID.
 * @returns {{ ok: true, steamId: string } | { ok: false, error: string }}
 */
export function evaluateLinkSubmission({ isMine, validation, currentLink, steamIdOwner, userId }) {
  if (isMine !== 'Yes') {
    return { ok: false, error: 'Please confirm the Steam ID is yours (select **Yes**) and try again.' };
  }

  if (!validation?.valid) {
    return { ok: false, error: validation?.reason || 'Invalid Steam ID.' };
  }

  const steamId = validation.steamId;

  if (currentLink && currentLink === steamId) {
    return { ok: false, error: 'You are already linked to that Steam ID.' };
  }

  if (currentLink && currentLink !== steamId) {
    return {
      ok: false,
      error: `Your Discord is already linked to Steam ID \`${currentLink}\`. Open a ticket if you need to change it.`,
    };
  }

  if (steamIdOwner && steamIdOwner !== userId) {
    return {
      ok: false,
      error: "That Steam ID is already linked to another Discord account. Open a ticket if that's a mistake.",
    };
  }

  return { ok: true, steamId };
}
