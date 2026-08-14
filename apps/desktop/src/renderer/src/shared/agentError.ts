// Classify an agent error message so the UI can react in kind (Phase 11 task 2, Phase 2 task 1).
// Auth failures surface a "Reconnect Claude" banner while the map keeps working (decision 38); a
// rate-limit surfaces a softer "slow down" note; a dropped connection and a model the account can't
// reach each get their own actionable note; everything else is left to the chat's own error bubble.
export type AgentErrorKind = 'auth' | 'rate-limit' | 'connection' | 'no-access' | 'other';

export function classifyAgentError(message: string): AgentErrorKind {
  const m = message.toLowerCase();
  if (/rate.?limit|\b429\b|too many requests|overloaded|quota|usage limit/.test(m))
    return 'rate-limit';
  // Model-access denial reads like a 403, but is about the model, not the session — checked before
  // the broad auth pattern below so it doesn't get swallowed by "forbidden"/"\b403\b".
  if (
    /does not have access to (the model|this model)|model (is )?not (found|available)|no access to (this )?model|permission denied for model|not authorized (for|to use) (this|the) model/.test(
      m,
    )
  )
    return 'no-access';
  if (
    /unauthor|forbidden|\b401\b|\b403\b|oauth|token (has )?expired|expired token|invalid api key|authentication|not logged in|please (re-?)?login|sign in/.test(
      m,
    )
  )
    return 'auth';
  if (
    /network|fetch failed|econnrefused|enotfound|econnreset|etimedout|socket hang up|offline|no internet|dns lookup failed|getaddrinfo|ehostunreach/.test(
      m,
    )
  )
    return 'connection';
  return 'other';
}
