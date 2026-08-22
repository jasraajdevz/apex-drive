'use strict';
/* ============================================================
   Apex Drive — garage & tuning shop
   ============================================================ */

const Shop = {
  cat: 'cars', el: {}, hover: null, lastPh: null,

  init() {
    this.el = {
      root: $('shop'), rail: $('shoprail'), list: $('shoplist'),
      cash: $('cash'), name: $('sc-name'), cls: $('sc-class'),
      stats: $('sc-stats'), delta: $('sc-delta'), dyno: $('dyno'),
    };
    this.dctx = this.el.dyno.getContext('2d');
    $('shopclose').onclick = () => Game.closeShop();
    $('shopdrive').onclick = () => Game.closeShop(true);
    this.buildRail();
  },

  buildRail() {
    const groups = [
      ['Showroom', [['cars', '🚗', 'Cars'], ['visual', '🎨', 'Appearance'], ['stats', '📊', 'Stats']]],
      ['Powertrain', [['engine', '🔧', 'Engine'], ['forced', PARTS.forced.icon, PARTS.forced.n],
      ['intake', PARTS.intake.icon, PARTS.intake.n], ['exhaust', PARTS.exhaust.icon, PARTS.exhaust.n],
      ['ecu', PARTS.ecu.icon, PARTS.ecu.n], ['cooling', PARTS.cooling.icon, PARTS.cooling.n],
      ['nitrous', PARTS.nitrous.icon, PARTS.nitrous.n]]],
      ['Transmission', [['gearbox', PARTS.gearbox.icon, PARTS.gearbox.n], ['clutch', PARTS.clutch.icon, PARTS.clutch.n],
      ['diff', PARTS.diff.icon, PARTS.diff.n], ['drivetrain', PARTS.drivetrain.icon, PARTS.drivetrain.n]]],
      ['Chassis', [['tyres', PARTS.tyres.icon, PARTS.tyres.n], ['susp', PARTS.susp.icon, PARTS.susp.n],
      ['brakes', PARTS.brakes.icon, PARTS.brakes.n], ['weight', PARTS.weight.icon, PARTS.weight.n],
      ['aero', PARTS.aero.icon, PARTS.aero.n]]],
    ];
    let h = '';
    for (const [title, items] of groups) {
      h += `<div class="railsep">${title}</div>`;
      for (const [id, icon, label] of items)
        h += `<button data-c="${id}"><i>${icon}</i>${label}<s data-tier="${id}"></s></button>`;
    }
    this.el.rail.innerHTML = h;
    this.el.rail.querySelectorAll('button').forEach(b => {
      b.onclick = () => { this.cat = b.dataset.c; this.render(); Audio2.ui('tick'); };
      b.onmouseenter = () => Audio2.ui('hover');
    });
  },

  open() {
    this.el.root.classList.remove('hidden');
    this.cat = this.cat || 'cars';
    this.render();
  },
  // startMode closes the shop unconditionally, which throws if anything
  // reaches a mode before init has wired the elements up
  close() { if (!this.el) return; this.el.root.classList.add('hidden'); this.preview(null); },

  /* hovering an item previews its effect on the stat panel */
  preview(ph) { this.previewPh = ph; this.drawStats(); },

  render() {
    const g = Garage.car(), spec = specById(Garage.current);
    this.el.cash.textContent = money(Garage.cash);
    this.el.name.textContent = spec.name;
    this.el.cls.textContent = spec.cls + ' · ' + (buildPhys(Garage.current).drive || '').toUpperCase();
    this.el.rail.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.c === this.cat));
    this.el.rail.querySelectorAll('s[data-tier]').forEach(s => {
      const c = s.dataset.tier;
      if (PARTS[c]) { const t = g.parts[c] | 0; s.textContent = t > 0 ? 'L' + t : ''; }
      else if (c === 'engine') s.textContent = g.engine !== 'stock' ? 'SWAP' : '';
      else s.textContent = '';
    });
    if (this.cat === 'stats') this.renderStats();
    else if (this.cat === 'cars') this.renderCars();
    else if (this.cat === 'engine') this.renderEngines();
    else if (this.cat === 'visual') this.renderVisual();
    else this.renderParts(this.cat);
    this.drawStats();
  },

  card(opts) {
    const { tier, name, sub, price, state, effects } = opts;
    const cls = 'item' + (state === 'on' ? ' on' : '') + (state === 'locked' ? ' locked' : '');
    let px;
    if (state === 'on') px = '<div class="px owned">INSTALLED</div>';
    else if (price === 0) px = '<div class="px owned">FREE</div>';
    else px = `<div class="px${Garage.canAfford(price) ? '' : ' cant'}">${money(price)}</div>`;
    return `<div class="${cls}" data-i="${opts.idx}">
      <div class="tier">${tier}</div>
      <div class="nm"><b>${name}</b><u>${sub || ''}</u>${effects || ''}</div>
      ${px}</div>`;
  },

  renderCars() {
    let h = '<h3>Showroom</h3>';
    CAR_SPECS.forEach((s, i) => {
      const owned = !!Garage.owned[s.id];
      const cur = Garage.current === s.id;
      const st = buildPhys(owned ? s.id : s.id);
      const stats = statsFor(s.phys.baseTorque ? s.phys : Object.assign({}, s.phys, {
        baseTorque: s.phys.power * 0.92, forced: 'none', maxBoostPsi: 0, boostVE: 0.062,
        cylinders: s.phys.cylinders, soundType: s.phys.sound
      }));
      h += this.card({
        idx: i, tier: cur ? '✓' : (owned ? '•' : '$'),
        name: s.name, sub: s.cls + ' · ' + s.phys.drive.toUpperCase(),
        price: owned ? 0 : s.price, state: cur ? 'on' : (owned ? '' : 'locked'),
        effects: `<div class="effect"><span>${stats.hp} hp</span><span>${s.phys.mass} kg</span><span>${stats.vmax} km/h</span></div>`
      });
    });
    this.el.list.innerHTML = h;
    this.bindItems((i) => {
      const s = CAR_SPECS[i];
      if (Garage.owned[s.id]) { Garage.current = s.id; Garage.save(); Game.applyCar(); Audio2.ui('ok'); }
      else if (Garage.canAfford(s.price)) {
        Garage.add(-s.price); Garage.owned[s.id] = true; Garage.cars[s.id] = Garage.defaults(s.id);
        Garage.current = s.id; Garage.save(); Game.applyCar();
        Audio2.ui('buy'); Game.toast('Purchased ' + s.name, 'good');
      } else { Audio2.ui('deny'); Game.toast('Not enough cash', 'bad'); }
      this.render();
    });
  },

  renderEngines() {
    const g = Garage.car();
    let h = '<h3>Engine Swap</h3>';
    ENGINES.forEach((e, i) => {
      const on = g.engine === e.id;
      const sub = e.id === 'stock' ? 'Original powerplant' : (e.cyl + ' cylinders · ' + e.rl + ' rpm');
      h += this.card({
        idx: i, tier: on ? '✓' : (e.id === 'stock' ? '•' : '$'),
        name: e.n, sub, price: on ? 0 : e.cost, state: on ? 'on' : '',
        effects: `<div class="effect"><span>${e.desc}</span>${e.nm ? `<span class="up">${e.nm} Nm base</span>` : ''}</div>`
      });
    });
    this.el.list.innerHTML = h;
    this.bindItems((i) => {
      const e = ENGINES[i], g2 = Garage.car();
      if (g2.engine === e.id) return;
      if (e.cost && !Garage.canAfford(e.cost)) { Audio2.ui('deny'); Game.toast('Not enough cash', 'bad'); return; }
      if (e.cost) Garage.add(-e.cost);
      g2.engine = e.id; Garage.save(); Game.applyCar();
      Audio2.ui('buy'); Game.toast('Fitted ' + e.n, 'good');
      this.render();
    }, (i) => this.previewWith(ph => { }, () => {
      const g2 = Garage.car(), old = g2.engine;
      g2.engine = ENGINES[i].id; const ph = buildPhys(Garage.current); g2.engine = old; return ph;
    }));
  },

  renderParts(cat) {
    const P = PARTS[cat], g = Garage.car(), cur = g.parts[cat] | 0;
    let h = `<h3>${P.n}</h3>`;
    P.items.forEach((it, i) => {
      h += this.card({
        idx: i, tier: i === cur ? '✓' : i, name: it.n,
        sub: this.describe(cat, it), price: i === cur ? 0 : it.cost,
        state: i === cur ? 'on' : '', effects: this.effectTags(cat, it)
      });
    });
    this.el.list.innerHTML = h;
    this.bindItems((i) => {
      const it = P.items[i], g2 = Garage.car();
      if ((g2.parts[cat] | 0) === i) return;
      if (it.cost && !Garage.canAfford(it.cost)) { Audio2.ui('deny'); Game.toast('Not enough cash', 'bad'); return; }
      if (it.cost) Garage.add(-it.cost);
      g2.parts[cat] = i; Garage.save(); Game.applyCar();
      Audio2.ui('buy'); Game.toast(it.n + ' installed', 'good');
      this.render();
    }, (i) => this.previewWith(null, () => {
      const g2 = Garage.car(), old = g2.parts[cat];
      g2.parts[cat] = i; const ph = buildPhys(Garage.current); g2.parts[cat] = old; return ph;
    }));
  },

  renderStats() {
    const ph = buildPhys(Garage.current);
    const st = statsFor(ph);
    const spec = specById(Garage.current);
    const g = Garage.car();
    const S = Garage.stats || {};
    const dmg = Math.max(g.damage || 0, (Game.player ? Game.player.damage : 0) || 0);

    const row = (k, v, bar) => `<div class="srow"><u>${k}</u><b>${v}</b>${
      bar === undefined ? '' : `<i class="sbar"><s style="width:${clamp(bar, 2, 100).toFixed(0)}%"></s></i>`}</div>`;

    const gears = ph.gears.length + ' speed' + (ph.parts && ph.parts.gearbox ? ' · ' + ph.parts.gearbox.n : '');
    const induction = ph.forced === 'none' ? 'Naturally aspirated'
      : (ph.forced === 'turbo' ? 'Turbocharged' : 'Supercharged') + ' · ' + ph.maxBoostPsi.toFixed(1) + ' psi';

    this.el.list.innerHTML =
      `<h3>${spec.name} — specification</h3><div class="sheet">` +
      row('Peak power', st.hp + ' hp @ ' + st.hpRpm + ' rpm', st.hp / 9) +
      row('Peak torque', st.nm + ' Nm @ ' + st.nmRpm + ' rpm', st.nm / 11) +
      row('Redline', Math.round(ph.redline) + ' rpm', (ph.redline - 5000) / 50) +
      row('0–100 km/h', st.zero100.toFixed(1) + ' s', 120 - st.zero100 * 20) +
      row('Top speed', st.vmax + ' km/h', st.vmax / 3.6) +
      row('Kerb weight', st.mass + ' kg', 100 - (st.mass - 900) / 12) +
      row('Power / tonne', st.pwr.toFixed(0) + ' hp/t', st.pwr / 6) +
      row('Induction', induction) +
      row('Drivetrain', ph.drive.toUpperCase() + ' · ' + gears) +
      row('Differential', (ph.diffLock * 100).toFixed(0) + '% lock', ph.diffLock * 100) +
      row('Grip index', st.grip.toFixed(2), (st.grip - 1) * 90) +
      row('Braking', ph.brake.toFixed(2) + ' g', ph.brake * 32) +
      row('Downforce', (ph.dfR * 100).toFixed(0), ph.dfR * 45) +
      row('Nitrous', ph.nosShot ? '+' + (ph.nosShot * 100).toFixed(0) + '% for ' + ph.nosTank + ' s' : 'Not fitted') +
      row('Condition', dmg > 0.01 ? (100 - dmg * 100).toFixed(0) + '%' : 'Pristine', 100 - dmg * 100) +
      '</div>' +
      '<h3>Career</h3><div class="sheet">' +
      row('Distance driven', ((S.distance || 0) / 1000).toFixed(1) + ' km') +
      row('Top speed ever', Math.round(S.topSpeed || 0) + ' km/h') +
      row('Best drift score', Math.round(S.drift || 0).toLocaleString('en-US')) +
      row('Routes completed', (S.races || 0)) +
      row('Total earned', money(S.earned || 0)) +
      row('Cars owned', Object.keys(Garage.owned).length + ' / ' + CAR_SPECS.length) +
      '</div>';
  },

  renderVisual() {
    const g = Garage.car();
    let h = '<h3>Body colour</h3><div class="swatches" id="swatches">';
    PAINTS.forEach((p, i) => h += `<div class="sw${i === g.paint ? ' on' : ''}" data-i="${i}" style="background:${p.c}" title="${p.n}"></div>`);
    h += '</div><h3>Racing stripe</h3><div class="swatches" id="stripes">';
    h += `<div class="sw none${(g.stripe | 0) < 0 ? ' on' : ''}" data-s="-1" title="None">✕</div>`;
    PAINTS.forEach((p, i) => h += `<div class="sw${g.stripe === i ? ' on' : ''}" data-s="${i}" style="background:${p.c}" title="${p.n}"></div>`);
    h += '</div><h3>Finish</h3>';
    ['Gloss', 'Metallic', 'Matte', 'Chrome'].forEach((n, i) => {
      h += this.card({ idx: i, tier: i === g.finish ? '✓' : i, name: n, sub: 'Clear coat', price: 0, state: i === g.finish ? 'on' : '' });
    });
    h += '<h3>Wheels</h3>';
    RIMS.forEach((r, i) => {
      h += this.card({ idx: 100 + i, tier: i === g.rim ? '✓' : i, name: r.n, sub: r.spokes + ' spoke', price: i === g.rim ? 0 : r.cost, state: i === g.rim ? 'on' : '' });
    });
    h += '<h3>Wheel finish</h3>';
    RIM_FINISH_NAMES.forEach((n, i) => {
      h += this.card({ idx: 200 + i, tier: i === (g.rimFinish | 0) ? '✓' : i, name: n, sub: 'Powder coat', price: i === (g.rimFinish | 0) ? 0 : 900, state: i === (g.rimFinish | 0) ? 'on' : '' });
    });
    h += '<h3>Brake calipers</h3>';
    CALIPER_NAMES.forEach((n, i) => {
      h += this.card({ idx: 300 + i, tier: i === (g.caliper | 0) ? '✓' : i, name: n, sub: 'Caliper paint', price: i === (g.caliper | 0) ? 0 : 450, state: i === (g.caliper | 0) ? 'on' : '' });
    });
    this.el.list.innerHTML = h;

    this.el.list.querySelectorAll('#swatches .sw').forEach(sw => sw.onclick = () => {
      Garage.car().paint = +sw.dataset.i; Garage.save(); Audio2.ui('tick'); this.render();
    });
    this.el.list.querySelectorAll('#stripes .sw').forEach(sw => sw.onclick = () => {
      Garage.car().stripe = +sw.dataset.s; Garage.save(); Audio2.ui('tick'); this.render();
    });
    this.bindItems((i) => {
      const g2 = Garage.car();
      if (i >= 300) { this.buy(450, () => g2.caliper = i - 300); }
      else if (i >= 200) { this.buy(900, () => g2.rimFinish = i - 200); }
      else if (i >= 100) {
        const r = RIMS[i - 100];
        if (g2.rim === i - 100) return;
        this.buy(r.cost, () => { g2.rim = i - 100; Game.applyCar(); });
      } else { g2.finish = i; Garage.save(); Audio2.ui('tick'); }
      this.render();
    });
  },

  buy(cost, apply) {
    if (cost && !Garage.canAfford(cost)) { Audio2.ui('deny'); Game.toast('Not enough cash', 'bad'); return false; }
    if (cost) Garage.add(-cost);
    apply(); Garage.save(); Audio2.ui(cost ? 'buy' : 'tick');
    return true;
  },

  bindItems(onClick, onHover) {
    this.el.list.querySelectorAll('.item').forEach(el => {
      el.onclick = () => onClick(+el.dataset.i);
      el.onmouseenter = () => {
        Audio2.ui('hover');
        if (onHover) { const ph = onHover(+el.dataset.i); this.preview(ph); }
      };
      el.onmouseleave = () => this.preview(null);
    });
  },
  previewWith(_, fn) { return fn(); },

  describe(cat, it) {
    if (cat === 'forced') return it.kind === 'none' ? 'No forced induction'
      : (it.kind === 'turbo' ? `${it.psi} psi · spools ~${it.spool} rpm` : `${it.psi} psi · instant`);
    if (cat === 'gearbox') return `${(it.shift * 1000) | 0} ms shift`;
    if (cat === 'diff') return it.lock >= 1 ? 'Fully locked — sideways specialist' : `${(it.lock * 100) | 0}% lock`;
    if (cat === 'tyres') return `grip ${it.grip.toFixed(2)} · wet ${it.wet.toFixed(2)}`;
    if (cat === 'nitrous') return it.shot ? `+${(it.shot * 100) | 0}% for ${it.tank}s` : 'No bottle';
    if (cat === 'drivetrain') return it.drive ? 'Converts to ' + it.drive.toUpperCase() : 'As built';
    return '';
  },
  effectTags(cat, it) {
    const tag = (t, cls) => `<span class="${cls || ''}">${t}</span>`;
    let out = [];
    if (it.tq && it.tq !== 1) out.push(tag(`${it.tq > 1 ? '+' : ''}${((it.tq - 1) * 100).toFixed(0)}% torque`, 'up'));
    if (it.psi) out.push(tag(`${it.psi} psi`, 'up'));
    if (it.grip && it.grip !== 1) out.push(tag(`${it.grip > 1 ? '+' : ''}${((it.grip - 1) * 100).toFixed(0)}% grip`, it.grip > 1 ? 'up' : 'dn'));
    if (it.brake && it.brake !== 1) out.push(tag(`+${((it.brake - 1) * 100).toFixed(0)}% braking`, 'up'));
    if (it.mass) out.push(tag(`${it.mass > 0 ? '+' : ''}${it.mass} kg`, it.mass < 0 ? 'up' : 'dn'));
    if (it.df && it.df !== 1) out.push(tag(`+${((it.df - 1) * 100).toFixed(0)}% downforce`, 'up'));
    if (it.drag && it.drag > 1) out.push(tag(`+${((it.drag - 1) * 100).toFixed(0)}% drag`, 'dn'));
    if (it.rl) out.push(tag(`+${it.rl} rpm`, 'up'));
    if (it.slide && it.slide > 1) out.push(tag('slide-friendly', 'up'));
    return out.length ? `<div class="effect">${out.join('')}</div>` : '';
  },

  /* ---------------- stats + dyno ---------------- */
  drawStats() {
    const ph = buildPhys(Garage.current);
    const s = statsFor(ph);
    const pv = this.previewPh ? statsFor(this.previewPh) : null;
    const row = (k, v, unit) => `<div><u>${k}</u><b>${v}<s>${unit || ''}</s></b></div>`;
    this.el.stats.innerHTML =
      row('Power', s.hp, ' hp') + row('Torque', s.nm, ' Nm') +
      row('0–100', s.zero100.toFixed(1), ' s') + row('Top speed', s.vmax, ' km/h') +
      row('Weight', s.mass, ' kg') + row('Power/tonne', s.pwr.toFixed(0), '');
    if (pv) {
      const d = (a, b, unit, inv) => {
        const diff = b - a;
        if (Math.abs(diff) < 0.05) return '';
        const cls = (inv ? diff < 0 : diff > 0) ? 'up' : 'dn';
        return `<span class="${cls}">${diff > 0 ? '+' : ''}${Math.abs(diff) < 10 ? diff.toFixed(1) : diff.toFixed(0)}${unit}</span> `;
      };
      this.el.delta.innerHTML = d(s.hp, pv.hp, ' hp') + d(s.nm, pv.nm, ' Nm') +
        d(s.zero100, pv.zero100, ' s', true) + d(s.vmax, pv.vmax, ' km/h') + d(s.mass, pv.mass, ' kg', true);
    } else this.el.delta.innerHTML = '<span style="opacity:.5">hover a part to compare</span>';

    // bodywork repair
    const g = Garage.car();
    const dmg = (Game.player && Game.current === Garage.current) ? Game.player.damage : (g.damage || 0);
    const d2 = Math.max(g.damage || 0, (Game.player ? Game.player.damage : 0) || 0);
    let rb = document.getElementById('repairbtn');
    if (d2 > 0.02) {
      const cost = Math.round(d2 * (specById(Garage.current).price * 0.05 + 1200));
      if (!rb) {
        rb = document.createElement('button');
        rb.id = 'repairbtn'; rb.className = 'btn ghost wide';
        this.el.delta.parentNode.insertBefore(rb, this.el.delta.nextSibling);
      }
      rb.textContent = 'Repair bodywork · ' + money(cost) + '  (' + Math.round(d2 * 100) + '% damaged)';
      rb.disabled = !Garage.canAfford(cost);
      rb.onclick = () => {
        if (!Garage.canAfford(cost)) { Audio2.ui('deny'); return; }
        Garage.add(-cost);
        g.damage = 0;
        if (Game.player) { Game.player.damage = 0; Game.player.damageSide = 0; }
        Garage.save(); Audio2.ui('buy'); Game.toast('Panel work done', 'good');
        this.render();
      };
    } else if (rb) rb.remove();

    this.drawDyno(ph, this.previewPh);
  },

  drawDyno(ph, ghost) {
    const c = this.dctx, W = this.el.dyno.width, H = this.el.dyno.height;
    c.clearRect(0, 0, W, H);
    const padL = 34, padR = 34, padT = 18, padB = 24;
    const gw = W - padL - padR, gh = H - padT - padB;
    const rlMax = Math.max(ph.redline, ghost ? ghost.redline : 0);

    let maxHp = 0, maxNm = 0;
    const sample = (p) => {
      const hp = [], nm = [];
      for (let i = 0; i <= 80; i++) {
        const r = 800 + (p.redline - 800) * i / 80;
        const t = torqueAt(r, p);
        nm.push([r, t]); hp.push([r, t * r / 7127]);
        maxHp = Math.max(maxHp, t * r / 7127); maxNm = Math.max(maxNm, t);
      }
      return { hp, nm };
    };
    const A = sample(ph), G = ghost ? sample(ghost) : null;
    maxHp = Math.ceil(maxHp / 100) * 100 || 100;
    maxNm = Math.ceil(maxNm / 100) * 100 || 100;

    // grid
    c.strokeStyle = 'rgba(140,180,220,.13)'; c.lineWidth = 1;
    c.font = '9px Rajdhani, sans-serif'; c.fillStyle = 'rgba(160,190,220,.55)';
    for (let i = 0; i <= 4; i++) {
      const y = padT + gh * i / 4;
      c.beginPath(); c.moveTo(padL, y); c.lineTo(W - padR, y); c.stroke();
      c.textAlign = 'right'; c.fillText(Math.round(maxHp * (1 - i / 4)), padL - 5, y + 3);
      c.textAlign = 'left'; c.fillText(Math.round(maxNm * (1 - i / 4)), W - padR + 5, y + 3);
    }
    c.textAlign = 'center';
    for (let r = 2000; r < rlMax; r += 2000) {
      const x = padL + gw * (r - 800) / (rlMax - 800);
      c.strokeStyle = 'rgba(140,180,220,.09)';
      c.beginPath(); c.moveTo(x, padT); c.lineTo(x, padT + gh); c.stroke();
      c.fillText((r / 1000) + 'k', x, H - 8);
    }

    const plot = (pts, max, col, w, dash) => {
      c.save(); c.beginPath(); c.setLineDash(dash || []);
      pts.forEach(([r, v], i) => {
        const x = padL + gw * (r - 800) / (rlMax - 800);
        const y = padT + gh * (1 - v / max);
        i ? c.lineTo(x, y) : c.moveTo(x, y);
      });
      c.strokeStyle = col; c.lineWidth = w; c.lineJoin = 'round';
      c.shadowColor = col; c.shadowBlur = 8; c.stroke(); c.restore();
    };
    if (G) { plot(G.hp, maxHp, 'rgba(124,243,124,.45)', 1.5, [4, 3]); plot(G.nm, maxNm, 'rgba(255,207,107,.35)', 1.5, [4, 3]); }
    plot(A.hp, maxHp, '#22e3ff', 2.2);
    plot(A.nm, maxNm, '#ffcf6b', 2.0);

    c.setLineDash([]); c.shadowBlur = 0;
    c.textAlign = 'left'; c.fillStyle = '#22e3ff'; c.font = '10px Rajdhani, sans-serif';
    c.fillText('HP', padL + 4, padT + 11);
    c.textAlign = 'right'; c.fillStyle = '#ffcf6b';
    c.fillText('TORQUE', W - padR - 4, padT + 11);
  }
};
