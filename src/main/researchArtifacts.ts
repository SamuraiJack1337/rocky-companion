import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ResearchArtifact, ResearchResult } from '../shared/types';
import { INBOX_WORKSPACE_ID } from '../shared/types';

interface ArtifactFile { artifacts: ResearchArtifact[] }

function valid(value: unknown): value is ResearchArtifact {
  if (!value || typeof value !== 'object') return false;
  const item = value as ResearchArtifact;
  return typeof item.id === 'string' && typeof item.topic === 'string' &&
    typeof item.createdAt === 'string' && typeof item.updatedAt === 'string' &&
    ['running', 'completed', 'failed', 'cancelled'].includes(item.status);
}

export class ResearchArtifactStore {
  private current: ResearchArtifact[] | null = null;
  constructor(private readonly resolvePath: () => string = () => path.join(app.getPath('userData'), 'research-artifacts.json')) {}

  private load(): ResearchArtifact[] {
    if (this.current) return this.current;
    try {
      const raw = JSON.parse(fs.readFileSync(this.resolvePath(), 'utf8')) as Partial<ArtifactFile>;
      this.current = Array.isArray(raw.artifacts) ? raw.artifacts.filter(valid).map((item) => ({
        ...item,
        workspaceId: item.workspaceId || INBOX_WORKSPACE_ID,
        ...(item.status === 'running' ? { status: 'failed' as const, error: 'Rocky stopped before this research finished.' } : {}),
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
      fs.writeFileSync(tmp, JSON.stringify({ artifacts: this.current }, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, target);
    } catch (error) { console.error('[researchArtifacts] failed to persist:', (error as Error).message); }
  }

  start(topic: string, workspaceId = INBOX_WORKSPACE_ID): ResearchArtifact {
    const now = new Date().toISOString();
    const artifact: ResearchArtifact = {
      id: randomUUID(), topic: topic.slice(0, 1000), workspaceId, createdAt: now, updatedAt: now, status: 'running',
    };
    this.load().push(artifact);
    this.save();
    return { ...artifact };
  }

  finish(id: string, result: ResearchResult): void {
    const artifact = this.load().find((item) => item.id === id);
    if (!artifact) return;
    artifact.updatedAt = new Date().toISOString();
    artifact.status = result.cancelled ? 'cancelled' : result.ok ? 'completed' : 'failed';
    artifact.report = result.report;
    artifact.summary = result.summary;
    artifact.sources = result.sources;
    artifact.error = result.error;
    this.save();
  }

  list(workspaceId?: string): ResearchArtifact[] {
    return this.load().filter((item) => !workspaceId || item.workspaceId === workspaceId)
      .map((item) => ({ ...item, sources: item.sources ? [...item.sources] : undefined }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  delete(id: string): void {
    const index = this.load().findIndex((item) => item.id === id);
    if (index < 0) return;
    this.load().splice(index, 1);
    this.save();
  }

  reassignWorkspace(fromId: string, toId = INBOX_WORKSPACE_ID): void {
    let changed = false;
    for (const item of this.load()) if (item.workspaceId === fromId) { item.workspaceId = toId; changed = true; }
    if (changed) this.save();
  }

  clear(): void { this.current = []; this.save(); }
}

export const researchArtifacts = new ResearchArtifactStore();
