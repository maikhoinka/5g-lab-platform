import express from 'express';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 3001);
const file = (process.env.DATABASE_URL || './data/fibersync.db').replace(/^sqlite:(\/\/)?/, '');

fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
const db = new Database(file);
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');

db.exec(`CREATE TABLE IF NOT EXISTS teams(id INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE);CREATE TABLE IF NOT EXISTS labs(id INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE);CREATE TABLE IF NOT EXISTS racks(id INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE,lab_id INTEGER REFERENCES labs(id));CREATE TABLE IF NOT EXISTS patch_panels(id INTEGER PRIMARY KEY,name TEXT NOT NULL,rack_id INTEGER NOT NULL REFERENCES racks(id),unit TEXT NOT NULL,UNIQUE(rack_id,unit,name));CREATE TABLE IF NOT EXISTS radios(id INTEGER PRIMARY KEY,serial_number TEXT NOT NULL UNIQUE);CREATE TABLE IF NOT EXISTS testlines(id INTEGER PRIMARY KEY,btsid TEXT NOT NULL UNIQUE CHECK(length(btsid)=4),type TEXT NOT NULL DEFAULT 'CLASSICAL',device TEXT NOT NULL,device_port TEXT NOT NULL);CREATE TABLE IF NOT EXISTS circuits(id INTEGER PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN('RADIO','TESTLINE')),radio_id INTEGER UNIQUE REFERENCES radios(id),testline_id INTEGER UNIQUE REFERENCES testlines(id),team_id INTEGER REFERENCES teams(id),lab_id INTEGER REFERENCES labs(id),switch_port TEXT NOT NULL UNIQUE,switch_side TEXT NOT NULL CHECK(switch_side IN('OUT','IN')),created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,CHECK((kind='RADIO' AND radio_id IS NOT NULL AND testline_id IS NULL AND switch_side='OUT') OR (kind='TESTLINE' AND testline_id IS NOT NULL AND radio_id IS NULL AND switch_side='IN')));CREATE TABLE IF NOT EXISTS circuit_hops(id INTEGER PRIMARY KEY,circuit_id INTEGER NOT NULL REFERENCES circuits(id) ON DELETE CASCADE,position INTEGER NOT NULL,panel_id INTEGER NOT NULL REFERENCES patch_panels(id),port TEXT NOT NULL,UNIQUE(circuit_id,position),UNIQUE(panel_id,port));CREATE TABLE IF NOT EXISTS e2e_links(id INTEGER PRIMARY KEY,radio_circuit_id INTEGER NOT NULL UNIQUE REFERENCES circuits(id) ON DELETE CASCADE,testline_circuit_id INTEGER NOT NULL UNIQUE REFERENCES circuits(id) ON DELETE CASCADE,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`);

const one = (sql, ...args) => db.prepare(sql).get(...args);

function cleanOrphanedRecords() {
  db.transaction(() => {
    db.prepare("DELETE FROM e2e_links WHERE radio_circuit_id NOT IN (SELECT id FROM circuits) OR testline_circuit_id NOT IN (SELECT id FROM circuits)").run();
    db.prepare("DELETE FROM testlines WHERE id NOT IN (SELECT testline_id FROM circuits WHERE testline_id IS NOT NULL)").run();
    db.prepare("DELETE FROM radios WHERE id NOT IN (SELECT radio_id FROM circuits WHERE radio_id IS NOT NULL)").run();
  })();
}

function cleanDanglingDuplicates(kind, value) {
  if (kind === 'RADIO') {
    db.prepare('DELETE FROM radios WHERE serial_number=? AND id NOT IN (SELECT radio_id FROM circuits WHERE radio_id IS NOT NULL)').run(value);
    return;
  }

  db.prepare('DELETE FROM testlines WHERE btsid=? AND id NOT IN (SELECT testline_id FROM circuits WHERE testline_id IS NOT NULL)').run(value);
}

