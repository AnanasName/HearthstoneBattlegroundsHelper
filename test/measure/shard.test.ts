import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readShards, shardInArg, shardName, shardOutArg, writeShard } from '../../src/measure/shard.js';

describe('флаги режима шарда', () => {
  it('без флагов — обычный прогон одним процессом', () => {
    expect(shardOutArg(['--parts=4'])).toBeNull();
    expect(shardInArg(['--parts=4'])).toBeNull();
  });

  it('--shard-out даёт путь файла куска', () => {
    expect(shardOutArg(['--shard-out=C:/tmp/куски/0000.json'])).toBe('C:/tmp/куски/0000.json');
  });

  it('--shard-in даёт КАТАЛОГ кусков', () => {
    expect(shardInArg(['--shard-in=C:/tmp/куски'])).toBe('C:/tmp/куски');
  });
});

describe('чтение и запись кусков', () => {
  let dir = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shard-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('кусок переживает запись и чтение', () => {
    const path = join(dir, shardName(0));
    writeShard(path, { rows: [{ turn: 7, agreed: true }], skipped: 2 });
    expect(readShards<{ rows: { turn: number; agreed: boolean }[]; skipped: number }>(dir)).toEqual([
      { rows: [{ turn: 7, agreed: true }], skipped: 2 },
    ]);
  });

  it('куски читаются в порядке НОМЕРА, а не в порядке записи', () => {
    // Порядок важен: склейка строк должна совпасть с прогоном по партиям
    // подряд, иначе метрика, зависящая от порядка, тихо разойдётся.
    writeShard(join(dir, shardName(11)), { n: 11 });
    writeShard(join(dir, shardName(2)), { n: 2 });
    writeShard(join(dir, shardName(0)), { n: 0 });
    expect(readShards<{ n: number }>(dir).map((s) => s.n)).toEqual([0, 2, 11]);
  });

  it('имя куска дополняется нулями — иначе part10 встанет перед part2', () => {
    expect(shardName(0)).toBe('0000.json');
    expect(shardName(7)).toBe('0007.json');
    expect(shardName(52)).toBe('0052.json');
  });

  it('посторонние файлы в каталоге кусков не читаются', () => {
    writeShard(join(dir, shardName(0)), { n: 0 });
    writeFileSync(join(dir, 'заметка.txt'), 'не кусок');
    expect(readShards<{ n: number }>(dir)).toEqual([{ n: 0 }]);
  });

  it('пустого каталога хватает: кусков нет — и список пуст', () => {
    expect(readShards(dir)).toEqual([]);
  });
});
