/** Match the progress notice emitted immediately before a filesystem-backed
 * distro starts booting. */
export function isDistroFilesystemBootNotice(text: string): boolean {
  return /booting (?:the )?(?:freshly unpacked )?distro from (?:your )?filesystem \(\/\)/i.test(text);
}

/** Print a script locally only after the guest is ready, its filesystem-boot
 * progress line has appeared, and console output has been quiet long enough
 * for the OS's remaining boot messages to finish. No guest input is sent. */
export function createBootAwarePrintGate(
  print: () => void,
  quietMs = 2000,
): {
  setReady(ready: boolean): void;
  setBootMessageSeen(seen: boolean): void;
  activity(): void;
  cancel(): void;
} {
  let ready = false;
  let bootMessageSeen = false;
  let printed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clearTimer = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const schedule = (): void => {
    if (!ready || !bootMessageSeen || printed || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (!ready || !bootMessageSeen || printed) return;
      printed = true;
      print();
    }, quietMs);
  };

  return {
    setReady(value: boolean) {
      ready = value;
      if (!ready) clearTimer();
      else schedule();
    },
    setBootMessageSeen(value: boolean) {
      bootMessageSeen = value;
      if (!bootMessageSeen) clearTimer();
      else schedule();
    },
    activity() {
      if (!ready || !bootMessageSeen || printed) return;
      clearTimer();
      schedule();
    },
    cancel() {
      ready = false;
      clearTimer();
    },
  };
}
