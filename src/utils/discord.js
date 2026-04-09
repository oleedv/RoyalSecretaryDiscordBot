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
 * Try to send a message with file attachments. If the payload is too large
 * (Discord error 40005), retry without files.
 */
export async function trySendWithFiles(target, options) {
  try {
    const msg = await target.send(options);
    return { msg, tooLarge: false };
  } catch (err) {
    if (err.code === 40005) {
      const { files, ...rest } = options;
      const msg = await target.send(rest);
      return { msg, tooLarge: true };
    }
    throw err;
  }
}
