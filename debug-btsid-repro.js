import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1');
    server.on('listening', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

const run = async () => {
  const port = await getFreePort();
  const dbFile = path.join(process.cwd(), 'data', 'tmp-8854.db');
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(dbFile + suffix, { force: true });
  }

  const server = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), DATABASE_URL: './data/tmp-8854.db' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let logs = '';
  server.stdout.on('data', c => logs += String(c));
  server.stderr.on('data', c => logs += String(c));

  const waitForHealth = async () => {
    for (let i = 0; i < 80; i += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (response.ok) return;
      } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('server did not start: ' + logs);
  };

  try {
    await waitForHealth();
    const free = await (await fetch(`http://127.0.0.1:${port}/api/free-switch-ports?kind=TESTLINE`)).json();
    const switchPort = free[0];
    const body = {
      kind: 'TESTLINE',
      btsid: '9999',
      teamId: 1,
      labId: 1,
      testlineType: 'CLASSICAL',
      device: 'Switch',
      devicePort: 'C5',
      switchPort,
      hops: [{ panelId: 1, port: 'A1A' }]
    };

    const create1 = await fetch(`http://127.0.0.1:${port}/api/circuits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    console.log('CREATE1 status', create1.status, await create1.text());
    const created = await create1.json();
    const delete1 = await fetch(`http://127.0.0.1:${port}/api/circuits/${created.id}`, { method: 'DELETE' });
    console.log('DELETE status', delete1.status, delete1.statusText);

    const secondBody = { ...body, switchPort: free[1] || switchPort };
    const create2 = await fetch(`http://127.0.0.1:${port}/api/circuits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(secondBody)
    });
    console.log('CREATE2 status', create2.status, await create2.text());
  } finally {
    server.kill('SIGTERM');
  }
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
