#!/usr/bin/env bash
# Generated standalone launcher; edit scripts/machine/* then run build-machine.mjs.
set -Eeuo pipefail
umask 077
fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
COMMAND=${1:-help}
case "$COMMAND" in
  help) printf '%s\n' 'Usage: mytikas-machine.sh prepare|doctor|status|migrate|import ARCHIVE.zip|recover finish-export|recover previous|recover source'; exit 0 ;;
  prepare|doctor|status|migrate|import|recover) ;;
  *) fail 'Unknown command; use help' ;;
esac
MACHINE_HOME="$HOME/.mytikas"
mkdir -p "$MACHINE_HOME/tools"
chmod 700 "$MACHINE_HOME" "$MACHINE_HOME/tools"
SYSTEM=$(uname -s)
[[ $(uname -m) == x86_64 ]] || fail 'This launcher supports Intel macOS and x86_64 WSL2 only'
case "$SYSTEM" in
  Darwin) NODE_OS=darwin; NODE_SHA=d5e336d588c45be0c37dbd52cc29895593009ca4997a77a1fd02815131ed0e52 ;;
  Linux) NODE_OS=linux; NODE_SHA=361718c444e49af2ca5a110c83ba6a8901143f23ab285ebbef0341f391f482a9 ;;
  *) fail 'Unsupported operating system' ;;
esac
verify() {
  local actual
  if command -v shasum >/dev/null 2>&1; then actual=$(shasum -a 256 "$1");
  else actual=$(sha256sum "$1"); fi
  [[ ${actual%% *} == "$2" ]] || fail 'Downloaded installer checksum mismatch'
}
fetch() { curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 --output "$2" "$1"; }
if ! command -v node >/dev/null 2>&1 || [[ $(node -p 'process.versions.node.split(".")[0]') != 24 ]]; then
  NODE_DIR="$MACHINE_HOME/tools/node-v24.22.2-$NODE_OS-x64"
  if [[ ! -x "$NODE_DIR/bin/node" ]]; then
    STAGE=$(mktemp -d "$MACHINE_HOME/tools/node.XXXXXX")
    trap 'rm -rf -- "$STAGE"' EXIT
    fetch "https://nodejs.org/dist/v24.22.2/node-v24.22.2-$NODE_OS-x64.tar.gz" "$STAGE/node.tar.gz"
    verify "$STAGE/node.tar.gz" "$NODE_SHA"
    tar -xzf "$STAGE/node.tar.gz" -C "$STAGE"
    mv "$STAGE/node-v24.22.2-$NODE_OS-x64" "$NODE_DIR"
    rm -rf -- "$STAGE"
    trap - EXIT
  fi
  export PATH="$NODE_DIR/bin:$PATH"
fi
unset DOCKER_HOST DOCKER_CONTEXT
DOCKER=(docker)
if [[ -f "$MACHINE_HOME/machine.json" ]]; then
  SELECTED_CONTEXT=$(node -e 'const fs=require("node:fs"); const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(s.context)process.stdout.write(s.context)' "$MACHINE_HOME/machine.json")
  if [[ -n $SELECTED_CONTEXT ]]; then DOCKER+=(--context "$SELECTED_CONTEXT"); fi
fi
if [[ $COMMAND != status ]]; then
  if [[ $SYSTEM == Darwin ]]; then
    export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"
  fi
  if ! "${DOCKER[@]}" info >/dev/null 2>&1; then
    if [[ $SYSTEM == Linux ]]; then
      fail 'Start Docker Desktop on Windows, select Linux containers, enable Settings > Resources > WSL Integration for this distribution, then rerun this command. Check docker context show and docker info inside WSL.'
    fi
    if [[ ! -d /Applications/Docker.app ]]; then
      INSTALLER="$MACHINE_HOME/tools/Docker-4.98.0-intel.dmg"
      if [[ ! -f "$INSTALLER" ]]; then
        fetch 'https://desktop.docker.com/mac/main/amd64/245422/Docker.dmg' "$INSTALLER.partial"
        verify "$INSTALLER.partial" 96b53f9a4a807b6be6207d18f360b9778ff481e1d94b5027bdf1ae2a22d837cb
        mv "$INSTALLER.partial" "$INSTALLER"
      fi
      verify "$INSTALLER" 96b53f9a4a807b6be6207d18f360b9778ff481e1d94b5027bdf1ae2a22d837cb
      MOUNT=$(mktemp -d "$MACHINE_HOME/tools/docker-mount.XXXXXX")
      hdiutil attach "$INSTALLER" -mountpoint "$MOUNT" -nobrowse -quiet
      trap 'hdiutil detach "$MOUNT" -quiet; rmdir "$MOUNT"' EXIT
      codesign --verify --deep --strict "$MOUNT/Docker.app"
      spctl --assess --type execute "$MOUNT/Docker.app"
      sudo "$MOUNT/Docker.app/Contents/MacOS/install"
      hdiutil detach "$MOUNT" -quiet
      rmdir "$MOUNT"
      trap - EXIT
    fi
    open -a Docker
    printf '%s\n' 'Complete Docker Desktop permissions and terms prompts. Waiting up to 60 seconds; rerun the same command if more time is needed.'
    for ((attempt=0;attempt<12;attempt++)); do
      if "${DOCKER[@]}" info >/dev/null 2>&1; then break; fi
      sleep 5
    done
    "${DOCKER[@]}" info >/dev/null 2>&1 || fail 'Docker Desktop is not ready. Complete its prompts, then rerun this command.'
  fi
fi
export MYTIKAS_LAUNCH_DIR
MYTIKAS_LAUNCH_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PAYLOAD=$(mktemp "$MACHINE_HOME/tools/launcher.XXXXXX")
trap 'rm -f -- "$PAYLOAD"' EXIT
# The following source is part of this trusted launcher, never read from the transfer ZIP.
cat > "$PAYLOAD" <<'MYTIKAS_EMBEDDED_MODULE'
