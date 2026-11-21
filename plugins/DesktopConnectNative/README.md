# DesktopConnectNative

Remote control TIDAL Desktop from the TIDAL phone app with TIDAL Connect. The plugin runs its own
receiver, so no TIDAL binary is needed.

## Playing on the PC while the phone is connected
If you play your own album or track on the PC while the phone is connected, the phone shows what
the PC plays: the title, the artist, the album, the duration, the position, and whether it plays or
is paused. The phone's play, pause, seek, next and previous then control the PC's own queue. The
phone's queue list still shows the phone's queue. Picking a track there, or starting something new
on the phone, gives the player back to the phone.

## Only on the same local network
The TIDAL app finds the receiver with mDNS, which only works on the local network (Wi-Fi).
It does not work over Tailscale or another VPN when the phone is on mobile data. Android does no
mDNS on mobile networks, and a VPN over mobile data counts as one. The receiver itself is reachable
over the VPN, so the phone only needs to be told the PC's address.

On a rooted Android phone with a Vector/LSPosed framework, the module
[TIDAL Connect over Tailscale](https://github.com/Solomag/TidalConnectTailscale) can do that.
You enter only the PC's Tailscale address in its settings screen. It then asks the receiver for its record at
`GET /tidalconnect/service` (on ports 9000–9019), which returns `name`, `type`, `port` and the TXT
record. It reports the receivers it finds to TIDAL's `NsdManager` discovery. TIDAL's own search
(Sony's SDK) also runs only on Wi-Fi, so the module lets it run on any network. Tested with TIDAL
Android 2.220.1 on mobile data with Wi-Fi off (2026-11): the PC is listed, and connect, play, next
and pause work.

## Firewall
The phone connects to the port shown in the plugin's settings (the first free port from 9000).
Allow it in the PC's firewall: for the local network, and for the Tailscale adapter if you use one.

## Allowed addresses
The receiver has no login: whoever reaches its port can take over the session and control the player.
So it lets in only the local network (10/8, 172.16/12, 192.168/16, link-local, IPv6 unique local and
link-local), the PC itself and Tailscale (100.64.0.0/10), and drops other connections before TLS.
For a port forwarded from the internet, add the phone's addresses or ranges under **Allowed addresses**
(like `203.0.113.5, 198.51.100.0/24`). **Allow any address** lets everyone in.
