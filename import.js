// ===================== Import + sort a whole patient folder =====================
// 1) read only the header of every file (first 64 KB; full file for RTSTRUCT/REG), 2) group into
// image series / structure sets / registrations, 3) let the user pick primary, extra scans and the
// structure set, 4) load through the normal primary/secondary path (all REGs are added so chains resolve).
let patScan = null;

$('patBtn').onclick = () => $('patDir').click();
$('patDir').onchange = async e => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  let dlg = $('patDlg');
  if (!dlg) { dlg = document.createElement('div'); dlg.id = 'patDlg'; document.body.appendChild(dlg); }
  dlg.style.display = 'block';
  dlg.innerHTML = `<div class="panel"><h3 style="margin-top:0">Reading patient folder…</h3>
    <progress id="pProg" max="${files.length}" value="0" style="width:400px"></progress> <span id="pProgTxt"></span></div>`;
  try { patScan = await scanFolder(files); patRender(); }
  catch (err) { dlg.querySelector('.panel').innerHTML += `<p style="color:#f88">ERROR: ${esc(err)}</p><button onclick="$('patDlg').style.display='none'">Close</button>`; }
};

async function scanFolder(files) {
  const hdr = py.globals.get('header');
  py.FS.mkdirTree('/data');
  const series = {}, structs = [], regs = [], other = {};
  let skipped = 0;
  const t0 = performance.now();
  for (let i = 0; i < files.length; i++) {
    const f = files[i], p = `/data/h_${i}`;
    const trunc = f.size > 65536;
    py.FS.writeFile(p, new Uint8Array(await f.slice(0, 65536).arrayBuffer()));
    let h = JSON.parse(hdr(p, trunc));
    if (!h.ok && h.need_full) {
      py.FS.writeFile(p, new Uint8Array(await f.arrayBuffer()));
      h = JSON.parse(hdr(p, false));
    }
    if (!h.ok) { skipped++; }
    else if (h.mod === 'RTSTRUCT') structs.push({...h, file: f});
    else if (h.mod === 'REG') regs.push({...h, file: f});
    else if (['RTPLAN', 'RTDOSE', 'RTRECORD', 'SR', 'PR', 'KO', 'RTIMAGE'].includes(h.mod) || !h.plane) other[h.mod || '?'] = (other[h.mod || '?'] || 0) + 1;
    else {
      const s = series[h.series] || (series[h.series] = {...h, files: [], key: h.series});
      s.files.push(f);
    }
    if (i % 40 === 39) {
      $('pProg').value = i + 1;
      $('pProgTxt').textContent = `${i + 1} / ${files.length} files (${((performance.now() - t0) / 1000).toFixed(0)} s)`;
      await new Promise(r => setTimeout(r));
    }
  }
  const list = Object.values(series).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  // defaults: primary = CT referenced by the newest structure set, else the largest CT, else largest series
  structs.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  let pri = null;
  for (const st of structs) { pri = list.find(s => st.refSeries.includes(s.series) && s.mod === 'CT'); if (pri) break; }
  if (!pri) pri = [...list].filter(s => s.mod === 'CT').sort((a, b) => b.files.length - a.files.length)[0];
  if (!pri) pri = [...list].sort((a, b) => b.files.length - a.files.length)[0];
  const sel = {pri: pri && pri.key, extra: new Set(), rs: null};
  // extras: everything else that looks like a real volume (not scouts), MR first, newest first, max 4
  const cand = list.filter(s => s.key !== sel.pri && s.files.length >= 10)
    .sort((a, b) => (a.mod === 'MR' ? 0 : 1) - (b.mod === 'MR' ? 0 : 1) || (b.date + b.time).localeCompare(a.date + a.time));
  cand.slice(0, 4).forEach(s => sel.extra.add(s.key));
  const out = {list, structs, regs, other, skipped, nFiles: files.length, sel};
  patDefaultRs(out);
  return out;
}
function patDefaultRs(ps) {
  const pri = ps.list.find(s => s.key === ps.sel.pri);
  const ok = ps.structs.filter(st => pri && (st.refSeries.includes(pri.series) || st.refFoR.includes(pri.FoR)));
  ps.sel.rs = ok.length ? ps.structs.indexOf(ok[0]) : null;
}
// how a series links to the primary: same frame of reference, via REG file(s), or not at all
function patLink(ps, s) {
  const pri = ps.list.find(x => x.key === ps.sel.pri);
  if (!pri || s.key === pri.key) return {cls: 'ok', txt: ''};
  if (s.FoR && s.FoR === pri.FoR) return {cls: 'ok', txt: 'same frame of reference'};
  // BFS over frames of reference: each REG connects all the FoRs it lists
  const seen = new Set([pri.FoR]), q = [pri.FoR];
  while (q.length) {
    const f = q.shift();
    for (const r of ps.regs) if (r.fors.includes(f)) for (const g of r.fors) if (!seen.has(g)) { seen.add(g); q.push(g); }
  }
  if (seen.has(s.FoR)) {
    const direct = ps.regs.some(r => r.fors.includes(pri.FoR) && r.fors.includes(s.FoR));
    const def = ps.regs.some(r => r.deformable && r.fors.includes(s.FoR));
    return {cls: def ? 'mid' : 'ok', txt: (direct ? 'registered (REG)' : 'registered via another scan') + (def ? ', deformable: rigid part only' : '')};
  }
  return {cls: 'bad', txt: 'no registration found'};
}
const fmtDate = d => d && d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : (d || '');

