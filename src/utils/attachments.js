import sharp from 'sharp'

const MAX_IMAGE_DIMENSION = 1024
const IMAGE_FETCH_TIMEOUT = 8000

/**
 * Max bytes for re-uploading a non-image attachment into the relay channel.
 * Larger files (especially videos) often exceed Discord REST's ~15s timeout
 * and abort mid-upload — staff still get the CDN link in the embed field.
 */
export const MAX_RELAY_REUPLOAD_BYTES = 8 * 1024 * 1024;

/**
 * Fetch image attachments, resize, and return as base64-encoded PNG.
 * Failed fetches are silently skipped (Promise.allSettled).
 */
export async function fetchImagesAsBase64(attachments, maxImages = 10) {
  if (!attachments || !Array.isArray(attachments) || attachments.length === 0) return []

  const imageAttachments = attachments
    .filter((a) => a.contentType?.startsWith('image/'))
    .slice(0, maxImages)

  if (imageAttachments.length === 0) return []

  const results = await Promise.allSettled(
    imageAttachments.map(async (att) => {
      const res = await fetch(att.url, {
        signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      const buffer = Buffer.from(await res.arrayBuffer())
      const resized = await sharp(buffer)
        .resize(MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .png()
        .toBuffer()

      return {
        media_type: 'image/png',
        data: resized.toString('base64'),
      }
    })
  )

  return results.filter((r) => r.status === 'fulfilled').map((r) => r.value)
}

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
 * Whether a non-image attachment is small enough to attempt re-upload.
 * Unknown size is treated as eligible; trySendWithFiles falls back on failure.
 */
export function canReuploadAttachment(attachment) {
  if (attachment == null) return false;
  const size = attachment.size;
  if (typeof size === 'number' && size > MAX_RELAY_REUPLOAD_BYTES) return false;
  return Boolean(attachment.url);
}

/**
 * Enrich an embed and sendOptions with attachment data from a Discord message.
 * Images are embedded by URL (no re-upload). Non-image files are re-uploaded
 * only when under MAX_RELAY_REUPLOAD_BYTES; larger ones stay as embed links only.
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
  const reuploadable = nonImageFiles.filter((a) => canReuploadAttachment(a));
  if (reuploadable.size > 0) {
    sendOptions.files = reuploadable.map((a) => ({ attachment: a.url, name: a.name }));
  }
}
