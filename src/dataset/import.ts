import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { readTavernTurns } from '../advisors/tavern/turns.js';
import { CONTRIB_DIR, DATASET_DIR } from '../app/paths.js';
import { GZ_SUFFIX, META_SUFFIX, sessionOfFile, type SessionMeta } from '../collector/archive.js';
import { EXPORT_FORMAT, type ExportManifest } from '../collector/export.js';
import { readTar } from '../collector/tar.js';
import { SOURCE_OF_TRUTH } from '../parser/blocks.js';
import { parseLogLine, splitLogLines } from '../parser/logLine.js';
import { reduceLog } from '../state/reducer.js';
import { BATTLEGROUNDS_GAME_TYPE as BG_GAME_TYPE } from '../state/types.js';
import { gameSignature, type DatasetRecord } from './recorder.js';

/**
 * Приём архива логов от исполнителя: `hsbg-logs_….tar` → записи датасета.
 *
 * Вторая половина цикла «передать ПО — получить данные». Первая
 * (`collector/`) кладёт в контейнер сырые Power.log по сессиям клиента;
 * здесь они режутся на партии, прогоняются ТЕМ ЖЕ пакетным путём, что
 * досбор из фикстур (`reduceLog` + `readTavernTurns`), и превращаются
 * в `DatasetRecord` с пометкой, чья партия.
 *
 * ## Что принимается, а что нет — и вслух
 *
 * Исполнителю платят за партии, поэтому счёт принятого обязан быть честным
 * и объяснимым:
 *
 * - **обрыв** — лог кончился раньше FINAL_GAMEOVER: клиент закрыт посреди
 *   партии, либо не снят предел 10 000 КБ и лог оборван игрой. Финального
 *   места нет — учиться не на чем;
 * - **нет точек решения** — подключение к самому финалу (то же правило,
 *   что у живого рекордера);
 * - **дубль** — партия уже в датасете: тот же отпечаток `gameSignature`.
 *   Повторный экспорт присылает те же сессии полнее, и это норма, а не
 *   попытка сдать одно дважды;
 * - **не разобран** — редьюсер упал: сегмент без объявления своего
 *   игрока, чужой формат, обрезанный файл.
 *
 * Сегмент, начинающийся не с первого хода (переподключение — дамп
 * с CREATE_GAME посреди партии), принимается с пометкой `partial`:
 * живой рекордер такие партии тоже пишет, а фикстура part1 из четырёх
 * таких кусков и состоит.
 *
 * ## Что кладётся куда
 *
 * Сырой архив распаковывается в `contrib/<псевдоним>/<имя архива>/`
 * как пришёл — это сырьё для фикстур (партия исполнителя, где советник
 * ошибся, становится `partN` без преобразований). Записи ложатся
 * в общий каталог датасета с префиксом `c-<псевдоним>_` и полем
 * `contributor`: загрузчик фазы 6 читает каталог плоско и ничего о них
 * знать не обязан, а отличить свои от чужих можно по полю.
 *
 * Псевдоним — из ключа `--from`, иначе BattleTag игрока из самого лога
 * (`GameState.playerBattleTag`, `#` → `-`): в логе он есть всегда, и это
 * та же величина, по которой парсер отличает «кто я».
 */

export interface ImportedGame {
  readonly session: string;
  /** Порядковый номер партии в сессии, с единицы. */
  readonly index: number;
  readonly fileName: string;
  readonly finalPlace: number;
  readonly buildNumber: number | null;
  readonly checkpoints: number;
  /** Первая точка решения не на первом ходу — сегмент переподключения. */
  readonly partial: boolean;
  readonly overlay: boolean | null;
}

export type SkipReason = 'не Battlegrounds' | 'обрыв' | 'нет точек решения' | 'дубль' | 'не разобран';

