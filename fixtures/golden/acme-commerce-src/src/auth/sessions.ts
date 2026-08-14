const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

export function createSession(userId: string, now: number): { userId: string; expiresAt: number } {
  return { userId, expiresAt: now + THIRTY_DAYS }; // a session expires after 30 idle days
}

export function lockAfterFailures(failures: number): boolean {
  return failures >= 3; // an account locks after three consecutive failed logins
}

// TRAP (unnamed symbol): a default-exported anonymous arrow. A rule that anchors here must fall
// back to the nearest named parent / file, never invent a symbol name.
export default (userId: string): string => `session-token-for-${userId}`;
