/**
 * Serialize attachments for DB storage.
 */
export function formatForDb(attachments) {
  return attachments.map((a) => ({ url: a.url, name: a.name, contentType: a.contentType }));
}

/**
 * Get the URL of the first image attachment, if any.
 */
export function extractFirstImage(attachments) {
  const images = attachments.filter((a) => a.contentType?.startsWith('image/'));
  return images.first?.() || images[0] || null;
}

/**
 * Build a markdown list of attachment links.
 */
export function buildFileList(attachments) {
  return attachments.map((a) => `[${a.name}](${a.url})`).join('\n');
}

/**
 * Enrich an embed and sendOptions with attachment data from a Discord message.
 */
export function applyAttachments(embed, sendOptions, messageAttachments) {
  if (messageAttachments.size === 0) return;

  const firstImage = messageAttachments.find((a) => a.contentType?.startsWith('image/'));
  if (firstImage) {
    embed.setImage(firstImage.url);
  }

  const fileList = messageAttachments.map((a) => `[${a.name}](${a.url})`).join('\n');
  embed.addFields({ name: 'Attachments', value: fileList });

  const nonImageFiles = messageAttachments.filter((a) => !a.contentType?.startsWith('image/'));
  if (nonImageFiles.size > 0) {
    sendOptions.files = nonImageFiles.map((a) => ({ attachment: a.url, name: a.name }));
  }
}