if (!one('SELECT id FROM teams LIMIT 1')) {
  db.transaction(() => {
    db.prepare('INSERT INTO teams(name) VALUES(?)').run('RF Lab');
    db.prepare('INSERT INTO teams(name) VALUES(?)').run('RAN Validation');
    db.prepare('INSERT INTO labs(name) VALUES(?)').run('L4-01');
    db.prepare('INSERT INTO labs(name) VALUES(?)').run('L4-04');
    db.prepare('INSERT INTO racks(name,lab_id) VALUES(?,?)').run('R2810', 1);
    db.prepare('INSERT INTO racks(name,lab_id) VALUES(?,?)').run('R2815', 2);
    db.prepare('INSERT INTO patch_panels(name,rack_id,unit) VALUES(?,?,?)').run('Front cassette A', 1, 'U23');
    db.prepare('INSERT INTO patch_panels(name,rack_id,unit) VALUES(?,?,?)').run('Back cassette B', 1, 'U42');
    db.prepare('INSERT INTO patch_panels(name,rack_id,unit) VALUES(?,?,?)').run('Testline panel', 2, 'U08');
    db.prepare('INSERT INTO radios(serial_number) VALUES(?)').run('SN-A4412');
    db.prepare("INSERT INTO testlines(btsid,type,device,device_port) VALUES('1001','CLASSICAL','Switch','C5')").run();
    db.prepare("INSERT INTO circuits(kind,radio_id,team_id,lab_id,switch_port,switch_side) VALUES('RADIO',1,1,1,'1.1/1','OUT')").run();
    db.prepare("INSERT INTO circuits(kind,testline_id,team_id,lab_id,switch_port,switch_side) VALUES('TESTLINE',1,2,2,'4.7/1','IN')").run();
    db.prepare('INSERT INTO circuit_hops(circuit_id,position,panel_id,port) VALUES(?,?,?,?)').run(1, 1, 1, 'A1A');
    db.prepare('INSERT INTO circuit_hops(circuit_id,position,panel_id,port) VALUES(?,?,?,?)').run(1, 2, 2, 'B2A');
    db.prepare('INSERT INTO circuit_hops(circuit_id,position,panel_id,port) VALUES(?,?,?,?)').run(2, 1, 3, 'E5A');
    db.prepare('INSERT INTO e2e_links(radio_circuit_id,testline_circuit_id) VALUES(?,?)').run(1, 2);
  })();
}

cleanOrphanedRecords();

app.use(express.json());

const cs = `SELECT c.id,c.kind,c.radio_id radioId,c.testline_id testlineId,c.switch_port switchPort,c.switch_side switchSide,r.serial_number serialNumber,t.btsid,t.type testlineType,t.device,t.device_port devicePort,tm.name team,l.name lab FROM circuits c LEFT JOIN radios r ON r.id=c.radio_id LEFT JOIN testlines t ON t.id=c.testline_id LEFT JOIN teams tm ON tm.id=c.team_id LEFT JOIN labs l ON l.id=c.lab_id`;

function circuit(id) {
  const c = one(`${cs} WHERE c.id=?`, id);
  if (c) c.hops = db.prepare('SELECT h.id,h.position,h.port,p.name panel,p.unit,r.name rack FROM circuit_hops h JOIN patch_panels p ON p.id=h.panel_id JOIN racks r ON r.id=p.rack_id WHERE h.circuit_id=? ORDER BY h.position').all(id);
  return c;
}

function need(value, label) {
  if (!value) throw Error(`${label} is required.`);
  return value;
}

app.get('/health', (_q, s) => {
  try {
    one('SELECT 1');
    s.json({ status: 'ok', database: 'connected' });
  } catch {
    s.status(503).json({ status: 'error', database: 'unavailable' });
  }
});

