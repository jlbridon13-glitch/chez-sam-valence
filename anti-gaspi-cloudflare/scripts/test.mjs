// Tests de bout en bout. Usage : node scripts/test.mjs <URL> <MOT_DE_PASSE_ADMIN> [phase]
// phase "seed" crée les données, "check" vérifie qu'elles ont survécu à un redémarrage.
const [base, PASSWORD, phase = 'all'] = process.argv.slice(2);
let ok = 0, ko = 0, ipn = 10;
const t = (name, cond, extra = '') => { if (cond) { ok++; console.log('  ✔', name); } else { ko++; console.log('  ✘', name, extra); } };
const H = { 'X-Requested-With': 'cs' };
let cookie = '';
async function call(method, path, { json, raw, type, auth = true, headers = {}, ip } = {}) {
  const h = { ...H, 'cf-connecting-ip': ip || `10.0.0.${ipn++ % 250}`, ...headers };
  if (json) h['Content-Type'] = 'application/json';
  if (raw) h['Content-Type'] = type;
  if (auth && cookie) h.cookie = cookie;
  const r = await fetch(base + path, { method, headers: h, body: json ? JSON.stringify(json) : raw });
  let data = null; const ct = r.headers.get('content-type') || '';
  if (ct.includes('json')) data = await r.json();
  return { status: r.status, data, headers: r.headers, res: r };
}
const login = async (pw, ip) => {
  const r = await call('POST', '/api/admin/login', { json: { password: pw }, auth: false, ip });
  const sc = r.headers.get('set-cookie'); if (r.status === 200 && sc) cookie = sc.split(';')[0];
  return r;
};
const jpeg = () => { const b = new Uint8Array(400); b.set([0xff, 0xd8, 0xff, 0xe0]); b.fill(7, 4); return b; };
const offerBody = (o = {}) => ({ title: 'Plat test NOESIS', description: 'Test technique', price_cents: 450, quantity: 3, allergens: ['gluten', 'lait'], photo_id: null, pickup_from: '21:30', pickup_to: '22:15', active: true, ...o });

