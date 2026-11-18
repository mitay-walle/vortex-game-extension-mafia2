// Watches mafia2.exe: when a run ends, reports how long it ran and whether Windows logged a crash
// of it (Application Error in the Application event log). Windows only: tasklist and wevtutil.
import { execFile } from 'node:child_process';

const EXE = 'mafia2.exe';
const POLL_MS = 10_000;

const run = (cmd: string, args: string[]): Promise<string> =>
  new Promise(resolve => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err === null ? stdout : ''));
  });

export async function isRunning(): Promise<boolean> {
  const out = await run('tasklist', ['/FI', `IMAGENAME eq ${EXE}`, '/NH', '/FO', 'CSV']);
  return out.toLowerCase().includes(`"${EXE}"`);
}

/** Whether Windows logged a crash of the game since `since` (ms). */
export async function crashedSince(since: number): Promise<boolean> {
  const iso = new Date(since).toISOString();
  // filtered by name in the query: other programs can fill the log with their own crashes
  const query = `*[System[Provider[@Name='Application Error'] and TimeCreated[@SystemTime>='${iso}']]`
    + ` and EventData[Data[@Name='AppName']='${EXE}']]`;
  const out = await run('wevtutil', ['qe', 'Application', `/q:${query}`, '/c:1']);
  return out.toLowerCase().includes(EXE);
}

export interface RunEnd {
  startedAt: number;
  endedAt: number;
  crashed: boolean;
}

/**
 * Polls while `active()` is true. `onStart` is called when the game starts (to take a snapshot of
 * the mods), `onEnd` when it has exited. Returns a function that stops watching.
 */
export function watchGame(active: () => boolean, onStart: () => void, onEnd: (end: RunEnd) => void): () => void {
  let startedAt: number | undefined;
  let busy = false;
  const tick = async () => {
    if (busy || (!active() && startedAt === undefined)) return;
    busy = true;
    try {
      const running = await isRunning();
      if (running && startedAt === undefined) {
        startedAt = Date.now();
        onStart();
      } else if (!running && startedAt !== undefined) {
        const started = startedAt;
        startedAt = undefined;
        const endedAt = Date.now();
        // the event can be written a moment after the process is gone
        await new Promise(r => setTimeout(r, 3000));
        onEnd({ startedAt: started, endedAt, crashed: await crashedSince(started - 5000) });
      }
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), POLL_MS);
  return () => clearInterval(timer);
}
