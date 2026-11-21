# DesktopConnectNative

Remote control TIDAL Desktop from the TIDAL phone app with TIDAL Connect. The plugin runs its own
receiver, so no TIDAL binary is needed.

## Only on the same local network
The TIDAL app finds the receiver with mDNS, which only works on the local network (Wi-Fi).
It does not work over Tailscale or another VPN when the phone is on mobile data. Android does no
mDNS on mobile networks, and a VPN over mobile data counts as one. The receiver itself is reachable
over the VPN, so the phone only needs to be told the PC's address.

On a rooted Android phone with a Vector/LSPosed framework, a small module inside TIDAL can do that.
It is given only the PC's Tailscale address. It then asks the receiver for its record at
`GET /tidalconnect/service` (on ports 9000–9019), which returns `name`, `type`, `port` and the TXT
record. It reports the receivers it finds to TIDAL's `NsdManager` discovery. TIDAL's own search
(Sony's SDK) also runs only on Wi-Fi, so the module lets it run on any network. Tested with TIDAL
Android 2.220.1 on mobile data with Wi-Fi off (2026-11): the PC is listed, and connect, play, next
and pause work.

## Firewall
The phone connects to the port shown in the plugin's settings (the first free port from 9000).
Allow it in the PC's firewall: for the local network, and for the Tailscale adapter if you use one.
