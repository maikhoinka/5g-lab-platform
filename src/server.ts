import 'dotenv/config';
import express, { NextFunction, Request, Response } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ConnectionStatus, NodeStatus, NodeType, Prisma } from '@prisma/client';
import { prisma } from './prisma.js';
// @ts-ignore: the existing project does not include @types/better-sqlite3.
import Database from 'better-sqlite3';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 3000);
const databaseFile = (process.env.SQLITE_DATABASE_URL || './data/fibersync.db').replace(/^sqlite:(\/\/)?/, '');
const publicDirectory = path.resolve(here, '../public');

fs.mkdirSync(path.dirname(path.resolve(databaseFile)), { recursive: true });
const db = new Database(databaseFile);
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');

db.exec(`CREATE TABLE IF NOT EXISTS teams(id INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE);CREATE TABLE IF NOT EXISTS labs(id INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE);CREATE TABLE IF NOT EXISTS racks(id INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE,lab_id INTEGER REFERENCES labs(id));CREATE TABLE IF NOT EXISTS patch_panels(id INTEGER PRIMARY KEY,name TEXT NOT NULL,rack_id INTEGER NOT NULL REFERENCES racks(id),unit TEXT NOT NULL,UNIQUE(rack_id,unit,name));CREATE TABLE IF NOT EXISTS radios(id INTEGER PRIMARY KEY,serial_number TEXT NOT NULL UNIQUE);CREATE TABLE IF NOT EXISTS testlines(id INTEGER PRIMARY KEY,btsid TEXT NOT NULL UNIQUE CHECK(length(btsid)=4),type TEXT NOT NULL DEFAULT 'CLASSICAL',device TEXT NOT NULL,device_port TEXT NOT NULL);CREATE TABLE IF NOT EXISTS circuits(id INTEGER PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN('RADIO','TESTLINE')),radio_id INTEGER UNIQUE REFERENCES radios(id),testline_id INTEGER UNIQUE REFERENCES testlines(id),team_id INTEGER REFERENCES teams(id),lab_id INTEGER REFERENCES labs(id),switch_port TEXT NOT NULL UNIQUE,switch_side TEXT NOT NULL CHECK(switch_side IN('OUT','IN')),created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,CHECK((kind='RADIO' AND radio_id IS NOT NULL AND testline_id IS NULL AND switch_side='OUT') OR (kind='TESTLINE' AND testline_id IS NOT NULL AND radio_id IS NULL AND switch_side='IN')));CREATE TABLE IF NOT EXISTS circuit_hops(id INTEGER PRIMARY KEY,circuit_id INTEGER NOT NULL REFERENCES circuits(id) ON DELETE CASCADE,position INTEGER NOT NULL,panel_id INTEGER NOT NULL REFERENCES patch_panels(id),port TEXT NOT NULL,UNIQUE(circuit_id,position),UNIQUE(panel_id,port));CREATE TABLE IF NOT EXISTS e2e_links(id INTEGER PRIMARY KEY,radio_circuit_id INTEGER NOT NULL UNIQUE REFERENCES circuits(id) ON DELETE CASCADE,testline_circuit_id INTEGER NOT NULL UNIQUE REFERENCES circuits(id) ON DELETE CASCADE,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`);

const one = (sql: string, ...args: unknown[]): any => db.prepare(sql).get(...args);
const run = (sql: string, ...args: unknown[]): any => db.prepare(sql).run(...args);

function cleanOrphanedRecords(): void {
  db.transaction(() => {
    run('DELETE FROM e2e_links WHERE radio_circuit_id NOT IN (SELECT id FROM circuits) OR testline_circuit_id NOT IN (SELECT id FROM circuits)');
    run('DELETE FROM testlines WHERE id NOT IN (SELECT testline_id FROM circuits WHERE testline_id IS NOT NULL)');
    run('DELETE FROM radios WHERE id NOT IN (SELECT radio_id FROM circuits WHERE radio_id IS NOT NULL)');
  })();
}

function cleanDanglingDuplicates(kind: string, value: string): void {
  if (kind === 'RADIO') {
    run('DELETE FROM radios WHERE serial_number=? AND id NOT IN (SELECT radio_id FROM circuits WHERE radio_id IS NOT NULL)', value);
    return;
  }
  run('DELETE FROM testlines WHERE btsid=? AND id NOT IN (SELECT testline_id FROM circuits WHERE testline_id IS NOT NULL)', value);
}