app.get('/api/inventory', (_q, s) => s.json({
  teams: db.prepare('SELECT * FROM teams ORDER BY name').all(),
  labs: db.prepare('SELECT * FROM labs ORDER BY name').all(),
  racks: db.prepare('SELECT r.id,r.name,r.lab_id labId,l.name lab FROM racks r LEFT JOIN labs l ON l.id=r.lab_id ORDER BY r.name').all(),
  panels: db.prepare('SELECT p.id,p.name,p.unit,p.rack_id rackId,r.name rack FROM patch_panels p JOIN racks r ON r.id=p.rack_id ORDER BY r.name,p.unit').all()
}));

app.post('/api/inventory/:type', (q, s, n) => {
  try {
    const b = q.body;
    let r;
    if (q.params.type === 'teams') r = db.prepare('INSERT INTO teams(name) VALUES(?)').run(need(b.name, 'Name'));
    else if (q.params.type === 'labs') r = db.prepare('INSERT INTO labs(name) VALUES(?)').run(need(b.name, 'Name'));
    else if (q.params.type === 'racks') r = db.prepare('INSERT INTO racks(name,lab_id) VALUES(?,?)').run(need(b.name, 'Name'), b.labId || null);
    else if (q.params.type === 'panels') r = db.prepare('INSERT INTO patch_panels(name,rack_id,unit) VALUES(?,?,?)').run(need(b.name, 'Name'), need(b.rackId, 'Rack'), need(b.unit, 'Unit'));
    else return s.status(404).json({ error: 'Inventory collection not found.' });
    s.status(201).json({ id: Number(r.lastInsertRowid) });
  } catch (e) {
    n(e);
  }
});

app.get('/api/circuits', (_q, s) => s.json(db.prepare(`${cs} ORDER BY c.id DESC`).all().map(x => circuit(x.id))));

app.post('/api/circuits', (q, s, n) => {
  try {
    const b = q.body;
    const kind = b.kind;
    const hops = Array.isArray(b.hops) ? b.hops : [];

    if (!['RADIO', 'TESTLINE'].includes(kind)) return s.status(400).json({ error: 'Circuit kind must be RADIO or TESTLINE.' });
    if (!hops.length) return s.status(400).json({ error: 'Add at least one patch panel hop.' });

    let id;

    db.transaction(() => {
      let radio = null;
      let testline = null;

      if (kind === 'RADIO') {
        const sn = need(b.serialNumber?.trim(), 'Radio serial number');
        cleanDanglingDuplicates('RADIO', sn);
        const existingRadio = one('SELECT * FROM radios WHERE serial_number=?', sn);
        if (existingRadio) {
          const linked = one('SELECT id FROM circuits WHERE radio_id=? LIMIT 1', existingRadio.id);
          if (linked) throw Error(`Radio ${sn} already has a documented circuit.`);
          db.prepare('DELETE FROM radios WHERE id=?').run(existingRadio.id);
        }
        radio = { id: Number(db.prepare('INSERT INTO radios(serial_number) VALUES(?)').run(sn).lastInsertRowid) };
      } else {
        const x = need(b.btsid?.trim(), 'BTSID');
        if (!/^\d{4}$/.test(x)) throw Error('BTSID must contain exactly 4 digits.');

        cleanDanglingDuplicates('TESTLINE', x);
        const existingTestline = one('SELECT * FROM testlines WHERE btsid=?', x);
        if (existingTestline) {
          const linked = one('SELECT id FROM circuits WHERE testline_id=? LIMIT 1', existingTestline.id);
          if (linked) throw Error(`Test line ${x} already has a documented circuit.`);
          db.prepare('DELETE FROM testlines WHERE id=?').run(existingTestline.id);
        }

        testline = {
          id: Number(db.prepare('INSERT INTO testlines(btsid,type,device,device_port) VALUES(?,?,?,?)').run(x, b.testlineType || 'CLASSICAL', need(b.device, 'Device'), need(b.devicePort, 'Device port')).lastInsertRowid)
        };
      }

      const r = db.prepare('INSERT INTO circuits(kind,radio_id,testline_id,team_id,lab_id,switch_port,switch_side) VALUES(?,?,?,?,?,?,?)')
        .run(kind, radio?.id || null, testline?.id || null, b.teamId || null, b.labId || null, need(b.switchPort, 'Optical switch port'), kind === 'RADIO' ? 'OUT' : 'IN');
      id = Number(r.lastInsertRowid);

      const hopKeys = new Set();
      hops.forEach((hop) => {
        const key = `${hop.panelId}:${hop.port?.trim()}`;
        if (hopKeys.has(key)) throw Error(`Patch panel port ${hop.port} is repeated in this circuit.`);
        hopKeys.add(key);
      });

      const addHop = db.prepare('INSERT INTO circuit_hops(circuit_id,position,panel_id,port) VALUES(?,?,?,?)');
      hops.forEach((hop, index) => addHop.run(id, index + 1, need(hop.panelId, 'Patch panel'), need(hop.port?.trim(), 'Patch panel port')));
    })();

    s.status(201).json(circuit(id));
  } catch (e) {
    n(e);
  }
});

