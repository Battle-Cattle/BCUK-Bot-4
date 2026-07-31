import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { mockLogger } from '../../test-utils/loggerMock';
import type { SfxFile } from '../../db';

const mockCreate = vi.fn();

vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));
vi.mock('../../shared/config', () => ({ OPENAI_API_KEY: 'test-key', SFX_FOLDER: '/app/sfx' }));
vi.mock('../csrf', () => ({ csrfProtection: (_req: any, _res: any, next: any) => next() }));
vi.mock('../middleware', () => ({ requireOwnerJson: (_req: any, _res: any, next: any) => next() }));
vi.mock('../../db', () => ({ findSoundFiles: vi.fn() }));
vi.mock('fs', () => ({
  default: {
    promises: {
      readFile: vi.fn(),
    },
  },
}));
vi.mock('child_process', () => ({ spawn: vi.fn() }));
vi.mock('ffmpeg-static', () => ({ default: '/usr/bin/ffmpeg' }));
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(function OpenAI() {
    return { chat: { completions: { create: mockCreate } } };
  }),
}));

import supertest from 'supertest';
import { spawn } from 'child_process';
import fs from 'fs';
import { findSoundFiles } from '../../db';
import { buildTestApp } from '../../test-utils/expressTestApp';
import router, { sampleFilesForSuggestion, transcodeToMp3, requestDescriptionSuggestion } from './sfxSuggestDescription';

/** Builds a minimal SfxFile fixture. */
function makeFile(id: number, weight: number, file = `sound-${id}.mp3`, hidden = false): SfxFile {
  return { id, trigger_id: 1n, file, trigger_command: null, weight, hidden, category_id: null };
}

/** Fake ChildProcess-like EventEmitter for mocking `spawn` in transcodeToMp3 tests. */
function makeFakeProcess() {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  const stdin = new EventEmitter() as any;
  stdin.write = vi.fn();
  stdin.end = vi.fn();
  proc.stdin = stdin;
  proc.kill = vi.fn();
  return proc;
}

