// NotificationService — OS notifications for long operations and waits (decision 50). Only fires
// when the window is not focused, so it never nags a user who is already looking. The Electron
// Notification + focus check are injected, which keeps the gating logic testable without Electron.
type Notifier = (title: string, body: string) => void;

export class NotificationService {
  constructor(
    private readonly isFocused: () => boolean,
    private readonly notifier: Notifier,
  ) {}

  /** Notify unless the window is focused. Returns whether a notification was actually shown. */
  notify(title: string, body: string): boolean {
    if (this.isFocused()) return false;
    this.notifier(title, body);
    return true;
  }
}
