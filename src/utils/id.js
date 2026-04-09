import crypto from 'node:crypto';

export function generateId() {
  return 'c' + crypto.randomBytes(12).toString('hex');
}