if (!one('SELECT id FROM teams LIMIT 1')) {
  db.transaction(() => {
    run('INSERT INTO teams(name) VALUES(?)', 'RF Lab');
    run('INSERT INTO teams(name) VALUES(?)', 'RAN Validation');
    run('INSERT INTO labs(name) VALUES(?)', 'L4-01');
    run('INSERT INTO labs(name) VALUES(?)', 'L4-04');
    run('INSERT INTO racks(name,lab_id) VALUES(?,?)', 'R2810', 1);
    run('INSERT INTO racks(name,lab_id) VALUES(?,?)', 'R2815', 2);
    run('INSERT INTO patch_panels(name,rack_id,unit) VALUES(?,?,?)', 'Front cassette A', 1, 'U23');
    run('INSERT INTO patch_panels(name,rack_id,unit) VALUES(?,?,?)', 'Back cassette B', 1, 'U42');
    run('INSERT INTO patch_panels(name,rack_id,unit) VALUES(?,?,?)', 'Testline panel', 2, 'U08');
    run('INSERT INTO radios(serial_number) VALUES(?)', 'SN-A4412');
    run("INSERT INTO testlines(btsid,type,device,device_port) VALUES('1001','CLASSICAL','Switch','C5')");
    run("INSERT INTO circuits(kind,radio_id,team_id,lab_id,switch_port,switch_side) VALUES('RADIO',1,1,1,'1.1/1','OUT')");
    run("INSERT INTO circuits(kind,testline_id,team_id,lab_id,switch_port,switch_side) VALUES('TESTLINE',1,2,2,'4.7/1','IN')");
    run('INSERT INTO circuit_hops(circuit_id,position,panel_id,port) VALUES(?,?,?,?)', 1, 1, 1, 'A1A');
    run('INSERT INTO circuit_hops(circuit_id,position,panel_id,port) VALUES(?,?,?,?)', 1, 2, 2, 'B2A');
    run('INSERT INTO circuit_hops(circuit_id,position,panel_id,port) VALUES(?,?,?,?)', 2, 1, 3, 'E5A');
    run('INSERT INTO e2e_links(radio_circuit_id,testline_circuit_id) VALUES(?,?)', 1, 2);
  })();
}

cleanOrphanedRecords();
app.use(express.json());

const circuitSelect = `SELECT c.id,c.kind,c.radio_id radioId,c.testline_id testlineId,c.switch_port switchPort,c.switch_side switchSide,r.serial_number serialNumber,t.btsid,t.type testlineType,t.device,t.device_port devicePort,tm.name team,l.name lab FROM circuits c LEFT JOIN radios r ON r.id=c.radio_id LEFT JOIN testlines t ON t.id=c.testline_id LEFT JOIN teams tm ON tm.id=c.team_id LEFT JOIN labs l ON l.id=c.lab_id`;

function getCircuit(id: number): any {
  const result = one(`${circuitSelect} WHERE c.id=?`, id);
  if (result) result.hops = db.prepare('SELECT h.id,h.position,h.port,p.name panel,p.unit,r.name rack FROM circuit_hops h JOIN patch_panels p ON p.id=h.panel_id JOIN racks r ON r.id=p.rack_id WHERE h.circuit_id=? ORDER BY h.position').all(id);
  return result;
}

function required<T>(value: T, label: string): T {
  if (!value) throw Error(`${label} is required.`);
  return value;
}

app.get('/health', async (_req, res) => {
  try {
    one('SELECT 1');
    res.json({ status: 'ok', database: 'connected' });
  } catch {
    res.status(503).json({ status: 'error', database: 'unavailable' });
  }
});

const nodeTypes = new Set(Object.values(NodeType));
const nodeStatuses = new Set(Object.values(NodeStatus));
const connectionStatuses = new Set(Object.values(ConnectionStatus));
function isNonEmptyString(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }

