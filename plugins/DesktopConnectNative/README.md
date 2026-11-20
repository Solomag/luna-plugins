# DesktopConnectNative

Remote control TIDAL Desktop from the TIDAL phone app with TIDAL Connect. The plugin runs its own
receiver, so no TIDAL binary is needed.

## Only on the same local network
The TIDAL app finds the receiver with mDNS, which only works on the local network (Wi-Fi).
It does not work over Tailscale or another VPN when the phone is on mobile data. Android does no
mDNS on mobile networks, and a VPN over mobile data counts as one. The receiver itself is reachable
over the VPN, so the phone only needs to be told the PC's address. On a rooted Android phone with
a Vector/LSPosed framework, a small module hooking TIDAL's `NsdManager` calls can add the PC by its
Tailscale IP and the plugin's port. That works on mobile data (tested with TIDAL Android 2026-11).

## Firewall
The phone connects to the port shown in the plugin's settings (the first free port from 9000).
Allow it in the PC's firewall: for the local network, and for the Tailscale adapter if you use one.
