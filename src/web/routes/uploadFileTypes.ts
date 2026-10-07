// Magic-byte detection for every user upload (SFX sounds, alert images/sounds, overlay videos).
// The client-supplied MIME type is unreliable, so each upload route validates the actual bytes
// with one of these before writing anything to disk.

/**
 * True if `buf` starts with a complete, well-formed 10-byte ID3v2 header:
 * the "ID3" tag, a version byte that isn't the reserved 0xFF, and a syncsafe
 * size (each of the 4 size bytes has its top bit clear). Checking the full
 * header — not just the 3-byte tag — avoids misidentifying truncated/junk
 * payloads as MP3.
 */
function isValidId3Header(buf: Buffer): boolean {
  if (buf.length < 10) return false;
  if (!buf.subarray(0, 3).equals(Buffer.from([0x49, 0x44, 0x33]))) return false;
  if (buf[3] === 0xff || buf[4] === 0xff) return false;
  // buf.length >= 10 is checked above, so bytes 6-9 exist.
  return (buf[6]! & 0x80) === 0 && (buf[7]! & 0x80) === 0 && (buf[8]! & 0x80) === 0 && (buf[9]! & 0x80) === 0;
}

const RIFF_MAGIC = Buffer.from([0x52, 0x49, 0x46, 0x46]); // "RIFF"
const WAVE_MAGIC = Buffer.from([0x57, 0x41, 0x56, 0x45]); // "WAVE"
const OGG_MAGIC = Buffer.from([0x4f, 0x67, 0x67, 0x53]); // "OggS"

/**
 * True if `buf` contains `bytes` starting at `offset` (false if `buf` is too short).
 * @param buf - The buffer to inspect.
 * @param bytes - The expected byte sequence.
 * @param offset - Byte offset in `buf` to compare at; defaults to 0.
 */
export function startsWithBytes(buf: Buffer, bytes: Buffer, offset = 0): boolean {
  return buf.length >= offset + bytes.length && buf.subarray(offset, offset + bytes.length).equals(bytes);
}

/**
 * True if `buf` starts with a valid MPEG audio frame header: 11-bit sync (0xFF then top 3 bits of
 * byte 1) followed by a valid version/layer/bitrate/sample-rate. Validates the full 4-byte header
 * and rejects the reserved bit combinations so junk like `FF E0 00 00` — which only matches the
 * sync — isn't mistaken for MP3.
 */
export function isValidMpegFrameHeader(buf: Buffer): boolean {
  if (buf.length < 4) return false;
  const byte0 = buf[0]!, byte1 = buf[1]!, byte2 = buf[2]!; // length >= 4 checked above
  if (byte0 !== 0xff || (byte1 & 0xe0) !== 0xe0) return false;
  const versionBits = (byte1 >> 3) & 0x03; // 0x01 = reserved MPEG version
  const layerBits = (byte1 >> 1) & 0x03; // 0x00 = reserved layer
  const bitrateBits = (byte2 >> 4) & 0x0f; // 0x0f = bad/invalid bitrate
  const sampleRateBits = (byte2 >> 2) & 0x03; // 0x03 = reserved sample rate
  return versionBits !== 0x01 && layerBits !== 0x00 && bitrateBits !== 0x0f && sampleRateBits !== 0x03;
}

/**
 * Detect an audio file's type from its magic bytes, independent of the
 * client-supplied MIME type. Supports the three accepted formats.
 * - WAV: `RIFF` at offset 0 and `WAVE` at offset 8
 * - OGG: `OggS` at offset 0
 * - MP3: a complete 10-byte ID3v2 header at offset 0, or a valid MPEG audio
 *   frame header (see {@link isValidMpegFrameHeader})
 */
export function detectAudioType(buf: Buffer): 'mp3' | 'ogg' | 'wav' | null {
  if (startsWithBytes(buf, RIFF_MAGIC) && startsWithBytes(buf, WAVE_MAGIC, 8)) return 'wav';
  if (startsWithBytes(buf, OGG_MAGIC)) return 'ogg';
  if (isValidId3Header(buf) || isValidMpegFrameHeader(buf)) return 'mp3';
  return null;
}

/**
 * Detect an image file's type from its magic bytes, independent of the client-supplied MIME
 * type. Deliberately excludes SVG (script/XSS risk if ever reflected back to a browser source).
 * - PNG: `\x89PNG\r\n\x1a\n` signature
 * - GIF: `GIF87a` or `GIF89a` signature
 * - JPEG: `\xFF\xD8\xFF` signature
 * - WEBP: `RIFF....WEBP` container
 */
export function detectImageType(buf: Buffer): 'png' | 'gif' | 'jpeg' | 'webp' | null {
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'png';
  }
  if (buf.subarray(0, 6).equals(Buffer.from('GIF87a', 'ascii')) || buf.subarray(0, 6).equals(Buffer.from('GIF89a', 'ascii'))) {
    return 'gif';
  }
  if (buf.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    return 'jpeg';
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).equals(Buffer.from('RIFF', 'ascii')) &&
    buf.subarray(8, 12).equals(Buffer.from('WEBP', 'ascii'))
  ) {
    return 'webp';
  }
  return null;
}

/**
 * Detect video type from buffer magic bytes, independent of the client-supplied MIME type.
 * WebM: EBML header 0x1A 0x45 0xDF 0xA3
 * MP4: ftyp box signature at bytes 4–7: 0x66 0x74 0x79 0x70
 */
export function detectVideoType(buf: Buffer): 'webm' | 'mp4' | null {
  if (buf.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    return 'webm';
  }
  if (buf.subarray(4, 8).equals(Buffer.from([0x66, 0x74, 0x79, 0x70]))) {
    return 'mp4';
  }
  return null;
}
