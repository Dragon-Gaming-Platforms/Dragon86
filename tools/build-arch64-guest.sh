#!/bin/sh
# Build public/arch64/ — the 64-bit Arch Linux guest.
#
# What this produces (all vendored output, committed by the build-arch64
# workflow, never written by hand):
#
#   public/arch64/bzImage            Arch Linux x86_64 kernel (the `linux`
#                                    package's vmlinuz)
#   public/arch64/initrd.gz          the 64-bit userland: Arch's bash,
#                                    coreutils, grep, sed, gawk, kmod,
#                                    util-linux setsid + their glibc closure,
#                                    busybox for the rest, the virtio/9p/
#                                    serial/keyboard kernel modules, and a
#                                    static 64-bit git — in exactly the layout
#                                    of the 32-bit initrd (whose non-userland
#                                    entries — /init, /networking.sh, /etc —
#                                    are reused verbatim; they are shell
#                                    scripts and text, not binaries)
#   public/arch64/git-remote-http.gz git's HTTPS transport, static
#                                    x86_64-musl (libcurl + mbedTLS), same
#                                    recipe as the proven 32-bit one in
#                                    tools/build-git-remote-http.sh
#
# Where the pieces come from:
#   - kernel + userland: the official `archlinux` Docker image, packages
#     installed with pacman (this is Arch's own x86_64 build, not a rebuild)
#   - git + transport: built here from pinned source tarballs with zig cc
#     (same versions as the 32-bit guest; only the target triple differs)
#
# Run on ubuntu-latest (needs docker, node/npm, python3). ~10 minutes.
set -eu

REPO=$(cd "$(dirname "$0")/.." && pwd)
WORK=${WORK:-/tmp/d86-arch64-build}
OUT="$REPO/public/arch64"
ZIG_TARGET=x86_64-linux-musl

GIT_VERSION=2.49.1
CURL_VERSION=8_11_1
MBEDTLS_VERSION=3.6.2
ZLIB_VERSION=1.3.1
ZIG_PKG=@oven/zig@0.11.0-dev.2401

mkdir -p "$WORK/src" "$WORK/prefix/lib" "$WORK/prefix/include" "$WORK/bin" "$OUT"
say() { printf '== %s\n' "$*"; }

# ================================================================ userland ==
# Everything Arch: run the official image, install the packages, and copy the
# curated file set plus its shared-library closure into a staging tree.
STAGE="$WORK/stage"
if [ ! -f "$STAGE/.done" ]; then
  say "Arch x86_64 userland + kernel via docker"
  rm -rf "$STAGE"; mkdir -p "$STAGE"
  docker run --rm -v "$STAGE:/stage" -v "$REPO/tools:/tools:ro" archlinux:latest \
    bash /tools/arch64-collect.sh
  # the container wrote as root; hand the tree back to the runner user
  sudo chown -R "$(id -u):$(id -g)" "$STAGE" 2>/dev/null || chown -R "$(id -u):$(id -g)" "$STAGE" || true
  [ -f "$STAGE/.done" ]
fi
KVER=$(cat "$STAGE/kver")
say "kernel: $KVER"

# ================================================================ toolchain ==
if [ ! -x "$WORK/zig/zig" ]; then
  say "zig $ZIG_PKG from npm"
  ( cd "$WORK" && { [ -f package.json ] || npm init -y >/dev/null; }
    npm i --no-audit --no-fund "$ZIG_PKG" >/dev/null )
  ln -sfn "$WORK/node_modules/@oven/zig-linux-x64" "$WORK/zig"
fi
ZIG="$WORK/zig/zig"
"$ZIG" version

fetch() { # owner/repo tag file — same pins as tools/build-git-remote-http.sh
  [ -f "$WORK/src/$3" ] || {
    say "fetch $1@$2"
    curl -sSL -o "$WORK/src/$3" "https://codeload.github.com/$1/tar.gz/refs/tags/$2"
  }
  tar xzf "$WORK/src/$3" -C "$WORK/src"
}
fetch git/git "v$GIT_VERSION" git.tgz
fetch curl/curl "curl-$CURL_VERSION" curl.tgz
fetch Mbed-TLS/mbedtls "v$MBEDTLS_VERSION" mbedtls.tgz
fetch madler/zlib "v$ZLIB_VERSION" zlib.tgz

# ===================================================================== zlib ==
if [ ! -f "$WORK/prefix/lib/libz.a" ]; then
  say "zlib (static, $ZIG_TARGET)"
  ( cd "$WORK/src/zlib-$ZLIB_VERSION"
    CC="$ZIG cc -target $ZIG_TARGET" ./configure --static --prefix="$WORK/prefix" >/dev/null
    make -j"$(nproc)" libz.a >/dev/null
    cp libz.a "$WORK/prefix/lib/"; cp zlib.h zconf.h "$WORK/prefix/include/" )
fi

