'use strict';
const $ = (s) => document.querySelector(s);
const LABELS = {gluten:'Gluten',crustaces:'Crustacés',oeufs:'Œufs',poisson:'Poisson',arachides:'Arachides',soja:'Soja',lait:'Lait','fruits-a-coque':'Fruits à coque',celeri:'Céleri',moutarde:'Moutarde',sesame:'Sésame',sulfites:'Sulfites',lupin:'Lupin',mollusques:'Mollusques'};
const euro = (c) => (c / 100).toLocaleString('fr-FR', {style:'currency', currency:'EUR'});
const hm = (t) => t.replace(':', 'h');

function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') n.className = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) n.append(c.nodeType ? c : document.createTextNode(String(c)));
  return n;
}
function toast(t) { const x = $('#toast'); x.textContent = t; x.className = 'show'; setTimeout(() => (x.className = ''), 3500); }

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, credentials: 'same-origin', headers: { 'X-Requested-With': 'cs', ...(opts.json ? {'Content-Type':'application/json'} : {}), ...(opts.headers||{}) }, body: opts.json ? JSON.stringify(opts.json) : opts.body });
  let data = {};
  try { data = await res.json(); } catch {}
  if (res.status === 401 && !path.endsWith('/login')) { showLogin('Session expirée, reconnectez-vous.'); throw new Error('401'); }
  if (!res.ok) { const e = new Error(data.error || 'Erreur réseau. Réessayez.'); e.status = res.status; throw e; }
  return data;
}

const app = $('#app');
let allergenList = [];
let tab = 'offers';

function showLogin(message) {
  $('#logout').hidden = true;
  const err = el('div');
  if (message) err.append(el('div', {class:'msg err'}, message));
  const pw = el('input', {type:'password', required:'', autocomplete:'current-password', maxlength:'200'});
  const btn = el('button', {class:'btn full', type:'submit'}, 'Se connecter');
  const form = el('form', {}, err, el('label', {}, 'Mot de passe', pw), btn);
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); err.replaceChildren(); btn.disabled = true;
    try { await api('/api/admin/login', {method:'POST', json:{password: pw.value}}); showApp(); }
    catch (x) { err.append(el('div', {class:'msg err'}, x.message)); btn.disabled = false; pw.value = ''; }
  });
  app.replaceChildren(el('div', {class:'panel', style:'max-width:440px;margin:30px auto'}, el('h2', {}, 'Espace Sam'), el('p', {class:'fine'}, 'Accès réservé au restaurant.'), form));
}

async function showApp() {
  $('#logout').hidden = false;
  const tabs = el('div', {class:'tabs', role:'tablist'},
    el('button', {class:'tab', role:'tab', 'aria-selected': String(tab === 'offers'), onclick: () => { tab = 'offers'; showApp(); }}, 'Mes offres'),
    el('button', {class:'tab', role:'tab', 'aria-selected': String(tab === 'res'), onclick: () => { tab = 'res'; showApp(); }}, 'Réservations'));
  const content = el('div', {}, 'Chargement…');
  app.replaceChildren(tabs, content);
  try { await (tab === 'offers' ? renderOffers(content) : renderReservations(content)); }
  catch (e) { if (e.message !== '401') content.replaceChildren(el('div', {class:'msg err'}, e.message)); }
}

