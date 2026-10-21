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
  if (value?.format === 'newera-theater-source') {
    const result = validateSource(value);
    console.log(`유효한 작성 원본: ${result.name} · 씬 ${result.scenes.length}개 · 원형 ${result.templates.length}개`);
  } else {
    const result = validateBundle(value);
    console.log(`유효한 세계관: ${result.title} · 씬 ${result.sceneCount}개 · 인스턴스 ${result.instanceCount}개 · 진행 ${result.tick}회`);
  }
} catch (cause) {
  console.error(`검증 실패: ${cause instanceof Error ? cause.message : String(cause)}`);
  process.exit(1);
}