# ================================================================== mbedtls ==
if [ ! -f "$WORK/prefix/lib/libmbedtls.a" ]; then
  say "mbedtls (static, $ZIG_TARGET)"
  ( cd "$WORK/src/mbedtls-$MBEDTLS_VERSION"
    make CC="$ZIG cc -target $ZIG_TARGET" AR="$ZIG ar" CFLAGS="-O2 -fPIC" lib -j"$(nproc)" >/dev/null
    mkdir -p "$WORK/prefix/include/mbedtls" "$WORK/prefix/include/psa"
    cp include/mbedtls/*.h "$WORK/prefix/include/mbedtls/"
    cp include/psa/*.h "$WORK/prefix/include/psa/"
    cp library/*.a "$WORK/prefix/lib/" )
fi

# ================================================================== libcurl ==
# Same hand-written Makefile.mk build as the 32-bit transport; the config
# header carries the x86_64 type sizes (long/size_t/void* are 8 bytes here).
if [ ! -f "$WORK/prefix/lib/libcurl.a" ]; then
  say "libcurl (mbedTLS, static, $ZIG_TARGET)"
  cat > "$WORK/src/curl-curl-$CURL_VERSION/lib/curl_config.h" <<'CONFIG'
#define SIZEOF_INT 4
#define SIZEOF_LONG 8
#define SIZEOF_SHORT 2
#define SIZEOF_SIZE_T 8
#define SIZEOF_OFF_T 8
#define SIZEOF_CURL_OFF_T 8
#define SIZEOF_TIME_T 8
#define SIZEOF_LONG_LONG 8
#define SIZEOF_VOIDP 8
#define HAVE_RECV 1
#define RECV_TYPE_ARG1 int
#define RECV_TYPE_ARG2 void *
#define RECV_TYPE_ARG3 size_t
#define RECV_TYPE_ARG4 int
#define RECV_TYPE_RETV ssize_t
#define HAVE_SEND 1
#define SEND_TYPE_ARG1 int
#define SEND_QUAL_ARG2 const
#define SEND_TYPE_ARG2 void *
#define SEND_TYPE_ARG3 size_t
#define SEND_TYPE_ARG4 int
#define SEND_TYPE_RETV ssize_t
#define HAVE_STRUCT_TIMEVAL 1
#define HAVE_SYS_SOCKET_H 1
#define HAVE_SYS_TIME_H 1
#define HAVE_SYS_TYPES_H 1
#define HAVE_SYS_STAT_H 1
#define HAVE_SYS_UIO_H 1
#define HAVE_UNISTD_H 1
#define HAVE_FCNTL_H 1
#define HAVE_NETDB_H 1
#define HAVE_NETINET_IN_H 1
#define HAVE_NETINET_TCP_H 1
#define HAVE_ARPA_INET_H 1
#define HAVE_SIGNAL_H 1
#define HAVE_ERRNO_H 1
#define HAVE_STRING_H 1
#define HAVE_STDLIB_H 1
#define HAVE_TIME_H 1
#define HAVE_PWD_H 1
#define HAVE_POLL_H 1
#define HAVE_SYS_POLL_H 1
#define HAVE_SYS_IOCTL_H 1
#define HAVE_DIRENT_H 1
#define HAVE_LIBGEN_H 1
#define HAVE_SIGACTION 1
#define HAVE_SIGNAL 1
#define HAVE_SOCKET 1
#define HAVE_FCNTL 1
#define HAVE_FCNTL_O_NONBLOCK 1
#define HAVE_GETADDRINFO 1
#define HAVE_GETTIMEOFDAY 1
#define HAVE_SELECT 1
#define HAVE_POLL 1
#define HAVE_STRDUP 1
#define HAVE_STRTOK_R 1
#define HAVE_STRCASECMP 1
#define HAVE_STRNCASECMP 1
#define HAVE_STRERROR_R 1
#define HAVE_POSIX_STRERROR_R 1
#define HAVE_WRITEV 1
#define HAVE_PIPE 1
#define HAVE_ALARM 1
#define HAVE_UTIME 1
#define HAVE_UTIMES 1
#define HAVE_GETEUID 1
#define HAVE_ACCESS 1
#define HAVE_FTRUNCATE 1
#define HAVE_SOCKETPAIR 1
#define HAVE_INET_PTON 1
#define HAVE_INET_NTOP 1
#define HAVE_BASENAME 1
#define HAVE_GMTIME_R 1
#define HAVE_LOCALTIME_R 1
#define HAVE_TIMEGM 1
#define HAVE_MSG_NOSIGNAL 1
#define HAVE_IFADDRS_H 1
#define HAVE_SYS_UN_H 1
#define HAVE_LONGLONG 1
#define HAVE_CLOCK_GETTIME 1
#define HAVE_MONOTONIC_CLOCK 1
#define HAVE_CLOCK_GETTIME_MONOTONIC 1
#define HAVE_SCHED_YIELD 1
#define HAVE_GETRLIMIT 1
#define HAVE_SETRLIMIT 1
#define ENABLE_IPV6 1
#define CURL_DISABLE_LDAP 1
#define CURL_DISABLE_LDAPS 1
#define CURL_DISABLE_SMB 1
#define CURL_DISABLE_GOPHER 1
#define CURL_DISABLE_MQTT 1
#define CURL_DISABLE_TELNET 1
#define CURL_DISABLE_DICT 1
#define CURL_DISABLE_TFTP 1
#define CURL_DISABLE_POP3 1
#define CURL_DISABLE_IMAP 1
#define CURL_DISABLE_SMTP 1
#define CURL_DISABLE_RTSP 1
/* Where the guest keeps its roots; see installGitTransport() in the bridge. */
#define CURL_CA_BUNDLE "/etc/ssl/certs/ca-certificates.crt"
#define OS "x86_64-linux-musl"
#define CURL_OS "x86_64-linux-musl"
CONFIG
  ( cd "$WORK/src/curl-curl-$CURL_VERSION"
    mkdir -p lib/x86_64-unknown-linux-musl
    make -C lib -f Makefile.mk CFG=-mbedtls-zlib-ipv6 \
      CC="$ZIG cc -target $ZIG_TARGET" AR="$ZIG ar" \
      MBEDTLS_PATH="$WORK/prefix" ZLIB_PATH="$WORK/prefix" \
      CFLAGS="-O2 -fPIC -DHAVE_CONFIG_H" libcurl.a -j"$(nproc)" >/dev/null
    cp lib/libcurl.a "$WORK/prefix/lib/"
    mkdir -p "$WORK/prefix/include/curl"
    cp include/curl/*.h "$WORK/prefix/include/curl/" )
fi

# ============================================== git + git-remote-http (64) ==
# The same split the 32-bit guest uses: a static git WITHOUT curl in the
# initramfs (local operation: init/add/commit/branch/merge/file:// all work),
# plus the separate HTTPS transport binary (curl+mbedTLS) that the OS writes
# into /usr/lib/git-core at boot.
GIT_MAKE_FLAGS="NO_GETTEXT=1 NO_TCLTK=1 NO_PERL=1 NO_PYTHON=1 NO_RUST=1 NO_OPENSSL=1 \
  NO_INSTALL_HARDLINKS=1 NO_ICONV=1 NO_REGEX=NeedsStartEnd NO_EXPAT=1"
if [ ! -f "$WORK/bin/git" ]; then
  say "git (static, $ZIG_TARGET)"
  ( cd "$WORK/src/git-$GIT_VERSION"
    make -j"$(nproc)" git \
      CC="$ZIG cc -target $ZIG_TARGET" AR="$ZIG ar" \
      prefix=/usr gitexecdir=/usr/lib/git-core \
      CFLAGS="-O2 -I$WORK/prefix/include" LDFLAGS="-static -L$WORK/prefix/lib" \
      ZLIB_PATH="$WORK/prefix" NO_CURL=1 $GIT_MAKE_FLAGS >/dev/null
    cp git "$WORK/bin/git"
    strip "$WORK/bin/git" )
fi
if [ ! -f "$WORK/bin/git-remote-http" ]; then
  say "git-remote-http (static, $ZIG_TARGET)"
  ( cd "$WORK/src/git-$GIT_VERSION"
    make -j"$(nproc)" git-remote-http \
      CC="$ZIG cc -target $ZIG_TARGET" AR="$ZIG ar" \
      prefix=/usr gitexecdir=/usr/lib/git-core \
      CURL_CFLAGS="-I$WORK/prefix/include" \
      CURL_LDFLAGS="$WORK/prefix/lib/libcurl.a $WORK/prefix/lib/libmbedtls.a $WORK/prefix/lib/libmbedx509.a $WORK/prefix/lib/libmbedcrypto.a $WORK/prefix/lib/libz.a" \
      CFLAGS="-O2 -I$WORK/prefix/include" LDFLAGS="-L$WORK/prefix/lib" \
      $GIT_MAKE_FLAGS >/dev/null
    cp git-remote-http "$WORK/bin/git-remote-http"
    strip "$WORK/bin/git-remote-http" )
fi

# The runner is x86_64, so these binaries run HERE — check them for real
# before they ship. (The transport speaks the remote-helper protocol on
# stdin; "capabilities" must answer with fetch/push/option lines.)
say "checking the binaries on this (x86_64) machine"
"$WORK/bin/git" --version
printf 'capabilities\n\n' | "$WORK/bin/git-remote-http" x https://github.com/ | grep -q fetch
say "git-remote-http answers the remote-helper handshake"

# ================================================================ assemble ==
say "assembling initrd.gz"
cp "$WORK/bin/git" "$STAGE/usr/bin/git"
chmod 755 "$STAGE/usr/bin/git"
python3 "$REPO/tools/make-arch64-initrd.py" \
  --base "$REPO/public/v86/initrd.gz" \
  --stage "$STAGE" \
  --out "$OUT/initrd.gz"

cp "$STAGE/vmlinuz" "$OUT/bzImage"
gzip -9 -n -c "$WORK/bin/git-remote-http" > "$OUT/git-remote-http.gz"

say "wrote $OUT/bzImage           ($(wc -c < "$OUT/bzImage") bytes, kernel $KVER)"
say "wrote $OUT/initrd.gz         ($(wc -c < "$OUT/initrd.gz") bytes)"
say "wrote $OUT/git-remote-http.gz ($(wc -c < "$OUT/git-remote-http.gz") bytes)"