app.get('/', (_req, res) => res.sendFile(path.join(publicDirectory, 'index.html')));
app.get('/api/nodes', async (_req, res) => res.json(await prisma.node.findMany({ orderBy: { createdAt: 'desc' } })));
app.post('/api/nodes', async (req, res) => {
  const { name, type, location, status = NodeStatus.ACTIVE } = req.body;
  if (!isNonEmptyString(name) || !isNonEmptyString(location) || !nodeTypes.has(type) || !nodeStatuses.has(status)) return res.status(400).json({ error: 'name, type, location, and a valid optional status are required' });
  res.status(201).json(await prisma.node.create({ data: { name: name.trim(), type, location: location.trim(), status } }));
});
app.get('/api/connections', async (_req, res) => res.json(await prisma.connection.findMany({ include: { sourceNode: true, targetNode: true }, orderBy: { createdAt: 'desc' } })));
app.post('/api/connections', async (req, res) => {
  const { sourceNodeId, targetNodeId, fiberCount, status = ConnectionStatus.ACTIVE, notes } = req.body;
  if (!isNonEmptyString(sourceNodeId) || !isNonEmptyString(targetNodeId) || sourceNodeId === targetNodeId || !Number.isInteger(fiberCount) || fiberCount <= 0 || !connectionStatuses.has(status) || (notes !== undefined && notes !== null && typeof notes !== 'string')) return res.status(400).json({ error: 'Valid distinct node IDs, a positive integer fiberCount, and a valid optional status are required' });
  res.status(201).json(await prisma.connection.create({ data: { sourceNodeId, targetNodeId, fiberCount, status, notes: notes?.trim() || null }, include: { sourceNode: true, targetNode: true } }));
});
app.patch('/api/connections/:id/status', async (req, res) => {
  if (!connectionStatuses.has(req.body.status)) return res.status(400).json({ error: 'A valid connection status is required' });
  res.json(await prisma.connection.update({ where: { id: req.params.id }, data: { status: req.body.status }, include: { sourceNode: true, targetNode: true } }));
});

app.get('/api/inventory', (_req, res) => res.json({ teams: db.prepare('SELECT * FROM teams ORDER BY name').all(), labs: db.prepare('SELECT * FROM labs ORDER BY name').all(), racks: db.prepare('SELECT r.id,r.name,r.lab_id labId,l.name lab FROM racks r LEFT JOIN labs l ON l.id=r.lab_id ORDER BY r.name').all(), panels: db.prepare('SELECT p.id,p.name,p.unit,p.rack_id rackId,r.name rack FROM patch_panels p JOIN racks r ON r.id=p.rack_id ORDER BY r.name,p.unit').all() }));
app.post('/api/inventory/:type', (req, res, next) => {
  try {
    const b = req.body; let result: any;
    if (req.params.type === 'teams') result = run('INSERT INTO teams(name) VALUES(?)', required(b.name, 'Name'));
    else if (req.params.type === 'labs') result = run('INSERT INTO labs(name) VALUES(?)', required(b.name, 'Name'));
    else if (req.params.type === 'racks') result = run('INSERT INTO racks(name,lab_id) VALUES(?,?)', required(b.name, 'Name'), b.labId || null);
    else if (req.params.type === 'panels') result = run('INSERT INTO patch_panels(name,rack_id,unit) VALUES(?,?,?)', required(b.name, 'Name'), required(b.rackId, 'Rack'), required(b.unit, 'Unit'));
    else return res.status(404).json({ error: 'Inventory collection not found.' });
    res.status(201).json({ id: Number(result.lastInsertRowid) });
  } catch (error) { next(error); }
});

