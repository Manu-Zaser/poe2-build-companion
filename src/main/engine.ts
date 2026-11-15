import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { log } from './log';

/**
 * Client for the calculation engine (dist/engine.js): a long-running child process that hosts
 * Path of Building. One request at a time is processed by the engine; requests are queued here.
 */
export class Engine {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private readyPromise: Promise<void> | null = null;
  private stderrTail: string[] = [];

  constructor(
    private readonly script: string,
    private readonly pobDir: string,
  ) {}

  /** Starts the engine (once). Resolves when PoB has finished loading. */
  start(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      // The Electron binary runs as plain Node with this flag – no extra runtime to ship.
      const child = spawn(process.execPath, [this.script], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', POB_DIR: this.pobDir },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.child = child;
      let ready = false;

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (d: string) => {
        this.stderrTail.push(d);
        if (this.stderrTail.length > 50) this.stderrTail.shift();
      });

      const lines = createInterface({ input: child.stdout });
      lines.on('line', (line) => {
        let msg: { ready?: boolean; fatal?: string; startupMs?: number; id?: number; result?: unknown; ms?: number };
        try {
          msg = JSON.parse(line);
        } catch {
          log(`engine: unexpected output ${line.slice(0, 200)}`);
          return;
        }
        if (!ready) {
          if (msg.ready) {
            ready = true;
            log(`engine: ready in ${msg.startupMs} ms`);
            resolve();
          } else {
            reject(new Error(msg.fatal ?? 'The calculation engine did not start.'));
          }
          return;
        }
        const p = msg.id !== undefined ? this.pending.get(msg.id) : undefined;
        if (!p) return;
        this.pending.delete(msg.id!);
        clearTimeout(p.timer);
        const result = msg.result as { error?: string } | undefined;
        if (result && typeof result === 'object' && !Array.isArray(result) && typeof result.error === 'string') {
          p.reject(new Error(result.error));
        } else {
          p.resolve({ result, ms: msg.ms });
        }
      });

      child.on('error', (err) => {
        log(`engine: spawn error ${err.message}`);
        if (!ready) reject(err);
      });
      child.on('exit', (code) => {
        log(`engine: exited with ${code}\n${this.stderrTail.join('').slice(-2000)}`);
        const err = new Error('The calculation engine stopped unexpectedly.');
        if (!ready) reject(err);
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(err);
        }
        this.pending.clear();
        this.child = null;
        this.readyPromise = null; // the next call starts a fresh engine
      });
    });
    return this.readyPromise;
  }

  async request<T>(cmd: string, args: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<{ result: T; ms: number }> {
    await this.start();
    const child = this.child;
    if (!child) throw new Error('The calculation engine is not running.');
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The calculation engine did not answer "${cmd}" in time.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      child.stdin.write(JSON.stringify({ ...args, id, cmd }) + '\n');
    });
  }

  stop() {
    this.child?.stdin.end();
    this.child = null;
  }
}
