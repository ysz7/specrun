// ChatService — persists chat history per project locally (decision 23). Keyed by a base64 of the
// project path so arbitrary paths don't collide with electron-store's dot-notation.
import Store from 'electron-store';
import type { ChatMessage } from '@alethic/ipc';

interface Schema {
  byProject: Record<string, ChatMessage[]>;
}

const keyFor = (projectPath: string): string => Buffer.from(projectPath).toString('base64');

export class ChatService {
  private readonly store = new Store<Schema>({ name: 'alethic-chat', defaults: { byProject: {} } });
  private project: string | null = null;

  setProject(path: string | null): void {
    this.project = path;
  }

  history(): ChatMessage[] {
    if (!this.project) return [];
    return this.store.get('byProject')[keyFor(this.project)] ?? [];
  }

  append(message: ChatMessage): void {
    if (!this.project) return;
    const all = this.store.get('byProject');
    const key = keyFor(this.project);
    all[key] = [...(all[key] ?? []), message];
    this.store.set('byProject', all);
  }

  clear(): void {
    if (!this.project) return;
    const all = this.store.get('byProject');
    delete all[keyFor(this.project)];
    this.store.set('byProject', all);
  }

  /** Compact the history: keep the most recent turns, collapse the older ones into a marker so the
   * conversation stays legible and the context gauge drops. Returns the new history. */
  compact(): ChatMessage[] {
    if (!this.project) return [];
    const all = this.store.get('byProject');
    const key = keyFor(this.project);
    const msgs = all[key] ?? [];
    const KEEP = 6;
    if (msgs.length <= KEEP + 1) return msgs;
    const dropped = msgs.length - KEEP;
    const marker: ChatMessage = {
      id: `compact-${Date.now()}`,
      role: 'system',
      text: `↔ Compacted ${dropped} earlier message${dropped === 1 ? '' : 's'} to free context.`,
      ts: new Date().toISOString(),
    };
    const next = [marker, ...msgs.slice(-KEEP)];
    all[key] = next;
    this.store.set('byProject', all);
    return next;
  }
}
