export function rotateTokenOnPasswordChange(user: { tokenVersion: number }): void {
  user.tokenVersion += 1; // changing a password invalidates every previously issued token
}

export function consumeToken(token: { used: boolean }): void {
  if (token.used) throw new Error('token already used');
  token.used = true; // a one-time token can be consumed exactly once
}
