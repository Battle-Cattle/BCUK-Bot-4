import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
import OpenAI from 'openai';
import type { SfxFile } from '../../db';
import { findSoundFiles } from '../../db';
import { csrfProtection } from '../csrf';
import { requireOwner } from '../middleware';
import { OPENAI_API_KEY, SFX_FOLDER } from '../../shared/config';
import { safeResolve } from '../../shared/pathUtils';
import { parsePositiveBigIntId, normalizeRequiredText } from './shared';

const log = createLogger('Web');
const router = Router();

/** Audio-capable chat model used for description suggestions — the "mini" variant keeps this cheap for a trial feature. */
const SUGGESTION_MODEL = 'gpt-audio-mini';
/** Matches `sfxtrigger.description`'s `VARCHAR(255)` column (schema.sql). */
const MAX_DESCRIPTION_LENGTH = 255;
/** Caps how many sound files are sent to the model per suggestion, bounding both request size and cost. */
const MAX_SAMPLE = 5;
/** Caps the trigger-command context text sent to the model, since it's client-supplied and only used for prompt context. */
const MAX_TRIGGER_COMMAND_LENGTH = 100;

let openaiClient: OpenAI | null = null;

/** Lazily constructs (and caches) the OpenAI client, so importing this module never requires `OPENAI_API_KEY` to be set. */
function getOpenAiClient(): OpenAI {
  if (!openaiClient) openaiClient = new OpenAI({ apiKey: OPENAI_API_KEY });
  return openaiClient;
}

/**
 * Picks which of a trigger's sound files to analyse when there's more than `maxSample`.
 * Sorts by `weight` (ties broken by `id` for determinism), always keeps the rarest
 * (lowest weight) and most common (highest weight) file so the suggestion sees both
 * ends of the trigger's variety, then fills the remaining budget with files evenly
 * spaced across the sorted list. Includes hidden files — `hidden` only affects the
 * public listing, not playback, so a hidden file still contributes to what the
 * trigger actually sounds like.
 * @param files All sound files belonging to the trigger.
 * @param maxSample Maximum number of files to return (default `MAX_SAMPLE`).
 * @returns Up to `maxSample` files, sorted by weight ascending.
 */
export function sampleFilesForSuggestion(files: SfxFile[], maxSample: number = MAX_SAMPLE): SfxFile[] {
  const sorted = [...files].sort((a, b) => a.weight - b.weight || a.id - b.id);
  if (sorted.length <= maxSample) return sorted;

  const lastIndex = sorted.length - 1;
  const selected = new Set<number>([0, lastIndex]);
  const remaining = maxSample - selected.size;
  const innerCount = lastIndex - 1; // indices 1..lastIndex-1 are available for spacing
  for (let i = 1; i <= remaining && innerCount > 0; i++) {
    const idx = Math.round((i * (innerCount + 1)) / (remaining + 1));
    selected.add(Math.min(Math.max(idx, 1), innerCount));
  }
  return Array.from(selected).sort((a, b) => a - b).map((i) => sorted[i]);
}

/**
 * Determines the audio format from a stored SFX filename's extension. Storage always
 * writes the magic-byte-detected extension (`buildStoredName` in `sfxFileUpload.ts`),
 * so the extension is trustworthy without re-sniffing the file's bytes.
 * @param filename Stored relative filename (within `SFX_FOLDER`).
 * @returns The detected format, or null if the extension isn't one of the supported types.
 */
function formatFromFilename(filename: string): 'wav' | 'mp3' | 'ogg' | null {
  const ext = path.extname(filename).slice(1).toLowerCase();
  return ext === 'wav' || ext === 'mp3' || ext === 'ogg' ? ext : null;
}

/** Kills the ffmpeg process and rejects if a transcode hasn't finished within this long. */
const TRANSCODE_TIMEOUT_MS = 10_000;

/**
 * Transcodes an in-memory audio buffer to MP3 via `ffmpeg-static`, entirely in memory
 * (stdin/stdout pipes) — used for `ogg` clips, since OpenAI's audio-input models only
 * accept `wav`/`mp3`. Kills the process and rejects if it hasn't finished within
 * `TRANSCODE_TIMEOUT_MS`, so a hung/corrupt input can't block the request indefinitely.
 * @param buffer Raw bytes of the source audio file.
 * @returns The transcoded MP3 bytes.
 */
export function transcodeToMp3(buffer: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) {
      reject(new Error('ffmpeg-static returned no path'));
      return;
    }
    const proc = spawn(ffmpegPath, ['-i', 'pipe:0', '-f', 'mp3', 'pipe:1']);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timeout = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`ffmpeg transcode timed out after ${TRANSCODE_TIMEOUT_MS}ms`));
    }, TRANSCODE_TIMEOUT_MS);
    proc.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    proc.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    // If ffmpeg exits before consuming all of stdin (e.g. a corrupt/truncated
    // file), writing/ending the pipe emits an 'error' (EPIPE) on the stdin stream
    // itself. Without a listener here, Node treats that as an unhandled 'error'
    // event and throws — crashing the whole process, not just this request. The
    // actual failure is already surfaced via the 'close' handler below.
    proc.stdin.on('error', () => {});
    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve(Buffer.concat(stdout));
      } else {
        reject(new Error(`ffmpeg exited with code ${code}: ${Buffer.concat(stderr).toString('utf8').slice(-500)}`));
      }
    });
    proc.stdin.write(buffer);
    proc.stdin.end();
  });
}

