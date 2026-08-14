// Ctrl+K local search (decision 49): a tiny in-memory index over node title + body. A linear
// scan is well under 10ms for 1000 nodes and needs zero dependencies. Chat is for meaning;
// this is for "find the node".
import { snapshotNode, type AtlasVm } from './viewmodel';
import type { Kind } from '../entities/node';

export interface SearchHit {
  id: string;
  title: string;
  kind: Kind;
  path: string;
  score: number;
}

export function searchNodes(vm: AtlasVm, query: string, limit = 20): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const terms = q.split(/\s+/).filter(Boolean);
  const hits: SearchHit[] = [];

  for (const node of vm.byId.values()) {
    const title = node.title.toLowerCase();
    const body = (snapshotNode(vm, node.id)?.body ?? '').toLowerCase();
    let score = 0;
    let matchedAll = true;
    for (const term of terms) {
      if (title.includes(term)) score += title.startsWith(term) ? 6 : 4;
      else if (body.includes(term)) score += 1;
      else {
        matchedAll = false;
        break;
      }
    }
    if (matchedAll && score > 0) {
      hits.push({ id: node.id, title: node.title, kind: node.kind, path: node.path, score });
    }
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
