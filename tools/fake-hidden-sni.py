#!/usr/bin/env python3
"""A StatusNotifierItem shaped the way Chromium and Electron ones are.

Three properties, all of which the real Discord and Bitwarden items have:

  * it serves org.kde.StatusNotifierItem properly (Get/GetAll work),
  * its Introspect reply advertises no interfaces at all, and
  * it never calls RegisterStatusNotifierItem.

Anything that decides "is there an item here?" from the introspection interface
list walks straight past it, at any depth and any call budget. That includes
appindicator's busAnalyzer, and it included Status Tray's own object-tree walk
until the property-probe fallback was added.

Written with dbus-python rather than GJS on purpose: reproducing this shape
needs Introspect overridden while the properties still answer, and GJS's only
route to that is consuming a message in add_filter, which double-frees and
segfaults the process.

Usage:
    tools/fake-hidden-sni.py [--path /org/chromium/StatusNotifierItem/1]
    tools/fake-hidden-sni.py --advertise   # control: same item, honest Introspect
"""

import argparse
import sys

import dbus
import dbus.service
from dbus.mainloop.glib import DBusGMainLoop
from gi.repository import GLib

SNI_IFACE = "org.kde.StatusNotifierItem"
INTROSPECTABLE = "org.freedesktop.DBus.Introspectable"
PROPERTIES = "org.freedesktop.DBus.Properties"

PROPS = {
    "Id": "fake_hidden_icon_1",
    "Title": "Hidden SNI test",
    "Status": "Active",
    "Category": "ApplicationStatus",
    "IconName": "dialog-information",
    "AttentionIconName": "",
    "OverlayIconName": "",
    "ToolTip": "Hidden SNI test",
}

HONEST_XML = """<node>
  <interface name="org.kde.StatusNotifierItem">
    <property name="Id" type="s" access="read"/>
    <property name="Title" type="s" access="read"/>
    <property name="Status" type="s" access="read"/>
    <property name="Category" type="s" access="read"/>
    <property name="IconName" type="s" access="read"/>
  </interface>
</node>
"""


class Ancestor(dbus.service.Object):
    """Enumerates one child, so a walk from '/' can actually reach the leaf.

    Without this the item is unreachable and a negative result would prove
    nothing about the interface list. It mirrors the chain Bitwarden presents:
    / -> org -> chromium -> StatusNotifierItem -> 1.
    """

    def __init__(self, conn, path, child):
        super().__init__(conn, path)
        self._child = child

    @dbus.service.method(INTROSPECTABLE, in_signature="", out_signature="s")
    def Introspect(self):
        return '<node>\n  <node name="%s"/>\n</node>\n' % self._child


class HiddenItem(dbus.service.Object):
    def __init__(self, conn, path, advertise):
        super().__init__(conn, path)
        self._advertise = advertise

    @dbus.service.method(INTROSPECTABLE, in_signature="", out_signature="s")
    def Introspect(self):
        # The whole point: a bare node, while the properties below still answer.
        return HONEST_XML if self._advertise else "<node>\n</node>\n"

    @dbus.service.method(PROPERTIES, in_signature="ss", out_signature="v")
    def Get(self, interface, prop):
        if interface != SNI_IFACE or prop not in PROPS:
            raise dbus.exceptions.DBusException(
                "org.freedesktop.DBus.Error.InvalidArgs",
                "No such property %s on %s" % (prop, interface),
            )
        return dbus.String(PROPS[prop])

    @dbus.service.method(PROPERTIES, in_signature="s", out_signature="a{sv}")
    def GetAll(self, interface):
        if interface != SNI_IFACE:
            return dbus.Dictionary({}, signature="sv")
        return dbus.Dictionary(
            {k: dbus.String(v) for k, v in PROPS.items()}, signature="sv"
        )

    @dbus.service.method(SNI_IFACE, in_signature="ii", out_signature="")
    def Activate(self, x, y):
        print("Activate(%d, %d) — the host reached this item" % (x, y))

    @dbus.service.signal(SNI_IFACE, signature="")
    def NewIcon(self):
        pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--path", default="/org/chromium/StatusNotifierItem/1")
    parser.add_argument(
        "--advertise",
        action="store_true",
        help="control run: identical item that does name the interface",
    )
    args = parser.parse_args()

    DBusGMainLoop(set_as_default=True)
    bus = dbus.SessionBus()

    segments = [s for s in args.path.split("/") if s]
    keep = []
    for i, seg in enumerate(segments):
        parent = "/" if i == 0 else "/" + "/".join(segments[:i])
        keep.append(Ancestor(bus, parent, seg))

    keep.append(HiddenItem(bus, args.path, args.advertise))

    print("Exporting a StatusNotifierItem at %s" % args.path)
    print("  bus name:   %s" % bus.get_unique_name())
    print("  Introspect: %s" % ("names the interface (control)"
                                if args.advertise else "bare <node></node>"))
    print("  Get(Id):    %s" % PROPS["Id"])
    print("  Register:   deliberately NOT called")
    print()
    print("Toggle Status Tray to make it sweep, then check whether the icon")
    print("appears. Ctrl+C to stop.")
    sys.stdout.flush()

    try:
        GLib.MainLoop().run()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
