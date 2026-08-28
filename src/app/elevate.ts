import { spawnSync } from 'node:child_process';

/**
 * Запуск себя же с правами администратора — ради одного файла.
 *
 * `client.config` лежит в каталоге игры (Program Files), и без него лог
 * обрывается на 10 000 КБ — партия не долетает до конца, и на приёме
 * такую отбраковывают. Писать туда без повышения прав нельзя, а говорить
 * исполнителю «запустите от администратора» — значит, что он этого
 * не сделает. Поэтому приложение перезапускает само себя с ключом
 * `--setup` через UAC: пользователь видит один запрос с именем нашей
 * программы, повышенный экземпляр правит файл и выходит.
 *
 * Делается это PowerShell-ом (`Start-Process -Verb RunAs`): другого
 * штатного способа запросить UAC из Node на Windows нет. Команда
 * собирается отдельной функцией, чтобы кавычки были проверены тестом,
 * а не глазами: одинарная кавычка внутри одинарных в PowerShell удваивается.
 */

export interface Command {
  readonly file: string;
  readonly args: readonly string[];
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function elevationCommand(exe: string, args: readonly string[]): Command {
  const list = args.length === 0 ? '' : ` -ArgumentList @(${args.map(psQuote).join(',')})`;
  const script =
    `$p = Start-Process -FilePath ${psQuote(exe)}${list} -Verb RunAs -Wait -PassThru; ` +
    'exit $p.ExitCode';
  return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', script] };
}

/** true — повышенный экземпляр отработал с нулевым кодом. Отказ в UAC — false. */
export function runElevated(exe: string, args: readonly string[]): boolean {
  const command = elevationCommand(exe, args);
  const result = spawnSync(command.file, [...command.args], { windowsHide: true, stdio: 'ignore' });
  return result.status === 0;
}
