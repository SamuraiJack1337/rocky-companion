import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TaskRecord } from '../shared/types';
import { INBOX_WORKSPACE_ID } from '../shared/types';

interface TasksFile { tasks: TaskRecord[] }

function valid(value: unknown): value is TaskRecord {
  if (!value || typeof value !== 'object') return false;
  const task = value as TaskRecord;
  return typeof task.id === 'string' && typeof task.title === 'string' &&
    typeof task.createdAt === 'string' && (task.status === 'open' || task.status === 'completed');
}

function optionalIso(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export class TasksStore {
  private current: TaskRecord[] | null = null;
  constructor(private readonly resolvePath: () => string = () => path.join(app.getPath('userData'), 'tasks.json')) {}

  private load(): TaskRecord[] {
    if (this.current) return this.current;
    try {
      const raw = JSON.parse(fs.readFileSync(this.resolvePath(), 'utf8')) as Partial<TasksFile>;
      this.current = Array.isArray(raw.tasks) ? raw.tasks.filter(valid).map((task) => ({
        ...task,
        workspaceId: task.workspaceId || INBOX_WORKSPACE_ID,
      })) : [];
    } catch { this.current = []; }
    return this.current;
  }

  private save(): void {
    if (!this.current) return;
    const target = this.resolvePath();
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const tmp = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ tasks: this.current }, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, target);
    } catch (error) { console.error('[tasks] failed to persist:', (error as Error).message); }
  }

  list(workspaceId?: string): TaskRecord[] {
    return this.load()
      .filter((task) => !workspaceId || task.workspaceId === workspaceId)
      .map((task) => ({ ...task }))
      .sort((a, b) => Number(a.status === 'completed') - Number(b.status === 'completed') || b.createdAt.localeCompare(a.createdAt));
  }

  add(input: { title: string; workspaceId?: string; dueAt?: string; remindAt?: string }): TaskRecord | null {
    const title = (input.title || '').replace(/\s+/g, ' ').trim().slice(0, 500).trim();
    if (!title) return null;
    const task: TaskRecord = {
      id: randomUUID(),
      title,
      workspaceId: input.workspaceId || INBOX_WORKSPACE_ID,
      createdAt: new Date().toISOString(),
      status: 'open',
      ...(optionalIso(input.dueAt) ? { dueAt: optionalIso(input.dueAt) } : {}),
      ...(optionalIso(input.remindAt) ? { remindAt: optionalIso(input.remindAt) } : {}),
    };
    this.load().push(task);
    this.save();
    return { ...task };
  }

  complete(id: string, completed: boolean): void {
    const task = this.load().find((item) => item.id === id);
    if (!task) return;
    task.status = completed ? 'completed' : 'open';
    task.completedAt = completed ? new Date().toISOString() : undefined;
    this.save();
  }

  delete(id: string): void {
    const index = this.load().findIndex((task) => task.id === id);
    if (index < 0) return;
    this.load().splice(index, 1);
    this.save();
  }

  dueReminder(now = new Date()): TaskRecord | null {
    const nowIso = now.toISOString();
    return this.load()
      .filter((task) => task.status === 'open' && task.remindAt && task.remindAt <= nowIso && !task.notifiedAt)
      .sort((a, b) => (a.remindAt ?? '').localeCompare(b.remindAt ?? ''))[0] ?? null;
  }

  markNotified(id: string): void {
    const task = this.load().find((item) => item.id === id);
    if (!task) return;
    task.notifiedAt = new Date().toISOString();
    this.save();
  }

  reassignWorkspace(fromId: string, toId = INBOX_WORKSPACE_ID): void {
    let changed = false;
    for (const task of this.load()) if (task.workspaceId === fromId) { task.workspaceId = toId; changed = true; }
    if (changed) this.save();
  }

  clear(): void { this.current = []; this.save(); }
}

export const tasks = new TasksStore();
