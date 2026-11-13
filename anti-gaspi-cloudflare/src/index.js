// Chez Sam — Anti-gaspi : API Cloudflare Worker + D1.
// Aucun secret dans ce fichier : le mot de passe de Sam est un secret Cloudflare (ADMIN_PASSWORD).

const ALLERGENS = [
  'gluten', 'crustaces', 'oeufs', 'poisson', 'arachides', 'soja', 'lait',
  'fruits-a-coque', 'celeri', 'moutarde', 'sesame', 'sulfites', 'lupin', 'mollusques',
];
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const HEX32 = /^[a-f0-9]{32}$/;
const MAX_PHOTO_BYTES = 1_500_000;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });

const bytesToHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (text) => bytesToHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
const randomHex = (n = 16) => bytesToHex(crypto.getRandomValues(new Uint8Array(n)));
const clientIp = (req) => req.headers.get('cf-connecting-ip') || '0.0.0.0';

async function safeEqual(a, b) {
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}

function makeCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

function cookieValue(req, name) {
  const raw = req.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

const cookieName = (https) => (https ? '__Host-cs_session' : 'cs_session');

function sessionCookie(https, value, maxAgeSec) {
  return `${cookieName(https)}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${https ? '; Secure' : ''}`;
}

async function requireAdmin(req, env, https) {
  const token = cookieValue(req, cookieName(https));
  if (!token || !HEX32.test(token.slice(0, 32)) || token.length !== 64) throw new HttpError(401, 'Connexion requise.');
  const row = await env.DB.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?1')
    .bind(await sha256(token)).first();
  if (!row || row.expires_at < Date.now()) throw new HttpError(401, 'Session expirée. Reconnectez-vous.');
}

async function rateCount(env, bucket, ip, windowMs) {
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM rate_events WHERE bucket = ?1 AND ip = ?2 AND ts > ?3')
    .bind(bucket, ip, Date.now() - windowMs).first();
  return r ? r.n : 0;
}
const rateHit = (env, bucket, ip) =>
  env.DB.prepare('INSERT INTO rate_events (bucket, ip, ts) VALUES (?1, ?2, ?3)').bind(bucket, ip, Date.now()).run();

async function readJson(req) {
  const type = req.headers.get('content-type') || '';
  if (!type.includes('application/json')) throw new HttpError(415, 'Format de données invalide.');
  const text = await req.text();
  if (text.length > 20_000) throw new HttpError(413, 'Requête trop volumineuse.');
  try {
    const v = JSON.parse(text);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('bad');
    return v;
  } catch {
    throw new HttpError(400, 'Données illisibles.');
  }
}

const str = (v, min, max, label) => {
  if (typeof v !== 'string') throw new HttpError(400, `${label} manquant.`);
  const t = v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (t.length < min || t.length > max) throw new HttpError(400, `${label} : entre ${min} et ${max} caractères.`);
  return t;
};
const int = (v, min, max, label) => {
  if (!Number.isInteger(v) || v < min || v > max) throw new HttpError(400, `${label} invalide (entre ${min} et ${max}).`);
  return v;
};

async function validateOffer(env, b) {
  const title = str(b.title, 2, 80, 'Nom du plat');
  const description = b.description == null || b.description === '' ? '' : str(b.description, 0, 500, 'Description');
  const price_cents = int(b.price_cents, 0, 100_000, 'Prix');
  const quantity = int(b.quantity, 0, 500, 'Quantité');
  const allergens = Array.isArray(b.allergens) ? [...new Set(b.allergens)] : null;
  if (!allergens || !allergens.every((a) => ALLERGENS.includes(a))) throw new HttpError(400, 'Allergènes invalides.');
  const pickup_from = b.pickup_from, pickup_to = b.pickup_to;
  if (!HHMM.test(pickup_from || '') || !HHMM.test(pickup_to || '') || pickup_from >= pickup_to)
    throw new HttpError(400, 'Heures de retrait invalides (début avant fin).');
  let photo_id = b.photo_id ?? null;
  if (photo_id !== null) {
    if (typeof photo_id !== 'string' || !HEX32.test(photo_id)) throw new HttpError(400, 'Photo invalide.');
    const p = await env.DB.prepare('SELECT id FROM photos WHERE id = ?1').bind(photo_id).first();
    if (!p) throw new HttpError(400, 'Photo introuvable : renvoyez-la.');
  }
  const active = b.active === false ? 0 : 1;
  return { title, description, price_cents, quantity, allergens, pickup_from, pickup_to, photo_id, active };
}

const offerOut = (o) => ({
  id: o.id,
  title: o.title,
  description: o.description,
  price_cents: o.price_cents,
  quantity: o.quantity,
  reserved: o.reserved,
  remaining: o.quantity - o.reserved,
  allergens: JSON.parse(o.allergens || '[]'),
  photo_url: o.photo_id ? `/photos/${o.photo_id}` : null,
  pickup_from: o.pickup_from,
  pickup_to: o.pickup_to,
  active: !!o.active,
});

const reservationOut = (r) => ({
  id: r.id,
  code: r.code,
  offer_title: r.offer_title,
  qty: r.qty,
  total_cents: r.qty * r.unit_price_cents,
  customer_name: r.customer_name,
  customer_phone: r.customer_phone,
  pickup_from: r.pickup_from,
  pickup_to: r.pickup_to,
  status: r.status,
  created_at: r.created_at,
});

async function lazyPurge(env) {
  const now = Date.now();
  const d90 = now - 90 * 24 * 3600 * 1000;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM reservations WHERE status != 'pending' AND updated_at < ?1").bind(d90),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?1').bind(now),
    env.DB.prepare('DELETE FROM rate_events WHERE ts < ?1').bind(now - 24 * 3600 * 1000),
    env.DB.prepare('DELETE FROM photos WHERE created_at < ?1 AND id NOT IN (SELECT photo_id FROM offers WHERE photo_id IS NOT NULL)')
      .bind(now - 24 * 3600 * 1000),
  ]);
}

