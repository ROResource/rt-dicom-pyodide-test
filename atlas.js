// ===================== Atlas PDF export =====================
// Builds a navigable PDF: title page (+contents), optional legend, then one slice per page.
// Uses globals from the main script (meta, rois, secs, notes, crop, py, ...).
const APLANES = ['ax', 'sag', 'cor'];
const PNAME = {ax: 'Axial', sag: 'Sagittal', cor: 'Coronal'};
let atlas = null;            // config, persisted between openings
let thumbImgs = {};          // plane -> canvas with the base image for the VOI editor
let voiDrag = null;
// every page is A4 landscape; image area = page minus margins/header/footer
const PG = {W: 297, H: 210, M: 5, HEAD: 17, FOOT: 15};
const IMG_ASPECT = (PG.H - PG.HEAD - PG.FOOT) / (PG.W - 2 * PG.M);   // max height/width that fills the page
let projCache = {key: '', cv: {}};

// ---------- config ----------
function atlasSync() {
  const c = {...(crop || fullCrop())};
  if (!atlas) {
    const gap = Math.abs(meta.sliceGap) || 1;
    atlas = {
      title: '', creator: '',
      voi: {ax: {...c}, sag: {...c}, cor: {...c}}, edit: 'ax', fresh: true,
      planeOn: {ax: true, sag: true, cor: true},
      // default ~3 mm between pages to keep the PDF manageable; set to 1 for every slice
      step: {ax: Math.max(1, Math.round(3 / gap)), sag: Math.max(1, Math.round(3 / meta.ps[1])), cor: Math.max(1, Math.round(3 / meta.ps[0]))},
      scans: [], roiOn: {}, notesOn: true,
      legend: {on: false, onlyDescribed: false, desc: {}},
      quality: 1200,
    };
  }
  // scans: primary, extra CT windows, then loaded secondaries (keep existing settings)
  const old = Object.fromEntries(atlas.scans.map(s => [s.key, s]));
  const [ctW, ctL] = $('wl').value.split(',').map(Number);
  const list = [old.pri || {key: 'pri', base: 'pri', kind: 'pri', include: true, planes: {ax: true, sag: true, cor: true}, ww: ctW, wl: ctL}];
  atlas.scans.filter(s => s.kind === 'win').forEach(s => list.push(s));
  for (const id of loadedIds())
    list.push(old[id] || {key: id, base: id, kind: 'sec', include: true, planes: {ax: true, sag: true, cor: true}, ww: secs[id].ww, wl: secs[id].wl});
  atlas.scans = list;
  // structures: default = currently visible
  rois.forEach(r => { if (!(r.number in atlas.roiOn)) atlas.roiOn[r.number] = r.visible; });
  if (atlas.fresh) { atlas.fresh = false; fitAspect('sag', atlas.voi.sag); fitAspect('cor', atlas.voi.cor); }
}
// sagittal/coronal boxes: limit the superior-inferior extent so the image fills a landscape page.
// mode: 't' keep bottom, 'b' keep top, otherwise centre on the selected structures (or the box)
function fitAspect(p, v, mode) {
  if (p === 'ax') return v;
  const gap = Math.abs(meta.sliceGap) || 1, W = p === 'sag' ? 'r' : 'c', psW = p === 'sag' ? meta.ps[0] : meta.ps[1];
  if (!mode) {
    // default: widen the box (up to the full scan) so the selected structures + margin fit in height
    let lo = Infinity, hi = -Infinity;
    for (const r of rois) if (atlas.roiOn[r.number] && r.ks.length) { lo = Math.min(lo, r.ks[0]); hi = Math.max(hi, r.ks[r.ks.length - 1]); }
    if (isFinite(lo)) {
      const m = Math.round((+$('cropMargin').value || 0) / gap);
      const needK = Math.min(v.k1, hi + m) - Math.max(v.k0, lo - m) + 1;
      const needW = Math.ceil(needK * gap / IMG_ASPECT / psW), haveW = v[W + '1'] - v[W + '0'] + 1;
      const full = (W === 'r' ? meta.rows : meta.cols);
      if (needW > haveW) {
        const w = Math.min(full, needW), mid = (v[W + '0'] + v[W + '1']) / 2;
        v[W + '0'] = Math.max(0, Math.min(full - w, Math.round(mid - w / 2))); v[W + '1'] = v[W + '0'] + w - 1;
      }
    }
  }
  const wMm = (v[W + '1'] - v[W + '0'] + 1) * psW;
  const maxK = Math.max(4, Math.floor(wMm * IMG_ASPECT / gap));
  if (v.k1 - v.k0 + 1 <= maxK) return v;
  if (mode === 't') v.k1 = v.k0 + maxK - 1;
  else if (mode === 'b') v.k0 = v.k1 - maxK + 1;
  else if (mode === 'keep') { const mid = (v.k0 + v.k1) / 2; v.k0 = Math.max(0, Math.round(mid - maxK / 2)); v.k1 = Math.min(meta.n - 1, v.k0 + maxK - 1); }
  else {
    let lo = Infinity, hi = -Infinity;
    for (const r of rois) if (atlas.roiOn[r.number] && r.ks.length) { lo = Math.min(lo, r.ks[0]); hi = Math.max(hi, r.ks[r.ks.length - 1]); }
    let mid = isFinite(lo) ? (lo + hi) / 2 : (v.k0 + v.k1) / 2;
    mid = Math.max(v.k0 + maxK / 2, Math.min(v.k1 - maxK / 2, mid));   // stay inside the current range
    v.k0 = Math.max(0, Math.round(mid - maxK / 2)); v.k1 = Math.min(meta.n - 1, v.k0 + maxK - 1);
  }
  return v;
}
const atlasName = s => s.kind === 'win' ? s.name : scanName(s.key);
function setAtlasName(s, v) {
  if (s.kind === 'win') s.name = v;
  else if (s.key === 'pri') { priName = v; $('name_pri').value = v; }
  else { secs[s.key].label = v; $('name_' + s.key).value = v; }
}
// slices of the edited plane that carry a note on any included scan (always included as pages)
function noteSlices(p) {
  if (!atlas.notesOn) return [];
  const v = atlas.voi[p], bases = new Set(atlas.scans.filter(s => s.include && s.planes[p]).map(s => s.base));
  const [lo, hi] = p === 'ax' ? [v.k0, v.k1] : p === 'sag' ? [v.c0, v.c1] : [v.r0, v.r1];
  return [...new Set(notes.filter(n => n.plane === p && bases.has(n.scan) && (n.text || '').trim() && n.idx >= lo && n.idx <= hi).map(n => n.idx))];
}
function sliceList(p) {
  const v = atlas.voi[p], st = Math.max(1, atlas.step[p] | 0), out = new Set();
  if (p === 'ax') for (let k = v.k1; k >= v.k0; k -= st) out.add(k);
  else if (p === 'sag') for (let c = v.c0; c <= v.c1; c += st) out.add(c);
  else for (let r = v.r0; r <= v.r1; r += st) out.add(r);
  noteSlices(p).forEach(i => out.add(i));
  // axial: superior -> inferior; sagittal: patient right -> left; coronal: anterior -> posterior
  return [...out].sort((a, b) => p === 'ax' ? b - a : a - b);
}
function spacingMm(p) {
  const gap = Math.abs(meta.sliceGap) || 1;
  return (atlas.step[p] || 1) * (p === 'ax' ? gap : p === 'sag' ? meta.ps[1] : meta.ps[0]);
}
// same geometry as the viewer's planeGeom, but for an arbitrary VOI
function geomVoi(p, v) {
  const {n, rows, cols, ps} = meta, gap = Math.abs(meta.sliceGap) || 1;
  const yk0 = (n - 1) - v.k1, yk1 = (n - 1) - v.k0;
  let g;
  if (p === 'ax')       g = {w: cols, h: rows, x0: v.c0, x1: v.c1, y0: v.r0, y1: v.r1, psx: ps[1], psy: ps[0]};
  else if (p === 'sag') g = {w: rows, h: n, x0: v.r0, x1: v.r1, y0: yk0, y1: yk1, psx: ps[0], psy: gap};
  else                  g = {w: cols, h: n, x0: v.c0, x1: v.c1, y0: yk0, y1: yk1, psx: ps[1], psy: gap};
  g.cw = g.x1 - g.x0 + 1; g.ch = g.y1 - g.y0 + 1; g.mmW = g.cw * g.psx; g.mmH = g.ch * g.psy;
  return g;
}

