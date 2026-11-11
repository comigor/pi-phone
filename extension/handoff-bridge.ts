type HandoffDispatchEvent = {
  sessionId?: string;
  cwd?: string;
  target?: string;
  useInboxRelay?: boolean;
  register?: (task: Promise<{ env?: Record<string, string>; leaseId?: string } | void>) => void;
};

type HandoffFenceEvent = {
  sessionId?: string;
  leaseId?: string;
  useInboxRelay?: boolean;
  register?: (task: Promise<void>) => void;
};

export interface HandoffLeaseController {
  readonly isHandoffLease: boolean;
  issueHandoffLease(target: string): Promise<{ relayUrl: string; token: string; leaseId: string }>;
  fenceHandoffLease(sessionId: string, leaseId?: string): Promise<void>;
}

export interface HandoffEventBus {
  on(event: string, listener: (payload: unknown) => void): void;
}

export function bindHandoffEvents(events: HandoffEventBus, getRuntime: () => HandoffLeaseController | undefined): void {
  events.on("handoff:before-dispatch", (rawEvent) => {
    const event = rawEvent as HandoffDispatchEvent | undefined;
    const runtime = getRuntime();
    if (!event?.useInboxRelay || typeof event.register !== "function" || !runtime || runtime.isHandoffLease) return;
    event.register(
      runtime.issueHandoffLease(String(event.target || "remote")).then((lease) => ({
        env: { PI_INBOX_RELAY_URL: lease.relayUrl, PI_INBOX_HANDOFF_TOKEN: lease.token },
        leaseId: lease.leaseId
      }))
    );
  });

  const handleFence = (rawEvent: unknown) => {
    const event = rawEvent as HandoffFenceEvent | undefined;
    const runtime = getRuntime();
    if (!event?.sessionId || typeof event.register !== "function" || !runtime || runtime.isHandoffLease) return;
    if (!event.useInboxRelay && !event.leaseId) return;
    event.register(runtime.fenceHandoffLease(String(event.sessionId), typeof event.leaseId === "string" ? event.leaseId : undefined));
  };

  events.on("handoff:before-pull", handleFence);
  events.on("handoff:before-destroy", handleFence);
}
