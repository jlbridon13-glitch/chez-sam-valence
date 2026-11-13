'use strict';
const $ = (s) => document.querySelector(s);
const ALLERGEN_LABELS = {gluten:'gluten',crustaces:'crustacés',oeufs:'œufs',poisson:'poisson',arachides:'arachides',soja:'soja',lait:'lait','fruits-a-coque':'fruits à coque',celeri:'céleri',moutarde:'moutarde',sesame:'sésame',sulfites:'sulfites',lupin:'lupin',mollusques:'mollusques'};
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
  const res = await fetch(path, { ...opts, headers: { 'X-Requested-With': 'cs', ...(opts.body ? {'Content-Type':'application/json'} : {}), ...(opts.headers||{}) } });
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) { const e = new Error(data.error || 'Erreur réseau. Réessayez.'); e.status = res.status; throw e; }
  return data;
}

async function loadOffers() {
  const box = $('#cards');
  try {
    const { offers } = await api('/api/offers');
    box.replaceChildren();
    if (!offers.length) { box.append(el('div', {class:'empty'}, el('strong', {}, "Pas de panier pour l'instant"), 'Revenez un peu plus tard : Sam publie ses paniers dans la journée.')); return; }
    for (const o of offers) box.append(card(o));
  } catch (e) {
    box.replaceChildren(el('div', {class:'empty'}, el('strong', {}, 'Chargement impossible'), e.message));
  }
}

function card(o) {
  const media = el('div', {class:'media'}, o.photo_url ? null : 'Chez Sam');
  if (o.photo_url) media.style.backgroundImage = `url("${o.photo_url}")`;
  const out = o.remaining <= 0;
  const stock = el('span', {class:'stock' + (out ? ' out' : o.remaining <= 2 ? ' low' : '')}, out ? 'Épuisé' : `${o.remaining} restant${o.remaining > 1 ? 's' : ''}`);
  const all = o.allergens.length ? el('div', {class:'allergens'}, el('b', {}, 'Allergènes : '), o.allergens.map((a) => ALLERGEN_LABELS[a] || a).join(', ')) : el('div', {class:'allergens fine'}, 'Allergènes : aucun déclaré — demandez au restaurant en cas de doute.');
  return el('article', {class:'card'}, media, el('div', {class:'body'},
    el('h3', {}, o.title), o.description ? el('p', {}, o.description) : null,
    el('div', {class:'meta'}, el('span', {}, `Retrait aujourd'hui de ${hm(o.pickup_from)} à ${hm(o.pickup_to)}`), el('span', {}, 'Chez Sam, place des Clercs, Valence')),
    all,
    el('div', {class:'bottom'}, el('div', {}, el('div', {class:'price'}, euro(o.price_cents)), stock),
      el('button', {class:'btn', ...(out ? {disabled:''} : {}), onclick: () => openReserve(o)}, 'Réserver'))));
}

function openModal(...kids) { $('#m-body').replaceChildren(...kids); $('#modal').hidden = false; }
function closeModal() { $('#modal').hidden = true; }
$('#m-close').addEventListener('click', closeModal);
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

function openReserve(o) {
  const max = Math.min(o.remaining, 5);
  const err = el('div');
  const qty = el('select', {id:'f-qty'}, Array.from({length:max}, (_, i) => el('option', {value:i + 1}, i + 1)));
  const name = el('input', {id:'f-name', required:'', maxlength:'80', autocomplete:'name'});
  const phone = el('input', {id:'f-phone', required:'', type:'tel', maxlength:'20', autocomplete:'tel', placeholder:'06 12 34 56 78'});
  const consent = el('input', {type:'checkbox', id:'f-consent', required:''});
  const btn = el('button', {class:'btn full', type:'submit'}, 'Confirmer la réservation');
  const form = el('form', {}, err,
    el('div', {class:'summary'}, el('strong', {}, o.title), el('br'), `${euro(o.price_cents)} · retrait ${hm(o.pickup_from)}–${hm(o.pickup_to)}`),
    el('label', {}, 'Nombre de paniers', qty), el('label', {}, 'Votre nom', name), el('label', {}, 'Téléphone', phone),
    el('label', {class:'check'}, consent, el('span', {}, "J'accepte que mon nom et mon téléphone soient utilisés par Chez Sam pour préparer mon retrait (conservés 90 jours). Aucun paiement n'est demandé maintenant.")),
    btn);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault(); err.replaceChildren(); btn.disabled = true; btn.textContent = 'Enregistrement…';
    try {
      const r = await api('/api/reservations', {method:'POST', body: JSON.stringify({offer_id:o.id, qty:Number(qty.value), name:name.value, phone:phone.value, consent:consent.checked})});
      showConfirmation(r.reservation); loadOffers();
    } catch (e) {
      err.replaceChildren(el('div', {class:'msg err'}, e.message)); btn.disabled = false; btn.textContent = 'Confirmer la réservation';
      if (e.status === 409 || e.status === 404) loadOffers();
    }
  });
  openModal(el('h2', {id:'m-title'}, 'Réserver'), form);
}

function confirmBox(r) {
  return el('div', {class:'confirm'}, el('div', {class:'fine'}, 'Code de retrait'), el('div', {class:'code'}, r.code),
    el('p', {}, el('strong', {}, `${r.qty} × ${r.offer_title}`), el('br'), `Total à régler sur place : ${euro(r.total_cents)}`),
    el('p', {}, `Retrait aujourd'hui de ${hm(r.pickup_from)} à ${hm(r.pickup_to)}, Chez Sam, place des Clercs, Valence. Présentez ce code au comptoir.`),
    el('p', {class:'fine'}, 'Gardez ce code (capture d\'écran conseillée). Le paiement se fait au restaurant : réserver n\'est pas payer.'));
}
function showConfirmation(r) { openModal(el('h2', {id:'m-title'}, 'Réservation enregistrée ✓'), confirmBox(r), el('p', {}), el('button', {class:'btn light full', onclick: closeModal}, 'Fermer')); }

$('#lookup').addEventListener('submit', async (ev) => {
  ev.preventDefault(); const out = $('#lookup-out'); out.replaceChildren();
  try {
    const { reservation: r } = await api('/api/reservations/' + encodeURIComponent($('#lookup-code').value.trim().toUpperCase()));
    const label = {pending:'En attente de retrait', collected:'Retirée', cancelled:'Annulée'}[r.status];
    out.append(el('div', {class:'msg ok'}, `Statut : ${label}`), confirmBox(r), el('p'));
  } catch (e) { out.append(el('div', {class:'msg err'}, e.message)); }
});

loadOffers();
setInterval(() => { if ($('#modal').hidden && !document.hidden) loadOffers(); }, 30000);
