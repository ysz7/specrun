// AuthService — connects the user's own Claude access (implementation-plan §2.1). Two paths:
//  1. Claude Code OAuth subscription — the primary path. The Agent SDK's subprocess reads the
//     Claude Code credential store on every query(), so a browser sign-in via `claude auth login`
//     is picked up on the next agent call with no app restart. We report its real state (and drive
//     the in-app "Connect with Claude Code" button) by shelling out to the `claude` CLI.
//  2. Anthropic API key fallback — stored encrypted in the OS keychain via safeStorage, never in
//     the project config; exported as ANTHROPIC_API_KEY for the SDK subprocess.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { safeStorage } from 'electron';
import Store from 'electron-store';
import type { AuthStatus } from '@alethic/ipc';

const run = promisify(execFile);

interface Schema {
  apiKeyEnc: string | null; // base64 of safeStorage-encrypted API key
}

interface CliStatus {
  loggedIn: boolean;
  authMethod?: string;
  email?: string;
  subscriptionType?: string;
}

export class AuthService {
  private readonly store = new Store<Schema>({
    name: 'alethic-auth',
    defaults: { apiKeyEnc: null },
  });
  private loginProc = false; // a login flow is in flight
  private cliCache: { at: number; value: CliStatus | null } | null = null;
  private static readonly CLI_TTL_MS = 3000; // don't spawn `claude` on every status poll

  constructor() {
    // Make a stored key available to the Agent SDK subprocess for this session.
    const key = this.apiKey();
    if (key) process.env['ANTHROPIC_API_KEY'] = key;
  }

  private apiKey(): string | null {
    const enc = this.store.get('apiKeyEnc');
    if (!enc || !safeStorage.isEncryptionAvailable()) return null;
    try {
      return safeStorage.decryptString(Buffer.from(enc, 'base64'));
    } catch {
      return null;
    }
  }

  /** Ask the Claude Code CLI whether the user is signed in (OAuth). Null if the CLI is absent.
   *  Cached briefly so several components + the login poll don't each spawn a `claude` process. */
  private async cliStatus(): Promise<CliStatus | null> {
    const now = Date.now();
    if (this.cliCache && now - this.cliCache.at < AuthService.CLI_TTL_MS)
      return this.cliCache.value;
    let value: CliStatus | null;
    try {
      const { stdout } = await run('claude', ['auth', 'status', '--json'], {
        shell: true,
        timeout: 8000,
        windowsHide: true,
      });
      value = JSON.parse(stdout) as CliStatus;
    } catch {
      value = null; // CLI not installed, errored, or not JSON
    }
    this.cliCache = { at: now, value };
    return value;
  }

  async status(): Promise<AuthStatus> {
    const cli = await this.cliStatus();
    const cliAvailable = cli !== null;
    // A stored API key takes effect for the SDK, but a live Claude Code login is the primary path.
    if (this.apiKey()) return { connected: true, method: 'apikey', cliAvailable };
    if (cli?.loggedIn) {
      return {
        connected: true,
        method: 'oauth',
        cliAvailable: true,
        ...(cli.email ? { email: cli.email } : {}),
        ...(cli.subscriptionType ? { plan: cli.subscriptionType } : {}),
      };
    }
    return { connected: false, method: null, cliAvailable };
  }

  setApiKey(key: string): AuthStatus {
    if (!safeStorage.isEncryptionAvailable()) return { connected: false, method: null };
    this.store.set('apiKeyEnc', safeStorage.encryptString(key).toString('base64'));
    process.env['ANTHROPIC_API_KEY'] = key;
    return { connected: true, method: 'apikey' };
  }

  /** Start the browser OAuth sign-in via the Claude Code CLI. Returns once the browser is launched;
   *  the caller polls status() until connected — no app restart needed (decision 38). */
  loginClaudeCode(): { started: boolean; error?: string } {
    if (this.loginProc) return { started: true };
    this.loginProc = true;
    const child = execFile(
      'claude',
      ['auth', 'login', '--claudeai'],
      { shell: true, windowsHide: true },
      () => {
        this.loginProc = false;
        this.cliCache = null; // force a fresh status read after the browser flow finishes
      },
    );
    child.on('error', () => {
      this.loginProc = false;
    });
    return { started: true };
  }

  /** Disconnect both paths: forget any API key and sign out of the Claude Code CLI. */
  async disconnect(): Promise<AuthStatus> {
    this.store.set('apiKeyEnc', null);
    delete process.env['ANTHROPIC_API_KEY'];
    try {
      await run('claude', ['auth', 'logout'], { shell: true, timeout: 8000, windowsHide: true });
    } catch {
      /* CLI absent or already logged out */
    }
    this.cliCache = null;
    return this.status();
  }
}