async function renderOffers(box) {
  const { offers, allergens } = await api('/api/admin/offers');
  allergenList = allergens;
  box.replaceChildren(el('button', {class:'btn full', onclick: () => offerForm(null)}, '+ Ajouter un plat anti-gaspi'), el('p'));
  if (!offers.length) box.append(el('div', {class:'empty', style:'padding:30px'}, el('strong', {}, 'Aucune offre'), 'Ajoutez votre premier plat avec une photo.'));
  for (const o of offers) {
    const thumb = el('div', {class:'thumb'}, o.photo_url ? null : '');
    if (o.photo_url) thumb.style.backgroundImage = `url("${o.photo_url}")`;
    box.append(el('div', {class:'item'}, thumb, el('div', {class:'info'},
      el('h3', {}, o.title),
      el('p', {}, `${euro(o.price_cents)} · ${o.reserved}/${o.quantity} réservé(s) · retrait ${hm(o.pickup_from)}–${hm(o.pickup_to)}`),
      el('span', {class:'tag' + (o.active ? '' : ' pause')}, o.active ? 'En ligne' : 'En pause'),
      el('div', {class:'actions'},
        el('button', {class:'btn light small', onclick: () => offerForm(o)}, 'Modifier'),
        el('button', {class:'btn light small', onclick: () => toggle(o)}, o.active ? 'Mettre en pause' : 'Remettre en ligne'),
        el('button', {class:'btn danger small', onclick: () => remove(o)}, 'Supprimer')))));
  }
}

async function toggle(o) {
  try { await api('/api/admin/offers/' + o.id, {method:'PUT', json: payload(o, {active: !o.active})}); showApp(); }
  catch (e) { toast(e.message); }
}
async function remove(o) {
  if (!confirm(`Supprimer « ${o.title} » ?`)) return;
  try { await api('/api/admin/offers/' + o.id, {method:'DELETE'}); toast('Offre supprimée'); showApp(); }
  catch (e) { toast(e.message); }
}
const payload = (o, over = {}) => ({title:o.title, description:o.description, price_cents:o.price_cents, quantity:o.quantity, allergens:o.allergens,
  photo_id: o.photo_url ? o.photo_url.split('/').pop() : null, pickup_from:o.pickup_from, pickup_to:o.pickup_to, active:o.active, ...over});

// Réduit la photo (max 1200 px, JPEG) avant envoi : rapide sur smartphone et sous la limite du serveur.
async function shrink(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1200 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  for (const q of [0.82, 0.7, 0.55]) {
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', q));
    if (blob && blob.size <= 1_400_000) return blob;
  }
  throw new Error('Photo trop lourde, essayez-en une autre.');
}

function openModal(...k) { $('#m-body').replaceChildren(...k); $('#modal').hidden = false; }
const closeModal = () => { $('#modal').hidden = true; };
$('#m-close').addEventListener('click', closeModal);

function offerForm(o) {
  const err = el('div');
  let photoId = o && o.photo_url ? o.photo_url.split('/').pop() : null;
  const preview = el('img', {class:'preview', alt:'Aperçu de la photo'});
  preview.hidden = !(o && o.photo_url); if (o && o.photo_url) preview.src = o.photo_url;
  const file = el('input', {type:'file', accept:'image/*', class:'file'});
  file.addEventListener('change', async () => {
    if (!file.files[0]) return;
    err.replaceChildren();
    try {
      const blob = await shrink(file.files[0]);
      const r = await api('/api/admin/photos', {method:'POST', body: blob, headers:{'Content-Type':'image/jpeg'}});
      photoId = r.photo_id; preview.src = r.photo_url; preview.hidden = false; toast('Photo ajoutée');
    } catch (e) { if (e.message !== '401') err.replaceChildren(el('div', {class:'msg err'}, e.message)); }
  });
  const title = el('input', {required:'', maxlength:'80', value: o ? o.title : ''});
  const desc = el('textarea', {maxlength:'500'}); desc.value = o ? o.description : '';
  const price = el('input', {required:'', type:'number', inputmode:'decimal', min:'0', max:'1000', step:'0.01', value: o ? (o.price_cents / 100).toFixed(2) : ''});
  const qty = el('input', {required:'', type:'number', inputmode:'numeric', min: o ? String(o.reserved) : '0', max:'500', step:'1', value: o ? o.quantity : ''});
  const from = el('input', {required:'', type:'time', value: o ? o.pickup_from : ''});
  const to = el('input', {required:'', type:'time', value: o ? o.pickup_to : ''});
  const boxes = allergenList.map((a) => { const c = el('input', {type:'checkbox', value:a}); if (o && o.allergens.includes(a)) c.checked = true; return c; });
  const btn = el('button', {class:'btn full', type:'submit'}, o ? 'Enregistrer' : 'Publier le plat');
  const form = el('form', {}, err,
    el('label', {}, 'Photo du plat (prenez-la avec votre téléphone)', file), preview,
    el('label', {}, 'Nom du plat', title),
    el('label', {}, el('span', {}, 'Description ', el('span', {class:'opt'}, '(facultatif)')), desc),
    el('div', {class:'row'}, el('label', {}, 'Prix (€)', price), el('label', {}, 'Quantité de paniers', qty)),
    el('div', {class:'row'}, el('label', {}, 'Retrait à partir de', from), el('label', {}, "Jusqu'à", to)),
    el('div', {class:'fine', style:'font-weight:700;color:var(--ink)'}, 'Allergènes présents'),
    el('div', {class:'allergen-grid'}, allergenList.map((a, i) => el('label', {}, boxes[i], LABELS[a] || a))),
    btn);
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); err.replaceChildren(); btn.disabled = true;
    const body = {title:title.value, description:desc.value, price_cents: Math.round(parseFloat(price.value) * 100), quantity: parseInt(qty.value, 10),
      allergens: boxes.filter((b) => b.checked).map((b) => b.value), photo_id: photoId, pickup_from: from.value, pickup_to: to.value, active: o ? o.active : true};
    try {
      await api(o ? '/api/admin/offers/' + o.id : '/api/admin/offers', {method: o ? 'PUT' : 'POST', json: body});
      closeModal(); toast(o ? 'Offre modifiée' : 'Plat publié !'); showApp();
    } catch (x) { if (x.message !== '401') err.append(el('div', {class:'msg err'}, x.message)); btn.disabled = false; }
  });
  openModal(el('h2', {}, o ? 'Modifier le plat' : 'Nouveau plat'), form);
}

