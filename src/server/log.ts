const ts = () => new Date().toISOString();

export const log = {
  info: (msg: string) => console.log(`${ts()} INFO  ${msg}`),
  warn: (msg: string) => console.warn(`${ts()} WARN  ${msg}`),
  error: (msg: string, err?: unknown) => console.error(`${ts()} ERROR ${msg}${err ? `: ${err instanceof Error ? err.message : String(err)}` : ''}`),
};
