// Pure comms state machine for the comms-watch feature. All times are epoch ms.
// No I/O, no Date.now() — the caller injects `now` so the logic is fully testable.
//
// Debounced model: a person's on/off-voice observation must be stable for `graceMs`
// before it flips the debounced `commsOk` state. This absorbs brief blips in BOTH
// directions — a short voice drop does not start an off-comms episode, and a short
// voice join does not reset an ongoing one. `offCommsSince` anchors the episode start
// so the reported duration grows monotonically; it clears (and the alert re-arms) when
// the person gets back on comms or leaves the game.
//
// @param {object} prev  previous persisted state (may be {} on first sighting):
//   { observedInVoice, voiceChangedAt, commsOk, offCommsSince, inGameSince, alerted }
// @param {object} obs   { inGame: boolean, inVoice: boolean }
// @param {number} now   epoch ms
// @param {object} opts  { graceMs, thresholdMs }
// @returns next state (superset of `prev`, safe to feed back) plus derived
//   { isOffComms, offCommsMs, shouldAlert }.
export function evaluateComms(prev, obs, now, { graceMs, thresholdMs }) {
  // Not in game: full reset. Also re-arms the alert episode for next time.
  if (!obs.inGame) {
    return {
      observedInVoice: null, voiceChangedAt: null, commsOk: null,
      offCommsSince: null, inGameSince: null, alerted: false,
      isOffComms: false, offCommsMs: 0, shouldAlert: false,
    };
  }

  // Exempt (a prospect while the server is on a Seed layer): the off-comms rules don't apply
  // — being in-game without Discord voice is allowed while seeding. Soft-reset the episode and
  // the voice debounce every tick so that when the exemption lifts (server goes live), a fresh
  // grace + threshold window starts from that transition rather than counting the seed time.
  // inGameSince is preserved (they are still in the same session).
  if (obs.exempt) {
    return {
      observedInVoice: null, voiceChangedAt: null, commsOk: null,
      offCommsSince: null, inGameSince: prev.inGameSince ?? now, alerted: false,
      isOffComms: false, offCommsMs: 0, shouldAlert: false,
    };
  }

  const inGameSince = prev.inGameSince ?? now;

  // Voice-presence debounce: reset the stability clock whenever the observation changes
  // (or on the very first sighting, where prev.observedInVoice is null/undefined).
  let observedInVoice = prev.observedInVoice;
  let voiceChangedAt = prev.voiceChangedAt;
  if (observedInVoice === null || observedInVoice === undefined || observedInVoice !== obs.inVoice) {
    observedInVoice = obs.inVoice;
    voiceChangedAt = now;
  }
  const stableFor = now - voiceChangedAt;

  // commsOk only adopts the observed value once it has been stable for the grace window;
  // otherwise it holds its previous debounced value (null while still undecided).
  let commsOk = prev.commsOk ?? null;
  if (stableFor >= graceMs) commsOk = obs.inVoice;

  let offCommsSince = prev.offCommsSince ?? null;
  let alerted = prev.alerted ?? false;
  if (commsOk === true) {
    offCommsSince = null;
    alerted = false; // back on comms -> re-arm
  } else if (commsOk === false) {
    offCommsSince = offCommsSince ?? voiceChangedAt; // anchor episode start, then hold steady
  } else {
    offCommsSince = null; // undecided during the initial grace
  }

  const isOffComms = commsOk === false && offCommsSince != null;
  const offCommsMs = isOffComms ? now - offCommsSince : 0;
  const shouldAlert = isOffComms && offCommsMs >= thresholdMs && !alerted;
  if (shouldAlert) alerted = true;

  return { observedInVoice, voiceChangedAt, commsOk, offCommsSince, inGameSince, alerted, isOffComms, offCommsMs, shouldAlert };
}

// Prospect classification takes priority over member (a prospect is never "just a member").
export function classifyKind(steamId, { prospectSteamIds, memberSteamIds }) {
  if (!steamId) return null;
  if (prospectSteamIds.has(steamId)) return 'prospect';
  if (memberSteamIds.has(steamId)) return 'member';
  return null;
}

export function formatDuration(ms) {
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}
