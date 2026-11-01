// Options rather than settings: settings live in the server, and these bound the time before the
// server is up and after it is told to stop, when nothing can be read from it.
export const serverStartTimeoutMs = 60_000;
export const serverStopTimeoutMs = 10_000;