// ---------- dialog ----------
function atlasOpen() {
  if (!meta) return;
  atlasSync();
  let dlg = $('atlasDlg');
  if (!dlg) { dlg = document.createElement('div'); dlg.id = 'atlasDlg'; document.body.appendChild(dlg); }
  dlg.style.display = 'block';
  atlasRender();
}
function atlasClose() {
  $('atlasDlg').style.display = 'none';
  buildImgSel(); buildRoiPanel(); draw(); renderNotesPanel();
}
$('atlasBtn').onclick = atlasOpen;

function atlasRender() {
  const A = atlas, dlg = $('atlasDlg');
  const incRois = rois.filter(r => A.roiOn[r.number]);
  dlg.innerHTML = `<div class="panel">
  <h3 style="margin-top:0">Build atlas PDF</h3>
  <h4>Title</h4>
  <label>Atlas title <input type="text" id="aTitle" style="width:380px" value="${esc(A.title)}" placeholder="e.g. Prostate + pelvic nodes CTV atlas"></label>
  <label>Created by (optional) <input type="text" id="aCreator" style="width:220px" value="${esc(A.creator)}"></label>

  <h4>Planes and volume of interest</h4>
  Each plane has its own box. Pick which one to edit, then drag inside a box to move it or drag its edges to resize, on any of the three views.
  Shaded areas show the full extent of the selected structures. Sagittal and coronal boxes are limited in height so the image fills a landscape A4 page (widen the box to allow more height).
  Which planes are built is set per scan below.
  <table style="margin-top:6px"><tr><th>Edit</th><th>Plane</th><th>Every Nth slice</th><th>Spacing</th><th>Pages per scan</th><th></th></tr>
  ${APLANES.map(p => `<tr>
    <td><input type="radio" name="voiEdit" value="${p}" ${A.edit === p ? 'checked' : ''}></td><td>${PNAME[p]}</td>
    <td><input type="number" class="aStep" data-p="${p}" min="1" max="50" value="${A.step[p]}"></td>
    <td id="aSp_${p}">${spacingMm(p).toFixed(1)} mm</td><td id="aPg_${p}">${sliceList(p).length}</td><td id="aNs_${p}" style="color:#ffd400"></td></tr>`).join('')}
  </table>
  <button id="aVoiReset">Reset this box to the current crop</button> <button id="aVoiCopy">Copy this box to all planes</button>
  <div class="thumbs">${APLANES.map(p => `<div><canvas id="aTh_${p}"></canvas><br>${PNAME[p]}</div>`).join('')}</div>

  <h4>Scans</h4>
  <table><tr><th>Include</th><th>Name in atlas</th><th>Type</th><th>W</th><th>L</th>${APLANES.map(p => `<th><label title="All scans"><input type="checkbox" class="aPlaneAll" data-p="${p}" ${A.scans.every(s => s.planes[p]) ? 'checked' : ''}> ${PNAME[p]}</label></th>`).join('')}<th></th></tr>
  ${A.scans.map((s, i) => `<tr>
    <td><input type="checkbox" class="aScan" data-i="${i}" ${s.include ? 'checked' : ''}></td>
    <td><input type="text" class="aScanName" data-i="${i}" value="${esc(atlasName(s))}" style="width:200px"></td>
    <td>${s.kind === 'pri' ? 'Primary CT' : s.kind === 'win' ? 'CT, other window' : (secs[s.key].status === 'UNREGISTERED' ? '<span style="color:#f88">unregistered</span>' : 'registered scan')}</td>
    <td><input type="number" class="aWW" data-i="${i}" value="${s.ww}"></td><td><input type="number" class="aWL" data-i="${i}" value="${s.wl}"></td>
    ${APLANES.map(p => `<td><input type="checkbox" class="aSP" data-i="${i}" data-p="${p}" ${s.planes[p] ? 'checked' : ''}></td>`).join('')}
    <td>${s.kind === 'win' ? `<button class="aRmWin" data-i="${i}">Remove</button>` : ''}</td></tr>`).join('')}
  </table>
  Add the CT in another window: <select id="aWinPreset"><option value="Lung window|1600|-600">Lung 1600/-600</option><option value="Bone window|2000|300">Bone 2000/300</option><option value="Mediastinal window|350|40">Mediastinal 350/40</option><option value="Custom window|400|40">Custom</option></select>
  <button id="aAddWin">+ Add CT window</button>

  <h4>Structures</h4>
  <button id="aRoiAll">All</button><button id="aRoiNone">None</button><button id="aRoiVis">Match viewer</button>
  <div class="roiGrid" style="margin-top:4px">${rois.map(r => `<label><input type="checkbox" class="aRoi" data-n="${r.number}" ${A.roiOn[r.number] ? 'checked' : ''}>
    <span class="sw" style="background:rgb(${r.color})"></span>${esc(r.name)}</label>`).join('')}</div>

  <h4>Notes</h4>
  <label><input type="checkbox" id="aNotes" ${A.notesOn ? 'checked' : ''}> Include notes (${notes.length} in total)</label>

  <h4>Legend</h4>
  <label><input type="checkbox" id="aLeg" ${A.legend.on ? 'checked' : ''}> Add a legend page describing the structures</label>
  <div id="aLegBox" style="display:${A.legend.on ? 'block' : 'none'};margin-top:6px">
    <div id="aLegMsg" style="color:#c90;margin-bottom:4px"></div>
    <label><input type="checkbox" id="aLegOnly" ${A.legend.onlyDescribed ? 'checked' : ''}> Only list structures that have a description</label>
    <table>${incRois.map(r => `<tr><td style="vertical-align:top;white-space:nowrap"><span class="sw" style="background:rgb(${r.color})"></span>${esc(r.name)}</td>
      <td><textarea class="aDesc ${(A.legend.desc[r.number] || '').trim() ? '' : 'empty'}" data-n="${r.number}" placeholder="Description, e.g. boundaries / guideline reference">${esc(A.legend.desc[r.number] || '')}</textarea></td></tr>`).join('')}</table>
  </div>

  <h4>Output</h4>
  Image resolution (image width): <select id="aQ">${[800, 1000, 1200, 1600, 2200].map(q => `<option ${A.quality === q ? 'selected' : ''}>${q}</option>`).join('')}</select> px
  <small style="color:#999">The CT itself is only ~300–500 px across the crop, so above ~1200 px only contour lines and note text get sharper.</small>
  <div class="foot">
    <span id="aSummary"></span><br>
    <button id="aBuild" style="font-weight:bold">Build PDF</button> <button id="aClose">Close</button>
    <progress id="aProg" value="0" max="1" style="display:none"></progress> <span id="aProgTxt"></span>
  </div></div>`;

  const q = s => dlg.querySelectorAll(s);
  $('aTitle').oninput = e => A.title = e.target.value;
  $('aCreator').oninput = e => A.creator = e.target.value;
  q('input[name=voiEdit]').forEach(x => x.onchange = e => { A.edit = e.target.value; refreshThumbImgs(); });
  q('.aPlaneAll').forEach(x => x.onchange = e => { A.scans.forEach(s => s.planes[e.target.dataset.p] = e.target.checked); atlasRender(); });
  q('.aStep').forEach(x => x.oninput = e => { A.step[e.target.dataset.p] = Math.max(1, +e.target.value | 0); atlasCounts(); });
  $('aVoiReset').onclick = () => { A.voi[A.edit] = fitAspect(A.edit, {...(crop || fullCrop())}); refreshThumbImgs(); atlasCounts(); };
  $('aVoiCopy').onclick = () => { const v = A.voi[A.edit]; APLANES.forEach(p => A.voi[p] = fitAspect(p, {...v})); atlasCounts(); };
  q('.aScan').forEach(x => x.onchange = e => { A.scans[+e.target.dataset.i].include = e.target.checked; atlasSummary(); });
  q('.aScanName').forEach(x => x.oninput = e => setAtlasName(A.scans[+e.target.dataset.i], e.target.value));
  q('.aWW').forEach(x => x.oninput = e => A.scans[+e.target.dataset.i].ww = +e.target.value);
  q('.aWL').forEach(x => x.oninput = e => A.scans[+e.target.dataset.i].wl = +e.target.value);
  q('.aSP').forEach(x => x.onchange = e => { A.scans[+e.target.dataset.i].planes[e.target.dataset.p] = e.target.checked; atlasRender(); });
  q('.aRmWin').forEach(x => x.onclick = e => { A.scans.splice(+e.target.dataset.i, 1); atlasRender(); });
  $('aAddWin').onclick = () => {
    const [name, ww, wl] = $('aWinPreset').value.split('|');
    const n = A.scans.filter(s => s.kind === 'win').length + 1;
    const pos = A.scans.findIndex(s => s.kind === 'sec');
    const s = {key: 'w' + Date.now(), base: 'pri', kind: 'win', name: `${scanName('pri')} ${name.toLowerCase()}${n > 1 ? ' ' + n : ''}`,
               include: true, planes: {...A.scans[0].planes}, ww: +ww, wl: +wl};
    A.scans.splice(pos < 0 ? A.scans.length : pos, 0, s); atlasRender();
  };
  const setRois = f => { rois.forEach(r => A.roiOn[r.number] = f(r)); atlasRender(); };
  $('aRoiAll').onclick = () => setRois(() => true); $('aRoiNone').onclick = () => setRois(() => false); $('aRoiVis').onclick = () => setRois(r => r.visible);
  q('.aRoi').forEach(x => x.onchange = e => { A.roiOn[+e.target.dataset.n] = e.target.checked; atlasRender(); });  // re-renders thumbs + legend
  $('aNotes').onchange = e => { A.notesOn = e.target.checked; atlasCounts(); };
  $('aLeg').onchange = e => { A.legend.on = e.target.checked; $('aLegBox').style.display = A.legend.on ? 'block' : 'none'; legendMsg(); atlasSummary(); };
  $('aLegOnly').onchange = e => { A.legend.onlyDescribed = e.target.checked; };
  q('.aDesc').forEach(x => x.oninput = e => { A.legend.desc[+e.target.dataset.n] = e.target.value; e.target.classList.toggle('empty', !e.target.value.trim()); legendMsg(); });
  $('aQ').onchange = e => { A.quality = +e.target.value; atlasSummary(); };
  $('aClose').onclick = atlasClose;
  $('aBuild').onclick = buildAtlas;
  legendMsg(); initThumbs(); refreshThumbImgs(); atlasCounts();
}
function legendMsg() {
  const el = $('aLegMsg'); if (!el) return;
  const inc = rois.filter(r => atlas.roiOn[r.number]);
  const missing = inc.filter(r => !(atlas.legend.desc[r.number] || '').trim()).length;
  el.textContent = missing ? `Please fill in descriptions: ${missing} of ${inc.length} included structures have none yet (highlighted).` : 'All included structures have a description.';
  el.style.color = missing ? '#c90' : '#9c9';
}
function atlasCounts() {
  APLANES.forEach(p => {
    $('aSp_' + p).textContent = spacingMm(p).toFixed(1) + ' mm'; $('aPg_' + p).textContent = sliceList(p).length;
    const k = noteSlices(p).length; $('aNs_' + p).textContent = k ? `incl. ${k} annotated slice${k > 1 ? 's' : ''}` : '';
  });
  drawThumbs(); atlasSummary();
}
function atlasPlan() {
  const scans = atlas.scans.filter(s => s.include);
  const sections = [];
  for (const s of scans) for (const p of APLANES)
    if (s.planes[p]) sections.push({s, p, idxs: sliceList(p)});
  return sections;
}
function atlasSummary() {
  const el = $('aSummary'); if (!el) return;
  const secs_ = atlasPlan(), pages = secs_.reduce((a, s) => a + s.idxs.length, 0);
  const mb = pages * 0.14 * Math.pow(atlas.quality / 1600, 1.6);
  el.textContent = `${secs_.length} sections, ${pages} image pages (+ title${atlas.legend.on ? ' + legend' : ''}). Estimated size ≈ ${mb < 1000 ? mb.toFixed(0) + ' MB' : (mb / 1000).toFixed(1) + ' GB'}.`;
}

