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

// Lets the chat show an image the user pasted as a path (a screenshot in ~/Pictures, a file in /tmp, ...).
// This reads a file off the disk on a browser's say-so, so it is deliberately narrow: an absolute path (or ~/...)
// that resolves under the home folder or the temp folder, no dot-folders (.ssh, .config, ...) except our own upload
// folder, and the bytes must really be a png/jpeg/gif/webp. Anything else is "not found", never an error message.
const IMG_EXT = /\.(png|jpe?g|gif|webp)$/i;
export function readImageFile(raw) {
  try {
    let p = String(raw || '');
    if (p.length > 1024 || p.includes('\0')) return null;
    if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
    if (!path.isAbsolute(p) || !IMG_EXT.test(p)) return null;
    const real = fs.realpathSync(p);
    const within = (root) => { const r = path.relative(fs.realpathSync(root), real); return r !== '' && !r.startsWith('..') && !path.isAbsolute(r) ? r : null; };
    const mine = within(uploadDir());
    const rel = mine !== null ? mine : (within(os.homedir()) ?? within(os.tmpdir()));
    if (rel === null) return null;
    if (mine === null && rel.split(path.sep).some((seg) => seg.startsWith('.'))) return null;
    const st = fs.statSync(real);
    if (!st.isFile() || st.size > UPLOAD_MAX) return null;
    const data = fs.readFileSync(real);
    const ext = imageExt(data);
    return ext ? { type: TYPES[ext], data } : null;
  } catch { return null; }
}
