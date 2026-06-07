/**
 * M4 verification — a connected client receives an UNSOLICITED topology refresh
 * (pushed via events.stream) when workspaces change, without asking.
 *
 *   bun run packages/bridge/src/main.ts &   # bridge running
 *   bun run scripts/ws-events-smoke.ts
 */
import { CmuxSocketClient } from "../packages/bridge/src/socket-client.ts";

const WS_URL = process.env.WS_URL ?? "ws://127.0.0.1:4380/ws";
let topoCount = 0;
let triggered = false;

const sock = new CmuxSocketClient();
await sock.connect();

const ws = new WebSocket(WS_URL);
const timeout = setTimeout(() => {
  console.error(`FAIL: only ${topoCount} topology message(s); expected an unsolicited refresh`);
  sock.close();
  process.exit(1);
}, 10_000);

ws.onopen = () => ws.send(JSON.stringify({ t: "hello", token: "" }));
ws.onmessage = async (ev: MessageEvent) => {
  const m = JSON.parse(typeof ev.data === "string" ? ev.data : "");
  if (m.t !== "topology") return;
  topoCount++;
  console.log(`topology #${topoCount} (${m.surfaces.length} surfaces)`);

  if (topoCount === 1 && !triggered) {
    // First topology came from hello. Now change the workspace set and expect a push.
    triggered = true;
    const w = await sock.call<any>("workspace.create", {});
    await Bun.sleep(700);
    await sock.call("workspace.close", { workspace_id: w.workspace_id });
  } else if (topoCount >= 2) {
    clearTimeout(timeout);
    console.log("unsolicited topology refresh received ✓");
    ws.close();
    sock.close();
    process.exit(0);
  }
};
ws.onerror = () => {
  console.error("FAIL ws error");
  sock.close();
  process.exit(1);
};