// ---------- VOI editor (three thumbnails, box of the plane being edited) ----------
function thumbGeom(p) {
  const {n, rows, cols, ps} = meta, gap = Math.abs(meta.sliceGap) || 1;
  if (p === 'ax') return {w: cols, h: rows, mmW: cols * ps[1], mmH: rows * ps[0], X: 'c', Y: 'r', flip: false};
  if (p === 'sag') return {w: rows, h: n, mmW: rows * ps[0], mmH: n * gap, X: 'r', Y: 'k', flip: true};
  return {w: cols, h: n, mmW: cols * ps[1], mmH: n * gap, X: 'c', Y: 'k', flip: true};
}
const AXMAX = () => ({c: meta.cols - 1, r: meta.rows - 1, k: meta.n - 1});
function initThumbs() {
  for (const p of APLANES) {
    const cv = $('aTh_' + p), t = thumbGeom(p), s = Math.min(320 / t.mmW, 320 / t.mmH);
    cv.style.width = Math.round(t.mmW * s) + 'px'; cv.style.height = Math.round(t.mmH * s) + 'px';
    cv.width = Math.round(t.mmW * s); cv.height = Math.round(t.mmH * s);
    cv.onmousedown = e => voiDown(e, p);
    cv.onmousemove = e => { if (!voiDrag) cv.style.cursor = cursorFor(hitVoi(e, p)); };
  }
}
function refreshThumbImgs() {     // base images through the centre of the box being edited
  const v = atlas.voi[atlas.edit], [ww, wl] = $('wl').value.split(',').map(Number);
  const mid = {ax: Math.round((v.k0 + v.k1) / 2), sag: Math.round((v.c0 + v.c1) / 2), cor: Math.round((v.r0 + v.r1) / 2)};
  for (const p of APLANES) {
    const t = thumbGeom(p);
    const proxy = py.globals.get('plane_rgba')(p, mid[p], ww, wl, 'pri'); const buf = proxy.toJs(); proxy.destroy();
    const c = thumbImgs[p] || (thumbImgs[p] = document.createElement('canvas'));
    c.width = t.w; c.height = t.h;
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.length), t.w, t.h), 0, 0);
  }
  drawThumbs();
}
function boxEdges(p, v) {          // box edges in native thumbnail coordinates
  const t = thumbGeom(p), n = meta.n;
  const x0 = v[t.X + '0'], x1 = v[t.X + '1'] + 1;
  const [y0, y1] = t.flip ? [n - (v.k1 + 1), n - v.k0] : [v[t.Y + '0'], v[t.Y + '1'] + 1];
  return {x0, x1, y0, y1};
}
// full extent of each selected structure projected onto each view (translucent fill)
function projections() {
  const sel = rois.filter(r => atlas.roiOn[r.number] && r.ks.length);
  const key = sel.map(r => r.number + ':' + r.color).join('|');
  if (projCache.key === key) return projCache.cv;
  const n = meta.n, out = {};
  for (const p of APLANES) {
    const t = thumbGeom(p), cv = document.createElement('canvas'); cv.width = t.w; cv.height = t.h;
    const ctx = cv.getContext('2d'), tmp = document.createElement('canvas'); tmp.width = t.w; tmp.height = t.h;
    const tc = tmp.getContext('2d');
    for (const r of sel) {
      tc.clearRect(0, 0, t.w, t.h); tc.fillStyle = `rgb(${r.color})`;
      for (const k of r.ks) for (const poly of r.slices[k]) {
        if (p === 'ax') {
          tc.beginPath(); tc.moveTo(poly[0] + .5, poly[1] + .5);
          for (let j = 2; j < poly.length; j += 2) tc.lineTo(poly[j] + .5, poly[j + 1] + .5);
          tc.closePath(); tc.fill();
        } else {
          let lo = Infinity, hi = -Infinity, o = p === 'sag' ? 1 : 0;   // sag: rows (y), cor: cols (x)
          for (let j = o; j < poly.length; j += 2) { lo = Math.min(lo, poly[j]); hi = Math.max(hi, poly[j]); }
          tc.fillRect(lo, (n - 1) - k, hi - lo + 1, 1);
        }
      }
      ctx.globalAlpha = 0.45; ctx.drawImage(tmp, 0, 0); ctx.globalAlpha = 1;
    }
    out[p] = cv;
  }
  projCache = {key, cv: out};
  return out;
}
function drawThumbs() {
  const proj = projections();
  for (const p of APLANES) {
    const cv = $('aTh_' + p); if (!cv || !thumbImgs[p]) continue;
    const t = thumbGeom(p), ctx = cv.getContext('2d'), kx = cv.width / t.w, ky = cv.height / t.h;
    ctx.drawImage(thumbImgs[p], 0, 0, cv.width, cv.height);
    if (proj[p]) ctx.drawImage(proj[p], 0, 0, cv.width, cv.height);
    const b = boxEdges(p, atlas.voi[atlas.edit]);
    const X0 = b.x0 * kx, X1 = b.x1 * kx, Y0 = b.y0 * ky, Y1 = b.y1 * ky;
    ctx.fillStyle = 'rgba(0,0,0,.55)';
    ctx.fillRect(0, 0, cv.width, Y0); ctx.fillRect(0, Y1, cv.width, cv.height - Y1);
    ctx.fillRect(0, Y0, X0, Y1 - Y0); ctx.fillRect(X1, Y0, cv.width - X1, Y1 - Y0);
    ctx.strokeStyle = '#0ff'; ctx.lineWidth = 2; ctx.strokeRect(X0, Y0, X1 - X0, Y1 - Y0);
    // where the pages of the edited plane cut this view
    const ep = atlas.edit;
    if (ep !== p) {
      ctx.strokeStyle = 'rgba(255,212,0,.35)'; ctx.lineWidth = 1;
      const idxs = sliceList(ep);
      for (const i of idxs) {
        ctx.beginPath();
        if (ep === 'ax') { const y = ((meta.n - 1 - i) + .5) * ky; ctx.moveTo(X0, y); ctx.lineTo(X1, y); }
        else if (ep === 'sag') { const x = (i + .5) * kx; if (p === 'ax' || p === 'cor') { ctx.moveTo(x, Y0); ctx.lineTo(x, Y1); } }
        else { if (p === 'ax') { const y = (i + .5) * ky; ctx.moveTo(X0, y); ctx.lineTo(X1, y); } else if (p === 'sag') { const x = (i + .5) * kx; ctx.moveTo(x, Y0); ctx.lineTo(x, Y1); } }
        ctx.stroke();
      }
    }
  }
}
function hitVoi(e, p) {
  const cv = $('aTh_' + p), r = cv.getBoundingClientRect(), t = thumbGeom(p);
  const mx = e.clientX - r.left, my = e.clientY - r.top, kx = r.width / t.w, ky = r.height / t.h;
  const b = boxEdges(p, atlas.voi[atlas.edit]), tol = 7;
  const X0 = b.x0 * kx, X1 = b.x1 * kx, Y0 = b.y0 * ky, Y1 = b.y1 * ky;
  const inY = my > Y0 - tol && my < Y1 + tol, inX = mx > X0 - tol && mx < X1 + tol;
  const h = {l: inY && Math.abs(mx - X0) < tol, r: inY && Math.abs(mx - X1) < tol, t: inX && Math.abs(my - Y0) < tol, b: inX && Math.abs(my - Y1) < tol};
  h.move = !h.l && !h.r && !h.t && !h.b && mx > X0 && mx < X1 && my > Y0 && my < Y1;
  return h;
}
function cursorFor(h) {
  if ((h.l && h.t) || (h.r && h.b)) return 'nwse-resize';
  if ((h.r && h.t) || (h.l && h.b)) return 'nesw-resize';
  if (h.l || h.r) return 'ew-resize';
  if (h.t || h.b) return 'ns-resize';
  return h.move ? 'move' : 'default';
}
function voiDown(e, p) {
  const h = hitVoi(e, p);
  if (!h.l && !h.r && !h.t && !h.b && !h.move) return;
  e.preventDefault();
  voiDrag = {p, h, x: e.clientX, y: e.clientY, start: {...atlas.voi[atlas.edit]}};
}
window.addEventListener('mousemove', e => {
  if (!voiDrag) return;
  const {p, h, start} = voiDrag, t = thumbGeom(p), cv = $('aTh_' + p), r = cv.getBoundingClientRect();
  const dX = Math.round((e.clientX - voiDrag.x) * t.w / r.width);
  let dY = Math.round((e.clientY - voiDrag.y) * t.h / r.height);
  if (t.flip) dY = -dY;                         // display y runs opposite to slice index
  const v = {...start}, mx = AXMAX();
  const clamp = (a, x) => Math.max(0, Math.min(mx[a], x));
  if (h.move) {
    for (const [a, d] of [[t.X, dX], [t.Y, dY]]) {
      const lo = start[a + '0'], hi = start[a + '1'];
      const dd = Math.max(-lo, Math.min(mx[a] - hi, d));
      v[a + '0'] = lo + dd; v[a + '1'] = hi + dd;
    }
  } else {
    if (h.l) v[t.X + '0'] = clamp(t.X, Math.min(start[t.X + '1'] - 4, start[t.X + '0'] + dX));
    if (h.r) v[t.X + '1'] = clamp(t.X, Math.max(start[t.X + '0'] + 4, start[t.X + '1'] + dX));
    // top edge of the display = low row (ax) or high slice (sag/cor)
    const top = t.flip ? '1' : '0', bot = t.flip ? '0' : '1';
    if (h.t) v[t.Y + top] = clamp(t.Y, t.flip ? Math.max(start.k0 + 4, start.k1 + dY) : Math.min(start[t.Y + '1'] - 4, start[t.Y + '0'] + dY));
    if (h.b) v[t.Y + bot] = clamp(t.Y, t.flip ? Math.min(start.k1 - 4, start.k0 + dY) : Math.max(start[t.Y + '0'] + 4, start[t.Y + '1'] + dY));
  }
  if (atlas.edit !== 'ax' && t.Y === 'k') fitAspect(atlas.edit, v, h.t ? 't' : h.b ? 'b' : 'keep');
  else if (atlas.edit !== 'ax') fitAspect(atlas.edit, v, 'keep');
  atlas.voi[atlas.edit] = v;
  atlasCounts();
});
window.addEventListener('mouseup', () => { if (voiDrag) { voiDrag = null; refreshThumbImgs(); } });

