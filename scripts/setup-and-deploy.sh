#!/usr/bin/env bash
# Puts Mandala online: Vercel hosting, a Turso database, the session secret, an invite code (or
# open sign-up) and, optionally, Gemini. Safe to re-run: each step skips what already exists.
# Secrets are never printed, except a generated invite code, since you need to share it.
#
#   ./scripts/setup-and-deploy.sh
#
# Options (environment variables):
#   PROJECT_NAME     Vercel project name (default: mandala-chart)
#   VERCEL_SCOPE     Vercel team or username to deploy under (default: your current team)
#   GEMINI_API_KEY   Gemini key to use instead of asking (use a key from your own Google Cloud project)
#   GEMINI_ENV_FILE  Optional .env file to read GEMINI_API_KEY from
#   SIGNUP_CODE      Invite code new accounts must enter, instead of asking. "open" lets anyone sign
#                    up. Unset, the script offers a random code (also when it cannot ask).
set -euo pipefail
cd "$(dirname "$0")/.."

VERCEL=(npx --yes vercel@latest)
if [ -n "${VERCEL_SCOPE:-}" ]; then VERCEL+=(--scope "$VERCEL_SCOPE"); fi
PROJECT_NAME="${PROJECT_NAME:-mandala-chart}"
GEMINI_ENV_FILE="${GEMINI_ENV_FILE:-}"

step() { printf '\n== %s\n' "$1"; }
has_env() { grep -qw "$1" <<<"$envs"; }
add_secret() { printf '%s' "$2" | "${VERCEL[@]}" env add "$1" production --sensitive --force >/dev/null; }

step "Vercel login"
"${VERCEL[@]}" whoami >/dev/null 2>&1 || "${VERCEL[@]}" login

step "Vercel project ($PROJECT_NAME)"
if [ -f .vercel/project.json ]; then
  echo "Already linked."
else
  "${VERCEL[@]}" project create "$PROJECT_NAME" >/dev/null 2>&1 || true
  "${VERCEL[@]}" link --yes --project "$PROJECT_NAME"
fi

# Read once. If the list cannot be read, stop: treating every name as missing would add a
# second database and replace the session secret (signing everyone out).
envs="$("${VERCEL[@]}" env ls production)" || {
  echo "Could not read the Vercel env vars, so nothing else was changed. Run the script again."
  exit 1
}

step "Database (Turso, through the Vercel Marketplace)"
if has_env TURSO_DATABASE_URL; then
  echo "Already connected."
else
  echo "The first time, a browser tab opens to accept Turso's terms. Pick the free plan."
  # Production only: local development never touches this database.
  "${VERCEL[@]}" integration add tursocloud --name "${PROJECT_NAME}-db" --plan starter --environment production --no-env-pull
fi

step "Session secret"
if has_env SESSION_SECRET; then
  echo "Already set."
else
  add_secret SESSION_SECRET "$(openssl rand -base64 32)"
fi

step "Invite code (only people with the code can create an account)"
if has_env SIGNUP_CODE; then
  echo "Already set."
else
  code="${SIGNUP_CODE:-}"
  suggested=""
  if [ -z "$code" ]; then
    # A random code by default: a word is easy to guess, and open sign-up should be a choice.
    suggested="$(openssl rand -base64 12)"
    # "|| true": with no terminal to ask, read fails, and the random code is used.
    read -r -p "Invite code [$suggested] (Enter to use it, or type open to let anyone sign up): " code || true
    code="${code:-$suggested}"
  fi
  if [ "$code" = "open" ]; then
    echo "Open sign-up. Anyone with the link can create an account."
  else
    add_secret SIGNUP_CODE "$code"
    if [ "$code" = "$suggested" ]; then
      echo "Invite code: $code"
      echo "Share it with the people you invite. Vercel will not show it again."
    fi
  fi
fi

step "Gemini key (optional: AI help and voice reports)"
if has_env GEMINI_API_KEY; then
  echo "Already set."
else
  key="${GEMINI_API_KEY:-}"
  if [ -z "$key" ] && [ -n "$GEMINI_ENV_FILE" ] && [ -f "$GEMINI_ENV_FILE" ]; then
    # "|| true": grep fails when no line matches, and that must not stop the script.
    key="$(grep -E '^(export[[:space:]]+)?GEMINI_API_KEY=' "$GEMINI_ENV_FILE" | head -1 | cut -d= -f2- | tr -d "\"' \r" || true)"
    if [ -n "$key" ]; then echo "Using the key from $GEMINI_ENV_FILE (not printed)."; else echo "No GEMINI_API_KEY in $GEMINI_ENV_FILE."; fi
  fi
  if [ -z "$key" ]; then
    read -r -s -p "Paste a Gemini API key (Enter to skip): " key
    echo
  fi
  if [ -n "$key" ]; then add_secret GEMINI_API_KEY "$key"; else echo "Skipped. AI stays off until you add it."; fi
fi

step "Deploy"
"${VERCEL[@]}" deploy --prod
