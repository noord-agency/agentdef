// update-notifier@7 ships no types, and @types/update-notifier is stuck on v6
// (CommonJS, clashes with the ESM default import). We use only a thin slice, so
// declare exactly that, matching the v7 ESM default export. Build-time only:
// tsc does not emit input .d.ts files, so this never lands in dist.
declare module 'update-notifier' {
  interface UpdateNotifierOptions {
    pkg: { name: string; version: string };
    updateCheckInterval?: number;
    shouldNotifyInNpmScript?: boolean;
  }
  interface NotifyOptions {
    defer?: boolean;
    message?: string;
    isGlobal?: boolean;
  }
  interface UpdateNotifierInstance {
    notify(options?: NotifyOptions): UpdateNotifierInstance;
    update?: { current: string; latest: string; name: string };
  }
  export default function updateNotifier(
    options: UpdateNotifierOptions,
  ): UpdateNotifierInstance;
}
