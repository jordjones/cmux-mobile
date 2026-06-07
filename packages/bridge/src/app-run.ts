/**
 * app-run — wires the cmux client + topology + input + auth + events + watcher
 * and starts the HTTP/WebSocket server. Shared by the dev entry (`main.ts`) and
 * the packaged CLI (`cli.ts`) so neither relies on `import.meta.main`.
 */
import type { BridgeConfig } from "./config.ts";
import { CmuxSocketClient } from "./socket-client.ts";
import { Topology } from "./topology.ts";
import { InputRouter } from "./input-router.ts";
import { startBridgeServer } from "./server.ts";
import { EventsClient } from "./events-client.ts";
import { Notifier } from "./notifier.ts";
import { SurfaceWatcher } from "./surface-watcher.ts";
import { PairingManager, TailscaleVerifier, TokenStore } from "./auth.ts";

export async function run(cfg: BridgeConfig): Promise<void> {
  const client = new CmuxSocketClient();
  await client.connect();
  console.log("connected to cmux socket ✓");

  const verifier = new TailscaleVerifier(true);
  if (cfg.authMode !== "off") await verifier.init();
  const tokens = new TokenStore();
  const pairing = new PairingManager();

  const host = cfg.host ?? (await TailscaleVerifier.selfIPv4()) ?? "127.0.0.1";
  const topology = new Topology(client);
  const input = new InputRouter(client);

  const server = await startBridgeServer(
    {
      host,
      port: cfg.port,
      authMode: cfg.authMode,
      webDir: cfg.webDir,
      webEntry: cfg.webEntry,
    },
    { client, topology, input, auth: { verifier, tokens, pairing } },
  );

  // Auto-refresh the picker when workspaces/surfaces change, and on cmux restart.
  let topoTimer: ReturnType<typeof setTimeout> | null = null;
  const broadcastTopology = async (): Promise<void> => {
    try {
      const surfaces = await topology.list();
      server.publish("all", JSON.stringify({ t: "topology", surfaces }));
    } catch {
      /* transient — the next event or a client refresh will recover */
    }
  };
  const events = new EventsClient({
    onTopologyChange: () => {
      if (topoTimer) return; // debounce a burst of structural events
      topoTimer = setTimeout(() => {
        topoTimer = null;
        void broadcastTopology();
      }, 300);
    },
    onBootChange: () => void broadcastTopology(),
  });
  await events.start();

  // Background watcher: webhook alert (even with the PWA closed) + a picker dot
  // when any surface becomes blocked waiting for input.
  const notifier = new Notifier(cfg.notifyUrl);
  const watcher = new SurfaceWatcher({
    client,
    topology,
    onNotify: (title, message) => void notifier.notify(title, message),
    onActivity: (attention) => server.publish("all", JSON.stringify({ t: "activity", attention })),
  });
  watcher.start();

  console.log(`cmux-bridge listening on http://${host}:${server.port}`);
  console.log(
    notifier.enabled
      ? "notify: webhook configured — alerts when a surface needs input"
      : "notify: in-app picker dot only (set CMUX_BRIDGE_NOTIFY_URL for push)",
  );

  function announceCode(): void {
    if (cfg.authMode !== "token") return;
    const code = pairing.issueCode();
    console.log(
      `\n🔗 Pair a device (code valid 5 min): open  http://${host}:${server.port}  and enter  ${code}` +
        `\n   (or: cmux-mobile pair add <name>;  send SIGUSR1 for a new code)\n`,
    );
  }

  if (cfg.authMode === "off") {
    console.log("auth: DISABLED (CMUX_BRIDGE_AUTH=off) — anyone who can reach the port has full control");
  } else if (cfg.authMode === "tailnet") {
    console.log("auth: Tailscale identity only — any device on your tailnet connects with no code.");
  } else {
    const activeDevices = tokens.list().filter((d) => !d.revoked).length;
    if (activeDevices === 0) announceCode();
    else console.log(`${activeDevices} paired device(s). Send SIGUSR1 to pair another.`);
  }
  process.on("SIGUSR1", announceCode);
}
