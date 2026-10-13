import { readFileSync } from 'node:fs';
import { FakeTavern as Base } from '../../dev/fakeTavern';
import type { WorldbookText } from '../../src/tavern/env';
import { CARD_DATA_FILES, DATA_FILES } from '../helpers';

export function diskWorldbook(): WorldbookText[] {
  return DATA_FILES.map(([name, file]) => ({
    name,
    content: readFileSync(file, 'utf8'),
    book: 'F1 领队模拟器',
  }));
}

export function cardWorldbook(): WorldbookText[] {
  return CARD_DATA_FILES.map(([name, file]) => ({
    name,
    content: readFileSync(file, 'utf8'),
    book: 'F1 领队模拟器',
  }));
}

export class FakeTavern extends Base {
  constructor(worldbook?: WorldbookText[]) {
    super(worldbook ?? diskWorldbook());
  }
}
