import { describe, expect, it } from 'vitest';

import {
  isBannerRule,
  isTruncationBanner,
  parseLogLine,
  splitLogLines,
} from '../../src/parser/logLine.js';
import { part1Segment, part1SegmentLines } from '../fixtures.js';

/**
 * Все строки в тестах ниже взяты дословно из data/fixtures/part1/segment1.log,
 * номера строк указаны — по правилу «сначала найди конструкцию в фикстуре,
 * потом сошлись на неё в тесте».
 */
describe('parseLogLine', () => {
  it('строка 2: содержимое без отступа', () => {
    const line = parseLogLine('D 00:17:32.3916963 GameState.DebugPrintPower() - CREATE_GAME');
    expect(line).toEqual({
      level: 'D',
      time: '00:17:32.3916963',
      source: 'GameState.DebugPrintPower',
      indent: 0,
      content: 'CREATE_GAME',
    });
  });

  it('строка 3: отступ 4 — вложено в CREATE_GAME', () => {
    const line = parseLogLine(
      'D 00:17:32.3916963 GameState.DebugPrintPower() -     GameEntity EntityID=16',
    );
    expect(line?.indent).toBe(4);
    expect(line?.content).toBe('GameEntity EntityID=16');
  });

  it('строка 4: отступ 8 — тег внутри сущности', () => {
    const line = parseLogLine(
      'D 00:17:32.3916963 GameState.DebugPrintPower() -         tag=CARDTYPE value=GAME',
    );
    expect(line?.indent).toBe(8);
    expect(line?.content).toBe('tag=CARDTYPE value=GAME');
  });

  it('строка 246: у PowerTaskList базовый отступ 4, а не 0', () => {
    // Тот же CREATE_GAME, что и в строке 2, но в другом канале и с отступом 4.
    // Нормализовать отступ на уровне строки нельзя — это забота сборщика блоков.
    const line = parseLogLine('D 00:17:32.3916963 PowerTaskList.DebugPrintPower() -     CREATE_GAME');
    expect(line?.source).toBe('PowerTaskList.DebugPrintPower');
    expect(line?.indent).toBe(4);
    expect(line?.content).toBe('CREATE_GAME');
  });

  it('строка 607: BLOCK_END идёт с нулевым отступом', () => {
    const line = parseLogLine('D 00:17:33.5266239 PowerTaskList.DebugPrintPower() - BLOCK_END');
    expect(line?.indent).toBe(0);
    expect(line?.content).toBe('BLOCK_END');
  });

  it('строка 336: дескриптор сущности внутри содержимого не трогается', () => {
    const line = parseLogLine(
      'D 00:17:32.3916963 PowerTaskList.DebugPrintPower() -     FULL_ENTITY - Updating ' +
        '[entityName=BaconPHhero id=35 zone=PLAY zonePos=0 cardId=TB_BaconShop_HERO_PH player=6] ' +
        'CardID=TB_BaconShop_HERO_PH',
    );
    expect(line?.content).toContain('cardId=TB_BaconShop_HERO_PH');
    // Внутри дескриптора есть " - " из "FULL_ENTITY - Updating": разделитель
    // строки ищется только по "() -", иначе содержимое порвалось бы здесь.
    expect(line?.content.startsWith('FULL_ENTITY - Updating [')).toBe(true);
  });

  it('строка 740: хвостовой пробел после value отбрасывается', () => {
    const line = parseLogLine(
      'D 00:17:33.5266239 PowerTaskList.DebugPrintPower() -     TAG_CHANGE ' +
        'Entity=[entityName=Благой Фаэлин id=104 zone=HAND zonePos=4 ' +
        'cardId=BG22_HERO_201_SKIN_D player=6] tag=ARMOR value=14 ',
    );
    expect(line?.content.endsWith('tag=ARMOR value=14')).toBe(true);
  });

  it('строка 5266: DebugPrintOptions идёт с отступом 2', () => {
    const line = parseLogLine(
      'D 00:18:43.0126319 GameState.DebugPrintOptions() -   option 1 type=POWER ' +
        'mainEntity=[entityName=Заморозить id=387 zone=PLAY zonePos=0 ' +
        'cardId=TB_BaconShopLockAll_Button player=6] error=NONE errorParam=',
    );
    expect(line?.source).toBe('GameState.DebugPrintOptions');
    expect(line?.indent).toBe(2);
  });

  it('кириллица в entityName не ломает разбор', () => {
    const line = parseLogLine(
      'D 00:17:33.5266239 GameState.DebugPrintPower() - TAG_CHANGE Entity=[entityName=Благой Фаэлин id=104 zone=PLAY zonePos=0 cardId=BG22_HERO_201_SKIN_D player=6] tag=PLAYER_LEADERBOARD_PLACE value=4',
    );
    expect(line?.content).toContain('Благой Фаэлин');
  });

  it('источник может содержать пробел и скобки', () => {
    // Строка 00:25:07.8784271 из segment1.log. Таких 24 за партию — источник
    // это не всегда Класс.Метод, и узкий шаблон на нём ломается.
    const line = parseLogLine(
      'D 00:25:07.8784271 PowerSpellController [taskListId=2162].InitPowerSpell() - ' +
        'FAILED to attach task list to spell Bacon_MinionSwap_OverrideSpawnIn_Super(Clone) ' +
        '(OverrideCustomSpawnSpell) for Card [entityName=Обновление id=4470 zone=PLAY ' +
        'zonePos=0 cardId=TB_BaconShop_8p_Reroll_Button player=6]',
    );
    expect(line?.source).toBe('PowerSpellController [taskListId=2162].InitPowerSpell');
    expect(line?.content.startsWith('FAILED to attach task list')).toBe(true);
  });

  it('возвращает null на том, что не является строкой лога', () => {
    expect(parseLogLine('')).toBeNull();
    expect(parseLogLine('==================================================')).toBeNull();
    expect(parseLogLine('Truncating log, which has reached the size limit of 10000KB')).toBeNull();
  });
});

