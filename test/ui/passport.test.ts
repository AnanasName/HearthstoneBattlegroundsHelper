import { describe, expect, it } from 'vitest';

import { parseClock } from '../../src/ui/logSlice.js';
import { gameOfFrame, gameRanges, passportsOf } from '../../src/ui/passport.js';

/**
 * Сессия клиента из двух партий: рейтинговая и Battlegrounds. Строки
 * разделены CRLF, как в настоящем логе, — фикстура обязана вырезаться
 * байт в байт, без пересклейки строк.
 */
const ranked = [
  'D 13:10:00.0000000 GameState.DebugPrintPower() - CREATE_GAME',
  'D 13:10:00.0000000 GameState.DebugPrintGame() - GameType=GT_RANKED',
  'D 13:30:00.0000000 GameState.DebugPrintPower() -     TAG_CHANGE Entity=GameEntity tag=STEP value=FINAL_GAMEOVER ',
].join('\r\n');
const battlegrounds = [
  'D 13:52:44.9044391 GameState.DebugPrintPower() - CREATE_GAME',
  'D 13:52:44.9044391 GameState.DebugPrintGame() - GameType=GT_BATTLEGROUNDS',
  'D 14:12:31.0139927 GameState.DebugPrintPower() -     TAG_CHANGE Entity=GameEntity tag=STEP value=FINAL_GAMEOVER ',
].join('\r\n');
const session = `${ranked}\r\n${battlegrounds}\r\n`;

describe('паспорт партии', () => {
  it('партии режутся по CREATE_GAME, и склейка кусков даёт исходный текст байт в байт', () => {
    const ranges = gameRanges(session);
    expect(ranges.map((r) => r.index)).toEqual([1, 2]);
    expect(ranges.map((r) => session.slice(r.from, r.to)).join('')).toBe(session);
    expect(session.slice(ranges[1]!.from, ranges[1]!.to)).toContain('\r\n');
    expect(session.slice(ranges[1]!.from)).toMatch(/^D 13:52:44/);
  });

  it('режим, конец партии и часы читаются по каждой партии отдельно', () => {
    const [first, second] = passportsOf(session);
    expect(first).toMatchObject({ gameType: 'GT_RANKED', battlegrounds: false, finished: true, start: '13:10:00' });
    expect(second).toMatchObject({ gameType: 'GT_BATTLEGROUNDS', battlegrounds: true, finished: true });
    expect(second!.start).toBe('13:52:44');
    expect(second!.end).toBe('14:12:31');
  });

  it('без FINAL_GAMEOVER партия не доиграна — место в ней текущее', () => {
    const cut = battlegrounds.split('\r\n').slice(0, 2).join('\r\n');
    expect(passportsOf(cut)[0]!.finished).toBe(false);
  });

  it('сегмент переподключения без CREATE_GAME — одна партия', () => {
    const segment = 'D 01:36:30.0000000 GameState.DebugPrintPower() - GameEntity EntityID=1\r\n';
    const passports = passportsOf(segment);
    expect(passports).toHaveLength(1);
    expect(passports[0]!.reconnect).toBe(true);
    expect(passports[0]!.gameType).toBeNull();
    // Режим неизвестен — партия считается своей, как в isBattlegroundsGame.
    expect(passports[0]!.battlegrounds).toBe(true);
  });

  it('кадр называет свою партию, а чужие часы — ни одну (урок part49)', () => {
    const passports = passportsOf(session);
    expect(gameOfFrame(passports, parseClock('13:53')!)).toBe(2);
    expect(gameOfFrame(passports, parseClock('13:20')!)).toBe(1);
    expect(gameOfFrame(passports, parseClock('16:01')!)).toBeNull();
  });

  it('конец партии — FINAL_GAMEOVER, а не последняя строка лобби после него', () => {
    const withLobby = `${battlegrounds}\r\nD 15:40:34.0000000 GameState.DebugPrintPower() - лобби\r\n`;
    const [passport] = passportsOf(withLobby);
    expect(passport!.end).toBe('14:12:31');
    // Кадр между партиями не приписывается закончившейся.
    expect(gameOfFrame([passport!], parseClock('14:30')!)).toBeNull();
  });
});
