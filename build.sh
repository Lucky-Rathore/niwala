#!/usr/bin/env bash
# Build Niwala: VS Code (Code - OSS) + opencode, with opencode's web UI built in.
#
#   ./build.sh dev                        build for this machine and launch Niwala from source
#   ./build.sh package <platform> <arch>  build a packaged app, e.g.
#                                           linux x64 | linux arm64
#                                           darwin x64 | darwin arm64
#                                           win32 x64 | win32 arm64
#
# VS Code's native modules must be built on the target OS, so run `package` on
# each OS (e.g. a CI matrix). The opencode binary itself can be cross-compiled.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPENCODE="$ROOT/opencode"
VSCODE="$ROOT/vscode"
EXT_BIN="$VSCODE/extensions/opencode/bin"

host_platform() {
	case "$(uname -s)" in
		Linux) echo linux ;;
		Darwin) echo darwin ;;
		MINGW* | MSYS* | CYGWIN*) echo win32 ;;
		*) echo "unsupported OS: $(uname -s)" >&2; exit 1 ;;
	esac
}

host_arch() {
	case "$(uname -m)" in
		x86_64 | amd64) echo x64 ;;
		aarch64 | arm64) echo arm64 ;;
		*) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;;
	esac
}

# Builds the opencode binary (web UI embedded) and copies it into the built-in extension.
build_opencode() {
	local platform="$1" arch="$2"
	local os="$platform"
	[[ "$platform" == win32 ]] && os=windows

	echo "==> Building opencode for $platform-$arch"
	(cd "$OPENCODE" && bun install)

	local single=()
	[[ "$platform" == "$(host_platform)" && "$arch" == "$(host_arch)" ]] && single=(--single)
	(
		cd "$OPENCODE/packages/opencode"
		OPENCODE_CHANNEL=niwala \
		OPENCODE_VERSION="$(node -p "require('./package.json').version")" \
			bun run script/build.ts ${single[@]+"${single[@]}"}
	)

	local out="$OPENCODE/packages/opencode/dist/opencode-$os-$arch/bin"
	rm -rf "$EXT_BIN" && mkdir -p "$EXT_BIN"
	if [[ -f "$out/opencode.exe" ]]; then
		cp "$out/opencode.exe" "$EXT_BIN/"
	else
		cp "$out/opencode" "$EXT_BIN/"
		chmod +x "$EXT_BIN/opencode"
	fi
}

# VS Code's native modules (native-keymap, keytar, kerberos) link against these on Linux.
check_linux_deps() {
	[[ "$(host_platform)" == linux ]] || return 0
	local missing=()
	pkg-config --exists x11 || missing+=(libx11-dev)
	pkg-config --exists xkbfile || missing+=(libxkbfile-dev)
	pkg-config --exists libsecret-1 || missing+=(libsecret-1-dev)
	pkg-config --exists krb5-gssapi || missing+=(libkrb5-dev)
	if ((${#missing[@]})); then
		echo "missing system packages for VS Code native modules; install them with:" >&2
		echo "  sudo apt-get install -y ${missing[*]}" >&2
		exit 1
	fi
}

# Where AppArmor blocks unprivileged user namespaces (Ubuntu 24.04+), Electron needs its
# setuid sandbox helper, which must be root-owned. Downloading Electron resets that.
check_electron_sandbox() {
	[[ "$(host_platform)" == linux ]] || return 0
	[[ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null)" == 1 ]] || return 0
	local sandbox="$VSCODE/.build/electron/chrome-sandbox"
	[[ -f "$sandbox" ]] || return 0
	if [[ "$(stat -c '%u %a' "$sandbox")" != "0 4755" ]]; then
		echo "Electron's sandbox helper must be root-owned and setuid; fix it with:" >&2
		echo "  sudo chown root:root '$sandbox' && sudo chmod 4755 '$sandbox'" >&2
		exit 1
	fi
}

install_vscode_deps() {
	echo "==> Installing VS Code dependencies"
	(cd "$VSCODE" && npm install)
	# A retried install can re-extract packages without restoring +x on their bins.
	local bin
	for bin in "$VSCODE"/node_modules/.bin/*; do
		[[ -e "$bin" && ! -x "$bin" ]] && chmod +x "$(readlink -f "$bin")"
	done
	return 0
}

cmd="${1:-dev}"
case "$cmd" in
	dev)
		check_linux_deps
		build_opencode "$(host_platform)" "$(host_arch)"
		install_vscode_deps
		(cd "$VSCODE" && npm run compile && npm run electron)
		check_electron_sandbox
		if [[ "$(host_platform)" == win32 ]]; then
			(cd "$VSCODE" && ./scripts/code.bat)
		else
			(cd "$VSCODE" && ./scripts/code.sh)
		fi
		;;
	package)
		platform="${2:?platform required (linux|darwin|win32)}"
		arch="${3:?arch required (x64|arm64)}"
		check_linux_deps
		build_opencode "$platform" "$arch"
		install_vscode_deps
		(cd "$VSCODE" && npm run gulp "vscode-$platform-$arch-min")
		echo "==> Niwala packaged at $ROOT/VSCode-$platform-$arch"
		;;
	*)
		echo "usage: $0 dev | package <platform> <arch>" >&2
		exit 1
		;;
esac