app.delete('/api/circuits/:id', (q, s) => {
  const existing = db.prepare(`${cs} WHERE c.id=?`).get(q.params.id);
  if (!existing) return s.status(404).json({ error: 'Circuit not found.' });

  db.transaction(() => {
    const circuitId = Number(q.params.id);
    db.prepare('DELETE FROM e2e_links WHERE radio_circuit_id=? OR testline_circuit_id=?').run(circuitId, circuitId);
    db.prepare('DELETE FROM circuits WHERE id=?').run(circuitId);

    if (existing.radioId && !one('SELECT 1 FROM circuits WHERE radio_id=? LIMIT 1', existing.radioId)) {
      db.prepare('DELETE FROM radios WHERE id=?').run(existing.radioId);
    }

    if (existing.testlineId && !one('SELECT 1 FROM circuits WHERE testline_id=? LIMIT 1', existing.testlineId)) {
      db.prepare('DELETE FROM testlines WHERE id=?').run(existing.testlineId);
    }

    cleanOrphanedRecords();
  })();

  s.status(204).end();
});

app.get('/api/e2e-links', (_q, s) => {
  const links = db.prepare('SELECT e.id, e.radio_circuit_id radioCircuitId, e.testline_circuit_id testlineCircuitId, rr.serial_number serialNumber, tt.btsid, rc.switch_port radioPort, tl.switch_port testlinePort FROM e2e_links e JOIN circuits rc ON rc.id=e.radio_circuit_id JOIN radios rr ON rr.id=rc.radio_id JOIN circuits tl ON tl.id=e.testline_circuit_id JOIN testlines tt ON tt.id=tl.testline_id ORDER BY e.id DESC').all();
  s.json(links.map((link) => ({
    ...link,
    radioHops: circuit(link.radioCircuitId)?.hops || [],
    testlineHops: circuit(link.testlineCircuitId)?.hops || []
  })));
});

app.post('/api/e2e-links', (q, s, n) => {
  try {
    const b = q.body;
    const r = one("SELECT id FROM circuits WHERE id=? AND kind='RADIO'", b.radioCircuitId);
    const t = one("SELECT id FROM circuits WHERE id=? AND kind='TESTLINE'", b.testlineCircuitId);
    if (!r || !t) return s.status(400).json({ error: 'Select one radio circuit and one test line circuit.' });
    if (one('SELECT id FROM e2e_links WHERE radio_circuit_id=?', r.id)) {
      return s.status(400).json({ error: 'This radio circuit is already paired.' });
    }
    if (one('SELECT id FROM e2e_links WHERE testline_circuit_id=?', t.id)) {
      return s.status(400).json({ error: 'This test line circuit is already paired.' });
    }

    const x = db.prepare('INSERT INTO e2e_links(radio_circuit_id,testline_circuit_id) VALUES(?,?)').run(r.id, t.id);
    s.status(201).json({ id: Number(x.lastInsertRowid) });
  } catch (e) {
    n(e);
  }
});

