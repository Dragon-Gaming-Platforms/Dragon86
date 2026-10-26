git, HTTPS, and what is actually in this guest
==============================================

`git clone https://github.com/owner/repo` works here. It is a real clone: real
history, real branches, `git log` all the way back.

How
---

The git binary in this guest is a static build configured without curl, so it
has no HTTP transport of its own — git never puts TLS inside git itself. Upstream
git ships those transports as separate programs, and looks them up in its exec
path (`git --exec-path`, which for this build is /usr/lib/git-core):

  /usr/lib/git-core/git-remote-http    real binary, static, libcurl + mbedTLS
  /usr/lib/git-core/git-remote-https   symlink to it (git picks by URL scheme)
  /etc/ssl/certs/ca-certificates.crt   the CA roots it verifies against

Those are written into this filesystem by Dragon86 at boot (see
public/v86/VENDORED.md in the Dragon86 sources for provenance and
tools/build-git-remote-http.sh for the build). They are ordinary files here —
visible and replaceable, like everything else on this share.

What works
----------

  git clone https://github.com/owner/repo        real clone, full history
  git clone https://github.com/owner/repo -b dev
  git fetch / pull / push (over https, with your credentials if you have them)
  git ls-remote https://github.com/owner/repo    just the refs
  git clone /path/to/repo, file:///path, *.bundle

If a clone fails now, the message is about the network, not about git: v86's
relay carries the guest's TCP, so check Dragon86 -> Settings -> v86 network, then

  d86-net check

The fallback: d86-clone
-----------------------

  d86-clone https://github.com/owner/repo [directory] [-b branch]

This predates the HTTPS transport and is still useful for very large
repositories or when you only want the files: it downloads GitHub's own tarball
for one branch and makes a single-commit repository. No upstream history — the
import commit says so.

About `ping`
------------

`ping 1.1.1.1` always succeeds here, even with the network completely dead: v86,
the emulator, answers ICMP on its own virtual link. A ping reply is not evidence
of anything.

  d86-net check

That walks the chain that matters — interface, route, resolv.conf, a real DNS
lookup, a real TLS connection, and then git's own transport — and stops at the
first broken link.

  /networking.sh          bring the emulated card up (DHCP)
  /networking.sh status   interface, routes, DNS as the guest sees them
