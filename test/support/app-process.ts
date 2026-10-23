import type { Subprocess } from 'bun';

export interface AppProcess {
  url: string;
  proc: Subprocess<'ignore', 'pipe', 'pipe'>;
  output: () => string;
  /** Sends the signal and resolves with the exit code. */
  kill: (signal?: NodeJS.Signals) => Promise<number | null>;
}

export async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port ?? 0;
  await probe.stop(true);
  return port;
}

async function collect(stream: ReadableStream<Uint8Array>, sink: string[]): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of stream) sink.push(decoder.decode(chunk));
}

/** Starts `bun src/main.ts` as a real OS process, the way an orchestrator would, and waits for liveness. */
export async function startApp(env: Record<string, string>, timeoutMs = 30_000): Promise<AppProcess> {
  const port = await freePort();
  const lines: string[] = [];
  const proc = Bun.spawn(['bun', 'src/main.ts'], {
    env: { ...process.env, ...env, PORT: String(port) },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  void collect(proc.stdout, lines);
  void collect(proc.stderr, lines);

  const url = `http://localhost:${String(port)}`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${url}/health/live`);
      if (res.ok) break;
    } catch {
      // not listening yet
    }
    if (proc.exitCode !== null || Date.now() > deadline) {
      throw new Error(`app did not start (exit ${String(proc.exitCode)}):\n${lines.join('')}`);
    }
    await Bun.sleep(100);
  }

  return {
    url,
    proc,
    output: () => lines.join(''),
    kill: async (signal = 'SIGTERM') => {
      proc.kill(signal);
      return proc.exited;
    },
  };
}
