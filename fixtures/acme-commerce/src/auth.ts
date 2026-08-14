export function createSession(userId, now) {
  return { userId, createdAt: now, expiresAt: now + THIRTY_DAYS, concurrentLimit: 5 };
}

export function lockAfterFailures(failures) {
  return failures >= 3; // lock the account after three failed logins
}

export function rotateTokenOnPasswordChange(user) {
  user.tokenVersion += 1; // every existing token is invalidated
}

export function consumeToken(token) {
  if (token.used) throw new Error('token already used');
  token.used = true; // single use
}
