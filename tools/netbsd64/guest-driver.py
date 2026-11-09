#!/usr/bin/env python3
"""Drive a NetBSD/evbarm-aarch64 guest over its serial console.

Used by .github/workflows/build-netbsd64.yml on a GitHub runner (the
development sandbox cannot reach cdn.netbsd.org or run qemu-system-aarch64).
Boots the kernel directly on QEMU's virt board — the same boot protocol the
v64 ARM64 machine uses in the browser (Linux-format kernel image + DTB, no
UEFI) — logs in as root on the serial console, and runs the commands from a
script file one line at a time, failing the build on the first command that
exits non-zero.

Script file syntax:
  # comment / blank      skipped
  -cmd                   run cmd, ignore its exit status
  cmd                    run cmd, fail if its exit status is not 0
  @poweroff              shutdown -p now and wait for QEMU to exit

Exit-status checking works by sending  echo "D86""-RC-$?"  after every
command: the marker only appears assembled in the command's OUTPUT, never in
the echoed input line, so matching D86-RC-<n> cannot race the tty echo.
"""

import argparse
import re
import sys
import time

import pexpect

parser = argparse.ArgumentParser()
parser.add_argument("--kernel", required=True, help="uncompressed netbsd-GENERIC64.img / netbsd-GENERIC.img")
parser.add_argument("--disk", action="append", required=True,
                    help="raw disk image; repeatable, order = ld0, ld1, ...")
parser.add_argument("--root", required=True,
                    help="kernel root= argument (dk1, NAME=label, ...). A comma list "
                         "('ld0a,ld1a,ld2a') boots with the first and answers the kernel's "
                         "'root device:' prompt with the rest in turn — 32-bit virt numbers "
                         "its virtio-mmio slots unpredictably, so ld numbering is a guess there.")
parser.add_argument("--script", required=True, help="command script file")
parser.add_argument("--timeout", type=int, default=1800, help="per-step timeout in seconds")
parser.add_argument("--memory", default="2048")
parser.add_argument("--qemu", default="qemu-system-aarch64", help="qemu binary (qemu-system-arm for armv7)")
parser.add_argument("--cpu", default="cortex-a57", help="-cpu model (cortex-a15 for armv7)")
args = parser.parse_args()

root_candidates = args.root.split(",")

qemu = [args.qemu,
        "-M", "virt", "-cpu", args.cpu, "-smp", "2", "-m", args.memory,
        "-display", "none", "-monitor", "none", "-serial", "stdio",
        "-no-reboot",
        "-kernel", args.kernel, "-append", "root=" + root_candidates[0],
        "-device", "virtio-rng-device"]
for i, disk in enumerate(args.disk):
    qemu += ["-drive", f"if=none,file={disk},format=raw,id=hd{i}",
             "-device", f"virtio-blk-device,drive=hd{i}"]

print("+ " + " ".join(qemu), flush=True)
child = pexpect.spawn(qemu[0], qemu[1:], timeout=args.timeout,
                      encoding="utf-8", codec_errors="replace")
child.logfile_read = sys.stdout

def run(cmd, must_succeed=True):
    child.sendline(cmd)
    child.sendline('echo "D86""-RC-$?"')
    # Waiting in chunks with a single newline nudge: one CI run hung forever
    # because the serial line dropped the final newline, leaving the shell
    # waiting on a half-received line. If the command is merely slow (the big
    # pax copies run for many minutes), the nudge is harmless typeahead that
    # becomes one empty prompt line after the queued echo. A truncated
    # command line still fails honestly via its non-zero exit status, and a
    # truly hung guest still fails at the full deadline.
    deadline = time.time() + args.timeout
    nudged = False
    while True:
        try:
            child.expect(re.compile(r"D86-RC-(\d+)"), timeout=min(90, args.timeout))
            break
        except pexpect.TIMEOUT:
            if time.time() >= deadline:
                raise
            if not nudged:
                child.send("\n")
                nudged = True
    rc = int(child.match.group(1))
    if must_succeed and rc != 0:
        print(f"\nFAILED (exit {rc}): {cmd}", file=sys.stderr)
        child.terminate(force=True)
        sys.exit(1)

# Boot to the login prompt and log in as root (the official live image and
# the image this builds both allow root on the secure console, no password).
# On the way there the kernel may fail to mount the first root= guess and
# ask on the console; answer with the remaining candidates in turn. The
# prompts ("root device:", then "dump device" and "file system (default
# generic)") only appear when the guess was wrong, so a correct first guess
# sails straight to login:.
tries = root_candidates[1:]
while True:
    i = child.expect(["login:", r"root device.*:", r"dump device.*:", r"file system.*:"])
    if i == 0:
        break
    if i == 1:
        if not tries:
            print("\nFAILED: the kernel rejected every root device candidate", file=sys.stderr)
            child.terminate(force=True)
            sys.exit(1)
        answer = tries.pop(0)
        print(f"\n[driver] root device prompt — trying {answer}", flush=True)
        child.sendline(answer)
    else:
        child.sendline("")  # defaults for dump device / file system type
child.sendline("root")
child.expect("# ")
# a sentinel prompt, so command output containing "# " cannot confuse us
child.sendline('PS1="D86SH# "; export PS1')
child.expect("D86SH# ")

for raw in open(args.script, encoding="utf-8"):
    line = raw.strip()
    if not line or line.startswith("#"):
        continue
    if line == "@poweroff":
        child.sendline("shutdown -p now")
        child.expect([pexpect.EOF, "halted"], timeout=600)
        if child.after != pexpect.EOF:
            child.expect(pexpect.EOF, timeout=600)
        child.wait()
        print("\nguest powered off", flush=True)
        sys.exit(0)
    if line.startswith("-"):
        run(line[1:], must_succeed=False)
    else:
        run(line)

print("\nscript ended without @poweroff", file=sys.stderr)
child.terminate(force=True)
sys.exit(1)
