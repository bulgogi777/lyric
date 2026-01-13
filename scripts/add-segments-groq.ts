#!/usr/bin/env bun
/**
 * Add word segments using Groq API (fast inference)
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

// Load env
const envPath = join(process.env.HOME!, '.claude/.env');
const envContent = await readFile(envPath, 'utf-8');
for (const line of envContent.split('\n')) {
  const [key, ...vals] = line.split('=');
  if (key && !key.startsWith('#')) {
    process.env[key.trim()] = vals.join('=').trim();
  }
}

const GROQ_API_KEY = process.env.GROQ_API_KEY;
if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY not set');

interface Segment { hanzi: string; pinyin: string; }
interface LyricLine { timestamp?: string; chinese: string; pinyin: string; english: string; segments?: Segment[]; }
interface Song { id: string; title: string; artist: string; hasLyrics: boolean; lyrics?: LyricLine[]; [key: string]: any; }

const ROOT = '/home/debian/apex/x/code/lyric';
const DATA_PATH = join(ROOT, 'data/songs.json');

async function segmentWithGroq(lines: Array<{ chinese: string; pinyin: string }>): Promise<Segment[][]> {
  if (lines.length === 0) return [];

  const prompt = `Segment Chinese lyrics into words. Output ONLY valid JSON array, no explanation.

Rules:
- Multi-char words together: 愛情→àiqíng
- Particles separate: 的→de
- Spaces: {"hanzi":" ","pinyin":""}
- English: keep as-is

Input:
${lines.map((l, i) => `${i + 1}. "${l.chinese}" = "${l.pinyin}"`).join('\n')}

Output: [[{"hanzi":"word","pinyin":"pinyin"},...],...]`;

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 4096,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Groq API error: ${response.status} ${err}`);
  }

  const data = await response.json();
  let output = data.choices[0].message.content.trim();

  // Remove markdown code blocks if present
  const jsonMatch = output.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) output = jsonMatch[1].trim();

  try {
    const result = JSON.parse(output);
    if (!Array.isArray(result)) throw new Error('Expected array');
    return result;
  } catch (e) {
    console.error('Parse error. Output:', output.substring(0, 300));
    throw new Error(`JSON parse failed: ${e}`);
  }
}

async function processSong(song: Song): Promise<boolean> {
  if (!song.hasLyrics || !song.lyrics) return false;

  const withSegments = song.lyrics.filter(l => l.segments?.length > 0).length;
  if (withSegments === song.lyrics.length) return false;

  console.log(`\n${song.title} - ${song.artist} (${song.lyrics.length} lines, ${withSegments} done)`);

  const BATCH_SIZE = 10;
  const allSegments: Segment[][] = [];

  for (let i = 0; i < song.lyrics.length; i += BATCH_SIZE) {
    const batch = song.lyrics.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(song.lyrics.length / BATCH_SIZE);

    process.stdout.write(`  Batch ${batchNum}/${totalBatches}...`);

    try {
      const segments = await segmentWithGroq(batch.map(l => ({ chinese: l.chinese, pinyin: l.pinyin })));
      allSegments.push(...segments);
      console.log(' ✓');
    } catch (e) {
      console.log(` ✗ ${e}`);
      for (let j = 0; j < batch.length; j++) allSegments.push([]);
    }

    // Small delay to avoid rate limits
    await new Promise(r => setTimeout(r, 200));
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

  const toProcess = data.filter(s =>
    s.hasLyrics && s.lyrics && !s.lyrics.every(l => l.segments?.length > 0)
  );

  console.log(`Found ${toProcess.length} songs needing segments`);

  for (const song of toProcess) {
    await processSong(song);
    await writeFile(DATA_PATH, JSON.stringify(data, null, 2));
  }

  console.log('\nComplete!');
}

main().catch(console.error);
