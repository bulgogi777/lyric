#!/usr/bin/env bun
/**
 * Add word segments to songs that don't have them.
 * Uses Gemini CLI for Chinese word segmentation.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

interface Segment {
  hanzi: string;
  pinyin: string;
}

interface LyricLine {
  timestamp?: string;
  chinese: string;
  pinyin: string;
  english: string;
  segments?: Segment[];
}

interface Song {
  id: string;
  title: string;
  artist: string;
  album?: string;
  duration?: number;
  hasLyrics: boolean;
  lyricsSource?: string;
  lyrics?: LyricLine[];
}

const ROOT = '/home/debian/apex/x/code/lyric';
const DATA_PATH = join(ROOT, 'data/songs.json');

/**
 * Call Gemini to segment Chinese text with pinyin alignment
 */
async function segmentWithGemini(lines: Array<{ chinese: string; pinyin: string }>): Promise<Segment[][]> {
  if (lines.length === 0) return [];

  const prompt = `Segment Chinese lyrics into words with pinyin. Output ONLY a JSON array (no markdown, no explanation).

Rules:
- Multi-char words stay together: 愛情→àiqíng (not 愛→ài + 情→qíng)
- Particles separate: 的→de, 是→shì
- Spaces: {"hanzi":" ","pinyin":""}
- English words: keep as-is with same pinyin
- CRITICAL: Output complete JSON, do not truncate

Input (${lines.length} lines):
${lines.map((l, i) => `${i + 1}. "${l.chinese}" = "${l.pinyin}"`).join('\n')}

Output format: [[{"hanzi":"word","pinyin":"pinyin"},...],...]`;

  const proc = Bun.spawn(['gemini', '-m', 'gemini-3-flash-preview', '-p', prompt], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const output = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Gemini failed: ${stderr}`);
  }

  // Extract JSON from response (may have markdown code blocks)
  let jsonStr = output.trim();

  // Remove markdown code blocks if present
  const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1].trim();
  }

  try {
    const result = JSON.parse(jsonStr);
    if (!Array.isArray(result)) {
      throw new Error('Expected array');
    }
    return result;
  } catch (e) {
    console.error('Failed to parse Gemini output:', output.substring(0, 500));
    throw new Error(`JSON parse failed: ${e}`);
  }
}

/**
 * Process a single song
 */
async function processSong(song: Song): Promise<boolean> {
  if (!song.hasLyrics || !song.lyrics) return false;

  // Check if all lines already have segments
  const withSegments = song.lyrics.filter(l => l.segments && l.segments.length > 0).length;
  if (withSegments === song.lyrics.length) {
    return false; // All lines already have segments
  }

  console.log(`\nProcessing: ${song.title} - ${song.artist} (${song.lyrics.length} lines, ${withSegments} already done)`);

  // Process in batches of 5 lines (small to avoid truncation)
  const BATCH_SIZE = 5;
  const allSegments: Segment[][] = [];

  for (let i = 0; i < song.lyrics.length; i += BATCH_SIZE) {
    const batch = song.lyrics.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(song.lyrics.length / BATCH_SIZE);

    console.log(`  Batch ${batchNum}/${totalBatches}...`);

    try {
      const segments = await segmentWithGemini(
        batch.map(l => ({ chinese: l.chinese, pinyin: l.pinyin }))
      );
      allSegments.push(...segments);

      // Small delay between batches to avoid rate limits
      if (i + BATCH_SIZE < song.lyrics.length) {
        await new Promise(r => setTimeout(r, 500));
      }
    } catch (e) {
      console.error(`  Error in batch ${batchNum}: ${e}`);
      // Fill with empty segments for failed batch
      for (let j = 0; j < batch.length; j++) {
        allSegments.push([]);
      }
    }
  }

  // Add segments to lyrics
  for (let i = 0; i < song.lyrics.length; i++) {
    if (allSegments[i] && allSegments[i].length > 0) {
      song.lyrics[i].segments = allSegments[i];
    }
  }

  const successCount = allSegments.filter(s => s.length > 0).length;
  console.log(`  Done: ${successCount}/${song.lyrics.length} lines segmented`);

  return true;
}

async function main() {
  // Parse args
  const args = process.argv.slice(2);
  const songFilter = args[0]; // Optional: filter by song title substring

  // Read current data
  const data = JSON.parse(await readFile(DATA_PATH, 'utf-8')) as Song[];

  // Find songs needing segments
  let songsToProcess = data.filter(s =>
    s.hasLyrics &&
    s.lyrics &&
    !s.lyrics.some(l => l.segments && l.segments.length > 0)
  );

  if (songFilter) {
    songsToProcess = songsToProcess.filter(s =>
      s.title.toLowerCase().includes(songFilter.toLowerCase()) ||
      s.artist.toLowerCase().includes(songFilter.toLowerCase())
    );
  }

  console.log(`Found ${songsToProcess.length} songs needing segments`);
  if (songFilter) {
    console.log(`(Filtered by: "${songFilter}")`);
  }

  if (songsToProcess.length === 0) {
    console.log('Nothing to process!');
    return;
  }

  // Process each song
  let processed = 0;
  for (const song of songsToProcess) {
    const updated = await processSong(song);
    if (updated) processed++;

    // Save after each song to preserve progress
    await writeFile(DATA_PATH, JSON.stringify(data, null, 2));
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Processed ${processed} songs`);
  console.log(`Data saved to ${DATA_PATH}`);
}

main().catch(console.error);
