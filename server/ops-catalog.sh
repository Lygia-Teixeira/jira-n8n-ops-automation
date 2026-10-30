#!/usr/bin/env bash
# ops-catalog: catálogo fixo de operações executadas pela automação via SSH.
#
# Instalação: /usr/local/sbin/ops-catalog (root:root, 0750). Chamado por:
#   - forced command em authorized_keys do usuário opsbot (recomendado):
#       restrict,command="sudo -n /usr/local/sbin/ops-catalog" ssh-ed25519 ...
#     a linha enviada pelo n8n chega em SSH_ORIGINAL_COMMAND;
#   - ou sudo direto com argumentos (modo sudo-wrapper).
#
# Saída: uma linha JSON no stdout, {"ok":true,...} ou {"ok":false,"error":"<código>"}.
# Tudo o que vem de fora é validado de novo aqui, independentemente do n8n.

set -euo pipefail
umask 077
export PATH=/usr/local/cpanel/bin:/usr/local/cpanel/3rdparty/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export LC_ALL=C

CONF=/etc/ops-catalog.conf
QUOTA_INCREASE_PCT=30        # aumento percentual da cota de e-mail
QUOTA_MAX_MB=10240           # teto absoluto de cota que a automação pode aplicar
CSF_TEMP_ALLOW_SECONDS=0     # >0 cria allow temporário após desbloquear (0 = não cria)
AUTOSSL_TIMEOUT=300          # segundos para o autossl_check da conta

# ---------------------------------------------------------------------------
# utilitários
# ---------------------------------------------------------------------------
log() { logger -t ops-catalog -p authpriv.info -- "$*" 2>/dev/null || true; }

emit() { # emit '<json>'
  printf '%s\n' "$1"
}

fail() { # fail <codigo>
  log "result=fail code=$1 action=${ACTION:-none}"
  emit "{\"ok\":false,\"error\":\"$1\"}"
  exit 1
}

load_conf() {
  # Lê só chaves conhecidas com valor numérico; nunca faz "source" do arquivo.
  [ -f "$CONF" ] || return 0
  [ "$(stat -c '%u' "$CONF")" = "0" ] || fail conf_not_root_owned
  case "$(stat -c '%a' "$CONF")" in 600|640|400|440) ;; *) fail conf_bad_mode ;; esac
  local key value
  while IFS='=' read -r key value; do
    case "$key" in
      QUOTA_INCREASE_PCT|QUOTA_MAX_MB|CSF_TEMP_ALLOW_SECONDS|AUTOSSL_TIMEOUT)
        [[ "$value" =~ ^[0-9]{1,6}$ ]] || fail conf_bad_value
        printf -v "$key" '%s' "$value"
        ;;
      ''|'#'*) ;;
      *) fail conf_unknown_key ;;
    esac
  done < "$CONF"
}

valid_user() {
  [[ "$1" =~ ^[a-z][a-z0-9]{0,15}$ ]] || return 1
  case "$1" in root|admin|nobody|cpanel|mail|system) return 1 ;; esac
  [ -f "/var/cpanel/users/$1" ]
}

valid_domain() {
  [ "${#1}" -le 253 ] || return 1
  [[ "$1" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]]
}

valid_mail_local() {
  [[ "$1" =~ ^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$ ]] || return 1
  [[ "$1" != *..* ]]
}

domain_owned_by() { # domain_owned_by <dominio> <usuario>  (via /etc/userdomains, comparação exata)
  awk -v d="$1:" -v u="$2" '$1 == d && $2 == u { found = 1 } END { exit found ? 0 : 1 }' /etc/userdomains
}

public_ip() { # imprime a forma canônica se for IP público (unicast global); falha caso contrário
  python3 -I -c '
import ipaddress, sys
try:
    ip = ipaddress.ip_address(sys.argv[1])
except ValueError:
    sys.exit(1)
if not ip.is_global or ip.is_multicast:
    sys.exit(1)
print(ip.compressed)
' "$1"
}

# ---------------------------------------------------------------------------
# operações
# ---------------------------------------------------------------------------
op_ip_unblock() { # ip-unblock <ip>
  local ip
  ip="$(public_ip "$1")" || fail ip_invalid
  csf -dr "$ip" >/dev/null 2>&1 || true   # remove de csf.deny (se houver)
  csf -tr "$ip" >/dev/null 2>&1 || true   # remove de bloqueios temporários (lfd)
  if [ "$CSF_TEMP_ALLOW_SECONDS" -gt 0 ]; then
    csf -ta "$ip" "$CSF_TEMP_ALLOW_SECONDS" "ops-catalog" >/dev/null 2>&1 || fail csf_temp_allow_failed
  fi
  if awk -v ip="$ip" '$1 == ip { found = 1 } END { exit found ? 0 : 1 }' /etc/csf/csf.deny; then
    fail still_denied
  fi
  log "result=ok action=ip-unblock ip=$ip"
  emit "{\"ok\":true,\"action\":\"ip-unblock\",\"ip\":\"$ip\"}"
}

