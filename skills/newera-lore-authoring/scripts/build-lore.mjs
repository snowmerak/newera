#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildBundle, validateBundle } from './lore-format.mjs';

const [, , inputArg, outputArg] = process.argv;
if (!inputArg || !outputArg) {
  console.error('사용법: node build-lore.mjs <source.json> <output.json>');
  process.exit(2);
}

try {
  const inputPath = resolve(inputArg);
  const outputPath = resolve(outputArg);
  const source = JSON.parse(await readFile(inputPath, 'utf8'));
  const bundle = buildBundle(source);
  const summary = validateBundle(bundle);
  await writeFile(outputPath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
  console.log(`생성 완료: ${outputPath}`);
  console.log(`로어: ${summary.title} · 인물 ${summary.characterCount}명 · 묘사 ${summary.narrativeMode}`);
} catch (cause) {
  console.error(`생성 실패: ${cause instanceof Error ? cause.message : String(cause)}`);
  process.exit(1);
}
