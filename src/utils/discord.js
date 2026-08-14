/**
 * Shared Discord helpers - getUserTag, sendDM, ensurePartialFetched, trySendWithFiles.
 */

/**
 * Get a display tag for a guild member or fall back to userId.
 */
export function getUserTag(member, fallbackId) {
  return member?.user.tag || fallbackId;
}

/**
 * Send a DM to a user by ID. Returns null on failure.
 */
export async function sendDM(client, userId, content) {
  const user = await client.users.fetch(userId).catch(() => null);
  if (!user) return null;
  return user.send(content).catch(() => null);
}

/**
 * Ensure a potentially partial reaction/message is fully fetched.
 * Returns false if the fetch fails (caller should bail).
 */
export async function ensurePartialFetched(partial) {
  if (!partial.partial) return true;
  try {
    await partial.fetch();
    return true;
  } catch {
    return false;
  }
}

/**
 * Errors that mean the file re-upload failed but the text/embed may still send.
 * Common when relaying videos: Discord REST aborts after ~15s (AbortError), or
 * the payload exceeds Discord's upload limit (40005).
 */
export function isFileSendFailure(err) {
  if (!err) return false;
  if (err.code === 40005) return true; // Request entity too large
  if (err.name === 'AbortError') return true;
  if (err.code === 'ABORT_ERR') return true; // Node undici / DOMException
  const msg = String(err.message || '');
  if (/operation was aborted|aborted due to timeout|UND_ERR_ABORTED/i.test(msg)) return true;
  return false;
}

/**
 * Try to send a message with file attachments. If re-upload fails (too large,
 * REST timeout/AbortError, etc.), retry without files so the embed + CDN links
 * still reach staff/users.
 */
export async function trySendWithFiles(target, options) {
  try {
    const msg = await target.send(options);
    return { msg, tooLarge: false };
  } catch (err) {
    if (!options.files?.length || !isFileSendFailure(err)) throw err;
    const { files, ...rest } = options;
    const msg = await target.send(rest);
    return { msg, tooLarge: true };
  }
}