op_mail_quota_increase() { # mail-quota-increase <usuario> <local> <dominio>
  local user="$1" local_part="$2" domain="$3" home current new
  valid_user "$user" || fail user_invalid
  valid_mail_local "$local_part" || fail mail_local_invalid
  valid_domain "$domain" || fail domain_invalid
  domain_owned_by "$domain" "$user" || fail domain_not_owned
  home="$(getent passwd "$user" | cut -d: -f6)"
  [ -n "$home" ] && [ -d "$home/mail/$domain/$local_part" ] || fail mailbox_not_found

  current="$(uapi --user="$user" --output=json Email get_pop_quota email="$local_part" domain="$domain" 2>/dev/null \
    | python3 -I -c '
import json, sys
d = json.load(sys.stdin).get("result", {})
v = d.get("data")
if d.get("status") != 1 or v in (None, "", "unlimited", 0, "0"):
    sys.exit(1)
print(int(float(v)))
')" || fail quota_read_failed

  new=$(( (current * (100 + QUOTA_INCREASE_PCT) + 99) / 100 ))
  [ "$new" -gt "$QUOTA_MAX_MB" ] && new="$QUOTA_MAX_MB"
  [ "$new" -gt "$current" ] || fail quota_at_limit

  uapi --user="$user" --output=json Email edit_pop_quota email="$local_part" domain="$domain" quota="$new" 2>/dev/null \
    | python3 -I -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("result",{}).get("status")==1 else 1)' \
    || fail quota_update_failed

  log "result=ok action=mail-quota-increase user=$user mailbox=$local_part domain=$domain before_mb=$current new_mb=$new"
  emit "{\"ok\":true,\"action\":\"mail-quota-increase\",\"before_mb\":$current,\"new_mb\":$new}"
}

op_ssl_autossl() { # ssl-autossl <usuario> <dominio>
  local user="$1" domain="$2"
  valid_user "$user" || fail user_invalid
  valid_domain "$domain" || fail domain_invalid
  domain_owned_by "$domain" "$user" || fail domain_not_owned
  # Confira o nome do binário/função na documentação da sua versão do cPanel/WHM.
  timeout "$AUTOSSL_TIMEOUT" /usr/local/cpanel/bin/autossl_check --user="$user" >/dev/null 2>&1 || true
  whmapi1 --output=json get_autossl_problems_for_user username="$user" 2>/dev/null \
    | python3 -I -c '
import json, sys
user, domain = sys.argv[1], sys.argv[2]
data = (json.load(sys.stdin).get("data") or {})
items = data.get("problems_by_domain") or data.get("payload") or []
out = []
for p in items[:50]:
    d = str(p.get("domain", ""))[:253]
    out.append({"domain": d, "problem": str(p.get("problem", ""))[:300]})
print(json.dumps({"ok": True, "action": "ssl-autossl", "user": user, "domain": domain, "problems": out}))
' "$user" "$domain" || fail autossl_status_failed
  log "result=ok action=ssl-autossl user=$user domain=$domain"
}

# ---------------------------------------------------------------------------
# despacho
# ---------------------------------------------------------------------------
main() {
  load_conf
  [ "$(id -u)" = "0" ] || fail must_run_as_root

  if [ "$#" -eq 0 ] && [ -n "${SSH_ORIGINAL_COMMAND:-}" ]; then
    [ "${#SSH_ORIGINAL_COMMAND}" -le 512 ] || fail command_too_long
    [[ "$SSH_ORIGINAL_COMMAND" =~ ^[A-Za-z0-9._:\ -]+$ ]] || fail unsafe_characters
    set -f
    # shellcheck disable=SC2086 # divisão por espaço é intencional; charset já validado
    set -- $SSH_ORIGINAL_COMMAND
    set +f
  fi

  ACTION="${1:-}"
  exec 9>/run/lock/ops-catalog.lock
  flock -w 60 9 || fail lock_timeout

  case "$ACTION" in
    ip-unblock)          [ "$#" -eq 2 ] || fail bad_arguments; op_ip_unblock "$2" ;;
    mail-quota-increase) [ "$#" -eq 4 ] || fail bad_arguments; op_mail_quota_increase "$2" "$3" "$4" ;;
    ssl-autossl)         [ "$#" -eq 3 ] || fail bad_arguments; op_ssl_autossl "$2" "$3" ;;
    *)                   fail unknown_action ;;
  esac
}

[ "$#" -le 4 ] || fail bad_arguments
main "${1+"$1"}" "${2+"$2"}" "${3+"$3"}" "${4+"$4"}"
