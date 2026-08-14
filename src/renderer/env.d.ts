import type { MagentBridge } from "../shared/bridge";

declare global {
  interface Window {
    magent?: MagentBridge;
  }
}

export {};
