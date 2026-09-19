#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { validateBundle, validateSource } from './lore-format.mjs';

const [, , inputArg] = process.argv;
if (!inputArg) {
  console.error('사용법: node validate-lore.mjs <source-or-lore.json>');
  process.exit(2);
}

try {
  const inputPath = resolve(inputArg);
  const value = JSON.parse(await readFile(inputPath, 'utf8'));
  if (value?.format === 'newera-lore-source') {
    const result = validateSource(value);
    console.log(`유효한 작성 원본: ${result.title} · 인물 ${result.characters.length}명 · 묘사 ${result.world.narrativeMode}`);
  } else {
    const result = validateBundle(value);
    console.log(`유효한 import 로어: ${result.title} · 인물 ${result.characterCount}명 · 묘사 ${result.narrativeMode} · 턴 ${result.turn}`);
  }
} catch (cause) {
  console.error(`검증 실패: ${cause instanceof Error ? cause.message : String(cause)}`);
  process.exit(1);
}
