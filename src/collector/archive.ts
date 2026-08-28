import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { appendFile, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

import { findLatestSession, listSessions, POWER_LOG_NAME, type LogSession } from '../watcher/logPaths.js';
import { FileTailer } from '../watcher/tail.js';

/**
 * Архив Power.log по сессиям клиента — то, что исполнитель присылает.
 *
 * ## Почему сырой лог, а не записи датасета
 *
 * Записи датасета (`data/dataset/*.json`) — производная от редьюсера ТОЙ
 * версии приложения, что стояла у игрока. Редьюсер меняется еженедельно:
 * `lobby` вошёл в состояние 18.08, `actions` — 19.08 (и их пришлось
 * досыпать из фикстур), `heroPowerScriptData` — 28.08. Запись старой сборки
 * не обновить, лог перечитывается любой будущей версией — ровно это
 * и делает `dataset:backfill`. Лог к тому же и есть формат фикстур проекта,
 * не зависит от свежести снапшота карт и жмётся в двадцать раз (part33:
 * 28.8 МБ → 1.44 МБ). Записи генерируются на нашей стороне командой
 * `dataset:import`.
 *
 * ## Что делается
 *
 * Hearthstone заводит папку логов на каждый запуск клиента и в старую
 * больше не пишет (docs/power-log.md). Отсюда две ветви:
 *
 * - **завершённые сессии** (все, кроме самой свежей) сжимаются с диска
 *   как есть — «досбор»: он подбирает и партии, сыгранные, пока
 *   приложение не работало, лишь бы конфиги логирования были в порядке;
 * - **свежая сессия** тянется живьём в `.part`-копию тем же `FileTailer`,
 *   что и советник: если клиент когда-нибудь начнёт чистить старые папки,
 *   у нас останется своя копия. При смене сессии копия сжимается
 *   и досбор дожимает её с источника уже как завершённую.
 *
 * Рядом с каждым `.gz` лежит `.meta.json`: сколько байт источника
 * в нём, завершена ли сессия, шёл ли оверлей, версия приложения. Флаг
 * оверлея — не украшение: партия, сыгранная по подсказкам, для датасета
 * «как играют люди» — другой класс данных (docs/ml.md).
 *
 * Сжатие идёт потоком, а не `gzipSync`: сессия из пяти партий — полторы
 * сотни мегабайт, и держать главный поток Electron столько не стоит.
 */

export const PART_SUFFIX = '.Power.log.part';
export const GZ_SUFFIX = '.Power.log.gz';
export const META_SUFFIX = '.meta.json';

export interface SessionMeta {
  readonly session: string;
  /** Сколько байт источника лежит в `.gz`. */
  readonly sourceBytes: number;
  /** Сжато с завершённой сессии; false — снимок живой, источник мог расти дальше. */
  readonly complete: boolean;
  /** Шёл ли оверлей при записи; null — сессия сжата досбором, приложение при ней не работало. */
  readonly overlay: boolean | null;
  readonly appVersion: string;
  readonly archivedAt: string;
}

export interface ArchivedSession {
  readonly meta: SessionMeta;
  readonly gzPath: string;
  readonly metaPath: string;
  readonly gzBytes: number;
}

export type ArchiverEvent =
  | { readonly kind: 'archived'; readonly session: string; readonly sourceBytes: number }
  | { readonly kind: 'tailing'; readonly session: string }
  | { readonly kind: 'error'; readonly message: string };

export interface LogArchiverOptions {
  readonly logsRoot: string;
  readonly gamesDir: string;
  readonly appVersion: string;
  /** Читается в момент записи: оверлей переключают на ходу. */
  readonly overlay: () => boolean;
  readonly pollMs: number;
  readonly now: () => Date;
  readonly onEvent: (event: ArchiverEvent) => void;
}

export const DEFAULT_ARCHIVER_OPTIONS: Omit<LogArchiverOptions, 'logsRoot' | 'gamesDir'> = {
  appVersion: '0.0.0',
  overlay: () => false,
  // Секунда: архиву спешить некуда, а советник читает тот же файл сам.
  pollMs: 1000,
  now: () => new Date(),
  onEvent: () => undefined,
};

/** Имя сессии из имени файла архива, или null для посторонних файлов. */
export function sessionOfFile(fileName: string): string | null {
  for (const suffix of [GZ_SUFFIX, META_SUFFIX, PART_SUFFIX]) {
    if (fileName.endsWith(suffix)) return fileName.slice(0, -suffix.length);
  }
  return null;
}

async function gzipFile(source: string, target: string): Promise<void> {
  // Через временный файл: полусжатый `.gz` после сбоя выглядел бы как готовый.
  const tmp = `${target}.tmp`;
  await pipeline(createReadStream(source), createGzip({ level: 6 }), createWriteStream(tmp));
  renameSync(tmp, target);
}

export class LogArchiver {
  readonly #options: LogArchiverOptions;
  #timer: NodeJS.Timeout | null = null;
  #ticking = false;
  #stopped = false;

  #live: { session: LogSession; tailer: FileTailer; partPath: string; bytes: number } | null = null;

  constructor(options: Partial<LogArchiverOptions> & Pick<LogArchiverOptions, 'logsRoot' | 'gamesDir'>) {
    this.#options = { ...DEFAULT_ARCHIVER_OPTIONS, ...options };
  }

  get gamesDir(): string {
    return this.#options.gamesDir;
  }

  get logsRoot(): string {
    return this.#options.logsRoot;
  }

  /** Сессия, которая тянется живьём, и сколько её байт уже скопировано. */
  get live(): { readonly session: string; readonly bytes: number } | null {
    return this.#live === null ? null : { session: this.#live.session.name, bytes: this.#live.bytes };
  }

  async start(): Promise<void> {
    mkdirSync(this.#options.gamesDir, { recursive: true });
    await this.sweep();
    this.#timer = setInterval(() => void this.#tick(), this.#options.pollMs);
    await this.#tick();
  }

  /** Остановить слежение и сжать живую копию — что успели, то и сохранено. */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    await this.snapshotLive();
  }

  #metaPath(session: string): string {
    return join(this.#options.gamesDir, `${session}${META_SUFFIX}`);
  }

  #gzPath(session: string): string {
    return join(this.#options.gamesDir, `${session}${GZ_SUFFIX}`);
  }

  #readMeta(session: string): SessionMeta | null {
    const path = this.#metaPath(session);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as SessionMeta;
    } catch {
      return null;
    }
  }

  #writeMeta(meta: SessionMeta): void {
    writeFileSync(this.#metaPath(meta.session), JSON.stringify(meta, null, 2), 'utf8');
  }

  /**
   * Досбор: сжать завершённые сессии, которых в архиве ещё нет или которые
   * лежат снимком короче источника. Сирота `.part` без источника (клиент
   * почистил папку, а мы упали, не дожав) сжимается как есть.
   */
  async sweep(): Promise<string[]> {
    // Досбор зовут и без start() — экспорт из терминала; каталог обязан быть.
    mkdirSync(this.#options.gamesDir, { recursive: true });
    const archived: string[] = [];
    const sessions = listSessions(this.#options.logsRoot);
    const latest = sessions.at(-1) ?? null;

    for (const session of sessions) {
      if (session.name === latest?.name) continue;
      const source = join(session.dir, POWER_LOG_NAME);
      if (!existsSync(source)) continue;

      const size = statSync(source).size;
      const meta = this.#readMeta(session.name);
      if (meta !== null && meta.complete && meta.sourceBytes >= size) continue;

      try {
        await gzipFile(source, this.#gzPath(session.name));
        this.#writeMeta({
          session: session.name,
          sourceBytes: size,
          complete: true,
          // Флаг оверлея известен только живой записи; досбор его не выдумывает.
          overlay: meta?.overlay ?? null,
          appVersion: this.#options.appVersion,
          archivedAt: this.#options.now().toISOString(),
        });
        const part = join(this.#options.gamesDir, `${session.name}${PART_SUFFIX}`);
        if (existsSync(part)) unlinkSync(part);
        archived.push(session.name);
        this.#options.onEvent({ kind: 'archived', session: session.name, sourceBytes: size });
      } catch (error) {
        this.#options.onEvent({ kind: 'error', message: `${session.name}: ${String(error)}` });
      }
    }

    for (const fileName of readdirSync(this.#options.gamesDir)) {
      if (!fileName.endsWith(PART_SUFFIX)) continue;
      const session = sessionOfFile(fileName) ?? '';
      if (session === latest?.name) continue;
      if (sessions.some((s) => s.name === session && existsSync(join(s.dir, POWER_LOG_NAME)))) continue;
      const part = join(this.#options.gamesDir, fileName);
      try {
        const size = statSync(part).size;
        if (size > 0) {
          await gzipFile(part, this.#gzPath(session));
          this.#writeMeta({
            session,
            sourceBytes: size,
            complete: false,
            overlay: this.#readMeta(session)?.overlay ?? null,
            appVersion: this.#options.appVersion,
            archivedAt: this.#options.now().toISOString(),
          });
          archived.push(session);
          this.#options.onEvent({ kind: 'archived', session, sourceBytes: size });
        }
        unlinkSync(part);
      } catch (error) {
        this.#options.onEvent({ kind: 'error', message: `${fileName}: ${String(error)}` });
      }
    }
    return archived;
  }

  async #tick(): Promise<void> {
    if (this.#ticking || this.#stopped) return;
    this.#ticking = true;
    try {
      await this.tick();
    } catch (error) {
      this.#options.onEvent({ kind: 'error', message: String(error) });
    } finally {
      this.#ticking = false;
    }
  }

  /** Один опрос: смена сессии, дописанные байты. Открыт для тестов. */
  async tick(): Promise<void> {
    const latest = findLatestSession(this.#options.logsRoot);
    if (latest === null) return;

    if (this.#live === null || this.#live.session.name !== latest.name) {
      await this.snapshotLive();
      this.#live = null;
      // Прежняя живая сессия стала завершённой — досбор дожмёт её с источника.
      await this.sweep();
      const partPath = join(this.#options.gamesDir, `${latest.name}${PART_SUFFIX}`);
      writeFileSync(partPath, '');
      this.#live = {
        session: latest,
        tailer: new FileTailer(join(latest.dir, POWER_LOG_NAME)),
        partPath,
        bytes: 0,
      };
      this.#options.onEvent({ kind: 'tailing', session: latest.name });
    }

    const live = this.#live;
    const { data, restarted } = await live.tailer.read();
    if (restarted) {
      await truncate(live.partPath, 0);
      live.bytes = 0;
    }
    if (data.length > 0) {
      await appendFile(live.partPath, data);
      live.bytes += data.length;
    }
  }

  /**
   * Сжать живую копию сейчас, не прекращая слежения: перед экспортом
   * и при остановке. Следующий снимок перепишет `.gz` более полным.
   */
  async snapshotLive(): Promise<void> {
    const live = this.#live;
    if (live === null || live.bytes === 0) return;
    const previous = this.#readMeta(live.session.name);
    if (previous !== null && previous.sourceBytes >= live.bytes) return;

    await gzipFile(live.partPath, this.#gzPath(live.session.name));
    this.#writeMeta({
      session: live.session.name,
      sourceBytes: live.bytes,
      complete: false,
      overlay: this.#options.overlay(),
      appVersion: this.#options.appVersion,
      archivedAt: this.#options.now().toISOString(),
    });
    this.#options.onEvent({ kind: 'archived', session: live.session.name, sourceBytes: live.bytes });
  }

  /** Что лежит в архиве: по одной записи на сессию с `.gz` и `.meta.json`. */
  listArchived(): ArchivedSession[] {
    const out: ArchivedSession[] = [];
    if (!existsSync(this.#options.gamesDir)) return out;
    for (const fileName of readdirSync(this.#options.gamesDir).sort()) {
      if (!fileName.endsWith(GZ_SUFFIX)) continue;
      const session = sessionOfFile(fileName) ?? '';
      const meta = this.#readMeta(session);
      if (meta === null) continue;
      const gzPath = join(this.#options.gamesDir, fileName);
      out.push({ meta, gzPath, metaPath: this.#metaPath(session), gzBytes: statSync(gzPath).size });
    }
    return out;
  }
}
