// Small SVG charts without dependencies: one axis, thin marks, hover tooltips.
const tip = () => document.getElementById('tip');

function showTip(html, ev) {
  const t = tip();
  t.innerHTML = html;
  t.hidden = false;
  const w = t.offsetWidth;
  const x = Math.min(Math.max(8, ev.clientX - w / 2), window.innerWidth - w - 8);
  t.style.left = `${x}px`;
  t.style.top = `${Math.max(8, ev.clientY - t.offsetHeight - 14)}px`;
}
export const hideTip = () => { tip().hidden = true; };

function niceScale(min, max, ticks = 4) {
  if (min === max) { max = min + 1; }
  const raw = (max - min) / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const values = [];
  for (let v = lo; v <= hi + step / 2; v += step) values.push(Math.round(v * 100) / 100);
  return { lo, hi, values };
}

const axisNum = (v) => new Intl.NumberFormat('de-CH', { maximumFractionDigits: 0 }).format(v);

function frame(el, height) {
  const W = Math.max(el.clientWidth || 600, 280);
  return { W, H: height, l: 44, r: 8, t: 10, b: 24 };
}

// points: [{ x: 0..1 position in the period, y: value, label: tooltip html }], drawn as a step line.
export function stepLine(el, points, xLabels) {
  const f = frame(el, 220);
  const ys = points.map((p) => p.y);
  const s = niceScale(Math.min(0, ...ys), Math.max(...ys, 1));
  const X = (x) => f.l + x * (f.W - f.l - f.r);
  const Y = (y) => f.t + (1 - (y - s.lo) / (s.hi - s.lo)) * (f.H - f.t - f.b);

  let d = '';
  points.forEach((p, i) => {
    if (i === 0) d += `M${X(p.x).toFixed(1)} ${Y(p.y).toFixed(1)}`;
    else d += `H${X(p.x).toFixed(1)}V${Y(p.y).toFixed(1)}`;
  });
  const last = points[points.length - 1];

  el.innerHTML = `<svg viewBox="0 0 ${f.W} ${f.H}" role="img" aria-label="Saldoverlauf">
    ${s.values.map((v) => `<line x1="${f.l}" x2="${f.W - f.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--grid)"/>
      <text x="${f.l - 6}" y="${Y(v) + 4}" text-anchor="end">${axisNum(v)}</text>`).join('')}
    ${xLabels.map((m) => `<text x="${X(m.x)}" y="${f.H - 6}" text-anchor="middle">${m.label}</text>`).join('')}
    <path d="${d}" fill="none" stroke="var(--series-1)" stroke-width="2" stroke-linejoin="round"/>
    <circle cx="${X(last.x)}" cy="${Y(last.y)}" r="4" fill="var(--series-1)" stroke="var(--surface)" stroke-width="2"/>
    <line class="cross" y1="${f.t}" y2="${f.H - f.b}" stroke="var(--ink-3)" stroke-width="1" visibility="hidden"/>
    <circle class="dot" r="4" fill="var(--series-1)" stroke="var(--surface)" stroke-width="2" visibility="hidden"/>
    <rect class="hit" x="${f.l}" y="0" width="${f.W - f.l - f.r}" height="${f.H}" fill="transparent"/>
  </svg>`;

  const svg = el.querySelector('svg');
  const cross = svg.querySelector('.cross');
  const dot = svg.querySelector('.dot');
  const hit = svg.querySelector('.hit');
  hit.addEventListener('pointermove', (ev) => {
    const r = svg.getBoundingClientRect();
    const px = (ev.clientX - r.left) * (f.W / r.width);
    let best = points[0];
    for (const p of points) { if (X(p.x) <= px) best = p; }
    cross.setAttribute('x1', X(best.x)); cross.setAttribute('x2', X(best.x));
    cross.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', X(best.x)); dot.setAttribute('cy', Y(best.y));
    dot.setAttribute('visibility', 'visible');
    showTip(best.label, ev);
  });
  hit.addEventListener('pointerleave', () => {
    cross.setAttribute('visibility', 'hidden');
    dot.setAttribute('visibility', 'hidden');
    hideTip();
  });
}

// months: [{ label, income, spending, tip }]
export function pairedBars(el, months) {
  const f = frame(el, 220);
  const max = Math.max(1, ...months.flatMap((m) => [m.income, m.spending]));
  const s = niceScale(0, max);
  const Y = (y) => f.t + (1 - (y - s.lo) / (s.hi - s.lo)) * (f.H - f.t - f.b);
  const groupW = (f.W - f.l - f.r) / months.length;
  const barW = Math.min(14, Math.max(4, (groupW - 6) / 2 - 1));
  const base = Y(0);

  const bar = (x, v, color) => {
    if (v <= 0) return '';
    const y = Y(v);
    const h = base - y;
    const r = Math.min(4, barW / 2, h);
    return `<path fill="${color}" d="M${x} ${base}V${y + r}Q${x} ${y} ${x + r} ${y}H${x + barW - r}Q${x + barW} ${y} ${x + barW} ${y + r}V${base}Z"/>`;
  };

  el.innerHTML = `<svg viewBox="0 0 ${f.W} ${f.H}" role="img" aria-label="Einnahmen und Ausgaben pro Monat">
    ${s.values.map((v) => `<line x1="${f.l}" x2="${f.W - f.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--grid)"/>
      <text x="${f.l - 6}" y="${Y(v) + 4}" text-anchor="end">${axisNum(v)}</text>`).join('')}
    ${months.map((m, i) => {
      const cx = f.l + groupW * (i + .5);
      return `${bar(cx - barW - 1, m.income, 'var(--series-1)')}${bar(cx + 1, m.spending, 'var(--series-2)')}
        <text x="${cx}" y="${f.H - 6}" text-anchor="middle">${m.label}</text>
        <rect class="hit" data-i="${i}" x="${f.l + groupW * i}" y="0" width="${groupW}" height="${f.H}" fill="transparent"/>`;
    }).join('')}
  </svg>`;

  el.querySelectorAll('.hit').forEach((r) => {
    r.addEventListener('pointermove', (ev) => showTip(months[+r.dataset.i].tip, ev));
    r.addEventListener('pointerleave', hideTip);
  });
}
