# Chez Sam — Anti-gaspi (démo Cloudflare)

Application séparée du site officiel. Cloudflare Worker + base D1 (SQLite). Photos stockées dans D1.

- `src/index.js` : API (auth par session, offres, photos, réservations atomiques, retrait).
- `public/` : page client (`/`) et espace Sam (`/admin/`), sans étape de build.
- `migrations/` : schéma de la base.
- `scripts/test.mjs` : tests de bout en bout (`node scripts/test.mjs <URL> <mot de passe>`).
- `scripts/deploy.sh` : déploiement complet.

Le mot de passe de Sam n'est jamais dans le dépôt : c'est le secret Cloudflare `ADMIN_PASSWORD`.
En local, copier `.dev.vars.example` vers `.dev.vars` (ignoré par git).