function patRender() {
  const ps = patScan, dlg = $('patDlg'), showDates = !$('anonChk').checked;
  const otherTxt = Object.entries(ps.other).map(([k, v]) => `${v} ${k}`).join(', ');
  dlg.innerHTML = `<div class="panel">
  <h3 style="margin-top:0">Patient folder</h3>
  ${ps.nFiles} files: ${ps.list.length} image series, ${ps.structs.length} structure set${ps.structs.length === 1 ? '' : 's'}, ${ps.regs.length} registration${ps.regs.length === 1 ? '' : 's'}${otherTxt ? `, ${otherTxt} (not used yet)` : ''}${ps.skipped ? `, ${ps.skipped} non-DICOM/unreadable skipped` : ''}.
  ${$('anonChk').checked ? '<br><span class="ok">Anonymise on import is on</span>: dates and patient details are hidden here and removed as files are loaded.' : ''}
  <h4>Image series</h4>
  <table><tr><th>Primary</th><th>Extra scan</th><th>Modality</th><th>Description</th>${showDates ? '<th>Date</th>' : ''}<th>Images</th><th>Plane</th><th>Pixel / slice</th><th>Link to primary</th></tr>
  ${ps.list.map((s, i) => {
    const l = patLink(ps, s), isPri = s.key === ps.sel.pri;
    return `<tr class="${s.files.length < 10 ? 'dim' : ''}">
      <td><input type="radio" name="pPri" data-i="${i}" ${isPri ? 'checked' : ''}></td>
      <td><input type="checkbox" class="pEx" data-i="${i}" ${ps.sel.extra.has(s.key) && !isPri ? 'checked' : ''} ${isPri ? 'disabled' : ''}></td>
      <td>${esc(s.mod)}</td><td>${esc(s.desc || '(no description)')}</td>${showDates ? `<td>${fmtDate(s.date)}</td>` : ''}
      <td>${s.files.length}</td><td>${esc(s.plane)}</td><td>${s.ps ? s.ps.toFixed(2) : '?'} / ${s.thk ? s.thk.toFixed(1) : '?'} mm</td>
      <td class="${l.cls}">${isPri ? '<b>primary</b>' : l.txt}</td></tr>`;
  }).join('')}</table>
  <small>Up to 4 extra scans. Series with fewer than 10 images (scouts, localisers) are greyed out.</small>
  <h4>Structure set</h4>
  <select id="pRs"><option value="">None</option>${ps.structs.map((st, i) => {
    const pri = ps.list.find(s => s.key === ps.sel.pri), fits = pri && (st.refSeries.includes(pri.series) || st.refFoR.includes(pri.FoR));
    return `<option value="${i}" ${ps.sel.rs === i ? 'selected' : ''}>${esc(st.label || '(no label)')}: ${st.nROI} structures${showDates && st.date ? ', ' + fmtDate(st.date) : ''}${fits ? '' : ' (not drawn on this primary)'}</option>`;
  }).join('')}</select>
  <h4>Registrations</h4>
  ${ps.regs.length ? `All ${ps.regs.length} REG file${ps.regs.length > 1 ? 's are' : ' is'} loaded; scans registered to each other are chained back to the primary automatically.` : 'None found: only scans sharing the primary\'s frame of reference will line up.'}
  <div style="margin-top:14px;border-top:1px solid #333;padding-top:10px">
    <button id="pLoad" style="font-weight:bold">Load selected</button> <button id="pClose">Cancel</button> <span id="pMsg"></span>
  </div></div>`;
  dlg.querySelectorAll('input[name=pPri]').forEach(r => r.onchange = e => {
    const s = ps.list[+e.target.dataset.i]; ps.sel.pri = s.key; ps.sel.extra.delete(s.key); patDefaultRs(ps); patRender();
  });
  dlg.querySelectorAll('.pEx').forEach(c => c.onchange = e => {
    const s = ps.list[+e.target.dataset.i];
    if (e.target.checked) {
      if (ps.sel.extra.size >= 4) { e.target.checked = false; $('pMsg').textContent = 'Maximum 4 extra scans.'; return; }
      ps.sel.extra.add(s.key);
    } else ps.sel.extra.delete(s.key);
  });
  $('pRs').onchange = e => ps.sel.rs = e.target.value === '' ? null : +e.target.value;
  $('pClose').onclick = () => dlg.style.display = 'none';
  $('pLoad').onclick = patLoad;
}

async function patLoad() {
  const ps = patScan, dlg = $('patDlg');
  const pri = ps.list.find(s => s.key === ps.sel.pri);
  if (!pri) { $('pMsg').textContent = 'Choose a primary.'; return; }
  const extras = ps.list.filter(s => ps.sel.extra.has(s.key) && s.key !== pri.key);
  dlg.style.display = 'none';
  const rs = ps.sel.rs != null ? ps.structs[ps.sel.rs].file : null;
  if (!(await loadPrimaryFrom(pri.files, rs))) return;
  $('name_pri').value = priName = pri.desc ? `${pri.mod} ${pri.desc}`.slice(0, 40) : pri.mod;
  // every REG goes in, so chains through other scans resolve
  for (let i = 0; i < ps.regs.length; i++) {
    const p = await writeOne(ps.regs[i].file, 'xreg');
    py.globals.get('add_reg')('x' + (i + 1), p);
  }
  if (ps.regs.length) log(`Added ${ps.regs.length} registration file(s) from the folder.`);
  for (let i = 0; i < extras.length; i++) await loadSecondaryFrom(SLOT_IDS[i], extras[i].files, null);
  current = 'pri'; buildImgSel(); draw(); renderNotesPanel();
  log(`Patient folder loaded: primary + ${extras.length} extra scan(s).`);
}
