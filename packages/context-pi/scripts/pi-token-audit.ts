import { measurePiTokenAudit } from "./pi-token-audit-lib.ts";

console.log(JSON.stringify(await measurePiTokenAudit(), null, 2));
