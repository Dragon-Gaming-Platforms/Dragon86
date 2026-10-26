#!/bin/sh
# networking.sh — bring the emulated network card up inside the v86 guest.
#
# The card is provided by the EMULATOR, not by this guest: v86 emulates a
# NIC and, for the local link, answers DHCP itself (192.168.86.100 with
# 192.168.86.1 as gateway and DNS). Traffic beyond that link goes through
# v86's network backend — the relay URL set in Dragon86's Settings — so
# "no internet" here usually means the relay, not this script.
#
# Same job as /networking.sh in copy.sh's own images: load the driver,
# ask for a lease, done. Both NIC types v86 can emulate are handled, because
# the Arch image ships ne2k while Dragon86's guest ships virtio-net.
#
#   ./networking.sh            DHCP (default)
#   ./networking.sh static     use the fixed v86 address, no DHCP
#   ./networking.sh status     show the card and current configuration
#   ./networking.sh down       bring the interface down

set -u

MODE="${1:-dhcp}"
ROUTER=192.168.86.1
STATIC_IP=192.168.86.100
PREFIX=24

say() { echo "networking.sh: $*"; }

# v86's NIC is one of these, depending on how the emulator was started.
load_nic() {
    for m in virtio_net ne2k_pci ne2k-pci; do
        modprobe "$m" 2>/dev/null && say "loaded $m"
    done
    # Nothing loaded and nothing probed? Say so plainly instead of hanging.
    if ! ip link show 2>/dev/null | grep -qE '^[0-9]+: (eth|en)'; then
        say "no ethernet interface appeared — is the emulator exposing a NIC?"
        say "(Dragon86: Settings -> v86 network; the relay URL must not be 'off')"
        return 1
    fi
}

iface() {
    # First non-loopback interface, whatever the kernel named it.
    ip -o link show 2>/dev/null \
        | awk -F': ' '$2 != "lo" {print $2; exit}' \
        | sed 's/@.*//'
}

setup_dhcp_script() {
    # busybox udhcpc runs a "script" to apply a lease. GNU-less guests have no
    # /usr/share/udhcpc, so ship a minimal one of our own.
    if [ -x /usr/share/udhcpc/default.script ]; then
        UDPSC=/usr/share/udhcpc/default.script
    else
        UDPSC=/etc/udhcpc.script
        cat > "$UDPSC" <<'EOF'
#!/bin/sh
# Minimal udhcpc hook: apply or drop a lease (busybox udhcpc contract).
case "$1" in
  deconfig|renew|bound)
    [ -n "${interface:-}" ] || exit 0
    if [ "$1" = deconfig ]; then
        ip addr flush dev "$interface" 2>/dev/null
        ip link set "$interface" up 2>/dev/null
        exit 0
    fi
    ip addr flush dev "$interface" 2>/dev/null
    ip addr add "$ip/$mask" dev "$interface" 2>/dev/null
    ip link set "$interface" up 2>/dev/null
    [ -n "${router:-}" ] && ip route add default via "$router" 2>/dev/null
    [ -n "${router:-}" ] && ip route replace default via "$router" 2>/dev/null
    : > /etc/resolv.conf
    for ns in ${dns:-}; do echo "nameserver $ns" >> /etc/resolv.conf; done
    [ -s /etc/resolv.conf ] || echo "nameserver 192.168.86.1" > /etc/resolv.conf
    ;;
esac
exit 0
EOF
        chmod +x "$UDPSC"
    fi
    echo "$UDPSC"
}

show_status() {
    IF="$(iface)"
    say "interface: ${IF:-none}"
    [ -n "${IF:-}" ] && ip addr show "$IF" 2>/dev/null
    say "routes:"; ip route show 2>/dev/null | sed 's/^/    /'
    say "dns:"; sed 's/^/    /' /etc/resolv.conf 2>/dev/null
    say "backend: this card is emulated by v86; v86's own DHCP serves this link (router $ROUTER)"
}

case "$MODE" in
    status) show_status; exit 0 ;;
    down)
        IF="$(iface)"
        [ -n "$IF" ] && ip link set "$IF" down && say "$IF down"
        exit 0 ;;
esac

# Loopback first: it is not the NIC and the emulator does not provide it, but
# anything that talks to itself over 127.0.0.1 needs it up.
ip link set lo up 2>/dev/null

load_nic || exit 1
IF="$(iface)"
[ -n "$IF" ] || { say "no interface"; exit 1; }

ip link set "$IF" up

if [ "$MODE" = static ]; then
    ip addr flush dev "$IF" 2>/dev/null
    ip addr add "$STATIC_IP/$PREFIX" dev "$IF"
    ip route replace default via "$ROUTER"
    echo "nameserver $ROUTER" > /etc/resolv.conf
    say "static: $IF = $STATIC_IP/$PREFIX, gw $ROUTER"
    show_status
    exit 0
fi

SCRIPT="$(setup_dhcp_script)"
if command -v udhcpc >/dev/null 2>&1; then
    # -q: one lease then exit, -t/-T: bounded retries, so this never hangs.
    udhcpc -i "$IF" -s "$SCRIPT" -q -n -t 6 -T 3 && say "dhcp: lease acquired on $IF" \
        || { say "dhcp failed — falling back to the fixed v86 address"; MODE=static; }
    if [ "$MODE" = static ]; then
        ip addr flush dev "$IF" 2>/dev/null
        ip addr add "$STATIC_IP/$PREFIX" dev "$IF"
        ip route replace default via "$ROUTER"
        echo "nameserver $ROUTER" > /etc/resolv.conf
    fi
elif command -v dhcpcd >/dev/null 2>&1; then
    dhcpcd -w4 "$IF" && say "dhcpcd: lease acquired on $IF"
else
    say "no DHCP client (udhcpc/dhcpcd) in this guest — using the fixed v86 address"
    ip addr flush dev "$IF" 2>/dev/null
    ip addr add "$STATIC_IP/$PREFIX" dev "$IF"
    ip route replace default via "$ROUTER"
    echo "nameserver $ROUTER" > /etc/resolv.conf
fi

show_status
say "done. Traffic beyond this link goes through v86's relay, set in Dragon86 Settings -> v86 network."