describe('распознавание баннера обрезки', () => {
  it('ловит баннер и его рамку', () => {
    expect(isTruncationBanner('Truncating log, which has reached the size limit of 10000KB')).toBe(
      true,
    );
    expect(isBannerRule('==================================================================')).toBe(
      true,
    );
    expect(isTruncationBanner('D 00:17:32.3916963 GameState.DebugPrintPower() - CREATE_GAME')).toBe(
      false,
    );
    expect(isBannerRule('')).toBe(false);
  });
});

describe('инвариант на реальном логе целиком', () => {
  it('в segment1.log нет ни одной строки, которую не удалось опознать', () => {
    const lines = part1SegmentLines(1);
    const unknown: string[] = [];

    for (const raw of lines) {
      if (raw === '') continue;
      if (parseLogLine(raw) !== null) continue;
      if (isTruncationBanner(raw) || isBannerRule(raw)) continue;
      unknown.push(raw);
    }

    expect(unknown.slice(0, 5)).toEqual([]);
    expect(lines.length).toBeGreaterThan(70_000);
  });

  it('segment1.log обрывается баннером предела, а не концом партии', () => {
    const lines = part1SegmentLines(1).filter((l) => l !== '');
    const tail = lines.slice(-3);
    expect(tail.some((l) => isTruncationBanner(l))).toBe(true);
    // Обрыв, а не финал: FINAL_GAMEOVER в этом сегменте нет, он в segment4.
    expect(part1Segment(1).includes('FINAL_GAMEOVER')).toBe(false);
  });

  it('баннер отделён одиночными LF, а не CRLF — разбиение обязано это учитывать', () => {
    const text = part1Segment(1);
    expect(text.includes('\n==================================================================\n')).toBe(
      true,
    );
    // Наивное разбиение по CRLF склеило бы рамку, баннер и рамку в одну строку.
    const naive = text.split('\r\n');
    const proper = splitLogLines(text);
    expect(proper.length).toBeGreaterThan(naive.length);
    expect(naive.some((l) => isTruncationBanner(l))).toBe(false);
    expect(proper.some((l) => isTruncationBanner(l))).toBe(true);
  });
});
