"""Generates the remote provisioning script for Prepare Kubernetes.

Kept as a generator rather than written inline in C++ because the script is
long, shell-quoted, and embedded in a C++ string literal — three layers of
escaping that are miserable to edit by hand and easy to get subtly wrong.

Run this to regenerate the block, then paste it into SshService.cpp.
"""

# Each line becomes one C++ string literal. Keeping them separate makes the
# generated source readable and diffable.
SCRIPT_LINES = [
    'set -e; ',
    'echo __STACKPILOT_PROVISION_K8S_START__; ',

    # ── already done? ────────────────────────────────────────────
    # Idempotent by design: re-running must be safe, because the button is
    # right next to "failed" and people will press it again.
    'if (command -v kubectl >/dev/null 2>&1 && kubectl get nodes >/dev/null 2>&1) || ',
    '   (command -v k3s >/dev/null 2>&1 && (k3s kubectl get nodes >/dev/null 2>&1 || $SUDOC k3s kubectl get nodes >/dev/null 2>&1)); then ',
    '  echo kubernetes_status=ready; echo __STACKPILOT_PROVISION_K8S_DONE__; exit 0; ',
    'fi; ',

    'if [ "$(id -u)" -ne 0 ] && ! $SUDOCHECK; then ',
    '  echo __STACKPILOT_SUDO_REQUIRED__; exit 20; ',
    'fi; ',
    "SUDO=''; [ \"$(id -u)\" -eq 0 ] || SUDO='$SUDOC'; ",

    # ── identify the distribution ────────────────────────────────
    # Reported back so a failure on an untested distro is diagnosable rather
    # than just "it did not work".
    'DISTRO=unknown; ',
    'if [ -r /etc/os-release ]; then . /etc/os-release; DISTRO="${ID:-unknown}"; fi; ',
    'echo distro="$DISTRO"; ',
    'echo distro_version="${VERSION_ID:-unknown}"; ',

    # ── a downloader, whichever exists ───────────────────────────
    # The old script hard-required curl and gave up. Minimal images routinely
    # ship wget instead, and installing curl is itself a package operation
    # that can fail, so try what is already there first.
    'DL=""; ',
    'if command -v curl >/dev/null 2>&1; then DL="curl -sfL"; ',
    'elif command -v wget >/dev/null 2>&1; then DL="wget -qO-"; ',
    'fi; ',
    'if [ -z "$DL" ]; then ',
    '  echo installing_downloader=yes; ',
    '  if command -v apt-get >/dev/null 2>&1; then $SUDO apt-get update -y >/dev/null 2>&1 || true; $SUDO apt-get install -y curl >/dev/null 2>&1 || true; ',
    '  elif command -v dnf >/dev/null 2>&1; then $SUDO dnf install -y curl >/dev/null 2>&1 || true; ',
    '  elif command -v yum >/dev/null 2>&1; then $SUDO yum install -y curl >/dev/null 2>&1 || true; ',
    '  elif command -v zypper >/dev/null 2>&1; then $SUDO zypper -n install curl >/dev/null 2>&1 || true; ',
    '  elif command -v pacman >/dev/null 2>&1; then $SUDO pacman -Sy --noconfirm curl >/dev/null 2>&1 || true; ',
    '  elif command -v apk >/dev/null 2>&1; then $SUDO apk add --no-cache curl >/dev/null 2>&1 || true; ',
    '  fi; ',
    '  command -v curl >/dev/null 2>&1 && DL="curl -sfL"; ',
    'fi; ',
    'if [ -z "$DL" ]; then echo __STACKPILOT_NO_DOWNLOADER__; exit 21; fi; ',

    # ── distro prerequisites ─────────────────────────────────────
    # k3s on the RHEL family needs container-selinux, or the agent starts and
    # then cannot run containers. This is the single most common reason k3s
    # "installs fine" on Fedora and then does nothing.
    'case "$DISTRO" in ',
    '  fedora|rhel|centos|rocky|almalinux|ol) ',
    '    echo installing_selinux_deps=yes; ',
    '    ($SUDO dnf install -y container-selinux selinux-policy-base >/dev/null 2>&1 || ',
    '     $SUDO yum install -y container-selinux selinux-policy-base >/dev/null 2>&1 || true); ',
    '    ;; ',
    '  amzn) ',
    '    ($SUDO yum install -y container-selinux >/dev/null 2>&1 || true); ',
    '    ;; ',
    'esac; ',

    # ── firewall ─────────────────────────────────────────────────
    # Fedora and RHEL ship firewalld enabled. It silently drops the API port
    # and the flannel VXLAN port, so the cluster forms and then nothing can
    # reach it. Opening these is why "it works on Ubuntu but not Fedora".
    'if command -v firewall-cmd >/dev/null 2>&1 && $SUDO firewall-cmd --state >/dev/null 2>&1; then ',
    '  echo configuring_firewalld=yes; ',
    '  $SUDO firewall-cmd --permanent --add-port=6443/tcp >/dev/null 2>&1 || true; ',
    '  $SUDO firewall-cmd --permanent --add-port=10250/tcp >/dev/null 2>&1 || true; ',
    '  $SUDO firewall-cmd --permanent --add-port=8472/udp >/dev/null 2>&1 || true; ',
    '  $SUDO firewall-cmd --permanent --add-masquerade >/dev/null 2>&1 || true; ',
    '  $SUDO firewall-cmd --reload >/dev/null 2>&1 || true; ',
    'fi; ',
    'if command -v ufw >/dev/null 2>&1 && $SUDO ufw status 2>/dev/null | grep -qi "^Status: active"; then ',
    '  echo configuring_ufw=yes; ',
    '  $SUDO ufw allow 6443/tcp >/dev/null 2>&1 || true; ',
    '  $SUDO ufw allow 10250/tcp >/dev/null 2>&1 || true; ',
    '  $SUDO ufw allow 8472/udp >/dev/null 2>&1 || true; ',
    'fi; ',

    # ── install ──────────────────────────────────────────────────
    # --cluster-init starts embedded etcd. It costs nothing on a single node
    # and is the difference between a cluster that can later gain a second
    # control plane and one that must be rebuilt to get HA.
    'echo installing_k3s=yes; ',
    'INSTALL_OK=no; ',
    'for attempt in 1 2 3; do ',
    '  echo install_attempt="$attempt"; ',
    '  if $DL https://get.k3s.io | INSTALL_K3S_EXEC="server --cluster-init --secrets-encryption --write-kubeconfig-mode=644" $SUDO sh - >/dev/null 2>&1; then ',
    '    INSTALL_OK=yes; break; ',
    '  fi; ',
    # A transient network or mirror failure should not require a human to
    # press the button again.
    '  echo install_retry_after_failure=yes; sleep 5; ',
    'done; ',
    'if [ "$INSTALL_OK" != "yes" ]; then echo __STACKPILOT_K3S_INSTALL_FAILED__; exit 22; fi; ',

    # ── wait for readiness ───────────────────────────────────────
    # The old script slept four seconds and then verified once. k3s routinely
    # takes longer on a small instance, so that reported failure on a cluster
    # that was merely still starting.
    'if command -v kubectl >/dev/null 2>&1; then K="kubectl"; ',
    'elif [ "$(id -u)" -eq 0 ]; then K="k3s kubectl"; ',
    'else K="$SUDO k3s kubectl"; fi; ',
    'READY=no; ',
    'for i in $(seq 1 30); do ',
    '  if $K get nodes >/dev/null 2>&1; then READY=yes; break; fi; ',
    '  sleep 4; ',
    'done; ',
    'if [ "$READY" != "yes" ]; then ',
    # Hand back the service log: on failure this is the only thing that says
    # why, and asking the user to SSH in and find it is a poor experience.
    '  echo __STACKPILOT_K8S_VERIFY_FAILED__; ',
    '  echo "--- k3s service log ---"; ',
    '  ($SUDO journalctl -u k3s --no-pager -n 40 2>/dev/null || $SUDO tail -n 40 /var/log/k3s.log 2>/dev/null || true); ',
    '  exit 23; ',
    'fi; ',

    # Node object exists; wait for it to actually report Ready.
    'for i in $(seq 1 20); do ',
    '  if $K get nodes 2>/dev/null | grep -qw Ready; then break; fi; ',
    '  sleep 3; ',
    'done; ',

    '$K get nodes -o wide 2>/dev/null || true; ',
    'echo kubernetes_status=ready; ',
    'echo __STACKPILOT_PROVISION_K8S_DONE__',
]


def to_cpp() -> str:
    out = []
    for line in SCRIPT_LINES:
        escaped = line.replace('\\', '\\\\').replace('"', '\\"')
        out.append(f'        "{escaped}"')
    return "\n".join(out)


if __name__ == "__main__":
    print(to_cpp())