app.get('/api/circuits', (_req, res) => res.json(db.prepare(`${circuitSelect} ORDER BY c.id DESC`).all().map((item: any) => getCircuit(item.id))));
app.post('/api/circuits', (req, res, next) => {
  try {
    const b = req.body; const kind = b.kind; const hops = Array.isArray(b.hops) ? b.hops : [];
    if (!['RADIO', 'TESTLINE'].includes(kind)) return res.status(400).json({ error: 'Circuit kind must be RADIO or TESTLINE.' });
    if (!hops.length) return res.status(400).json({ error: 'Add at least one patch panel hop.' });
    let id = 0;
    db.transaction(() => {
      let radio: { id: number } | null = null; let testline: { id: number } | null = null;
      if (kind === 'RADIO') {
        const serialNumber = required(b.serialNumber?.trim(), 'Radio serial number'); cleanDanglingDuplicates('RADIO', serialNumber);
        const existing = one('SELECT * FROM radios WHERE serial_number=?', serialNumber);
        if (existing) { if (one('SELECT id FROM circuits WHERE radio_id=? LIMIT 1', existing.id)) throw Error(`Radio ${serialNumber} already has a documented circuit.`); run('DELETE FROM radios WHERE id=?', existing.id); }
        radio = { id: Number(run('INSERT INTO radios(serial_number) VALUES(?)', serialNumber).lastInsertRowid) };
      } else {
        const btsid = required(b.btsid?.trim(), 'BTSID'); if (!/^\d{4}$/.test(btsid)) throw Error('BTSID must contain exactly 4 digits.'); cleanDanglingDuplicates('TESTLINE', btsid);
        const existing = one('SELECT * FROM testlines WHERE btsid=?', btsid);
        if (existing) { if (one('SELECT id FROM circuits WHERE testline_id=? LIMIT 1', existing.id)) throw Error(`Test line ${btsid} already has a documented circuit.`); run('DELETE FROM testlines WHERE id=?', existing.id); }
        testline = { id: Number(run('INSERT INTO testlines(btsid,type,device,device_port) VALUES(?,?,?,?)', btsid, b.testlineType || 'CLASSICAL', required(b.device, 'Device'), required(b.devicePort, 'Device port')).lastInsertRowid) };
      }
      id = Number(run('INSERT INTO circuits(kind,radio_id,testline_id,team_id,lab_id,switch_port,switch_side) VALUES(?,?,?,?,?,?,?)', kind, radio?.id || null, testline?.id || null, b.teamId || null, b.labId || null, required(b.switchPort, 'Optical switch port'), kind === 'RADIO' ? 'OUT' : 'IN').lastInsertRowid);
      const keys = new Set<string>(); hops.forEach((hop: any) => { const key = `${hop.panelId}:${hop.port?.trim()}`; if (keys.has(key)) throw Error(`Patch panel port ${hop.port} is repeated in this circuit.`); keys.add(key); });
      const addHop = db.prepare('INSERT INTO circuit_hops(circuit_id,position,panel_id,port) VALUES(?,?,?,?)'); hops.forEach((hop: any, index: number) => addHop.run(id, index + 1, required(hop.panelId, 'Patch panel'), required(hop.port?.trim(), 'Patch panel port')));
    })();
    res.status(201).json(getCircuit(id));
  } catch (error) { next(error); }
});

app.delete('/api/circuits/:id', (req, res) => {
  const existing = one(`${circuitSelect} WHERE c.id=?`, req.params.id); if (!existing) return res.status(404).json({ error: 'Circuit not found.' });
  db.transaction(() => { const id = Number(req.params.id); run('DELETE FROM e2e_links WHERE radio_circuit_id=? OR testline_circuit_id=?', id, id); run('DELETE FROM circuits WHERE id=?', id); if (existing.radioId && !one('SELECT 1 FROM circuits WHERE radio_id=? LIMIT 1', existing.radioId)) run('DELETE FROM radios WHERE id=?', existing.radioId); if (existing.testlineId && !one('SELECT 1 FROM circuits WHERE testline_id=? LIMIT 1', existing.testlineId)) run('DELETE FROM testlines WHERE id=?', existing.testlineId); cleanOrphanedRecords(); })();
  res.status(204).end();
});