async function renderReservations(box) {
  const { reservations } = await api('/api/admin/reservations');
  box.replaceChildren(el('button', {class:'btn light small', onclick: showApp}, '↻ Actualiser'), el('p'));
  if (!reservations.length) { box.append(el('div', {class:'empty', style:'padding:30px'}, el('strong', {}, 'Aucune réservation'), 'Elles apparaîtront ici dès qu\'un client réserve.')); return; }
  const when = (t) => new Date(t).toLocaleString('fr-FR', {dateStyle:'short', timeStyle:'short'});
  for (const r of reservations) {
    const labels = {pending:'À retirer', collected:'Retirée', cancelled:'Annulée'};
    box.append(el('div', {class:'item'}, el('div', {class:'info'},
      el('h3', {}, `${r.code} — ${r.customer_name}`),
      el('p', {}, `${r.qty} × ${r.offer_title} · ${euro(r.total_cents)} à régler sur place`),
      el('p', {}, el('a', {href:'tel:' + r.customer_phone}, r.customer_phone), ` · retrait ${hm(r.pickup_from)}–${hm(r.pickup_to)} · réservé ${when(r.created_at)}`),
      el('span', {class:'tag ' + r.status}, labels[r.status]),
      r.status === 'pending' ? el('div', {class:'actions'},
        el('button', {class:'btn small', onclick: () => act(r, 'collect')}, 'Valider le retrait'),
        el('button', {class:'btn danger small', onclick: () => act(r, 'cancel')}, 'Annuler')) : null)));
  }
}
async function act(r, action) {
  if (action === 'cancel' && !confirm(`Annuler la réservation ${r.code} ? Le panier sera remis en stock.`)) return;
  try { await api(`/api/admin/reservations/${r.id}/${action}`, {method:'POST'}); toast(action === 'collect' ? 'Retrait validé' : 'Réservation annulée'); showApp(); }
  catch (e) { if (e.message !== '401') toast(e.message); }
}

$('#logout').addEventListener('click', async () => { try { await api('/api/admin/logout', {method:'POST'}); } catch {} showLogin(); });

(async () => {
  try { await api('/api/admin/me'); showApp(); } catch { showLogin(); }
})();