/**
 * Режим партии — строка `GameType=…` канала `DebugPrintGame` сразу после
 * CREATE_GAME. У Battlegrounds это `GT_BATTLEGROUNDS` (part1, part7,
 * part33); первый же архив игрока принёс сессию из четырёх партий
 * `GT_RANKED` — обычный Standard, — и без этой проверки они шли
 * в отчёт как «обрыв на ходу 22», то есть как вина исполнителя.
 * У сегмента переподключения строки может не быть — тогда режим
 * неизвестен, и партия идёт в разбор как есть.
 */
export { BATTLEGROUNDS_GAME_TYPE } from '../state/types.js';

export function gameTypeOf(text: string): string | null {
  const m = /GameState\.DebugPrintGame\(\) - GameType=(\w+)/.exec(text);
  return m?.[1] ?? null;
}

export interface SkippedGame {
  readonly session: string;
  readonly index: number;
  readonly reason: SkipReason;
  readonly detail: string;
}

export interface ImportReport {
  readonly archive: string;
  readonly alias: string;
  readonly rating: number | null;
  readonly appVersion: string;
  readonly sessions: number;
  readonly accepted: readonly ImportedGame[];
  readonly skipped: readonly SkippedGame[];
  /** Куда распакован сырой архив. */
  readonly rawDir: string;
}

export interface ImportOptions {
  readonly datasetDir: string;
  readonly contribDir: string;
  /** Псевдоним исполнителя; без него — BattleTag из лога. */
  readonly alias: string | null;
  /** Рейтинг со слов исполнителя; в логе его нет. */
  readonly rating: number | null;
  /**
   * Свои партии, сыгранные через установленное приложение: записи без
   * поля `contributor` (отсутствие и значит «своя», как у живого
   * рекордера), сырой архив — в `contrib/own/`. Нужно потому, что
   * сборка пишет записи в `%LOCALAPPDATA%`, а не в датасет репозитория,
   * а в режиме сборщика не пишет их вовсе — единственный путь своих
   * партий в датасет теперь тот же архив.
   */
  readonly own: boolean;
  readonly now: () => Date;
}

export const OWN_ALIAS = 'own';

export const DEFAULT_IMPORT_OPTIONS: ImportOptions = {
  datasetDir: DATASET_DIR,
  contribDir: CONTRIB_DIR,
  alias: null,
  rating: null,
  own: false,
  now: () => new Date(),
};

function isCreateGame(raw: string): boolean {
  // Та же проверка, что у живого потока: строка канала-источника, а не
  // PowerTaskList, где то же слово дублируется.
  const line = parseLogLine(raw);
  return line !== null && line.source === SOURCE_OF_TRUTH && line.content === 'CREATE_GAME';
}

/**
 * Лог сессии → тексты партий: каждая начинается со своего CREATE_GAME.
 * Строки до первого CREATE_GAME (прогрев клиента) отбрасываются.
 */
export function splitGames(text: string): string[] {
  const games: string[][] = [];
  let current: string[] | null = null;
  for (const raw of splitLogLines(text)) {
    if (isCreateGame(raw)) {
      current = [];
      games.push(current);
    }
    current?.push(raw);
  }
  return games.map((lines) => lines.join('\n'));
}

/** Псевдоним из BattleTag: `AngryMem#2886` → `AngryMem-2886`; постороннее вычищается. */
export function aliasOf(battleTag: string): string {
  const cleaned = battleTag.replace('#', '-').replace(/[^\p{L}\p{N}_-]/gu, '');
  return /[\p{L}\p{N}]/u.test(cleaned) ? cleaned : 'unknown';
}

/** `Hearthstone_2026_08_28_01_07_50` → `2026-08-28T01-07-50`. */
export function sessionStamp(session: string): string {
  const m = /^Hearthstone_(\d{4})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_(\d{2})$/.exec(session);
  if (m === null) return session;
  return `${m[1] ?? ''}-${m[2] ?? ''}-${m[3] ?? ''}T${m[4] ?? ''}-${m[5] ?? ''}-${m[6] ?? ''}`;
}

