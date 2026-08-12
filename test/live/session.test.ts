import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BattleSetup } from '../../src/advisors/battle/mapper.js';
import type { PositionAdvice } from '../../src/advisors/position/advisor.js';
import type { PositionSource } from '../../src/live/advisor.js';
import { startLiveSession, type LiveSession } from '../../src/live/session.js';
import { loadCardIndex } from '../../src/data/cards.js';
import type { GameState } from '../../src/state/types.js';
import { part3Game } from '../fixtures.js';

/**
 * Склейка слежения и советников на настоящем файле, который дописывается.
 *
 * Дефект, ради которого тест и написан: помощник, запущенный посреди партии,
 * молчал. `LiveWatcher` зовёт обновление один раз на чтение, после применения
 * всех строк, поэтому единственное обновление догона несёт актуальное
 * состояние, — а правило «на догоне не советуем» его выбрасывало. Игрок видел
 * «новая партия» и дальше ничего: следующего обновления можно ждать сколько
 * угодно, если он в меню.
 */

class SilentPosition implements PositionSource {
  readonly calls: BattleSetup[] = [];

  advise(setup: BattleSetup): Promise<PositionAdvice | null> {
    this.calls.push(setup);
    // Счёт расстановки здесь не при чём: он проверен отдельно.
    return Promise.resolve(null);
  }

  cancel(): void {}
}

/**
 * Лог Hearthstone на диске: папка сессии клиента с Power.log внутри.
 *
 * `text === null` — сессия без лога: так выглядит только что запущенный
 * клиент, ещё не вошедший в партию. Файл создаётся ЛЕНИВО, при первом
 * сообщении канала: в сессии от 12.08 клиент стартовал в 21:17:17,
 * а первая строка лога датирована 21:18:34.
 */
function makeLogsRoot(text: string | null): { logsRoot: string; powerLog: string } {
  const logsRoot = mkdtempSync(join(tmpdir(), 'hsbg-logs-'));
  const dir = join(logsRoot, 'Hearthstone_2026_08_13_00_00_00');
  mkdirSync(dir);

  const powerLog = join(dir, 'Power.log');
  if (text !== null) writeFileSync(powerLog, text, 'utf8');
  return { logsRoot, powerLog };
}

describe('живая сессия на дописываемом файле', () => {
  let session: LiveSession | null = null;
  let logsRoot: string | null = null;

  afterEach(() => {
    session?.stop();
    session = null;
    if (logsRoot !== null) rmSync(logsRoot, { recursive: true, force: true });
    logsRoot = null;
  });

  it('партия, идущая до запуска помощника, советуется сразу', async () => {
    // Полтора десятка мегабайт партии: помощник запускают посреди игры,
    // и всё это уже лежит в файле.
    const text = part3Game();
    const started = makeLogsRoot(text.slice(0, Math.floor(text.length * 0.6)));
    logsRoot = started.logsRoot;

    const onTavern = vi.fn<(advice: unknown, state: GameState) => void>();
    session = startLiveSession(
      { cards: loadCardIndex(), position: new SilentPosition() },
      { onTavern },
      { watcher: { logsRoot, pollMs: 20, sessionCheckMs: 60_000 }, advisor: { quietMs: 30 } },
    );

    await vi.waitFor(
      () => {
        expect(onTavern).toHaveBeenCalled();
      },
      { timeout: 20_000, interval: 50 },
    );

    // Совет должен быть про положение, которое в игре сейчас, а не про пустое.
    const state = onTavern.mock.calls[0]?.[1];
    expect(state?.hero).not.toBeNull();
    expect(state?.board.length).toBeGreaterThan(0);
  }, 60_000);

  it('лог, появившийся после запуска помощника, подхватывается сам', async () => {
    // Игрок запустил помощник, пока Hearthstone в меню: папка сессии есть,
    // Power.log ещё нет. Требовать за это перезапуска помощника нельзя.
    const started = makeLogsRoot(null);
    logsRoot = started.logsRoot;

    const onTavern = vi.fn<(advice: unknown, state: GameState) => void>();
    const notices: string[] = [];
    session = startLiveSession(
      { cards: loadCardIndex(), position: new SilentPosition() },
      {
        onTavern,
        onNotice: (notice) => {
          notices.push(notice.kind);
        },
      },
      { watcher: { logsRoot, pollMs: 20, sessionCheckMs: 60_000 }, advisor: { quietMs: 30 } },
    );

    await vi.waitFor(
      () => {
        expect(notices).toContain('noPowerLog');
      },
      { timeout: 5000, interval: 20 },
    );

    // Партия началась — клиент завёл файл.
    const text = part3Game();
    writeFileSync(started.powerLog, text.slice(0, Math.floor(text.length * 0.6)), 'utf8');

    await vi.waitFor(
      () => {
        expect(onTavern).toHaveBeenCalled();
      },
      { timeout: 20_000, interval: 50 },
    );
    expect(notices).toContain('watching');
    // Именно «нашёлся впервые», а не «клиент перезапущен»: путать эти два
    // события значит врать игроку о том, что произошло.
    expect(notices).not.toContain('switched');
  }, 60_000);

  it('дописанные строки поднимают новый совет', async () => {
    const text = part3Game();
    const cut = Math.floor(text.length * 0.6);
    const started = makeLogsRoot(text.slice(0, cut));
    logsRoot = started.logsRoot;

    const onTavern = vi.fn<(advice: unknown, state: GameState) => void>();
    session = startLiveSession(
      { cards: loadCardIndex(), position: new SilentPosition() },
      { onTavern },
      { watcher: { logsRoot, pollMs: 20, sessionCheckMs: 60_000 }, advisor: { quietMs: 30 } },
    );

    await vi.waitFor(
      () => {
        expect(onTavern).toHaveBeenCalled();
      },
      { timeout: 20_000, interval: 50 },
    );
    const afterCatchUp = onTavern.mock.calls.length;
    const turnAtCatchUp = onTavern.mock.calls.at(-1)?.[1].turn ?? 0;

    // Игра доиграла партию — файл дописался.
    appendFileSync(started.powerLog, text.slice(cut), 'utf8');

    await vi.waitFor(
      () => {
        expect(onTavern.mock.calls.length).toBeGreaterThan(afterCatchUp);
      },
      { timeout: 20_000, interval: 50 },
    );
    expect(onTavern.mock.calls.at(-1)?.[1].turn).toBeGreaterThan(turnAtCatchUp);
  }, 60_000);
});
