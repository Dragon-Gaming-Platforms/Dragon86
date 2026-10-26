Why `git clone https://…` fails in this guest, and what to do instead
=====================================================================

Short version: the URL is fine. The git is the problem.

The git in this guest is a static build made for Dragon86 with no curl and no
OpenSSL (see public/v86/VENDORED.md in the Dragon86 sources). Without those,
git has no "https" transport to hand a request to. So:

  * `git clone https://github.com/owner/repo`
      → git never reaches the network. Depending on the argument it either
        dies with "repository 'https://…' does not exist" (its message for
        anything it cannot parse as a transport URL) or "Unable to find
        remote helper for 'https'". Neither is about GitHub, the repo, or
        your connection.

  * `git clone /path/to/repo`, `file:///path/to/repo`, `git clone x.bundle`,
    `git init`, `add`, `commit`, `branch`, `merge`, `log`, `diff`, `tag`,
    `push`/`pull` against a local path
      → these all work. That is ordinary git doing local work, which needs
        no network.

What does work, for getting a repository in here
------------------------------------------------

  d86-clone https://github.com/owner/repo [directory]

It downloads GitHub's own tarball for one branch with busybox wget (busybox
*does* have TLS), unpacks it, and then uses this guest's git to make a real
repository out of the result: one commit, the current files, a clean
`git status`.

  d86-clone https://github.com/owner/repo     → ./repo
  d86-clone owner/repo /Documents/repo        → visible in Dragon86's Files
  d86-clone https://github.com/owner/repo -b dev
  d86-clone https://github.com/owner/repo --force   (very large repositories)

What you do not get is upstream history — `git log` shows the single import
commit. History needs the git protocol over TLS, which this git cannot speak.
The script says so every time rather than pretending the clone was complete.

The `git` in this shell is a thin wrapper (from /usr/share/d86/helpers.sh,
sourced by /etc/profile) that catches exactly one case — `clone` with an
http(s) URL, which could never work — explains itself, and runs d86-clone.
Everything else goes to the real git. `command git clone <url>` still tries
real git, if you want to see the error for yourself.

About `ping`
------------

`ping 1.1.1.1` always succeeds here, even with the network completely dead:
v86, the emulator, answers ICMP on its own virtual link. A ping reply is not
evidence of anything.

  d86-net check

That walks the chain that matters — interface, route, resolv.conf, a real DNS
lookup, and a real TLS connection — and stops at the first broken link. If it
fails, the usual culprit is the relay in Dragon86 → Settings → v86 network.

  /networking.sh          bring the emulated card up (DHCP)
  /networking.sh status   interface, routes, DNS as the guest sees them
