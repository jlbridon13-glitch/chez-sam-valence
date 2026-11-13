#!/usr/bin/env bash
# Déploie la démo anti-gaspi Chez Sam sur Cloudflare (Workers + D1). Gratuit, aucun domaine acheté.
# Prérequis : être connecté à Cloudflare (npx wrangler login) ou avoir CLOUDFLARE_API_TOKEN défini.
# Le mot de passe de Sam est demandé ici et envoyé directement à Cloudflare : il n'est écrit nulle part dans le code.
set -euo pipefail
cd "$(dirname "$0")/.."
DB_NAME="chez-sam-anti-gaspi"

npm install --no-audit --no-fund

if ! npx wrangler d1 list --json | grep -q "\"name\": \"$DB_NAME\""; then
  npx wrangler d1 create "$DB_NAME"
fi
DB_ID=$(npx wrangler d1 list --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const l=JSON.parse(s).find(x=>x.name===process.argv[1]);console.log(l.uuid)})' "$DB_NAME")
sed -i.bak "s/\"database_id\": \"[^\"]*\"/\"database_id\": \"$DB_ID\"/" wrangler.jsonc && rm -f wrangler.jsonc.bak

npx wrangler d1 migrations apply "$DB_NAME" --remote
npx wrangler deploy

echo
echo "Choisissez le mot de passe de Sam (10 caractères minimum), puis collez-le quand Cloudflare le demande :"
npx wrangler secret put ADMIN_PASSWORD
echo
echo "Terminé. L'adresse https://chez-sam-anti-gaspi.<votre-compte>.workers.dev est affichée plus haut."
