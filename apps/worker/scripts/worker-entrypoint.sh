#!/usr/bin/env bash

set -euo pipefail

ssh_public_key="${SSH_PUBLIC_KEY:-}"
unset SSH_PUBLIC_KEY

if [[ $ssh_public_key == REPLACE_ME ]]; then
	ssh_public_key=""
fi

if [[ -n $ssh_public_key ]]; then
	if [[ $ssh_public_key == *$'\n'* || $ssh_public_key == *$'\r'* ]]; then
		printf 'SSH_PUBLIC_KEY must contain exactly one public key.\n' >&2
		exit 1
	fi

	key_type="${ssh_public_key%%[[:space:]]*}"
	case "$key_type" in
		ssh-ed25519 | ssh-rsa | ecdsa-sha2-nistp256 | ecdsa-sha2-nistp384 | ecdsa-sha2-nistp521 | sk-ssh-ed25519@openssh.com | sk-ecdsa-sha2-nistp256@openssh.com) ;;
		*)
			printf 'SSH_PUBLIC_KEY is not a valid public key.\n' >&2
			exit 1
			;;
	esac

	install -d -m 0700 -o root -g root /root/.ssh
	printf '%s\n' "$ssh_public_key" > /root/.ssh/authorized_keys
	chmod 0600 /root/.ssh/authorized_keys
	chown root:root /root/.ssh/authorized_keys

	if ! ssh-keygen -l -f /root/.ssh/authorized_keys >/dev/null 2>&1; then
		printf 'SSH_PUBLIC_KEY is not a valid public key.\n' >&2
		exit 1
	fi

	install -d -m 0755 /run/sshd
	ssh-keygen -A
	sshd_options=(
		-o Port=2222
		-o AuthenticationMethods=publickey
		-o KbdInteractiveAuthentication=no
		-o PasswordAuthentication=no
		-o PermitEmptyPasswords=no
		-o PermitRootLogin=prohibit-password
	)
	/usr/sbin/sshd -t "${sshd_options[@]}"
	/usr/sbin/sshd "${sshd_options[@]}"
fi

exec "$@"
