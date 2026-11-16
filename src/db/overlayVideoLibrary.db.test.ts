import { describe, it, expect } from 'vitest';
import type mysql from 'mysql2/promise';
import { getPool } from './pool';
import { addVideoToLibrary, getLibraryVideos, importLibraryVideo, removeLibraryVideo } from './overlayVideoLibrary';
import { addVideo, deleteVideo } from './overlayVideos';

// The overlay video library's foreign keys, against a real MySQL (npm run test:db). Each side
// owns its own file, so deleting one row must leave the others with the link set to NULL.

const GUILD_ID = '900000000000000001';
let nextDiscordId = 100000000000000000n;

/** Inserts a user, stream group and streamer, returning the streamer's id. */
async function seedStreamer(): Promise<number> {
  const pool = getPool();
  const discordId = String(nextDiscordId++);
  await pool.execute('INSERT IGNORE INTO guild (guild_id, name) VALUES (?, ?)', [GUILD_ID, 'Test guild']);
  await pool.execute('INSERT INTO `user` (discord_id, discord_name) VALUES (?, ?)', [discordId, `user-${discordId}`]);
  const [group] = await pool.execute<mysql.ResultSetHeader>(
    `INSERT INTO stream_group (guild_id, name, discord_channel, live_message, new_game_message)
     VALUES (?, ?, ?, '', '')`,
    [GUILD_ID, `group-${discordId}`, '900000000000000002'],
  );
  const [streamer] = await pool.execute<mysql.ResultSetHeader>(
    'INSERT INTO streamer (discord_id, group_id) VALUES (?, ?)', [discordId, group.insertId],
  );
  return streamer.insertId;
}

/** Adds a video for `streamerId` and puts it in the library, returning both ids. */
async function seedLibraryEntry(streamerId: number): Promise<{ videoId: number; libraryId: number }> {
  const videoId = await addVideo(streamerId, 'Clip', `clip-${streamerId}.mp4`);
  const added = await addVideoToLibrary(videoId, streamerId, `library-${streamerId}.mp4`);
  if (added.status !== 'added') throw new Error(`addVideoToLibrary returned ${added.status}`);
  return { videoId, libraryId: added.libraryId };
}

/** Reads one row's columns by primary key. */
async function row(table: 'overlay_video' | 'overlay_video_library', id: number): Promise<mysql.RowDataPacket | undefined> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(`SELECT * FROM ${table} WHERE id = ?`, [id]);
  return rows[0];
}

describe('overlay video library foreign keys (real MySQL)', () => {
  it("keeps the library entry, with source_video_id NULL, when the contributor deletes their video", async () => {
    const streamerId = await seedStreamer();
    const { videoId, libraryId } = await seedLibraryEntry(streamerId);

    expect(await deleteVideo(videoId, streamerId)).toBe(`clip-${streamerId}.mp4`);

    expect(await row('overlay_video_library', libraryId)).toMatchObject({
      source_video_id: null,
      contributor_streamer_id: streamerId,
      filename: `library-${streamerId}.mp4`,
    });
  });

  it("keeps the library entry, with contributor_streamer_id NULL, when the contributor's streamer row goes", async () => {
    const streamerId = await seedStreamer();
    const { libraryId } = await seedLibraryEntry(streamerId);

    await getPool().execute('DELETE FROM streamer WHERE id = ?', [streamerId]);

    // The streamer's own video cascades away with it, so the entry loses its source too.
    expect(await row('overlay_video_library', libraryId)).toMatchObject({ contributor_streamer_id: null, source_video_id: null });
    expect(await getLibraryVideos()).toEqual([
      expect.objectContaining({ id: libraryId, contributor_streamer_id: null, contributor_login: null }),
    ]);
  });

  it('keeps the imported overlay_video copies, with library_entry_id NULL, when the entry is removed', async () => {
    const contributorId = await seedStreamer();
    const importerId = await seedStreamer();
    const { libraryId } = await seedLibraryEntry(contributorId);
    const copyId = await importLibraryVideo(libraryId, importerId, 'imported.mp4');
    expect(copyId).not.toBeNull();
    expect(await row('overlay_video', copyId!)).toMatchObject({ library_entry_id: libraryId });

    expect(await removeLibraryVideo(libraryId)).toBe(`library-${contributorId}.mp4`);

    expect(await row('overlay_video_library', libraryId)).toBeUndefined();
    expect(await row('overlay_video', copyId!)).toMatchObject({ streamer_id: importerId, filename: 'imported.mp4', library_entry_id: null });
  });
});

describe('overlay video library unique keys (real MySQL)', () => {
  it('reports a video that is already in the library, and keeps the first entry', async () => {
    const streamerId = await seedStreamer();
    const { videoId, libraryId } = await seedLibraryEntry(streamerId);

    expect(await addVideoToLibrary(videoId, streamerId, 'another-copy.mp4')).toEqual({ status: 'already_in_library' });
    expect(await getLibraryVideos()).toEqual([expect.objectContaining({ id: libraryId })]);
  });

  it('rethrows a library filename collision, which is a caller bug rather than a duplicate video', async () => {
    const streamerId = await seedStreamer();
    await seedLibraryEntry(streamerId);
    const otherVideoId = await addVideo(streamerId, 'Other clip', 'other.mp4');

    await expect(addVideoToLibrary(otherVideoId, streamerId, `library-${streamerId}.mp4`)).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
  });
});

