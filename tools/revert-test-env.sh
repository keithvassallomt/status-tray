#!/bin/bash
#
# Undoes everything the issue #28 investigation changed on this machine.
# Leaves the captured evidence in ~/sni-boot-captures and ~/sni-race-tests
# alone; pass --purge-data to remove those too.
set -u

PURGE=${1:-}

echo "== restoring enabled-extensions to the pre-test set =="
gsettings set org.gnome.shell enabled-extensions \
    "['background-logo@fedorahosted.org', 'status-tray@keithvassallo.com']"

echo "== removing extensions installed for the test =="
for uuid in appindicatorsupport@rgcjonas.gmail.com caffeine@patapon.info \
            blur-my-shell@aunetx just-perfection-desktop@just-perfection \
            Vitals@CoreCoding.com; do
    gnome-extensions disable "$uuid" 2>/dev/null
    rm -rf "$HOME/.local/share/gnome-shell/extensions/$uuid"
    echo "  removed $uuid"
done

echo "== removing autostart entries =="
rm -fv ~/.config/autostart/zz-snitest-*.desktop ~/.config/autostart/zzz-sni-capture.desktop

echo "== removing debug logging override =="
rm -fv ~/.config/environment.d/99-sni-debug.conf

echo "== restoring Status Tray to a normal copy install with DEBUG off =="
cd "$(dirname "$0")/.." || exit 1
sed -i 's/^const DEBUG = true;/const DEBUG = false;/' src/extension.js
rm -rf "$HOME/.local/share/gnome-shell/extensions/status-tray@keithvassallo.com"
./install.sh >/dev/null && echo "  reinstalled from src (copy mode, DEBUG off)"

echo
echo "== NOT removed, remove by hand if you want them gone =="
echo "  flatpaks:  flatpak uninstall --user org.keepassxc.KeePassXC com.discordapp.Discord com.dropbox.Client"
echo "  remote:    flatpak remote-delete --user flathub"
echo "  native:    sudo dnf remove keepassxc"
echo "  config:    ~/.config/keepassxc/keepassxc.ini"
echo "             ~/.var/app/org.keepassxc.KeePassXC/"
echo "  (left alone because you may want to keep the apps)"

if [ "$PURGE" = "--purge-data" ]; then
    echo
    echo "== purging captured evidence =="
    rm -rfv ~/sni-boot-captures ~/sni-race-tests
fi

echo
echo "Done. Log out and back in for the extension changes to take effect."
