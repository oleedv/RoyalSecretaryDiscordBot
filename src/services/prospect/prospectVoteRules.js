export function shouldSkipVoteStart(playtimeHours, voteStartHours) {
  return typeof playtimeHours === 'number' && playtimeHours < voteStartHours;
}

export function shouldShowHoursWarning(playtimeHours, voteAcceptHours) {
  return typeof playtimeHours === 'number' && playtimeHours < voteAcceptHours;
}

export function hoursWarningValue(voteAcceptHours) {
  return (
    `This prospect has not completed the required ${voteAcceptHours} hours in-game. ` +
    `The vote will still run, but they cannot be accepted until they reach ${voteAcceptHours} hours.`
  );
}

export function formatOffDiscordCount(n) {
  const count = Number(n) || 0;
  return `${count} ${count === 1 ? 'time' : 'times'}`;
}

export function evaluateVoteOutcome({
  yes,
  no,
  playtimeHours,
  isTestSteamId,
  minYesVotes = 10,
  minYesRate = 0.8,
  voteAcceptHours = 16,
}) {
  const totalVotes = yes + no;
  const yesRate = totalVotes > 0 ? yes / totalVotes : 0;
  const votesOk = yes >= minYesVotes && yesRate >= minYesRate;
  const playtimeMissing = playtimeHours == null;
  const hoursUnverified = !isTestSteamId && playtimeMissing;
  const hoursOk = Boolean(isTestSteamId) || playtimeMissing || playtimeHours >= voteAcceptHours;
  const outcome = votesOk && hoursOk ? 'accepted' : 'denied';

  let denyReason = null;
  if (outcome === 'denied') {
    if (!votesOk && !hoursOk) {
      denyReason = `The membership vote did not pass, and the ${voteAcceptHours}-hour in-game requirement was not met.`;
    } else if (!hoursOk) {
      denyReason = `The ${voteAcceptHours}-hour in-game requirement was not met.`;
    } else {
      denyReason = 'The membership vote did not pass.';
    }
  }

  return { outcome, votesOk, hoursOk, hoursUnverified, denyReason };
}