// ---------------------------------------------------------------- routes API

async function handleApi(req, env, url) {
  const https = url.protocol === 'https:';
  const method = req.method;
  const path = url.pathname;

  if (method !== 'GET' && method !== 'HEAD') {
    const origin = req.headers.get('origin');
    if (origin && new URL(origin).host !== url.host) throw new HttpError(403, 'Origine refusée.');
    if (req.headers.get('x-requested-with') !== 'cs') throw new HttpError(403, 'Requête refusée.');
  }

  // ---- public
  if (path === '/api/offers' && method === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM offers WHERE active = 1 ORDER BY created_at DESC').all();
    return json({ offers: results.map(offerOut).map(({ reserved, quantity, active, ...o }) => o) });
  }

  if (path === '/api/reservations' && method === 'POST') {
    const ip = clientIp(req);
    if ((await rateCount(env, 'reserve', ip, 3600_000)) >= 8) throw new HttpError(429, 'Trop de réservations depuis cet appareil. Réessayez plus tard.');
    const b = await readJson(req);
    if (b.consent !== true) throw new HttpError(400, 'Vous devez accepter le traitement de vos données pour réserver.');
    const name = str(b.name, 2, 80, 'Nom');
    const phoneRaw = str(b.phone, 8, 20, 'Téléphone').replace(/[\s.\-()]/g, '');
    if (!/^\+?\d{8,15}$/.test(phoneRaw)) throw new HttpError(400, 'Numéro de téléphone invalide.');
    const qty = int(b.qty, 1, 10, 'Quantité');
    if (typeof b.offer_id !== 'string' || !HEX32.test(b.offer_id)) throw new HttpError(400, 'Offre invalide.');

    await rateHit(env, 'reserve', ip);
    const offer = await env.DB.prepare('SELECT * FROM offers WHERE id = ?1').bind(b.offer_id).first();
    if (!offer || !offer.active) throw new HttpError(404, "Cette offre n'est plus disponible.");

    // Réservation atomique : la ligne n'est modifiée que s'il reste assez de stock.
    const upd = await env.DB.prepare(
      'UPDATE offers SET reserved = reserved + ?1, updated_at = ?3 WHERE id = ?2 AND active = 1 AND quantity - reserved >= ?1',
    ).bind(qty, offer.id, Date.now()).run();
    if (upd.meta.changes !== 1) {
      const cur = await env.DB.prepare('SELECT quantity - reserved AS left, active FROM offers WHERE id = ?1').bind(offer.id).first();
      if (!cur || !cur.active) throw new HttpError(404, "Cette offre n'est plus disponible.");
      throw new HttpError(409, cur.left > 0 ? `Il ne reste que ${cur.left} panier(s).` : 'Désolé, cette offre est épuisée.');
    }

    const id = randomHex(16);
    const now = Date.now();
    let code = null;
    try {
      for (let i = 0; i < 6 && !code; i++) {
        const c = makeCode();
        try {
          await env.DB.prepare(
            `INSERT INTO reservations (id, code, offer_id, offer_title, unit_price_cents, qty, customer_name, customer_phone,
               pickup_from, pickup_to, status, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'pending',?11,?11)`,
          ).bind(id, c, offer.id, offer.title, offer.price_cents, qty, name, phoneRaw, offer.pickup_from, offer.pickup_to, now).run();
          code = c;
        } catch (e) {
          if (!String(e.message).includes('UNIQUE')) throw e;
        }
      }
      if (!code) throw new Error('code');
    } catch (e) {
      // L'enregistrement a échoué : on rend le stock et on ne confirme rien.
      await env.DB.prepare('UPDATE offers SET reserved = MAX(reserved - ?1, 0) WHERE id = ?2').bind(qty, offer.id).run();
      console.error('reservation insert failed', e && e.message);
      throw new HttpError(500, "La réservation n'a pas pu être enregistrée. Aucun panier n'est bloqué, réessayez.");
    }
    return json({
      ok: true,
      reservation: {
        code, offer_title: offer.title, qty, total_cents: qty * offer.price_cents,
        pickup_from: offer.pickup_from, pickup_to: offer.pickup_to, status: 'pending',
      },
    }, 201);
  }

  let m = path.match(/^\/api\/reservations\/([A-Z0-9]{6})$/);
  if (m && method === 'GET') {
    const ip = clientIp(req);
    if ((await rateCount(env, 'lookup', ip, 3600_000)) >= 60) throw new HttpError(429, 'Trop de requêtes.');
    await rateHit(env, 'lookup', ip);
    const r = await env.DB.prepare('SELECT * FROM reservations WHERE code = ?1').bind(m[1]).first();
    if (!r) throw new HttpError(404, 'Réservation introuvable.');
    const { customer_name, customer_phone, id, ...pub } = reservationOut(r);
    return json({ reservation: pub });
  }

  if (path === '/api/photos-info' && method === 'GET') return json({ max_bytes: MAX_PHOTO_BYTES });

  // ---- admin : connexion
  if (path === '/api/admin/login' && method === 'POST') {
    const ip = clientIp(req);
    if ((await rateCount(env, 'login_fail', ip, 15 * 60_000)) >= 5)
      throw new HttpError(429, 'Trop de tentatives. Patientez 15 minutes.');
    if (!env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 10) throw new HttpError(503, 'Administration non configurée.');
    const b = await readJson(req);
    const ok = typeof b.password === 'string' && b.password.length <= 200 && (await safeEqual(b.password, env.ADMIN_PASSWORD));
    if (!ok) {
      await rateHit(env, 'login_fail', ip);
      throw new HttpError(401, 'Mot de passe incorrect.');
    }
    const token = randomHex(32);
    await env.DB.prepare('INSERT INTO sessions (token_hash, expires_at) VALUES (?1, ?2)')
      .bind(await sha256(token), Date.now() + SESSION_TTL_MS).run();
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie(https, token, SESSION_TTL_MS / 1000) });
  }

  if (path === '/api/admin/logout' && method === 'POST') {
    const token = cookieValue(req, cookieName(https));
    if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(await sha256(token)).run();
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie(https, '', 0) });
  }

  // ---- admin : tout le reste exige une session valide
  if (path.startsWith('/api/admin/')) {
    await requireAdmin(req, env, https);

    if (path === '/api/admin/me' && method === 'GET') return json({ ok: true });

    if (path === '/api/admin/offers' && method === 'GET') {
      const { results } = await env.DB.prepare('SELECT * FROM offers ORDER BY created_at DESC').all();
      return json({ offers: results.map(offerOut), allergens: ALLERGENS });
    }

    if (path === '/api/admin/offers' && method === 'POST') {
      const v = await validateOffer(env, await readJson(req));
      const id = randomHex(16);
      const now = Date.now();
      await env.DB.prepare(
        `INSERT INTO offers (id, title, description, price_cents, quantity, reserved, allergens, photo_id, pickup_from, pickup_to, active, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,0,?6,?7,?8,?9,?10,?11,?11)`,
      ).bind(id, v.title, v.description, v.price_cents, v.quantity, JSON.stringify(v.allergens), v.photo_id, v.pickup_from, v.pickup_to, v.active, now).run();
      return json({ ok: true, id }, 201);
    }

    m = path.match(/^\/api\/admin\/offers\/([a-f0-9]{32})$/);
    if (m && method === 'PUT') {
      const v = await validateOffer(env, await readJson(req));
      const old = await env.DB.prepare('SELECT photo_id FROM offers WHERE id = ?1').bind(m[1]).first();
      if (!old) throw new HttpError(404, 'Offre introuvable.');
      const r = await env.DB.prepare(
        `UPDATE offers SET title=?2, description=?3, price_cents=?4, quantity=?5, allergens=?6, photo_id=?7,
           pickup_from=?8, pickup_to=?9, active=?10, updated_at=?11 WHERE id=?1 AND ?5 >= reserved`,
      ).bind(m[1], v.title, v.description, v.price_cents, v.quantity, JSON.stringify(v.allergens), v.photo_id, v.pickup_from, v.pickup_to, v.active, Date.now()).run();
      if (r.meta.changes !== 1) throw new HttpError(409, 'La quantité ne peut pas être inférieure aux paniers déjà réservés.');
      if (old.photo_id && old.photo_id !== v.photo_id) await env.DB.prepare('DELETE FROM photos WHERE id = ?1').bind(old.photo_id).run();
      return json({ ok: true });
    }

    if (m && method === 'DELETE') {
      const o = await env.DB.prepare('SELECT photo_id FROM offers WHERE id = ?1').bind(m[1]).first();
      if (!o) throw new HttpError(404, 'Offre introuvable.');
      const p = await env.DB.prepare("SELECT COUNT(*) AS n FROM reservations WHERE offer_id = ?1 AND status = 'pending'").bind(m[1]).first();
      if (p.n > 0) throw new HttpError(409, `Impossible : ${p.n} réservation(s) en attente. Validez ou annulez-les d'abord (ou mettez l'offre en pause).`);
      await env.DB.batch([
        env.DB.prepare('UPDATE reservations SET offer_id = NULL WHERE offer_id = ?1').bind(m[1]),
        env.DB.prepare('DELETE FROM offers WHERE id = ?1').bind(m[1]),
        ...(o.photo_id ? [env.DB.prepare('DELETE FROM photos WHERE id = ?1').bind(o.photo_id)] : []),
      ]);
      return json({ ok: true });
    }

    if (path === '/api/admin/photos' && method === 'POST') {
      const type = (req.headers.get('content-type') || '').split(';')[0].trim();
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(type)) throw new HttpError(415, 'Photo JPEG, PNG ou WebP uniquement.');
      const buf = await req.arrayBuffer();
      if (buf.byteLength < 100) throw new HttpError(400, 'Photo vide.');
      if (buf.byteLength > MAX_PHOTO_BYTES) throw new HttpError(413, 'Photo trop lourde (max 1,5 Mo).');
      const b = new Uint8Array(buf);
      const isJpeg = b[0] === 0xff && b[1] === 0xd8;
      const isPng = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
      const isWebp = b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45;
      if (!((type === 'image/jpeg' && isJpeg) || (type === 'image/png' && isPng) || (type === 'image/webp' && isWebp)))
        throw new HttpError(400, "Le fichier n'est pas une vraie photo.");
      const id = randomHex(16);
      await env.DB.prepare('INSERT INTO photos (id, content_type, data, created_at) VALUES (?1, ?2, ?3, ?4)')
        .bind(id, type, buf, Date.now()).run();
      return json({ ok: true, photo_id: id, photo_url: `/photos/${id}` }, 201);
    }

    if (path === '/api/admin/reservations' && method === 'GET') {
      await lazyPurge(env);
      const { results } = await env.DB.prepare(
        "SELECT * FROM reservations ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC LIMIT 300",
      ).all();
      return json({ reservations: results.map(reservationOut) });
    }

    m = path.match(/^\/api\/admin\/reservations\/([a-f0-9]{32})\/(collect|cancel)$/);
    if (m && method === 'POST') {
      const [, id, action] = m;
      const r = await env.DB.prepare('SELECT * FROM reservations WHERE id = ?1').bind(id).first();
      if (!r) throw new HttpError(404, 'Réservation introuvable.');
      const next = action === 'collect' ? 'collected' : 'cancelled';
      const upd = await env.DB.prepare("UPDATE reservations SET status = ?2, updated_at = ?3 WHERE id = ?1 AND status = 'pending'")
        .bind(id, next, Date.now()).run();
      if (upd.meta.changes !== 1) throw new HttpError(409, 'Cette réservation est déjà clôturée.');
      if (action === 'cancel' && r.offer_id)
        await env.DB.prepare('UPDATE offers SET reserved = MAX(reserved - ?1, 0), updated_at = ?3 WHERE id = ?2').bind(r.qty, r.offer_id, Date.now()).run();
      return json({ ok: true, status: next });
    }

    throw new HttpError(404, 'Introuvable.');
  }

  throw new HttpError(404, 'Introuvable.');
}

