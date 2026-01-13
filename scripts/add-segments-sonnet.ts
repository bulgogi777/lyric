#!/usr/bin/env bun
/**
 * Add word segments using Claude Sonnet (best quality for Chinese segmentation)
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

interface Segment { hanzi: string; pinyin: string; }
interface LyricLine { timestamp?: string; chinese: string; pinyin: string; english: string; segments?: Segment[]; }
interface Song { id: string; title: string; artist: string; hasLyrics: boolean; lyrics?: LyricLine[]; [key: string]: any; }

const ROOT = '/home/debian/apex/x/code/lyric';
const DATA_PATH = join(ROOT, 'data/songs.json');

async function segmentWithSonnet(lines: Array<{ chinese: string; pinyin: string }>): Promise<Segment[][]> {
  if (lines.length === 0) return [];

  const prompt = `Segment Chinese lyrics into words. Output ONLY a JSON array, no explanation.

Rules:
- Multi-char words together: 愛情→àiqíng, 不要→bùyào, 再見→zàijiàn
- Particles separate: 的→de, 了→le
- Spaces: {"hanzi":" ","pinyin":""}
- Punctuation: {"hanzi":"，","pinyin":""}

Input:
${lines.map((l, i) => `${i + 1}. "${l.chinese}" = "${l.pinyin}"`).join('\n')}

Output: [[{"hanzi":"word","pinyin":"pinyin"},...],...]`;

  const proc = Bun.spawn(['claude', '-p', '--model', 'sonnet', '--output-format', 'text'], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  proc.stdin.write(prompt);
  proc.stdin.end();

  const output = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Claude failed: ${stderr}`);
  }

  // Remove markdown code blocks if present
  let jsonStr = output.trim();
  const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) jsonStr = jsonMatch[1].trim();

  try {
    const result = JSON.parse(jsonStr);
    if (!Array.isArray(result)) throw new Error('Expected array');
    return result;
  } catch (e) {
    console.error('Parse error. Output:', output.substring(0, 300));
    throw new Error(`JSON parse failed: ${e}`);
  }
}

async function processSong(song: Song): Promise<boolean> {
  if (!song.hasLyrics || !song.lyrics) return false;

  console.log(`\n${song.title} - ${song.artist} (${song.lyrics.length} lines)`);

  // Clear existing segments to reprocess
  song.lyrics.forEach(l => delete l.segments);

  const BATCH_SIZE = 10;
  const allSegments: Segment[][] = [];

  for (let i = 0; i < song.lyrics.length; i += BATCH_SIZE) {
    const batch = song.lyrics.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(song.lyrics.length / BATCH_SIZE);

    process.stdout.write(`  Batch ${batchNum}/${totalBatches}...`);

    try {
      const segments = await segmentWithSonnet(batch.map(l => ({ chinese: l.chinese, pinyin: l.pinyin })));
      allSegments.push(...segments);
      console.log(' ✓');
    } catch (e) {
      console.log(` ✗ ${e}`);
      for (let j = 0; j < batch.length; j++) allSegments.push([]);
    }
  }

  for (let i = 0; i < song.lyrics.length; i++) {
    if (allSegments[i]?.length > 0) song.lyrics[i].segments = allSegments[i];
  }

  const success = allSegments.filter(s => s.length > 0).length;
  console.log(`  Done: ${success}/${song.lyrics.length}`);
  return true;
}

async function main() {
  const data = JSON.parse(await readFile(DATA_PATH, 'utf-8')) as Song[];
  const toProcess = data.filter(s => s.hasLyrics && s.lyrics);

  console.log(`Processing ${toProcess.length} songs with Sonnet`);

  for (const song of toProcess) {
    await processSong(song);
    await writeFile(DATA_PATH, JSON.stringify(data, null, 2));
  }

  console.log('\nComplete!');
}

main().catch(console.error);
