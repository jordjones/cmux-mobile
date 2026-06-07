/**
 * pair-device — manage bridge device tokens directly in ~/.cmux-bridge/tokens.json.
 * For the easy path, run the bridge and pair with the on-screen code from the
 * phone; this CLI is the headless/power-user path plus list/revoke.
 *
 *   bun run scripts/pair-device.ts list
 *   bun run scripts/pair-device.ts add <name>
 *   bun run scripts/pair-device.ts revoke <id>
 */
import { TokenStore, TailscaleVerifier } from "../packages/bridge/src/auth.ts";

const [cmd, arg] = process.argv.slice(2);
const store = new TokenStore();

switch (cmd) {
  case "list": {
    const devices = store.list();
    if (devices.length === 0) {
      console.log("No paired devices.");
      break;
    }
    for (const d of devices) {
      const flag = d.revoked ? " [REVOKED]" : "";
      console.log(`${d.id}  ${d.name}${flag}  created ${d.createdAt}  last ${d.lastSeenAt ?? "—"}`);
    }
    break;
  }

  case "add": {
    const name = arg ?? "device";
    const { id, token } = store.mint(name);
    const ip = (await TailscaleVerifier.selfIPv4()) ?? "<mac-tailnet-ip>";
    const port = process.env.CMUX_BRIDGE_PORT ?? "4380";
    console.log(`Paired device "${name}" (id ${id}).`);
    console.log("\nToken (store securely — shown once):");
    console.log("  " + token);
    console.log("\nOpen this on the device (token rides in the URL fragment, not sent to the server):");
    console.log(`  http://${ip}:${port}/#token=${token}`);
    break;
  }

  case "revoke": {
    if (!arg) {
      console.error("usage: pair-device.ts revoke <id>");
      process.exit(1);
    }
    console.log(store.revoke(arg) ? `Revoked ${arg}.` : `No active device ${arg}.`);
    break;
  }

  default:
    console.log("usage: pair-device.ts <list|add <name>|revoke <id>>");
}
