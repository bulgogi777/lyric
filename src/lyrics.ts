/**
 * Lyrics processing module
 * - Fetches lyrics from LRCLIB
 * - Converts to pinyin
 * - Translates via LLM
 */

import { pinyin } from 'pinyin-pro';

interface LRCLibResponse {
  id: number;
  name: string;
  trackName: string;
  artistName: string;
  albumName: string;
  duration: number;
  instrumental: boolean;
  plainLyrics: string | null;
  syncedLyrics: string | null;
}

interface SongMetadata {
  videoId: string;
  title: string;
  artist: string;
  album?: string;
  duration?: number;
}

interface ProcessedLine {
  chinese: string;
  pinyin: string;
  english: string;
  timestamp?: string;
}

interface ProcessedSong {
  metadata: SongMetadata;
  lines: ProcessedLine[];
}

/**
 * Fetch lyrics from LRCLIB API
 */
export async function fetchLyrics(artist: string, track: string): Promise<LRCLibResponse | null> {
  const params = new URLSearchParams({
    artist_name: artist,
    track_name: track,
  });

  try {
    const response = await fetch(`https://lrclib.net/api/get?${params}`);
    if (!response.ok) {
      // Try search endpoint as fallback
      const searchResponse = await fetch(`https://lrclib.net/api/search?${params}`);
      if (!searchResponse.ok) return null;
      const results = await searchResponse.json() as LRCLibResponse[];
      return results[0] || null;
    }
    return await response.json() as LRCLibResponse;
  } catch (error) {
    console.error(`Error fetching lyrics for ${artist} - ${track}:`, error);
    return null;
  }
}

/**
 * Convert Chinese text to pinyin
 */
export function toPinyin(text: string): string {
  return pinyin(text, {
    toneType: 'symbol',  // Use tone marks (ā á ǎ à)
    type: 'string',
    separator: ' '
  });
}

/**
 * Parse synced lyrics (LRC format) into lines with timestamps
 */
export function parseSyncedLyrics(lrc: string): Array<{ timestamp: string; text: string }> {
  const lines: Array<{ timestamp: string; text: string }> = [];
  const regex = /\[(\d{2}:\d{2}\.\d{2,3})\](.*)/g;

  let match;
  while ((match = regex.exec(lrc)) !== null) {
    const text = match[2].trim();
    if (text) {
      lines.push({
        timestamp: match[1],
        text,
      });
    }
  }

  return lines;
}

/**
 * Parse plain lyrics into lines
 */
export function parsePlainLyrics(lyrics: string): string[] {
  return lyrics
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);
}

/**
 * Translate Chinese text to English using Gemini CLI
 */
export async function translateWithGemini(lines: string[]): Promise<string[]> {
  const prompt = `Translate these Chinese song lyrics to natural English. Return ONLY the translations, one per line, in the same order. No numbering, no explanations, no quotes.

${lines.map((l, i) => `${i + 1}. ${l}`).join('\n')}`;

  const proc = Bun.spawn(['gemini', '-p', prompt], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const output = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Gemini translation failed: ${stderr}`);
  }

  // Parse output - one translation per line
  const translations = output
    .trim()
    .split('\n')
    .map(line => line.replace(/^\d+\.\s*/, '').trim())
    .filter(line => line.length > 0);

  // Ensure we have the right number of translations
  if (translations.length !== lines.length) {
    console.warn(`Warning: Got ${translations.length} translations for ${lines.length} lines`);
    // Pad with empty strings if needed
    while (translations.length < lines.length) {
      translations.push('[translation unavailable]');
    }
  }

  return translations;
}

/**
 * Process a song: fetch lyrics, add pinyin, translate
 */
export async function processSong(metadata: SongMetadata): Promise<ProcessedSong | null> {
  console.log(`Processing: ${metadata.artist} - ${metadata.title}`);

  // Fetch lyrics
  const lyricsData = await fetchLyrics(metadata.artist, metadata.title);
  if (!lyricsData || (!lyricsData.plainLyrics && !lyricsData.syncedLyrics)) {
    console.warn(`  No lyrics found`);
    return null;
  }

  // Update metadata with album info
  if (lyricsData.albumName) {
    metadata.album = lyricsData.albumName;
  }
  if (lyricsData.duration) {
    metadata.duration = lyricsData.duration;
  }

  // Parse lyrics
  let rawLines: Array<{ text: string; timestamp?: string }>;

  if (lyricsData.syncedLyrics) {
    rawLines = parseSyncedLyrics(lyricsData.syncedLyrics).map(l => ({
      text: l.text,
      timestamp: l.timestamp,
    }));
  } else if (lyricsData.plainLyrics) {
    rawLines = parsePlainLyrics(lyricsData.plainLyrics).map(text => ({ text }));
  } else {
    return null;
  }

  console.log(`  Found ${rawLines.length} lines`);

  // Generate pinyin for all lines
  const pinyinLines = rawLines.map(l => toPinyin(l.text));
  console.log(`  Generated pinyin`);

  // Translate in batches to avoid overwhelming the LLM
  const chineseTexts = rawLines.map(l => l.text);
  const BATCH_SIZE = 20;
  const translations: string[] = [];

  for (let i = 0; i < chineseTexts.length; i += BATCH_SIZE) {
    const batch = chineseTexts.slice(i, i + BATCH_SIZE);
    console.log(`  Translating batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(chineseTexts.length / BATCH_SIZE)}`);
    const batchTranslations = await translateWithGemini(batch);
    translations.push(...batchTranslations);
  }

  // Combine everything
  const lines: ProcessedLine[] = rawLines.map((raw, i) => ({
    chinese: raw.text,
    pinyin: pinyinLines[i],
    english: translations[i] || '[translation unavailable]',
    timestamp: raw.timestamp,
  }));

  return { metadata, lines };
}

/**
 * Format processed song as markdown
 */
export function formatMarkdown(song: ProcessedSong): string {
  const md: string[] = [];

  // Header
  md.push(`# ${song.metadata.title}`);
  md.push('');
  md.push(`**Artist:** ${song.metadata.artist}`);
  if (song.metadata.album) {
    md.push(`**Album:** ${song.metadata.album}`);
  }
  if (song.metadata.duration) {
    const mins = Math.floor(song.metadata.duration / 60);
    const secs = Math.floor(song.metadata.duration % 60);
    md.push(`**Duration:** ${mins}:${secs.toString().padStart(2, '0')}`);
  }
  md.push(`**YouTube:** https://www.youtube.com/watch?v=${song.metadata.videoId}`);
  md.push('');
  md.push('---');
  md.push('');

  // Lyrics
  for (const line of song.lines) {
    if (line.timestamp) {
      md.push(`*[${line.timestamp}]*`);
    }
    md.push(`**${line.chinese}**`);
    md.push(`*${line.pinyin}*`);
    md.push(line.english);
    md.push('');
  }

  return md.join('\n');
}
