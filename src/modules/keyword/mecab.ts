import { once } from 'node:events';
import { text as streamText } from 'node:stream/consumers';
import { spawn } from 'child_process';
import { EOL } from 'os';

/**
 * MeCab を実行して形態素解析結果を返す。
 *
 * 以前は memory-streams で標準出力をバッファリングしていたが、
 * Node 標準の stream/consumers で置き換えた。
 */
export async function mecab(
  text: string,
  mecabPath = 'mecab',
  dic?: string
): Promise<string[][]> {
  const args: string[] = [];
  if (dic) args.push('-d', dic);

  const lines = await cmd(
    mecabPath,
    args,
    `${text.replace(/[\n\s\t]/g, ' ')}\n`
  );

  const results: string[][] = [];

  for (const line of lines) {
    if (line === 'EOS') break;
    if (line === '') continue;

    const [word, value = ''] = line.split('\t');
    const array = value.split(',');
    array.unshift(word);
    results.push(array);
  }

  return results;
}

export async function cmd(
  command: string,
  args: string[],
  stdin: string
): Promise<string[]> {
  const child = spawn(command, args);

  const stdoutPromise = streamText(child.stdout);
  const stderrPromise = streamText(child.stderr);

  child.stdin.write(stdin);
  child.stdin.end();

  const [exitCode] = (await once(child, 'close')) as [number | null];
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);

  if (exitCode !== 0) {
    throw new Error(
      `mecab exited with code ${exitCode ?? 'unknown'}: ${stderr.trim()}`
    );
  }

  return stdout.split(EOL);
}
