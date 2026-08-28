import { dirname } from 'node:path';

import { ensureLogSizeLimit, inspectClientConfig } from '../watcher/clientConfig.js';
import { ensurePowerLogging, inspectLogConfig } from '../watcher/logConfig.js';

/**
 * Проверка и починка настроек игры при запуске помощника.
 *
 * ТЗ требует, чтобы приложение чинило их само: конфигов два, лежат они
 * в разных местах, и оба переживают не всякое обновление Hearthstone.
 * Требовать от игрока правки ini-файлов — верный способ получить
 * неработающего помощника и виноватого игрока.
 *
 * Оба конфига читаются клиентом ОДИН раз при старте, поэтому любая починка
 * означает «перезапустите игру», и сказать это надо прямо.
 */

export interface SetupProblem {
  readonly text: string;
  /** Нужен ли перезапуск клиента, чтобы починка подействовала. */
  readonly needsRestart: boolean;
  /**
   * Починка не удалась из-за прав: каталог игры пишется только
   * администратором. Приложение в сборке по этому флагу перезапускает
   * себя через UAC с ключом `--setup` (`app/elevate.ts`).
   */
  readonly needsElevation?: boolean;
}

export function checkGameSetup(logsRoot: string): SetupProblem | null {
  const logging = checkPowerLogging();
  if (logging !== null) return logging;
  return checkSizeLimit(logsRoot);
}

function checkPowerLogging(): SetupProblem | null {
  if (inspectLogConfig().powerToFile) return null;

  try {
    return ensurePowerLogging()
      ? { text: 'включил запись Power.log — перезапустите Hearthstone', needsRestart: true }
      : null;
  } catch {
    return { text: 'не вышло включить запись Power.log в log.config', needsRestart: false };
  }
}

function checkSizeLimit(logsRoot: string): SetupProblem | null {
  // Каталог игры — родительский для каталога логов.
  const installDir = dirname(logsRoot);

  try {
    if (inspectClientConfig(installDir).sufficient) return null;
    return ensureLogSizeLimit(installDir)
      ? { text: 'снял предел размера логов — перезапустите Hearthstone', needsRestart: true }
      : { text: 'предел размера логов мал, поправить не вышло', needsRestart: false };
  } catch {
    // Запись в каталог игры требует прав. Отказ ожидаем и падением
    // приложения быть не должен: без починки помощник работает, просто
    // лог оборвётся на десяти мегабайтах.
    return {
      text: 'не хватило прав поправить client.config — запустите от администратора',
      needsRestart: false,
      needsElevation: true,
    };
  }
}

/**
 * Что сказать, когда папка сессии есть, а Power.log в ней ещё нет.
 *
 * Клиент создаёт файл лениво: в сессии от 12.08 он стартовал в 21:17:17,
 * а первая строка лога датирована 21:18:34. Поэтому обычная причина —
 * «игра в меню», а вовсе не «логирование выключено», и пугать игрока
 * настройками, которые в порядке, нельзя.
 */
export function waitingForLogText(sessionDir: string): string {
  return inspectLogConfig().powerToFile
    ? 'Hearthstone запущен, жду начала партии'
    : `запись Power.log выключена — проверьте log.config (сессия ${sessionDir})`;
}