// ---------- page rendering ----------
const ROI_DRAWN = new Set();
function drawNoteOnCanvas(ctx, n, g, sx, sy, W, H) {
  const fs = (n.fs || g.cw / 60) * sx, k = fs / 12;
  const padX = (n.padX ? n.padX * sx : 6 * k), padY = (n.padY ? n.padY * sy : 3 * k), lh = fs * 1.35;
  ctx.font = `${fs}px system-ui, sans-serif`;
  const maxText = 248 * k;
  const lines = [];
  for (const para of (n.text || '').split('\n')) {
    let cur = '';
    for (const w of para.split(/(\s+)/)) {
      const t = cur + w;
      if (ctx.measureText(t.trimEnd()).width > maxText && cur.trim()) { lines.push(cur.trimEnd()); cur = w.trimStart(); }
      else cur = t;
    }
    lines.push(cur.trimEnd());
  }
  const tw = Math.max(24 * k, ...lines.map(l => ctx.measureText(l).width));
  const bw = tw + 2 * padX, bh = lines.length * lh + 2 * padY;
  let bx = (n.box.x - g.x0) * sx, by = (n.box.y - g.y0) * sy;
  bx = Math.max(0, Math.min(W - bw, bx)); by = Math.max(0, Math.min(H - bh, by));
  const ax = (n.anchor.x - g.x0) * sx, ay = (n.anchor.y - g.y0) * sy;
  const px = Math.max(bx, Math.min(bx + bw, ax)), py_ = Math.max(by, Math.min(by + bh, ay));
  ctx.strokeStyle = '#ffd400'; ctx.lineWidth = 1.5 * k;
  ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(px, py_); ctx.stroke();
  ctx.fillStyle = 'rgba(10,10,10,.82)'; ctx.fillRect(bx, by, bw, bh);
  ctx.strokeStyle = '#ffd400'; ctx.strokeRect(bx, by, bw, bh);
  ctx.fillStyle = '#fff'; ctx.textBaseline = 'top';
  lines.forEach((l, i) => ctx.fillText(l, bx + padX, by + padY + i * lh + (lh - fs) / 2));
  ctx.fillStyle = '#ffd400'; ctx.strokeStyle = '#000'; ctx.lineWidth = 1 * k;
  ctx.beginPath(); ctx.arc(ax, ay, 4 * k, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
}
function notesOn(s, p, idx) {
  if (!atlas.notesOn) return [];
  return notes.filter(n => n.scan === s.base && n.plane === p && n.idx === idx && (n.text || '').trim());
}
// returns {canvas, present: [rois on this slice]}
function renderAtlasImage(s, p, idx, W, H) {
  const v = atlas.voi[p], g = geomVoi(p, v);
  const which = s.kind === 'sec' ? s.key : 'pri';
  const proxy = py.globals.get('plane_rgba')(p, idx, s.ww, s.wl, which); const buf = proxy.toJs(); proxy.destroy();
  off.width = g.w; off.height = g.h;
  off.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.length), g.w, g.h), 0, 0);
  const cv = renderAtlasImage.cv || (renderAtlasImage.cv = document.createElement('canvas'));
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  ctx.drawImage(off, g.x0, g.y0, g.cw, g.ch, 0, 0, W, H);
  const sx = W / g.cw, sy = H / g.ch, X = x => (x - g.x0 + .5) * sx, Y = y => (y - g.y0 + .5) * sy;
  ctx.lineWidth = Math.max(1, lineWidth * W / 760); ctx.lineJoin = 'round';
  const present = [];
  const gIdx = {...g, idx};
  for (const r of rois) {
    if (!atlas.roiOn[r.number]) continue;
    ctx.strokeStyle = `rgb(${r.color})`;
    if (p === 'ax') {
      const cs = r.slices[idx]; if (!cs) continue;
      present.push(r);
      for (const c of cs) {
        ctx.beginPath(); ctx.moveTo(X(c[0]), Y(c[1]));
        for (let j = 2; j < c.length; j += 2) ctx.lineTo(X(c[j]), Y(c[j + 1]));
        ctx.closePath(); ctx.stroke();
      }
    } else {
      const o = reslicedOutline(r, p, idx, gIdx); if (!o) continue;
      present.push(r);
      ctx.beginPath();
      for (const poly of o.mp.coordinates) for (const ring of poly) {
        ring.forEach(([x, y], j) => { const cx = (x - g.x0) * sx, cy = (y + o.yoff - g.y0) * sy; j ? ctx.lineTo(cx, cy) : ctx.moveTo(cx, cy); });
        ctx.closePath();
      }
      ctx.stroke();
    }
  }
  for (const n of notesOn(s, p, idx)) drawNoteOnCanvas(ctx, n, g, sx, sy, W, H);
  // orientation labels
  const fs = Math.round(W / 70);
  ctx.font = `${fs}px system-ui, sans-serif`; ctx.fillStyle = '#ff0'; ctx.textBaseline = 'middle';
  const lab = p === 'ax' ? ['R', 'L', 'A', 'P'] : p === 'sag' ? ['A', 'P', 'S', 'I'] : ['R', 'L', 'S', 'I'];
  ctx.textAlign = 'left'; ctx.fillText(lab[0], fs * .5, H / 2);
  ctx.textAlign = 'right'; ctx.fillText(lab[1], W - fs * .5, H / 2);
  ctx.textAlign = 'center'; ctx.fillText(lab[2], W / 2, fs); ctx.fillText(lab[3], W / 2, H - fs);
  ctx.textAlign = 'left';
  return {cv, present};
}
const canvasJpeg = cv => new Promise(res => cv.toBlob(b => b.arrayBuffer().then(a => res(new Uint8Array(a))), 'image/jpeg', 0.9));
function slicePosLabel(p, idx) {
  const A = meta.A;
  if (!A) return '';
  if (p === 'ax') return `z ${(A[2][3] + idx * A[2][2]).toFixed(1)} mm`;
  if (p === 'sag') return `x ${(A[0][3] + idx * A[0][0]).toFixed(1)} mm`;
  return `y ${(A[1][3] + idx * A[1][1]).toFixed(1)} mm`;
}

