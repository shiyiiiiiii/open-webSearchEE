#!/bin/sh
set -eu
# This runs only inside the dedicated worker container. Never on a host.
role="${BROWSER_WORKER_ROLE:?Missing worker role}"
ports="${BROWSER_ALLOWED_PORTS:-80,443}"
case "$ports" in ''|*[!0-9,]*) echo 'Invalid egress ports' >&2; exit 1;; esac

iptables -P OUTPUT DROP
ip6tables -P OUTPUT DROP
iptables -A OUTPUT -p tcp -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
ip6tables -A OUTPUT -p tcp -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

case "$role" in
  browser)
    # Fixed IP avoids a browser-side DNS exception. No loopback, UDP, IPv6,
    # management-port or DIRECT exception, including proxy failure.
    iptables -A OUTPUT -d 172.30.0.2 -p tcp --dport 3128 -j ACCEPT
    tool=browserWorker
    ;;
  proxy)
    # The proxy uses its own fixed resolver, not Docker's synthetic/local DNS.
    iptables -A OUTPUT -d 1.1.1.1 -p udp --dport 53 -j ACCEPT
    iptables -A OUTPUT -d 1.1.1.1 -p tcp --dport 53 -j ACCEPT
    for cidr in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.0.0.0/8 192.0.0.0/8 198.18.0.0/15 198.51.100.0/24 203.0.113.0/24 224.0.0.0/4 240.0.0.0/4; do
      iptables -A OUTPUT -d "$cidr" -j REJECT
    done
    iptables -A OUTPUT -p tcp -m multiport --dports "$ports" -j ACCEPT
    # Resolve/check/pin IPv6 in the proxy as well as these network limits.
    for cidr in 2001::/23 2001:db8::/32 2002::/16 3fff::/20; do
      ip6tables -A OUTPUT -d "$cidr" -j REJECT
    done
    ip6tables -A OUTPUT -d 2000::/3 -p tcp -m multiport --dports "$ports" -j ACCEPT
    tool=browserEgressProxy
    ;;
  *) echo 'Invalid worker role' >&2; exit 1;;
esac
# Dropping uid removes the network-admin capability from the runtime process.
exec su-exec worker node "/app/build/tools/$tool.js"
