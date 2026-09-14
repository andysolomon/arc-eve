import { eveChannel } from "eve/channels/eve";
import { localDev } from "eve/channels/auth";

// Keep the standard Eve channel; host-cwd execution is deliberately confined to
// the authored tool and is never delegated to the Eve sandbox.
export default eveChannel({ auth: [localDev()] });