/** Отпечатки партий, уже лежащих в датасете, — любым путём записи. */
export function existingSignatures(datasetDir: string): Set<string> {
  const signatures = new Set<string>();
  if (!existsSync(datasetDir)) return signatures;
  for (const fileName of readdirSync(datasetDir)) {
    if (!fileName.endsWith('.json')) continue;
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(datasetDir, fileName), 'utf8'));
      if (typeof parsed !== 'object' || parsed === null) continue;
      if (!Array.isArray((parsed as { checkpoints?: unknown }).checkpoints)) continue;
      signatures.add(gameSignature(parsed as DatasetRecord));
    } catch {
      continue;
    }
  }
  return signatures;
}

interface ParsedGame {
  readonly session: string;
  readonly index: number;
  readonly overlay: boolean | null;
  readonly record: DatasetRecord | null;
  readonly battleTag: string | null;
  readonly skip: { reason: SkipReason; detail: string } | null;
}

function parseGame(session: string, index: number, text: string, overlay: boolean | null, now: Date): ParsedGame {
  const base = { session, index, overlay };
  const gameType = gameTypeOf(text);
  if (gameType !== null && gameType !== BG_GAME_TYPE) {
    return { ...base, record: null, battleTag: null, skip: { reason: 'не Battlegrounds', detail: gameType } };
  }
  let record: DatasetRecord;
  let battleTag: string | null;
  try {
    const finalState = reduceLog(text);
    const checkpoints = readTavernTurns(text);
    battleTag = finalState.playerBattleTag;
    if (finalState.phase !== 'gameOver' || finalState.finalPlace === null) {
      return {
        ...base,
        record: null,
        battleTag,
        skip: { reason: 'обрыв', detail: `лог кончился на ходу ${String(finalState.turn)}` },
      };
    }
    if (checkpoints.length === 0) {
      return { ...base, record: null, battleTag, skip: { reason: 'нет точек решения', detail: '' } };
    }
    record = {
      savedAt: now.toISOString(),
      buildNumber: finalState.buildNumber,
      heroCardId: finalState.hero?.cardId ?? null,
      finalPlace: finalState.finalPlace,
      checkpoints,
      actions: finalState.actions,
    };
  } catch (error) {
    return {
      ...base,
      record: null,
      battleTag: null,
      skip: { reason: 'не разобран', detail: error instanceof Error ? error.message : String(error) },
    };
  }
  return { ...base, record, battleTag, skip: null };
}

