import { measureMcpTokenAudit } from "./mcp-token-audit-lib.js";

console.log(JSON.stringify(await measureMcpTokenAudit(), null, 2));
