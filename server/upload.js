// Images attached in the chat box are stored on this machine and handed to the agent as a file path
// (the agent runs here too). Only real images are accepted: the type comes from the bytes, not the header.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const UPLOAD_MAX = 10 * 1024 * 1024;
const KEEP_MS = 24 * 3600 * 1000;
export const uploadDir = () => process.env.OFFICE_UPLOAD_DIR
  || path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'herdr-office', 'uploads');

export function imageExt(b) {
  if (b.length > 12 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length > 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1'))) return 'gif';
  if (b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

// Returns the saved file's path, or null when the bytes are not a supported image.
export function storeImage(body) {
  const ext = imageExt(body);
  if (!ext) return null;
  const dir = uploadDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const f of fs.readdirSync(dir)) { // uploads are scratch files: drop the old ones
    try { const fp = path.join(dir, f); if (Date.now() - fs.statSync(fp).mtimeMs > KEEP_MS) fs.unlinkSync(fp); } catch { /* raced */ }
  }
  const file = path.join(dir, `img-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}.${ext}`);
  fs.writeFileSync(file, body, { mode: 0o600 });
  return file;
}

const TYPES = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
export const UPLOAD_NAME = /^img-[a-z0-9]+-[0-9a-f]{8}\.(png|jpg|gif|webp)$/;
// Reads a stored upload back (for the chat thumbnails). The name is matched strictly, so no path can escape the folder.
export function readUpload(name) {
  const m = UPLOAD_NAME.exec(name);
  if (!m) return null;
  try { return { type: TYPES[m[1]], data: fs.readFileSync(path.join(uploadDir(), name)) }; } catch { return null; }
}
