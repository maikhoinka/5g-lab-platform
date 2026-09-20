import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';

const getFreePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  server.on('listening', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
  server.on('error', reject);
});

const waitForServer = async (port, logs) => {
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/switch-grid`);
      if (response.ok) return response;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Server did not start. Logs: ${logs.join('')}`);
};

const startServer = async () => {
  const port = await getFreePort();
  const testDb = 'E:/Portfolio/fibersync/data/test-fibersync.db';
  fs.rmSync(testDb, { force: true });
  const server = spawn(process.execPath, ['server.js'], {
    cwd: 'E:/Portfolio/fibersync',
    env: { ...process.env, PORT: String(port), DATABASE_URL: './data/test-fibersync.db' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const logs = [];
  server.stdout.on('data', (chunk) => logs.push(String(chunk)));
  server.stderr.on('data', (chunk) => logs.push(String(chunk)));

  return { server, port, logs };
};

test('switch-grid and free-port API expose the correct linked and available switch ports', async (t) => {
  const { server, port, logs } = await startServer();
  t.after(() => {
    if (!server.killed) server.kill('SIGTERM');
  });

  const response = await waitForServer(port, logs);
  const grid = await response.json();
  const linked = grid.flatMap((module) => module.ports.flatMap((port) => [port.out, port.in])).filter((port) => port.state === 'LINKED');

  assert.ok(linked.length > 0, `Expected at least one linked port on ${port}`);
  assert.ok(linked.every((port) => port.pairedWith), 'Each linked port should include pairedWith');

  const radioResponse = await fetch(`http://127.0.0.1:${port}/api/free-switch-ports?kind=RADIO`);
  assert.equal(radioResponse.status, 200, 'Radio free-port list should be available');

  const radioPorts = await radioResponse.json();
  assert.ok(Array.isArray(radioPorts), 'Radio free-port list should be an array');
  assert.ok(radioPorts.length > 0, 'At least one radio OUT port should be free');
  assert.ok(radioPorts.every((value) => /^\d+\.\d+\/\d+$/.test(value)), 'Ports should be formatted like 1.1/1');

  const testlineResponse = await fetch(`http://127.0.0.1:${port}/api/free-switch-ports?kind=TESTLINE`);
  assert.equal(testlineResponse.status, 200, 'Testline free-port list should be available');

  const testlinePorts = await testlineResponse.json();
  assert.ok(Array.isArray(testlinePorts), 'Testline free-port list should be an array');
  assert.ok(testlinePorts.length > 0, 'At least one testline IN port should be free');
});

test('deleting a testline circuit frees the BTSID for re-creation', async (t) => {
  const { server, port, logs } = await startServer();
  t.after(() => {
    if (!server.killed) server.kill('SIGTERM');
  });

  await waitForServer(port, logs);
  const freePorts = await (await fetch(`http://127.0.0.1:${port}/api/free-switch-ports?kind=TESTLINE`)).json();
  const switchPort = freePorts[0];
  const body = {
    kind: 'TESTLINE',
    btsid: '9999',
    teamId: 1,
    labId: 1,
    testlineType: 'CLASSICAL',
    device: 'Switch',
    devicePort: 'C5',
    switchPort,
    hops: [{ panelId: 3, port: 'Z99' }]
  };

  const create = await fetch(`http://127.0.0.1:${port}/api/circuits`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  assert.equal(create.status, 201, 'The first testline circuit should be created');

  const created = await create.json();
  const remove = await fetch(`http://127.0.0.1:${port}/api/circuits/${created.id}`, { method: 'DELETE' });
  assert.equal(remove.status, 204, 'Deleting the testline circuit should succeed');

  const recreate = await fetch(`http://127.0.0.1:${port}/api/circuits`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, switchPort: freePorts[1] || switchPort })
  });
  assert.equal(recreate.status, 201, 'The same BTSID should be allowed again after deleting the circuit');
});