app.delete('/api/e2e-links/:id', (q, s) => {
  const r = db.prepare('DELETE FROM e2e_links WHERE id=?').run(q.params.id);
  if (!r.changes) return s.status(404).json({ error: 'E2E link not found.' });
  s.status(204).end();
});

app.get('/api/free-switch-ports', (q, s) => {
  const kind = q.query.kind;

  if (!['RADIO', 'TESTLINE'].includes(kind || '')) {
    return s.status(400).json({ error: 'Circuit kind must be RADIO or TESTLINE.' });
  }

  const used = new Set(db.prepare('SELECT switch_port FROM circuits').all().map(x => x.switch_port));
  const ports = [];

  for (let module = 1; module <= 4; module += 1) {
    const name = `${module}.1`;
    for (let number = 1; number <= 4; number += 1) {
      const port = `${name}/${number}`;
      if (!used.has(port)) ports.push(port);
    }
  }

  s.json(ports);
});

app.get('/api/switch-grid', (_q, s) => {
  const circuits = db.prepare(cs).all();
  const links = db.prepare('SELECT radio_circuit_id radioId,testline_circuit_id testId FROM e2e_links').all();
  const paired = new Set(links.flatMap(x => [x.radioId, x.testId]));
  const pairings = new Map();

  links.forEach(link => {
    const radio = circuits.find(x => x.id === link.radioId);
    const testline = circuits.find(x => x.id === link.testId);

    if (radio && testline) {
      pairings.set(radio.id, { id: testline.id, side: testline.switchSide, port: testline.switchPort, kind: testline.kind, label: testline.kind === 'RADIO' ? testline.serialNumber : `TL-${testline.btsid}` });
      pairings.set(testline.id, { id: radio.id, side: radio.switchSide, port: radio.switchPort, kind: radio.kind, label: radio.kind === 'RADIO' ? radio.serialNumber : `TL-${radio.btsid}` });
    }
  });

  const modules = [];
  for (let module = 1; module <= 4; module += 1) {
    const name = `${module}.1`;
    const ports = [];
    for (let number = 1; number <= 4; number += 1) {
      const port = `${name}/${number}`;
      const outCircuit = circuits.find(x => x.switchPort === port && x.switchSide === 'OUT');
      const inCircuit = circuits.find(x => x.switchPort === port && x.switchSide === 'IN');
      ports.push({
        number,
        out: {
          port,
          side: 'OUT',
          circuit: outCircuit || null,
          state: outCircuit ? (paired.has(outCircuit.id) ? 'LINKED' : 'OCCUPIED') : 'FREE',
          pairedWith: outCircuit ? pairings.get(outCircuit.id) || null : null,
        },
        in: {
          port,
          side: 'IN',
          circuit: inCircuit || null,
          state: inCircuit ? (paired.has(inCircuit.id) ? 'LINKED' : 'OCCUPIED') : 'FREE',
          pairedWith: inCircuit ? pairings.get(inCircuit.id) || null : null,
        }
      });
    }
    modules.push({ module: name, ports });
  }

  s.json(modules);
});

app.use(express.static(path.join(here, 'public')));

app.use((q, s) => s.status(404).json({ error: `Resource not found: ${q.method} ${q.path}` }));

app.use((e, _q, s, _n) => {
  console.error(e);
  if (e.code === 'SQLITE_CONSTRAINT_UNIQUE' && e.message?.includes('circuit_hops.panel_id')) {
    return s.status(400).json({ error: 'That patch-panel port is already in use. Choose another patch-panel port.' });
  }
  if (e.code === 'SQLITE_CONSTRAINT_UNIQUE' && e.message?.includes('circuits.switch_port')) {
    return s.status(400).json({ error: 'That optical switch port is already in use. Choose another free port.' });
  }
  s.status(e.message?.includes('required') || e.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 400 : 500).json({
    error: e.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 'This port or record is already in use.' : e.message || 'Unexpected server error.'
  });
});

app.listen(port, () => console.log(`FiberSync listening on http://localhost:${port}`));
