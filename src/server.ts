import 'dotenv/config';
import express, { NextFunction, Request, Response } from 'express';
import { ConnectionStatus, NodeStatus, NodeType, Prisma } from '@prisma/client';
import { prisma } from './prisma.js';

const app = express();
const port = Number(process.env.PORT) || 3000;

app.use(express.json());

const nodeTypes = new Set(Object.values(NodeType));
const nodeStatuses = new Set(Object.values(NodeStatus));
const connectionStatuses = new Set(Object.values(ConnectionStatus));

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/', (_req, res) => {
  res.json({
    name: '5G Lab Fiber API',
    status: 'ok',
    endpoints: ['/health', '/api/nodes', '/api/connections']
  });
});

app.get('/api/nodes', async (_req, res) => {
  const nodes = await prisma.node.findMany({ orderBy: { createdAt: 'desc' } });
  res.json(nodes);
});

app.post('/api/nodes', async (req, res) => {
  const { name, type, location, status = NodeStatus.ACTIVE } = req.body;
  if (!isNonEmptyString(name) || !isNonEmptyString(location) || !nodeTypes.has(type) || !nodeStatuses.has(status)) {
    res.status(400).json({ error: 'name, type, location, and a valid optional status are required' });
    return;
  }

  const node = await prisma.node.create({
    data: { name: name.trim(), type, location: location.trim(), status }
  });
  res.status(201).json(node);
});

app.get('/api/connections', async (_req, res) => {
  const connections = await prisma.connection.findMany({
    include: { sourceNode: true, targetNode: true },
    orderBy: { createdAt: 'desc' }
  });
  res.json(connections);
});

app.post('/api/connections', async (req, res) => {
  const { sourceNodeId, targetNodeId, fiberCount, status = ConnectionStatus.ACTIVE, notes } = req.body;
  if (
    !isNonEmptyString(sourceNodeId) ||
    !isNonEmptyString(targetNodeId) ||
    sourceNodeId === targetNodeId ||
    !Number.isInteger(fiberCount) ||
    fiberCount <= 0 ||
    !connectionStatuses.has(status) ||
    (notes !== undefined && notes !== null && typeof notes !== 'string')
  ) {
    res.status(400).json({ error: 'Valid distinct node IDs, a positive integer fiberCount, and a valid optional status are required' });
    return;
  }

  const connection = await prisma.connection.create({
    data: { sourceNodeId, targetNodeId, fiberCount, status, notes: notes?.trim() || null },
    include: { sourceNode: true, targetNode: true }
  });
  res.status(201).json(connection);
});

app.patch('/api/connections/:id/status', async (req, res) => {
  const { status } = req.body;
  if (!connectionStatuses.has(status)) {
    res.status(400).json({ error: 'A valid connection status is required' });
    return;
  }

  const connection = await prisma.connection.update({
    where: { id: req.params.id },
    data: { status },
    include: { sourceNode: true, targetNode: true }
  });
  res.json(connection);
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2025') {
      res.status(404).json({ error: 'Connection not found' });
      return;
    }
    if (error.code === 'P2003') {
      res.status(400).json({ error: 'sourceNodeId and targetNodeId must reference existing nodes' });
      return;
    }
  }
  console.error(error);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(port, () => {
  console.log(`5G lab fiber API listening on port ${port}`);
});
