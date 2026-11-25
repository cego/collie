export {};

interface PiEvent {
  readonly reason?: string;
  readonly aborted?: boolean;
}

interface PiCtx {
  sessionManager: { getSessionFile: () => string | null };
  getContextUsage: () => { tokens: number } | undefined;
  compact: (callbacks: { onComplete: () => void }) => void;
}

interface PiHost {
  on: (event: string, handler: (event: PiEvent, ctx: PiCtx) => void) => void;
  registerCommand: (name: string, command: { handler: (args: string, ctx: PiCtx) => void }) => void;
}

const [extension, label] = [process.argv[2]!, process.argv[3]!] as const;
Reflect.set(process.env, "COLLIE_LAUNCH", label);
const loaded: { default: (host: PiHost) => void } = await import(extension);
const handlers = new Map<string, (event: PiEvent, ctx: PiCtx) => void>();
loaded.default({
  on: (event, handler) => handlers.set(event, handler),
  registerCommand: () => undefined,
});
handlers.get("session_start")?.(
  {},
  {
    sessionManager: { getSessionFile: () => "ses_launch" },
    getContextUsage: () => ({ tokens: 10 }),
    compact: () => undefined,
  },
);
process.stdout.write("loaded\n");