export function importArchive(tarPath: string, overrides: Partial<ImportOptions> = {}): ImportReport {
  const options = { ...DEFAULT_IMPORT_OPTIONS, ...overrides };
  const entries = readTar(readFileSync(tarPath));

  const manifestEntry = entries.find((e) => e.name === 'manifest.json');
  if (manifestEntry === undefined) throw new Error(`в ${tarPath} нет manifest.json — это не архив сборщика`);
  const manifest = JSON.parse(manifestEntry.data.toString('utf8')) as ExportManifest;
  const format: unknown = manifest.format;
  if (format !== EXPORT_FORMAT) {
    throw new Error(`формат архива «${String(format)}», умею только «${EXPORT_FORMAT}»`);
  }

  const metas = new Map<string, SessionMeta>();
  for (const entry of entries) {
    if (!entry.name.endsWith(META_SUFFIX)) continue;
    metas.set(sessionOfFile(entry.name) ?? '', JSON.parse(entry.data.toString('utf8')) as SessionMeta);
  }

  // Сначала разбор всех партий: псевдоним без ключа берётся из лога.
  const now = options.now();
  const parsed: ParsedGame[] = [];
  const logs = entries.filter((e) => e.name.endsWith(GZ_SUFFIX)).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of logs) {
    const session = sessionOfFile(entry.name) ?? entry.name;
    const overlay = metas.get(session)?.overlay ?? null;
    const games = splitGames(gunzipSync(entry.data).toString('utf8'));
    games.forEach((text, i) => {
      parsed.push(parseGame(session, i + 1, text, overlay, now));
    });
  }

  const tagged = parsed.find((g) => g.battleTag !== null)?.battleTag ?? null;
  const alias = options.own
    ? OWN_ALIAS
    : (options.alias ?? (tagged === null ? 'unknown' : aliasOf(tagged)));

  // Сырой архив — как пришёл: это сырьё для фикстур.
  const rawDir = join(options.contribDir, alias, basename(tarPath, '.tar'));
  mkdirSync(rawDir, { recursive: true });
  for (const entry of entries) writeFileSync(join(rawDir, basename(entry.name)), entry.data);

  mkdirSync(options.datasetDir, { recursive: true });
  const known = existingSignatures(options.datasetDir);
  const accepted: ImportedGame[] = [];
  const skipped: SkippedGame[] = [];

  for (const game of parsed) {
    if (game.skip !== null || game.record === null) {
      skipped.push({
        session: game.session,
        index: game.index,
        reason: game.skip?.reason ?? 'не разобран',
        detail: game.skip?.detail ?? '',
      });
      continue;
    }

    const record: DatasetRecord = {
      ...game.record,
      ...(options.own ? {} : { contributor: alias }),
      ...(options.rating === null || options.own ? {} : { contributorRating: options.rating }),
      ...(game.overlay === null ? {} : { overlay: game.overlay }),
    };
    const signature = gameSignature(record);
    if (known.has(signature)) {
      skipped.push({ session: game.session, index: game.index, reason: 'дубль', detail: 'уже в датасете' });
      continue;
    }
    known.add(signature);

    const place = record.finalPlace ?? 0;
    const fileName =
      `${options.own ? OWN_ALIAS : `c-${alias}`}_${sessionStamp(game.session)}_g${String(game.index)}` +
      `_b${String(record.buildNumber ?? 'unknown')}_p${String(place)}.json`;
    writeFileSync(join(options.datasetDir, fileName), JSON.stringify(record), 'utf8');

    accepted.push({
      session: game.session,
      index: game.index,
      fileName,
      finalPlace: place,
      buildNumber: record.buildNumber,
      checkpoints: record.checkpoints.length,
      partial: (record.checkpoints[0]?.turn ?? 1) > 1,
      overlay: game.overlay,
    });
  }

  return {
    archive: basename(tarPath),
    alias,
    rating: options.rating,
    appVersion: manifest.appVersion,
    sessions: logs.length,
    accepted,
    skipped,
    rawDir,
  };
}

/** Отчёт словами — для терминала и для сообщения исполнителю. */
export function formatReport(report: ImportReport): string {
  const lines: string[] = [];
  lines.push(
    `${report.archive}: ${report.alias === OWN_ALIAS ? 'свои партии' : `исполнитель ${report.alias}`}` +
      (report.rating === null ? '' : `, рейтинг ${String(report.rating)}`) +
      `, приложение ${report.appVersion}, сессий ${String(report.sessions)}`,
  );
  for (const g of report.accepted) {
    lines.push(
      `  + ${g.session} #${String(g.index)}: место ${String(g.finalPlace)}, ` +
        `билд ${String(g.buildNumber ?? '—')}, точек ${String(g.checkpoints)}` +
        (g.partial ? ', с переподключения' : '') +
        (g.overlay === true ? ', с оверлеем' : '') +
        ` → ${g.fileName}`,
    );
  }
  for (const s of report.skipped) {
    lines.push(`  - ${s.session} #${String(s.index)}: ${s.reason}${s.detail === '' ? '' : ` (${s.detail})`}`);
  }
  const counts = new Map<SkipReason, number>();
  for (const s of report.skipped) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1);
  const skippedText = [...counts].map(([reason, n]) => `${reason} ${String(n)}`).join(', ');
  lines.push(
    `принято партий: ${String(report.accepted.length)}` +
      (skippedText === '' ? '' : `; пропущено: ${skippedText}`) +
      `; сырой архив в ${report.rawDir}`,
  );
  return lines.join('\n');
}