app.get('/api/e2e-links', (_req, res) => { const links = db.prepare('SELECT e.id,e.radio_circuit_id radioCircuitId,e.testline_circuit_id testlineCircuitId,rr.serial_number serialNumber,tt.btsid,rc.switch_port radioPort,tl.switch_port testlinePort FROM e2e_links e JOIN circuits rc ON rc.id=e.radio_circuit_id JOIN radios rr ON rr.id=rc.radio_id JOIN circuits tl ON tl.id=e.testline_circuit_id JOIN testlines tt ON tt.id=tl.testline_id ORDER BY e.id DESC').all(); res.json(links.map((link: any) => ({ ...link, radioHops: getCircuit(link.radioCircuitId)?.hops || [], testlineHops: getCircuit(link.testlineCircuitId)?.hops || [] })));
});
app.post('/api/e2e-links', (req, res, next) => { try { const { radioCircuitId, testlineCircuitId } = req.body; const radio = one("SELECT id FROM circuits WHERE id=? AND kind='RADIO'", radioCircuitId); const testline = one("SELECT id FROM circuits WHERE id=? AND kind='TESTLINE'", testlineCircuitId); if (!radio || !testline) return res.status(400).json({ error: 'Select one radio circuit and one test line circuit.' }); if (one('SELECT id FROM e2e_links WHERE radio_circuit_id=?', radio.id)) return res.status(400).json({ error: 'This radio circuit is already paired.' }); if (one('SELECT id FROM e2e_links WHERE testline_circuit_id=?', testline.id)) return res.status(400).json({ error: 'This test line circuit is already paired.' }); res.status(201).json({ id: Number(run('INSERT INTO e2e_links(radio_circuit_id,testline_circuit_id) VALUES(?,?)', radio.id, testline.id).lastInsertRowid) }); } catch (error) { next(error); } });
+app.delete('/api/e2e-links/:id', (req, res) => { const result = run('DELETE FROM e2e_links WHERE id=?', req.params.id); if (!result.changes) return res.status(404).json({ error: 'E2E link not found.' }); res.status(204).end(); });
+
+app.get('/api/free-switch-ports', (req, res) => { const kind = req.query.kind; if (!['RADIO', 'TESTLINE'].includes(String(kind))) return res.status(400).json({ error: 'Circuit kind must be RADIO or TESTLINE.' }); const used = new Set(db.prepare('SELECT switch_port FROM circuits').all().map((item: any) => item.switch_port)); const ports: string[] = []; for (let module = 1; module <= 4; module += 1) for (let number = 1; number <= 4; number += 1) { const port = `${module}.1/${number}`; if (!used.has(port)) ports.push(port); } res.json(ports); });
+app.get('/api/switch-grid', (_req, res) => { const circuits = db.prepare(circuitSelect).all(); const links = db.prepare('SELECT radio_circuit_id radioId,testline_circuit_id testId FROM e2e_links').all(); const paired = new Set(links.flatMap((item: any) => [item.radioId, item.testId])); const pairings = new Map<number, any>(); links.forEach((link: any) => { const radio: any = circuits.find((item: any) => item.id === link.radioId); const testline: any = circuits.find((item: any) => item.id === link.testId); if (radio && testline) { pairings.set(radio.id, { id: testline.id, side: testline.switchSide, port: testline.switchPort, kind: testline.kind, label: `TL-${testline.btsid}` }); pairings.set(testline.id, { id: radio.id, side: radio.switchSide, port: radio.switchPort, kind: radio.kind, label: radio.serialNumber }); } }); const modules = []; for (let module = 1; module <= 4; module += 1) { const name = `${module}.1`; const ports = []; for (let number = 1; number <= 4; number += 1) { const port = `${name}/${number}`; const outCircuit: any = circuits.find((item: any) => item.switchPort === port && item.switchSide === 'OUT'); const inCircuit: any = circuits.find((item: any) => item.switchPort === port && item.switchSide === 'IN'); ports.push({ number, out: { port, side: 'OUT', circuit: outCircuit || null, state: outCircuit ? (paired.has(outCircuit.id) ? 'LINKED' : 'OCCUPIED') : 'FREE', pairedWith: outCircuit ? pairings.get(outCircuit.id) || null : null }, in: { port, side: 'IN', circuit: inCircuit || null, state: inCircuit ? (paired.has(inCircuit.id) ? 'LINKED' : 'OCCUPIED') : 'FREE', pairedWith: inCircuit ? pairings.get(inCircuit.id) || null : null } }); } modules.push({ module: name, ports }); } res.json(modules); });
+
+app.use(express.static(publicDirectory));
+app.use((_req, res) => res.status(404).json({ error: 'Resource not found.' }));
+app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => { if (error instanceof Prisma.PrismaClientKnownRequestError) { if (error.code === 'P2025') return res.status(404).json({ error: 'Connection not found' }); if (error.code === 'P2003') return res.status(400).json({ error: 'sourceNodeId and targetNodeId must reference existing nodes' }); } const sqliteError = error as { code?: string; message?: string }; if (sqliteError.code === 'SQLITE_CONSTRAINT_UNIQUE' && sqliteError.message?.includes('circuit_hops.panel_id')) return res.status(400).json({ error: 'That patch-panel port is already in use. Choose another patch-panel port.' }); if (sqliteError.code === 'SQLITE_CONSTRAINT_UNIQUE' && sqliteError.message?.includes('circuits.switch_port')) return res.status(400).json({ error: 'That optical switch port is already in use. Choose another free port.' }); console.error(error); res.status(500).json({ error: 'Internal server error' }); });
+
+app.listen(port, () => console.log(`FiberSync listening on http://localhost:${port}`));
