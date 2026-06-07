/**
 * notifier — fire-and-forget webhook when a backgrounded surface needs input.
 * POSTs plaintext to CMUX_BRIDGE_NOTIFY_URL with a Title header, which works
 * with an ntfy.sh topic URL out of the box (and most simple webhook receivers).
 * Never throws into the poll loop.
 */
export class Notifier {
  constructor(private readonly url: string | null) {}

  get enabled(): boolean {
    return !!this.url;
  }

  async notify(title: string, message: string): Promise<void> {
    if (!this.url) return;
    try {
      await fetch(this.url, {
        method: "POST",
        headers: { Title: title, Tags: "bell", Priority: "high" },
        body: message,
        signal: AbortSignal.timeout(5000), // bound each POST so a hung endpoint can't pile up sockets
      });
    } catch {
      /* best-effort; a failed notification must never disrupt the bridge */
    }
  }
}