console.log('# ' + base);
if (phase === 'all' || phase === 'seed') {
  console.log('\n[Sécurité / accès non autorisés]');
  let r = await call('GET', '/api/admin/offers', { auth: false }); t('admin sans connexion → 401', r.status === 401);
  r = await call('POST', '/api/admin/offers', { auth: false, json: offerBody() }); t('création sans connexion → 401', r.status === 401);
  r = await call('POST', '/api/admin/login', { headers: { 'X-Requested-With': '' }, json: { password: PASSWORD }, auth: false }); t('requête sans en-tête anti-CSRF → 403', r.status === 403);
  r = await call('POST', '/api/admin/login', { json: { password: PASSWORD }, auth: false, headers: { Origin: 'https://evil.example' } }); t('origine étrangère → 403', r.status === 403);
  r = await call('GET', '/api/admin/reservations', { auth: false, headers: { cookie: 'cs_session=' + 'a'.repeat(64) } }); t('faux cookie de session → 401', r.status === 401);
  r = await login('mauvais-mot-de-passe', '172.16.0.1'); t('mauvais mot de passe → 401', r.status === 401);
  for (let i = 0; i < 5; i++) r = await login('encore-faux', '172.16.0.2');
  r = await login(PASSWORD, '172.16.0.2'); t('blocage après 5 échecs (même bon mot de passe) → 429', r.status === 429);
  const h = (await call('GET', '/', { auth: false })).headers;
  t('en-têtes de sécurité (CSP, nosniff, noindex)', !!h.get('content-security-policy') && h.get('x-content-type-options') === 'nosniff' && /noindex/.test(h.get('x-robots-tag') || ''));

  console.log('\n[Connexion administrateur]');
  r = await login(PASSWORD, '172.16.0.3'); t('connexion Sam → 200 + cookie HttpOnly', r.status === 200 && /HttpOnly/i.test(r.headers.get('set-cookie')) && /SameSite=Strict/i.test(r.headers.get('set-cookie')));
  r = await call('GET', '/api/admin/me'); t('session valide → /me 200', r.status === 200);

  console.log('\n[Publication d\'un plat avec photo]');
  r = await call('POST', '/api/admin/photos', { raw: new Uint8Array([1, 2, 3].concat(Array(200).fill(9))), type: 'image/jpeg' }); t('faux fichier « jpeg » refusé → 400', r.status === 400);
  r = await call('POST', '/api/admin/photos', { raw: jpeg(), type: 'image/jpeg' }); t('photo valide acceptée → 201', r.status === 201 && /^[a-f0-9]{32}$/.test(r.data.photo_id));
  const photoId = r.data.photo_id;
  const pr = await fetch(base + r.data.photo_url); const pb = new Uint8Array(await pr.arrayBuffer());
  t('photo servie publiquement, mêmes octets', pr.status === 200 && pr.headers.get('content-type') === 'image/jpeg' && pb.length === 400 && pb[0] === 0xff);
  r = await call('POST', '/api/admin/offers', { json: offerBody({ title: 'x' }) }); t('validation serveur : nom trop court → 400', r.status === 400);
  r = await call('POST', '/api/admin/offers', { json: offerBody({ price_cents: -5 }) }); t('validation serveur : prix négatif → 400', r.status === 400);
  r = await call('POST', '/api/admin/offers', { json: offerBody({ allergens: ['inconnu'] }) }); t('validation serveur : allergène inconnu → 400', r.status === 400);
  r = await call('POST', '/api/admin/offers', { json: offerBody({ pickup_from: '23:00', pickup_to: '21:00' }) }); t('validation serveur : horaires inversés → 400', r.status === 400);
  r = await call('POST', '/api/admin/offers', { json: offerBody({ photo_id: photoId }) }); t('plat publié → 201', r.status === 201);
  const offerId = r.data.id;

  console.log('\n[Vue client]');
  r = await call('GET', '/api/offers', { auth: false }); const o = (r.data.offers || []).find((x) => x.id === offerId);
  t('plat visible côté client, sans cookie', !!o && o.remaining === 3 && o.price_cents === 450 && o.photo_url === '/photos/' + photoId);
  t('l\'API publique n\'expose pas le stock interne', o && !('reserved' in o) && !('quantity' in o));

  console.log('\n[Réservation]');
  const res = (qty = 1, extra = {}) => call('POST', '/api/reservations', { auth: false, json: { offer_id: offerId, qty, name: 'Client Test', phone: '06 12 34 56 78', consent: true, ...extra } });
  r = await res(1, { consent: false }); t('sans consentement RGPD → 400', r.status === 400);
  r = await res(1, { phone: 'abc' }); t('téléphone invalide → 400', r.status === 400);
  r = await res(1, { name: '' }); t('nom vide → 400', r.status === 400);
  r = await res(0); t('quantité 0 → 400', r.status === 400);
  r = await call('POST', '/api/reservations', { auth: false, json: { offer_id: 'f'.repeat(32), qty: 1, name: 'Zoé Test', phone: '0612345678', consent: true } }); t('offre inexistante → 404', r.status === 404);
  r = await res(1); t('réservation OK → 201 + code', r.status === 201 && /^[A-Z0-9]{6}$/.test(r.data.reservation.code) && r.data.reservation.total_cents === 450);
  const code1 = r.data.reservation.code;
  r = await call('GET', '/api/offers', { auth: false }); t('stock mis à jour 3 → 2', r.data.offers.find((x) => x.id === offerId).remaining === 2);
  r = await res(3); t('quantité > stock → 409, rien enregistré', r.status === 409);
  r = await call('GET', '/api/offers', { auth: false }); t('stock inchangé après refus (2)', r.data.offers.find((x) => x.id === offerId).remaining === 2);
  r = await call('GET', '/api/reservations/' + code1, { auth: false }); t('retrouver sa réservation par code', r.status === 200 && r.data.reservation.status === 'pending' && !('customer_phone' in r.data.reservation));

  console.log('\n[Doubles réservations : 10 clients en même temps pour 2 paniers restants]');
  const burst = await Promise.all(Array.from({ length: 10 }, () => res(1)));
  const wins = burst.filter((x) => x.status === 201).length, losses = burst.filter((x) => x.status === 409).length;
  t(`exactement 2 réussies (obtenu ${wins}), 8 refusées (obtenu ${losses})`, wins === 2 && losses === 8);
  r = await call('GET', '/api/offers', { auth: false }); t('stock final = 0, jamais négatif', r.data.offers.find((x) => x.id === offerId).remaining === 0);
  const adminOffer = async () => (await call('GET', '/api/admin/offers')).data.offers.find((x) => x.id === offerId);
  t('admin : 3 réservés sur 3', (await adminOffer()).reserved === 3);

  console.log('\n[Gestion Sam : réservations]');
  r = await call('GET', '/api/admin/reservations'); const list = r.data.reservations;
  t('Sam voit les 3 réservations avec téléphone', list.length === 3 && list.every((x) => x.customer_phone && x.status === 'pending'));
  const mine = list.find((x) => x.code === code1);
  r = await call('POST', `/api/admin/reservations/${mine.id}/cancel`); t('annulation → 200', r.status === 200);
  t('annulation remet 1 panier en stock', (await adminOffer()).reserved === 2);
  r = await call('POST', `/api/admin/reservations/${mine.id}/cancel`); t('double annulation → 409 (stock non recrédité deux fois)', r.status === 409 && (await adminOffer()).reserved === 2);
  r = await call('GET', '/api/offers', { auth: false }); t('le client revoit 1 panier disponible', r.data.offers.find((x) => x.id === offerId).remaining === 1);
  const other = list.find((x) => x.code !== code1);
  r = await call('POST', `/api/admin/reservations/${other.id}/collect`); t('validation du retrait → 200', r.status === 200 && r.data.status === 'collected');
  r = await call('POST', `/api/admin/reservations/${other.id}/collect`); t('retrait déjà validé → 409', r.status === 409);
  r = await call('POST', `/api/admin/reservations/${other.id}/cancel`); t('annuler un retrait déjà fait → 409', r.status === 409);
  r = await call('GET', '/api/reservations/' + other.code, { auth: false }); t('le client voit « retirée »', r.data.reservation.status === 'collected');

  console.log('\n[Gestion Sam : offres]');
  r = await call('PUT', '/api/admin/offers/' + offerId, { json: offerBody({ quantity: 1, photo_id: photoId }) }); t('quantité < réservé refusée → 409', r.status === 409);
  r = await call('PUT', '/api/admin/offers/' + offerId, { json: offerBody({ quantity: 6, title: 'Plat modifié', photo_id: photoId }) }); t('modification (qté 6, nouveau nom) → 200', r.status === 200);
  r = await call('GET', '/api/offers', { auth: false }); t('client voit la modification', r.data.offers.find((x) => x.id === offerId).title === 'Plat modifié' && r.data.offers.find((x) => x.id === offerId).remaining === 4);
  r = await call('PUT', '/api/admin/offers/' + offerId, { json: offerBody({ quantity: 6, photo_id: photoId, active: false }) }); t('pause de l\'offre → 200', r.status === 200);
  r = await call('GET', '/api/offers', { auth: false }); t('offre en pause invisible côté client', !r.data.offers.some((x) => x.id === offerId));
  r = await call('POST', '/api/reservations', { auth: false, json: { offer_id: offerId, qty: 1, name: 'Client Test', phone: '0612345678', consent: true } }); t('réserver une offre en pause → 404', r.status === 404);
  r = await call('DELETE', '/api/admin/offers/' + offerId); t('suppression refusée tant qu\'une réservation est en attente → 409', r.status === 409);
  for (const x of (await call('GET', '/api/admin/reservations')).data.reservations.filter((y) => y.status === 'pending')) await call('POST', `/api/admin/reservations/${x.id}/cancel`);
  t('toutes annulées → stock rendu (reste 1 retiré)', (await adminOffer()).reserved === 1);
  r = await call('PUT', '/api/admin/offers/' + offerId, { json: offerBody({ quantity: 6, photo_id: photoId, active: true, title: 'Plat persistant' }) }); t('remise en ligne', r.status === 200);
  // 2e offre supprimable
  r = await call('POST', '/api/admin/offers', { json: offerBody({ title: 'Plat à supprimer' }) }); const delId = r.data.id;
  r = await call('DELETE', '/api/admin/offers/' + delId); t('suppression d\'une offre sans réservation → 200', r.status === 200);
  r = await call('GET', '/api/offers', { auth: false }); t('offre supprimée disparue', !r.data.offers.some((x) => x.id === delId));

  console.log('\n[Déconnexion]');
  const old = cookie; r = await call('POST', '/api/admin/logout'); t('déconnexion → 200', r.status === 200);
  r = await call('GET', '/api/admin/offers', { headers: { cookie: old }, auth: false }); t('ancien cookie inutilisable après déconnexion → 401', r.status === 401);
  cookie = '';
  console.log('\n[Pages]');
  for (const p of ['/', '/admin/', '/app.js', '/admin/admin.js', '/style.css', '/images/logo-chez-sam-rond.png']) { const x = await call('GET', p, { auth: false }); t(`GET ${p} → 200`, x.status === 200); }
}
if (phase === 'check') {
  console.log('\n[Persistance après redémarrage du serveur]');
  const r = await call('GET', '/api/offers', { auth: false }); const o = r.data.offers.find((x) => x.title === 'Plat persistant');
  t('le plat publié est toujours là', !!o); t('stock conservé (5 restants sur 6, 1 retiré)', o && o.remaining === 5);
  t('la photo est toujours servie', o && (await fetch(base + o.photo_url)).status === 200);
  await login(PASSWORD, '172.16.9.9'); const rr = await call('GET', '/api/admin/reservations');
  t('historique des réservations conservé', rr.status === 200 && rr.data.reservations.some((x) => x.status === 'collected') && rr.data.reservations.some((x) => x.status === 'cancelled'));
}
console.log(`\nRésultat : ${ok} réussis, ${ko} échoués`);
process.exit(ko ? 1 : 0);
