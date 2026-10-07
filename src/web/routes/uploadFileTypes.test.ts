import { describe, it, expect } from 'vitest';
import { detectAudioType, detectImageType, detectVideoType, startsWithBytes, isValidMpegFrameHeader } from './uploadFileTypes';

const PNG_BUF = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

describe('detectAudioType', () => {
  it('detects MP3 by a complete ID3v2 header', () => {
    expect(
      detectAudioType(Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])),
    ).toBe('mp3');
  });

  it('rejects a truncated ID3 tag that is too short to be a full header', () => {
    expect(detectAudioType(Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00]))).toBeNull();
  });

  it('rejects an ID3 tag with an invalid (0xFF) version byte', () => {
    expect(
      detectAudioType(Buffer.from([0x49, 0x44, 0x33, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])),
    ).toBeNull();
  });

  it('rejects an ID3 tag with a non-syncsafe size byte', () => {
    expect(
      detectAudioType(Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x80, 0x00, 0x00, 0x00])),
    ).toBeNull();
  });

  it('detects MP3 by a valid MPEG frame sync', () => {
    expect(detectAudioType(Buffer.from([0xff, 0xfb, 0x90, 0x00]))).toBe('mp3');
  });

  it('rejects a frame-sync false positive with a reserved layer (0xff 0xe0 0x00 0x00)', () => {
    // Only the 11-bit sync matches; the version/layer/bitrate/sample-rate bits are
    // all-zero (reserved), so this must not be accepted as MP3.
    expect(detectAudioType(Buffer.from([0xff, 0xe0, 0x00, 0x00]))).toBeNull();
  });

  it('rejects a frame-sync header that is too short to validate', () => {
    expect(detectAudioType(Buffer.from([0xff, 0xfb]))).toBeNull();
  });

  it('detects OGG by OggS signature', () => {
    expect(detectAudioType(Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00]))).toBe('ogg');
  });

  it('detects WAV by RIFF/WAVE signature', () => {
    expect(detectAudioType(Buffer.from([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45]))).toBe('wav');
  });

  it('returns null for a RIFF container that is not WAVE', () => {
    const riffAvi = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x41, 0x56, 0x49, 0x20]);
    expect(detectAudioType(riffAvi)).toBeNull();
  });

  it('returns null for unrecognised bytes', () => {
    expect(detectAudioType(Buffer.from('not audio at all'))).toBeNull();
  });

  it('returns null for a buffer that is too short', () => {
    expect(detectAudioType(Buffer.from([0x49]))).toBeNull();
  });
});

describe('startsWithBytes', () => {
  const magic = Buffer.from([0x01, 0x02]);

  it('matches at offset 0 by default', () => {
    expect(startsWithBytes(Buffer.from([0x01, 0x02, 0x03]), magic)).toBe(true);
  });

  it('matches at a given offset', () => {
    expect(startsWithBytes(Buffer.from([0x00, 0x01, 0x02]), magic, 1)).toBe(true);
  });

  it('returns false when the bytes differ', () => {
    expect(startsWithBytes(Buffer.from([0x01, 0x03]), magic)).toBe(false);
  });

  it('returns false when the buffer is too short for the offset + length', () => {
    expect(startsWithBytes(Buffer.from([0x00, 0x01]), magic, 1)).toBe(false);
  });
});

describe('isValidMpegFrameHeader', () => {
  it('accepts a well-formed MPEG-1 Layer III frame header', () => {
    expect(isValidMpegFrameHeader(Buffer.from([0xff, 0xfb, 0x90, 0x00]))).toBe(true);
  });

  it('rejects a buffer shorter than 4 bytes', () => {
    expect(isValidMpegFrameHeader(Buffer.from([0xff, 0xfb, 0x90]))).toBe(false);
  });

  it('rejects a missing frame sync', () => {
    expect(isValidMpegFrameHeader(Buffer.from([0xff, 0x1b, 0x90, 0x00]))).toBe(false);
  });

  it('rejects a sync-only header with reserved version/layer bits', () => {
    expect(isValidMpegFrameHeader(Buffer.from([0xff, 0xe0, 0x00, 0x00]))).toBe(false);
  });

  it('rejects the bad bitrate index', () => {
    expect(isValidMpegFrameHeader(Buffer.from([0xff, 0xfb, 0xf0, 0x00]))).toBe(false);
  });

  it('rejects the reserved sample-rate index', () => {
    expect(isValidMpegFrameHeader(Buffer.from([0xff, 0xfb, 0x9c, 0x00]))).toBe(false);
  });
});

describe('detectImageType', () => {
  it('detects PNG by signature', () => {
    expect(detectImageType(PNG_BUF)).toBe('png');
  });

  it('detects GIF87a and GIF89a by signature', () => {
    expect(detectImageType(Buffer.from('GIF87a', 'ascii'))).toBe('gif');
    expect(detectImageType(Buffer.from('GIF89a', 'ascii'))).toBe('gif');
  });

  it('detects JPEG by signature', () => {
    expect(detectImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
  });

  it('detects WEBP by RIFF/WEBP container', () => {
    const buf = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP', 'ascii')]);
    expect(detectImageType(buf)).toBe('webp');
  });

  it('returns null for unrecognised bytes', () => {
    expect(detectImageType(Buffer.from('not an image'))).toBeNull();
  });

  it('returns null for SVG (deliberately not in the allowlist)', () => {
    expect(detectImageType(Buffer.from('<svg></svg>'))).toBeNull();
  });
});

describe('detectVideoType', () => {
  it('detects WebM by EBML magic bytes', () => {
    expect(detectVideoType(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00]))).toBe('webm');
  });

  it('detects MP4 by ftyp box at bytes 4–7', () => {
    expect(detectVideoType(Buffer.from([0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70]))).toBe('mp4');
  });

  it('returns null for unrecognised bytes', () => {
    expect(detectVideoType(Buffer.from('not a video'))).toBeNull();
  });

  it('returns null for a buffer that is too short', () => {
    expect(detectVideoType(Buffer.from([0x1a, 0x45]))).toBeNull();
  });
});
