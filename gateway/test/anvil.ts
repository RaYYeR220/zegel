import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';

export interface AnvilHandle {
  readonly url: string;
  stop(): Promise<void>;
}

/** Asks the OS for a port nobody is using, so parallel runs do not collide. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'string' || address === null) {
        server.close();
        reject(new Error('could not determine a free port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

/** True when anvil is on PATH. The contract cross-check is skipped when it is not. */
export function anvilAvailable(): boolean {
  try {
    return spawnSync('anvil', ['--version'], { encoding: 'utf8' }).status === 0;
  } catch {
    return false;
  }
}

export async function startAnvil(): Promise<AnvilHandle> {
  const port = await freePort();
  const child: ChildProcess = spawn('anvil', ['--port', String(port), '--silent'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`anvil exited with ${child.exitCode}: ${stderr}`);
    }
    if (await rpcReady(url)) break;
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`anvil did not become ready within 30s: ${stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return {
    url,
    async stop() {
      if (child.exitCode !== null) return;
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        child.kill();
        setTimeout(resolve, 3000).unref();
      });
    },
  };
}

async function rpcReady(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    });
    return response.ok;
  } catch {
    return false;
  }
}