function buildApp() {
  return buildTestApp({ router, bodyParser: 'json' });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── sampleFilesForSuggestion ───────────────────────────────────────────────────

describe('sampleFilesForSuggestion', () => {
  it('returns all files sorted by weight when count is within maxSample', () => {
    const files = [makeFile(1, 3), makeFile(2, 1), makeFile(3, 2)];
    expect(sampleFilesForSuggestion(files, 5).map((f) => f.id)).toEqual([2, 3, 1]);
  });

  it('breaks weight ties by id', () => {
    const files = [makeFile(2, 1), makeFile(1, 1)];
    expect(sampleFilesForSuggestion(files, 5).map((f) => f.id)).toEqual([1, 2]);
  });

  it('always includes the rarest and most common file when sub-sampling', () => {
    const files = Array.from({ length: 10 }, (_, i) => makeFile(i + 1, i + 1));
    const sample = sampleFilesForSuggestion(files, 5);
    const weights = sample.map((f) => f.weight);
    expect(weights[0]).toBe(1);
    expect(weights[weights.length - 1]).toBe(10);
    expect(sample).toHaveLength(5);
  });

  it('spaces the remaining picks evenly across the weight-sorted list', () => {
    const files = Array.from({ length: 10 }, (_, i) => makeFile(i + 1, i + 1));
    // Sorted weights are 1..10 (indices 0..9). Endpoints {0,9} plus 3 evenly spaced
    // inner picks at indices {2,5,7} → weights {1,3,6,8,10}.
    expect(sampleFilesForSuggestion(files, 5).map((f) => f.weight)).toEqual([1, 3, 6, 8, 10]);
  });

  it('respects a smaller maxSample', () => {
    const files = Array.from({ length: 10 }, (_, i) => makeFile(i + 1, i + 1));
    // Endpoints {0,9} plus 1 inner pick at index round(9/2)=5 → weights {1,6,10}.
    expect(sampleFilesForSuggestion(files, 3).map((f) => f.weight)).toEqual([1, 6, 10]);
  });

  it('still returns both endpoints even when maxSample is below 2', () => {
    const files = [makeFile(1, 1), makeFile(2, 2), makeFile(3, 3)];
    expect(sampleFilesForSuggestion(files, 1).map((f) => f.weight)).toEqual([1, 3]);
  });

  it('includes hidden files — hidden only affects the public listing, not playback', () => {
    const files = [makeFile(1, 1, 'a.mp3', true)];
    expect(sampleFilesForSuggestion(files, 5)).toHaveLength(1);
  });

  it('handles a single file', () => {
    const files = [makeFile(1, 1)];
    expect(sampleFilesForSuggestion(files, 5).map((f) => f.id)).toEqual([1]);
  });
});

// ── transcodeToMp3 ──────────────────────────────────────────────────────────────

describe('transcodeToMp3', () => {
  it('resolves with the concatenated stdout on a clean exit', async () => {
    const proc = makeFakeProcess();
    vi.mocked(spawn).mockReturnValue(proc);
    const promise = transcodeToMp3(Buffer.from('input'));
    proc.stdout.emit('data', Buffer.from('mp3-'));
    proc.stdout.emit('data', Buffer.from('bytes'));
    proc.emit('close', 0);
    await expect(promise).resolves.toEqual(Buffer.from('mp3-bytes'));
  });

  it('rejects with stderr context on a non-zero exit code', async () => {
    const proc = makeFakeProcess();
    vi.mocked(spawn).mockReturnValue(proc);
    const promise = transcodeToMp3(Buffer.from('input'));
    proc.stderr.emit('data', Buffer.from('bad input'));
    proc.emit('close', 1);
    await expect(promise).rejects.toThrow(/ffmpeg exited with code 1.*bad input/s);
  });

  it('rejects when the spawned process errors', async () => {
    const proc = makeFakeProcess();
    vi.mocked(spawn).mockReturnValue(proc);
    const promise = transcodeToMp3(Buffer.from('input'));
    proc.emit('error', new Error('spawn failed'));
    await expect(promise).rejects.toThrow('spawn failed');
  });

  it('does not crash on an EPIPE from stdin when ffmpeg exits early', async () => {
    const proc = makeFakeProcess();
    vi.mocked(spawn).mockReturnValue(proc);
    const promise = transcodeToMp3(Buffer.from('input'));
    // Simulate ffmpeg exiting before consuming all of stdin: emitting 'error' on
    // the stdin stream must not throw an unhandled error and crash the process.
    expect(() => proc.stdin.emit('error', new Error('EPIPE'))).not.toThrow();
    proc.emit('close', 1);
    await expect(promise).rejects.toThrow(/ffmpeg exited with code 1/);
  });

  it('kills the process and rejects if it does not close within the timeout', async () => {
    vi.useFakeTimers();
    try {
      const proc = makeFakeProcess();
      vi.mocked(spawn).mockReturnValue(proc);
      const promise = transcodeToMp3(Buffer.from('input'));
      const assertion = expect(promise).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
      expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── requestDescriptionSuggestion ─────────────────────────────────────────────────

describe('requestDescriptionSuggestion', () => {
  it('sends one input_audio block per clip and returns the trimmed description', async () => {
    mockCreate.mockResolvedValue({ choices: [{ message: { content: '  A loud air horn blast.  ' } }] });
    const clips = [{ buffer: Buffer.from('a'), format: 'mp3' as const }, { buffer: Buffer.from('b'), format: 'wav' as const }];

    const result = await requestDescriptionSuggestion(clips, '!airhorn', 2);

    expect(result).toBe('A loud air horn blast.');
    const call = mockCreate.mock.calls[0][0];
    expect(call.model).toBe('gpt-audio-mini');
    const content = call.messages[0].content;
    expect(content[0].type).toBe('text');
    expect(content.filter((c: any) => c.type === 'input_audio')).toHaveLength(2);
    expect(content[1].input_audio).toEqual({ data: Buffer.from('a').toString('base64'), format: 'mp3' });
  });

  it('mentions the sample size in the prompt when clips are a subset of the total files', async () => {
    mockCreate.mockResolvedValue({ choices: [{ message: { content: 'desc' } }] });
    await requestDescriptionSuggestion([{ buffer: Buffer.from('a'), format: 'mp3' }], '!meme', 8);
    expect(mockCreate.mock.calls[0][0].messages[0].content[0].text).toMatch(/sample of 1 of them/);
  });

  it('omits sample language when all files were analysed', async () => {
    mockCreate.mockResolvedValue({ choices: [{ message: { content: 'desc' } }] });
    await requestDescriptionSuggestion([{ buffer: Buffer.from('a'), format: 'mp3' }], '!clap', 1);
    expect(mockCreate.mock.calls[0][0].messages[0].content[0].text).not.toMatch(/sample of/);
  });

  it('single-clip prompt asks for a verbatim quote gated on recognizability, with a no-speech fallback', async () => {
    mockCreate.mockResolvedValue({ choices: [{ message: { content: 'desc' } }] });
    await requestDescriptionSuggestion([{ buffer: Buffer.from('a'), format: 'mp3' }], '!clap', 1);
    const text = mockCreate.mock.calls[0][0].messages[0].content[0].text;
    expect(text).toMatch(/recognizable spoken words/);
    expect(text).toMatch(/transcribe them verbatim/);
    expect(text).toMatch(/Otherwise describe what's audible/);
  });

  it('sampled prompt asks for a verbatim quote gated on recognizability, with a general-theme fallback', async () => {
    mockCreate.mockResolvedValue({ choices: [{ message: { content: 'desc' } }] });
    await requestDescriptionSuggestion([{ buffer: Buffer.from('a'), format: 'mp3' }], '!meme', 8);
    const text = mockCreate.mock.calls[0][0].messages[0].content[0].text;
    expect(text).toMatch(/recognizable spoken words/);
    expect(text).toMatch(/include a representative quote verbatim/);
    expect(text).toMatch(/Otherwise describe the general theme or variety/);
  });

  it('truncates a description longer than the VARCHAR(255) column', async () => {
    mockCreate.mockResolvedValue({ choices: [{ message: { content: 'x'.repeat(300) } }] });
    const result = await requestDescriptionSuggestion([{ buffer: Buffer.from('a'), format: 'mp3' }], '!clap', 1);
    expect(result).toHaveLength(255);
  });

  it('throws when OpenAI returns no content', async () => {
    mockCreate.mockResolvedValue({ choices: [{ message: { content: null } }] });
    await expect(requestDescriptionSuggestion([{ buffer: Buffer.from('a'), format: 'mp3' }], '!clap', 1)).rejects.toThrow('empty description');
  });
});

// ── POST /sfx/trigger/suggest-description ────────────────────────────────────────

describe('POST /sfx/trigger/suggest-description', () => {
  beforeEach(() => {
    vi.mocked(fs.promises.readFile).mockResolvedValue(Buffer.from('audio-bytes'));
    mockCreate.mockResolvedValue({ choices: [{ message: { content: 'A cheerful clap.' } }] });
  });

  it('rejects a missing/invalid trigger id', async () => {
    const res = await supertest(buildApp()).post('/sfx/trigger/suggest-description').send({ trigger_id: 'not-a-number' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_id' });
    expect(vi.mocked(findSoundFiles)).not.toHaveBeenCalled();
  });

  it('returns 404 when the trigger has no sound files', async () => {
    vi.mocked(findSoundFiles).mockResolvedValue([]);
    const res = await supertest(buildApp()).post('/sfx/trigger/suggest-description').send({ trigger_id: '5' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'no_file' });
  });

  it('returns 502 when loading the trigger files throws', async () => {
    vi.mocked(findSoundFiles).mockRejectedValue(new Error('db down'));
    const res = await supertest(buildApp()).post('/sfx/trigger/suggest-description').send({ trigger_id: '5' });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'suggestion_failed' });
  });

  it('returns 502 when the OpenAI call fails', async () => {
    vi.mocked(findSoundFiles).mockResolvedValue([makeFile(1, 1)]);
    mockCreate.mockRejectedValue(new Error('rate limited'));
    const res = await supertest(buildApp()).post('/sfx/trigger/suggest-description').send({ trigger_id: '5' });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'suggestion_failed' });
  });

  it('succeeds with a single file, passing the trigger command as context', async () => {
    vi.mocked(findSoundFiles).mockResolvedValue([makeFile(1, 1, 'clap.wav')]);
    const res = await supertest(buildApp())
      .post('/sfx/trigger/suggest-description')
      .send({ trigger_id: '5', trigger_command: '!clap' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ description: 'A cheerful clap.' });
    expect(fs.promises.readFile).toHaveBeenCalledWith('/app/sfx/clap.wav');
    expect(mockCreate.mock.calls[0][0].messages[0].content[0].text).toMatch(/!clap/);
  });

  it('samples down to MAX_SAMPLE files and transcodes ogg clips before sending', async () => {
    const files = [
      makeFile(1, 1, 'rare.ogg'),
      makeFile(2, 5, 'a.mp3'),
      makeFile(3, 10, 'common.wav'),
      makeFile(4, 15, 'b.mp3'),
      makeFile(5, 20, 'c.wav'),
      makeFile(6, 25, 'd.mp3'),
    ];
    vi.mocked(findSoundFiles).mockResolvedValue(files);

    const proc = makeFakeProcess();
    vi.mocked(spawn).mockReturnValue(proc);
    // Use .end() (not await) so the request is dispatched immediately — a supertest
    // Test object is otherwise inert until awaited/`.then()`d, and we need it sent
    // before we can wait for the transcode's ffmpeg mock to be invoked.
    const createPromise = new Promise<any>((resolve, reject) => {
      supertest(buildApp())
        .post('/sfx/trigger/suggest-description')
        .send({ trigger_id: '5' })
        .end((err, res) => (err ? reject(err) : resolve(res)));
    });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    proc.stdout.emit('data', Buffer.from('transcoded'));
    proc.emit('close', 0);

    const res = await createPromise;
    expect(res.status).toBe(200);
    const content = mockCreate.mock.calls[0][0].messages[0].content;
    expect(content.filter((c: any) => c.type === 'input_audio')).toHaveLength(5);
    expect(mockCreate.mock.calls[0][0].messages[0].content[0].text).toMatch(/sample of 5 of them/);
  });

  it('returns 502 when a file has an unrecognised stored extension', async () => {
    vi.mocked(findSoundFiles).mockResolvedValue([makeFile(1, 1, 'weird.xyz')]);
    const res = await supertest(buildApp()).post('/sfx/trigger/suggest-description').send({ trigger_id: '5' });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'suggestion_failed' });
  });
});

describe('POST /sfx/trigger/suggest-description (OPENAI_API_KEY unset)', () => {
  it('responds 503 without touching the database', async () => {
    vi.resetModules();
    vi.doMock('../../shared/logger', () => ({ createLogger: mockLogger }));
    vi.doMock('../../shared/config', () => ({ OPENAI_API_KEY: '', SFX_FOLDER: '/app/sfx' }));
    vi.doMock('../csrf', () => ({ csrfProtection: (_req: any, _res: any, next: any) => next() }));
    vi.doMock('../middleware', () => ({ requireOwnerJson: (_req: any, _res: any, next: any) => next() }));
    const findSoundFilesSpy = vi.fn();
    vi.doMock('../../db', () => ({ findSoundFiles: findSoundFilesSpy }));

    const freshRouter: any = (await import('./sfxSuggestDescription.js')).default;
    const freshBuildTestApp = (await import('../../test-utils/expressTestApp.js')).buildTestApp;
    const app = freshBuildTestApp({ router: freshRouter, bodyParser: 'json' });

    const res = await supertest(app).post('/sfx/trigger/suggest-description').send({ trigger_id: '5' });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'not_configured' });
    expect(findSoundFilesSpy).not.toHaveBeenCalled();
  });
});