// ---------- PDF ----------
async function buildAtlas() {
  const A = atlas;
  const sections = atlasPlan();
  if (!sections.length) { $('aProgTxt').textContent = 'Nothing selected.'; return; }
  const {jsPDF} = window.jspdf;
  const doc = new jsPDF({unit: 'mm', format: 'a4', orientation: 'landscape', compress: true});
  const title = A.title.trim() || 'Contouring atlas';
  const incRois = rois.filter(r => A.roiOn[r.number]);
  const legendRois = incRois.filter(r => !A.legend.onlyDescribed || (A.legend.desc[r.number] || '').trim());
  const BG = [17, 17, 17], FG = [230, 230, 230], DIM = [150, 150, 150], ACC = [255, 212, 0];

  // ---- layout of legend pages (pre-measured so page numbers are known up front) ----
  const legendPages = [];
  if (A.legend.on && legendRois.length) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
    let page = [], y = 30;
    for (const r of legendRois) {
      const lines = doc.splitTextToSize((A.legend.desc[r.number] || '').trim() || '-', 195);
      const h = Math.max(1, lines.length) * 4.6 + 4;
      if (y + h > 198) { legendPages.push(page); page = []; y = 30; }
      page.push({r, lines, y}); y += h;
    }
    legendPages.push(page);
  }
  // ---- page numbering ----
  let pg = 2;
  const legendFirst = legendPages.length ? pg : null; pg += legendPages.length;
  const pageOf = {};
  for (const sec of sections) {
    sec.first = pg;
    for (const i of sec.idxs) pageOf[`${sec.s.key}|${sec.p}|${i}`] = pg++;
    sec.last = pg - 1;
  }
  const total = pg - 1;
  const notePages = [];
  for (const sec of sections) for (const i of sec.idxs) if (notesOn(sec.s, sec.p, i).length) notePages.push(pageOf[`${sec.s.key}|${sec.p}|${i}`]);
  notePages.sort((a, b) => a - b);
  const secOf = (key, p) => sections.find(x => x.s.key === key && x.p === p);

  const bg = (w, h) => { doc.setFillColor(...BG); doc.rect(0, 0, w, h, 'F'); };
  // button: returns its width; link if a target page is given and it's not the current one
  const btn = (x, y, label, target, active, alignRight) => {
    doc.setFontSize(8); doc.setFont('helvetica', active ? 'bold' : 'normal');
    const w = doc.getTextWidth(label) + 5, h = 5.6, bx = alignRight ? x - w : x;
    const enabled = target != null;
    doc.setFillColor(...(active ? ACC : enabled ? [55, 55, 55] : [32, 32, 32]));
    doc.roundedRect(bx, y, w, h, 1.2, 1.2, 'F');
    doc.setTextColor(...(active ? [0, 0, 0] : enabled ? FG : [90, 90, 90]));
    doc.text(label, bx + 2.5, y + 3.9);
    if (enabled && !active) doc.link(bx, y, w, h, {pageNumber: target});
    return w;
  };

  // ---- title page (landscape; contents flow into a second column) ----
  {
    const W = PG.W, H = PG.H; bg(W, H);
    doc.setTextColor(...FG); doc.setFont('helvetica', 'bold'); doc.setFontSize(26);
    const tl = doc.splitTextToSize(title, 250);
    doc.text(tl, 20, 30);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(12); doc.setTextColor(...DIM);
    let y = 30 + tl.length * 11;
    const meta_ = [A.creator.trim() ? 'Created by ' + A.creator.trim() : null,
                   new Date().toLocaleDateString(undefined, {year: 'numeric', month: 'long', day: 'numeric'})].filter(Boolean);
    doc.text(meta_.join('   |   '), 20, y); y += 12;
    doc.setTextColor(...FG); doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.text('Contents', 20, y); y += 8;
    doc.setFontSize(10.5); doc.setFont('helvetica', 'normal');
    const top = y, bottom = H - 26, colW = 120, cols = [20, 20 + colW + 15];
    let col = 0;
    const need = h => { if (y + h > bottom && col === 0) { col = 1; y = top; } };
    const row = (label, page, indent) => {
      need(6.2); const x = cols[col];
      doc.setTextColor(...FG); doc.text(label, x + (indent || 0), y);
      doc.setTextColor(...ACC); doc.text('p. ' + page, x + colW, y, {align: 'right'});
      doc.link(x, y - 4, colW, 5.5, {pageNumber: page}); y += 6.2;
    };
    if (legendFirst) row('Legend', legendFirst);
    let lastScan = null;
    for (const sec of sections) {
      if (sec.s.key !== lastScan) {
        need(14); y += 2; doc.setFont('helvetica', 'bold'); doc.setTextColor(...FG); doc.text(atlasName(sec.s), cols[col], y); y += 6; doc.setFont('helvetica', 'normal');
        lastScan = sec.s.key;
      }
      row(`${PNAME[sec.p]} (${sec.idxs.length} pages, every ${spacingMm(sec.p).toFixed(1)} mm${noteSlices(sec.p).length ? ' + annotated slices' : ''})`, sec.first, 6);
    }
    doc.setFontSize(9); doc.setTextColor(...DIM);
    const nNotes = notePages.length;
    doc.text(`${incRois.length} structures, ${nNotes} annotated slice${nNotes === 1 ? '' : 's'}, ${total} pages.  Navigation: each page links to the same slice on the other scans, the other planes,`, 20, H - 16);
    doc.text('the previous/next slice and, where present, the previous/next annotated slice.', 20, H - 11.5);
  }
  // ---- legend pages ----
  legendPages.forEach((items, li) => {
    doc.addPage('a4', 'landscape'); bg(PG.W, PG.H);
    doc.setTextColor(...FG); doc.setFont('helvetica', 'bold'); doc.setFontSize(16);
    doc.text('Legend' + (legendPages.length > 1 ? ` (${li + 1}/${legendPages.length})` : ''), 20, 20);
    btn(PG.W - 20, 12, 'Contents', 1, false, true);
    for (const it of items) {
      doc.setFillColor(...it.r.color); doc.rect(20, it.y - 3.2, 4, 4, 'F');
      doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...FG);
      doc.text(doc.splitTextToSize(it.r.name, 50), 27, it.y);
      doc.setFont('helvetica', 'normal'); doc.setTextColor(200, 200, 200);
      doc.text(it.lines, 82, it.y);
    }
  });

  // ---- image pages ----
  $('aProg').style.display = ''; $('aProg').max = total; $('aBuild').disabled = true;
  const t0 = performance.now();
  try {
    for (const sec of sections) {
      const {s, p, idxs} = sec, g = geomVoi(p, A.voi[p]);
      // A4 landscape throughout
      const {W: PW, H: PH, M, HEAD, FOOT} = PG, land = true;
      const sc = Math.min((PW - 2 * M) / g.mmW, (PH - HEAD - FOOT) / g.mmH);
      const iw = g.mmW * sc, ih = g.mmH * sc, ix = (PW - iw) / 2, iy = HEAD + (PH - HEAD - FOOT - ih) / 2;
      const Wpx = A.quality, Hpx = Math.max(1, Math.round(A.quality * g.mmH / g.mmW));
      const others = sections.filter(x => x.p === p && x.s.key !== s.key);
      for (let j = 0; j < idxs.length; j++) {
        const idx = idxs[j], here = pageOf[`${s.key}|${p}|${idx}`];
        doc.addPage('a4', land ? 'landscape' : 'portrait'); bg(PW, PH);
        const {cv, present} = renderAtlasImage(s, p, idx, Wpx, Hpx);
        doc.addImage(await canvasJpeg(cv), 'JPEG', ix, iy, iw, ih, 'im' + here, 'NONE');
        // header line 1
        doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...FG);
        doc.text(doc.splitTextToSize(title, PW * 0.45)[0], M, 6.5);
        doc.setFont('helvetica', 'normal'); doc.setTextColor(...ACC);
        doc.text(`${atlasName(s)}  |  ${PNAME[p]} ${j + 1}/${idxs.length}  |  ${slicePosLabel(p, idx)}`, PW - M, 6.5, {align: 'right'});
        // header line 2: same slice on other scans | other planes of this scan
        let x = M;
        for (const t of [sec, ...others].sort((a, b) => A.scans.indexOf(a.s) - A.scans.indexOf(b.s)))
          x += btn(x, 9, atlasName(t.s), pageOf[`${t.s.key}|${p}|${idx}`], t.s.key === s.key) + 1.5;
        let xr = PW - M;
        for (const q of [...APLANES].reverse()) {
          const os = secOf(s.key, q); if (!os) continue;
          const target = q === p ? here : os.first + Math.floor((os.last - os.first) / 2);
          xr -= btn(xr, 9, PNAME[q], target, q === p, true) + 1.5;
        }
        // footer: structure key, then navigation
        const fy = PH - FOOT + 2;
        doc.setFontSize(7.5); doc.setFont('helvetica', 'normal');
        let kx = M;
        for (const r of present) {
          const w = doc.getTextWidth(r.name) + 6;
          if (kx + w > PW - M) { doc.setTextColor(...DIM); doc.text('...', kx, fy + 2.8); break; }
          doc.setFillColor(...r.color); doc.rect(kx, fy, 3, 3, 'F');
          doc.setTextColor(...FG); doc.text(r.name, kx + 4, fy + 2.6); kx += w + 2;
        }
        const ny = PH - 7.5;
        let bx = M;
        bx += btn(bx, ny, 'Contents', 1, false) + 1.5;
        if (legendFirst) bx += btn(bx, ny, 'Legend', legendFirst, false) + 1.5;
        bx += 3;
        bx += btn(bx, ny, '< Prev slice', j > 0 ? here - 1 : null, false) + 1.5;
        bx += btn(bx, ny, 'Next slice >', j < idxs.length - 1 ? here + 1 : null, false) + 1.5;
        if (notePages.length) {
          bx += 3;
          const prev = [...notePages].reverse().find(q => q < here), next = notePages.find(q => q > here);
          bx += btn(bx, ny, '< Prev note', prev ?? null, false) + 1.5;
          bx += btn(bx, ny, 'Next note >', next ?? null, false) + 1.5;
        }
        doc.setFontSize(8); doc.setTextColor(...DIM); doc.text(`p. ${here} / ${total}`, PW - M, ny + 3.9, {align: 'right'});
        $('aProg').value = here;
        if (here % 5 === 0) {
          const el = (performance.now() - t0) / 1000, rate = (here - 1) / el;
          $('aProgTxt').textContent = `page ${here} / ${total}, ~${Math.max(0, Math.round((total - here) / rate))} s left`;
          await new Promise(r => setTimeout(r));
        }
      }
    }
    $('aProgTxt').textContent = 'Writing PDF…';
    await new Promise(r => setTimeout(r));
    const fname = (title.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'atlas') + '.pdf';
    doc.save(fname);
    $('aProgTxt').textContent = `Done: ${total} pages in ${((performance.now() - t0) / 1000).toFixed(0)} s, saved as ${fname}`;
    log(`Atlas built: ${total} pages, ${notePages.length} annotated, ${fname}`);
  } catch (e) {
    $('aProgTxt').textContent = 'ERROR: ' + e; log('ERROR building atlas: ' + e); console.error(e);
  } finally { $('aBuild').disabled = false; }
}
