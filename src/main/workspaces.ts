import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { WorkspaceRecord } from '../shared/types';
import { INBOX_WORKSPACE_ID } from '../shared/types';

interface WorkspacesFile { workspaces: WorkspaceRecord[] }

const INBOX: WorkspaceRecord = {
  id: INBOX_WORKSPACE_ID,
  name: 'Inbox',
  createdAt: new Date(0).toISOString(),
  builtIn: true,
};

function valid(record: unknown): record is WorkspaceRecord {
  if (!record || typeof record !== 'object') return false;
  const item = record as WorkspaceRecord;
  return typeof item.id === 'string' && typeof item.name === 'string' && typeof item.createdAt === 'string';
}

export class WorkspacesStore {
  private current: WorkspaceRecord[] | null = null;

  constructor(private readonly resolvePath: () => string = () => path.join(app.getPath('userData'), 'workspaces.json')) {}

  private load(): WorkspaceRecord[] {
    if (this.current) return this.current;
    try {
      const raw = JSON.parse(fs.readFileSync(this.resolvePath(), 'utf8')) as Partial<WorkspacesFile>;
      this.current = Array.isArray(raw.workspaces) ? raw.workspaces.filter(valid) : [];
    } catch {
      this.current = [];
    }
    if (!this.current.some((workspace) => workspace.id === INBOX_WORKSPACE_ID)) {
      this.current.unshift({ ...INBOX });
      this.save();
    }
    return this.current;
  }

  private save(): void {
    if (!this.current) return;
    const target = this.resolvePath();
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const tmp = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ workspaces: this.current }, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, target);
    } catch (error) {
      console.error('[workspaces] failed to persist:', (error as Error).message);
    }
  }

  list(): WorkspaceRecord[] {
    return [...this.load()].sort((a, b) => Number(!!b.builtIn) - Number(!!a.builtIn) || a.name.localeCompare(b.name));
  }

  exists(id: string): boolean {
    return this.load().some((workspace) => workspace.id === id);
  }

  add(name: string): WorkspaceRecord | null {
    const clean = (name || '').replace(/\s+/g, ' ').trim().slice(0, 60).trim();
    if (!clean) return null;
    const existing = this.load().find((workspace) => workspace.name.toLowerCase() === clean.toLowerCase());
    if (existing) return { ...existing };
    const workspace: WorkspaceRecord = { id: randomUUID(), name: clean, createdAt: new Date().toISOString() };
    this.load().push(workspace);
    this.save();
    return { ...workspace };
  }

  delete(id: string): boolean {
    if (!id || id === INBOX_WORKSPACE_ID) return false;
    const index = this.load().findIndex((workspace) => workspace.id === id);
    if (index < 0) return false;
    this.load().splice(index, 1);
    this.save();
    return true;
  }

  clearCustom(): void {
    this.current = [{ ...INBOX }];
    this.save();
  }
}

export const workspaces = new WorkspacesStore();
