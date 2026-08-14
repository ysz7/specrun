// Model selector (decision 8): one model for everything, chosen in the chat like Claude Code.
// IDs are the exact Claude API strings; default is Sonnet 5.
export interface ModelOption {
  id: string;
  label: string;
}

export const MODELS: readonly ModelOption[] = [
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  { id: 'claude-fable-5', label: 'Claude Fable 5' },
];

export const DEFAULT_MODEL = 'claude-sonnet-5' as const;

export function isKnownModel(id: string): boolean {
  return MODELS.some((m) => m.id === id);
}
