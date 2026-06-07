/**
 * input-router — forward client input to cmux. The printable-vs-key decision is
 * made on the CLIENT (printables + Enter/Tab → text; everything else → named
 * keys); this just relays to the socket and lets cmux surface failure codes
 * (surface_unavailable / process_exited / input_queue_full).
 */
import type { CmuxSocketClient } from "./socket-client.ts";

export class InputRouter {
  constructor(private readonly client: CmuxSocketClient) {}

  async sendText(surfaceId: string, text: string): Promise<void> {
    await this.client.call("surface.send_text", { surface_id: surfaceId, text });
  }

  async sendKey(surfaceId: string, key: string): Promise<void> {
    await this.client.call("surface.send_key", { surface_id: surfaceId, key });
  }
}
