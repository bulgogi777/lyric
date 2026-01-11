/**
 * Playlist extraction module
 * Uses yt-dlp for YouTube/YouTube Music playlist metadata
 */

export interface PlaylistTrack {
  videoId: string;
  title: string;
  artist: string;
}

export interface Playlist {
  id: string;
  title: string;
  tracks: PlaylistTrack[];
}

/**
 * Extract playlist tracks using yt-dlp
 */
export async function extractPlaylist(playlistUrl: string): Promise<Playlist> {
  // Normalize URL to standard YouTube format
  const url = playlistUrl.replace('music.youtube.com', 'www.youtube.com');

  // Extract playlist ID
  const match = url.match(/list=([a-zA-Z0-9_-]+)/);
  if (!match) {
    throw new Error('Invalid playlist URL - no list parameter found');
  }
  const playlistId = match[1];

  // Get playlist info
  const infoProc = Bun.spawn([
    '/tmp/yt-dlp',
    '--flat-playlist',
    '--print', 'playlist_title',
    '--playlist-items', '1',
    url,
  ], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const playlistTitle = (await new Response(infoProc.stdout).text()).trim().split('\n')[0] || 'Unknown Playlist';
  await infoProc.exited;

  // Get all tracks
  const tracksProc = Bun.spawn([
    '/tmp/yt-dlp',
    '--flat-playlist',
    '--print', '%(id)s|%(title)s|%(channel)s',
    url,
  ], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const output = await new Response(tracksProc.stdout).text();
  const exitCode = await tracksProc.exited;

  if (exitCode !== 0) {
    const stderr = await new Response(tracksProc.stderr).text();
    throw new Error(`yt-dlp failed: ${stderr}`);
  }

  const tracks: PlaylistTrack[] = output
    .trim()
    .split('\n')
    .filter(line => line.includes('|'))
    .map(line => {
      const [videoId, title, artist] = line.split('|');
      return { videoId, title, artist };
    })
    .filter(track => track.videoId && track.videoId !== 'NA' && !track.title.includes('[Deleted video]'));

  return {
    id: playlistId,
    title: playlistTitle,
    tracks,
  };
}

/**
 * Parse artist name - clean up channel names to get artist
 */
export function cleanArtistName(channelName: string): string {
  // Remove common suffixes
  return channelName
    .replace(/官方專屬頻道$/i, '')
    .replace(/Official Channel$/i, '')
    .replace(/'s Official Channel$/i, '')
    .replace(/ - Topic$/i, '')
    .trim();
}

/**
 * Parse track title to extract clean title and possibly artist
 * Many YouTube Music titles include metadata in parentheses
 */
export function parseTrackTitle(title: string): { title: string; subtitle?: string } {
  // Match pattern like "Title (some description)"
  const match = title.match(/^(.+?)\s*\((.+)\)$/);
  if (match) {
    return {
      title: match[1].trim(),
      subtitle: match[2].trim(),
    };
  }
  return { title: title.trim() };
}