/** A single audio clip ready to send to OpenAI, alongside its accepted format. */
export interface AudioClip {
  buffer: Buffer;
  format: 'wav' | 'mp3';
}

/**
 * Asks OpenAI to describe the given audio clip(s) for use as a public SFX description.
 * @param clips One or more sampled clips (see {@link sampleFilesForSuggestion}) — more
 *   than one when the trigger's files were sub-sampled, so the model can describe the
 *   general theme rather than a single arbitrary clip.
 * @param triggerCommand The trigger's command string, given as context only (client-supplied, not persisted).
 * @param totalFileCount Total number of sound files the trigger actually has, so the
 *   prompt can tell the model when `clips` is a sample rather than the full set.
 * @returns A suggested description, trimmed to fit `sfxtrigger.description`'s column width.
 */
export async function requestDescriptionSuggestion(
  clips: AudioClip[],
  triggerCommand: string,
  totalFileCount: number,
): Promise<string> {
  const context = triggerCommand ? ` for the trigger "${triggerCommand}"` : '';
  // Explicitly ask for a verbatim quote when someone's speaking: without this, the
  // model tends to paraphrase recognizable lines/catchphrases away into a vague
  // paraphrase (e.g. a mumbled "mmm, bacon" becomes "a man making a sound"), even
  // though the actual words are usually the most useful description for a soundboard.
  const instruction = totalFileCount > clips.length
    ? `This Discord soundboard trigger${context} has ${totalFileCount} different sound files; you're hearing a sample of ${clips.length} of them. If any clip has recognizable spoken words, include a representative quote verbatim (in quotes) rather than paraphrasing it. Otherwise describe the general theme or variety of the sounds. Write one concise public-facing description, under 12 words, and don't just restate the trigger name.`
    : `This is a Discord soundboard sound${context}. If someone is speaking, transcribe the actual words verbatim (in quotes) rather than paraphrasing — that's usually the most useful description for a soundboard entry. Otherwise describe what's audible. Write one concise public-facing description, under 12 words, and don't just restate the trigger name.`;

  const completion = await getOpenAiClient().chat.completions.create({
    model: SUGGESTION_MODEL,
    modalities: ['text'],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: instruction },
          ...clips.map((clip) => ({
            type: 'input_audio' as const,
            input_audio: { data: clip.buffer.toString('base64'), format: clip.format },
          })),
        ],
      },
    ],
  });

  const text = completion.choices[0]?.message?.content?.trim();
  if (!text) throw new Error('OpenAI returned an empty description');
  return text.length > MAX_DESCRIPTION_LENGTH ? text.slice(0, MAX_DESCRIPTION_LENGTH) : text;
}

/**
 * Reads a sampled sound file from disk and converts it to a format OpenAI's
 * audio-input models accept, transcoding `ogg` to `mp3` via {@link transcodeToMp3}.
 * @param file The sfx row to load (its `file` column is the stored relative filename).
 * @returns The loaded/converted clip, ready for {@link requestDescriptionSuggestion}.
 * @throws If the filename's extension isn't a recognised format, or the resolved path escapes `SFX_FOLDER`.
 */
async function loadClip(file: SfxFile): Promise<AudioClip> {
  const format = formatFromFilename(file.file);
  if (!format) throw new Error(`Unrecognised stored extension for SFX file ${file.file}`);
  const fullPath = safeResolve(SFX_FOLDER, file.file);
  if (!fullPath) throw new Error(`Unsafe stored path for SFX file ${file.file}`);
  const buffer = await fs.promises.readFile(fullPath);
  return format === 'ogg' ? { buffer: await transcodeToMp3(buffer), format: 'mp3' } : { buffer, format };
}

// This route responds with JSON rather than a redirect — unlike the rest of the SFX
// mutation routes — because it's an AJAX-triggered "fill in a field" action (sfx.js
// populates the description input from the response) rather than a page mutation.
/**
 * POST /sfx/trigger/suggest-description — analyses a sample of a trigger's sound
 * files with OpenAI and returns a suggested public description. Owner-only while
 * this feature is being trialled for cost/effectiveness (see `requireOwner`).
 * @param req Express request; reads `trigger_id` and optional `trigger_command` (context only) from a JSON body.
 * @param res Express response; always responds with JSON.
 */
router.post('/sfx/trigger/suggest-description', requireOwner, csrfProtection, async (req, res) => {
  if (!OPENAI_API_KEY) {
    res.status(503).json({ error: 'not_configured' });
    return;
  }

  const triggerId = parsePositiveBigIntId(req.body?.trigger_id);
  if (triggerId === null) {
    res.status(400).json({ error: 'invalid_id' });
    return;
  }
  const triggerCommand = normalizeRequiredText(req.body?.trigger_command)?.slice(0, MAX_TRIGGER_COMMAND_LENGTH) ?? '';

  let files: SfxFile[];
  try {
    files = await findSoundFiles(triggerId);
  } catch (err) {
    log.error('Suggest SFX description error (load files):', err);
    res.status(502).json({ error: 'suggestion_failed' });
    return;
  }
  if (files.length === 0) {
    res.status(404).json({ error: 'no_file' });
    return;
  }

  try {
    const sample = sampleFilesForSuggestion(files);
    const clips = await Promise.all(sample.map(loadClip));
    const description = await requestDescriptionSuggestion(clips, triggerCommand, files.length);
    res.status(200).json({ description });
  } catch (err) {
    log.error('Suggest SFX description error:', err);
    res.status(502).json({ error: 'suggestion_failed' });
  }
});

export default router;