// ---------------------------------------------------------------- entrée

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

function secure(resp) {
  const r = new Response(resp.body, resp);
  r.headers.set('Content-Security-Policy', CSP);
  r.headers.set('X-Content-Type-Options', 'nosniff');
  r.headers.set('X-Frame-Options', 'DENY');
  r.headers.set('Referrer-Policy', 'same-origin');
  r.headers.set('Strict-Transport-Security', 'max-age=31536000');
  r.headers.set('Permissions-Policy', 'camera=(self), geolocation=(), microphone=()');
  r.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  return r;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (url.pathname.startsWith('/api/')) return secure(await handleApi(req, env, url));

      const ph = url.pathname.match(/^\/photos\/([a-f0-9]{32})$/);
      if (ph && (req.method === 'GET' || req.method === 'HEAD')) {
        const p = await env.DB.prepare('SELECT content_type, data FROM photos WHERE id = ?1').bind(ph[1]).first();
        if (!p) return secure(new Response('Introuvable', { status: 404 }));
        const data = p.data instanceof ArrayBuffer ? p.data : new Uint8Array(p.data).buffer;
        return secure(new Response(data, {
          headers: { 'content-type': p.content_type, 'cache-control': 'public, max-age=31536000, immutable' },
        }));
      }

      return secure(await env.ASSETS.fetch(req));
    } catch (e) {
      if (e instanceof HttpError) return secure(json({ error: e.message }, e.status));
      console.error('unhandled', e && e.stack);
      return secure(json({ error: 'Erreur du serveur. Réessayez dans un instant.' }, 500));
    }
  },
};
