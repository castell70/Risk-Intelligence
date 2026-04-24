import * as XLSX from 'xlsx';
import Chart from 'chart.js/auto';

let data = [];
let processed = [];
let chartInstance = null;
let radarInstance = null;
let indicatorKeys = []; // dynamic list of indicator columns to show in the students table
let detectedKeys = { name: null, faculty: null, career: null }; // robust detected header keys

const fileInput = document.getElementById('fileInput');
const selectedFileName = document.getElementById('selectedFileName');
const uploadBtn = document.getElementById('upload');
const summaryEl = document.getElementById('summary');
const chartCanvas = document.getElementById('chart');
const radarCanvas = document.getElementById('radarChart');

// Show selected file name under the selector
if (fileInput && selectedFileName) {
  fileInput.addEventListener('change', () => {
    const f = fileInput.files && fileInput.files[0];
    if (f) {
      selectedFileName.textContent = f.name;
    } else {
      selectedFileName.textContent = '';
    }
  });
}

const facultyFilter = document.getElementById('facultyFilter');
const careerFilter  = document.getElementById('careerFilter');
const riskFilter    = document.getElementById('riskFilter');
const studentSearch = document.getElementById('studentSearch');
const studentsList  = document.getElementById('studentsList');

function getField(obj, keys){
  for(const k of keys){ if(obj[k] !== undefined) return obj[k]; }
  return '';
}

uploadBtn.addEventListener('click', () => {
  const file = fileInput.files[0];
  const uploadMessageEl = document.getElementById('uploadMessage');
  // clear previous message
  if (uploadMessageEl) {
    uploadMessageEl.style.display = 'none';
    uploadMessageEl.textContent = '';
  }

  if(!file){
    // show inline message instructing user to select a file and focus the file input
    if (uploadMessageEl) {
      uploadMessageEl.textContent = 'Por favor seleccione un archivo .xlsx antes de cargar los datos.';
      uploadMessageEl.style.display = 'block';
      // focus the file input to guide the user
      fileInput && fileInput.focus();
      // hide message after 4 seconds
      setTimeout(() => {
        if (uploadMessageEl) uploadMessageEl.style.display = 'none';
      }, 4000);
    } else {
      // fallback to alert if message element is missing
      alert('Seleccione un archivo');
    }
    return;
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    try{
      const arr = new Uint8Array(e.target.result);
      const wb = XLSX.read(arr, {type:'array'});
      const sheet = wb.Sheets[wb.SheetNames[0]];
      data = XLSX.utils.sheet_to_json(sheet);
      if(!data || data.length === 0){
        const uploadMessageEl2 = document.getElementById('uploadMessage');
        if (uploadMessageEl2) {
          uploadMessageEl2.textContent = 'El archivo está vacío o mal estructurado.';
          uploadMessageEl2.style.display = 'block';
          setTimeout(() => { uploadMessageEl2.style.display = 'none'; }, 4000);
        } else {
          alert('El archivo está vacío o mal estructurado');
        }
        return;
      }

      processData();
      drawChart();
      renderStudents();

      // After successful load, switch UI to Dashboard
      const items = document.querySelectorAll('.sidebar .menu-item');
      const dashboardItem = Array.from(items).find(i => i.getAttribute('data-section') === 'dashboard');
      if (dashboardItem) {
        items.forEach(i => i.classList.remove('active'));
        dashboardItem.classList.add('active');
        // reuse existing updatePanels function defined in index.html script scope
        if (typeof updatePanels === 'function') {
          updatePanels(dashboardItem);
        } else {
          // fallback: manually show/hide sections
          const toolsPanel = document.getElementById('herramientasPanel');
          const dashboardSection = document.getElementById('dashboardSection');
          const estudiantesSection = document.getElementById('estudiantesSection');
          if (toolsPanel) toolsPanel.classList.add('hidden');
          if (dashboardSection) dashboardSection.classList.remove('hidden');
          if (estudiantesSection) estudiantesSection.classList.add('hidden');
        }
      }
    }catch(err){
      console.error(err);
      const uploadMessageEl2 = document.getElementById('uploadMessage');
      if (uploadMessageEl2) {
        uploadMessageEl2.textContent = 'Error al procesar el archivo.';
        uploadMessageEl2.style.display = 'block';
        setTimeout(() => { uploadMessageEl2.style.display = 'none'; }, 4000);
      } else {
        alert('Error al procesar el archivo');
      }
    }
  };
  reader.readAsArrayBuffer(file);
});

function zScore(arr, value){
  const mean = arr.reduce((a,b)=>a+b,0)/arr.length;
  const sd = Math.sqrt(arr.map(x=>Math.pow(x-mean,2)).reduce((a,b)=>a+b)/arr.length);
  return sd===0?0:(value-mean)/sd;
}

function detectKeysFromHeaderRow(row) {
  // row: object with column headers as keys
  const keys = Object.keys(row || {});
  const lower = k => (k || '').toString().toLowerCase();
  let nameKey = null, facultyKey = null, careerKey = null;
  for (const k of keys) {
    const kl = lower(k);
    if (!nameKey && (kl === 'nombre' || kl.startsWith('nombre') || kl.includes('nombre_') || kl.includes('name'))) {
      nameKey = k;
    }
    if (!facultyKey && (kl === 'facultad' || kl.startsWith('facultad') || kl.includes('facultad '))) {
      facultyKey = k;
    }
    if (!careerKey && (kl === 'carrera' || kl.startsWith('carrera') || kl.includes('carrera '))) {
      careerKey = k;
    }
    // stop early if all found
    if (nameKey && facultyKey && careerKey) break;
  }
  // fallback to common alternatives if not found
  if (!nameKey) {
    const alt = keys.find(k => /name|full\s*name|nombre_completo/i.test(k));
    if (alt) nameKey = alt;
  }
  if (!facultyKey) {
    const alt = keys.find(k => /faculty|facultad/i.test(k));
    if (alt) facultyKey = alt;
  }
  if (!careerKey) {
    const alt = keys.find(k => /career|carrera|programa/i.test(k));
    if (alt) careerKey = alt;
  }
  return { nameKey, facultyKey, careerKey };
}

function processData(){
  // Detect indicator keys from the first row of the sheet (exclude name/faculty/career meta)
  if(data && data.length){
    // detect header key names robustly from first row
    const first = data[0];
    const detected = detectKeysFromHeaderRow(first);
    detectedKeys.name = detected.nameKey;
    detectedKeys.faculty = detected.facultyKey;
    detectedKeys.career = detected.careerKey;

    const skipCandidates = new Set([
      detectedKeys.name, detectedKeys.faculty, detectedKeys.career,
      'Nombre','Nombre_Completo','nombre','Facultad','facultad','Carrera','carrera'
    ].filter(Boolean));

    indicatorKeys = Object.keys(first).filter(k => !skipCandidates.has(k));
  } else {
    indicatorKeys = [];
  }

  // Collect numeric arrays for z-scoring and normalization for known fields
  const acadArr = data.map(r=>Number(getField(r,['Promedio','promedio','PROMEDIO']))||0);
  const asistenciaArr = data.map(r=>Number(getField(r,['Asistencia','asistencia','ASISTENCIA','Porcentaje_Asistencia']))||0);
  const aprobadasArr = data.map(r=>Number(getField(r,['Aprobadas','aprobadas','Asignaturas_Aprobadas','asignaturas_aprobadas']))||0);

  // Helper to normalize an array to 0-1 (min-max), fallback to 0 when constant
  const normalize = (arr, val) => {
    const nums = arr.map(n=>Number(n)||0);
    const min = Math.min(...nums);
    const max = Math.max(...nums);
    if(max === min) return 0;
    return ((Number(val)||0) - min) / (max - min);
  };

  // detect possible RiesgoT key in sheet (case-insensitive)
  const sampleKeys = data.length ? Object.keys(data[0]) : [];
  // prefer Sem_Z-like column for textual risk counts (fallbacks tolerate variations)
  const semZKey = sampleKeys.find(k => (k || '').toString().toLowerCase() === 'sem_z') 
    || sampleKeys.find(k => (k || '').toString().toLowerCase() === 'semz') 
    || sampleKeys.find(k => (k || '').toString().toLowerCase() === 'sem z');

  processed = data.map((r, idx)=>{
    const nombre = detectedKeys.name ? (r[detectedKeys.name] ?? '') : getField(r,['Nombre_Completo','Nombre','nombre']) || '';
    const facultad = detectedKeys.faculty ? (r[detectedKeys.faculty] ?? '') : getField(r,['Facultad','facultad']) || '';
    const carrera = detectedKeys.career ? (r[detectedKeys.career] ?? '') : getField(r,['Carrera','carrera']) || '';
    const prom = Number(getField(r,['Promedio','promedio','PROMEDIO']))||0;

    const asistencia = Number(getField(r,['Asistencia','asistencia','ASISTENCIA','Porcentaje_Asistencia'])) || 0;
    const aprobadas = Number(getField(r,['Aprobadas','aprobadas','Asignaturas_Aprobadas','asignaturas_aprobadas'])) || 0;

    const zAcad = zScore(acadArr, prom);
    const nAsis = normalize(asistenciaArr, asistencia); // 0..1
    const nAprob = normalize(aprobadasArr, aprobadas); // 0..1

    const wAcad = 0.40;
    const wAsis = 0.30;
    const wAprob = 0.30;

    const scoreAcad = -zAcad;
    const scoreAsis = 1 - nAsis;
    const scoreAprob = 1 - nAprob;

    const IRD = wAcad * (scoreAcad / 3) + wAsis * scoreAsis + wAprob * scoreAprob;

    // Determine riesgo primarily from textual RiesgoT column when available (counts based on that)
    let riesgo = 'MEDIO';
    let semZRaw = null;
    if (semZKey) {
      semZRaw = r[semZKey];
      const txt = (String(semZRaw || '')).toLowerCase().trim();
      if (txt.includes('alto')) riesgo = 'ALTO';
      else if (txt.includes('bajo')) riesgo = 'BAJO';
      else if (txt.includes('medio')) riesgo = 'MEDIO';
      else {
        // if Sem_Z present but unrecognized, fallback to IRD
        if(IRD >= 0.55) riesgo = 'ALTO';
        else if(IRD <= 0.25) riesgo = 'BAJO';
        else riesgo = 'MEDIO';
      }
    } else {
      // no Sem_Z column: use IRD
      if(IRD >= 0.55) riesgo = 'ALTO';
      else if(IRD <= 0.25) riesgo = 'BAJO';
      else riesgo = 'MEDIO';
    }

    // capture raw indicator values for dynamic display (preserve original column names)
    const indicators = {};
    indicatorKeys.forEach(k => {
      indicators[k] = r[k];
    });

    return {
      _idx: idx,
      nombre,
      facultad,
      carrera,
      prom,
      asistencia,
      aprobadas,
      IRD,
      riesgo,                  // final normalized risk used by app (ALTO/MEDIO/BAJO)
      sem_z: semZRaw,          // raw Sem_Z textual value (if present)
      indicators
    };
  });
}

/* Modal: show detailed student info */
function safeText(v){ return (v === null || v === undefined) ? '' : String(v); }

function showStudentDetails(globalIndex){
  const modal = document.getElementById('studentDetailModal');
  if(!modal) return;
  const s = processed.find(p => p._idx === globalIndex);
  if(!s) return;
  // fill fields (attempt to read common property keys from indicators if present)
  document.getElementById('mdNombre').textContent = safeText(s.nombre);
  // common alternatives for carnet/email/direccion/telefono may be in indicators; attempt to find them
  const ind = s.indicators || {};
  const carnet = s.carnet || ind['Carnet'] || ind['carnet'] || ind['ID'] || ind['id'] || '';
  const email = ind['Email'] || ind['email'] || ind['Correo'] || ind['correo'] || ind['Email_ins'] || ind['email_ins'] || ind['email_inscripcion'] || '';
  const direccion = ind['Direccion'] || ind['direccion'] || ind['Domicilio'] || '';
  const telefono = ind['tel_cel'] || ind['Tel_Cel'] || ind['TEL_CEL'] || ind['Telefono'] || ind['telefono'] || ind['Tel'] || ind['tel'] || '';
  const inscritas = ind['Inscritas'] || ind['Asignaturas_Inscritas'] || ind['inscritas'] || ind['Asignaturas'] || '';
  const retiradas = ind['Retiradas'] || ind['Asignaturas_Retiradas'] || ind['retiradas'] || '';

  document.getElementById('mdCarnet').textContent = safeText(carnet);
  document.getElementById('mdEmail').textContent = safeText(email);
  document.getElementById('mdDireccion').textContent = safeText(direccion);
  document.getElementById('mdTelefono').textContent = safeText(telefono);

  document.getElementById('mdFacultad').textContent = safeText(s.facultad);
  document.getElementById('mdCarrera').textContent = safeText(s.carrera);
  document.getElementById('mdRiesgo').textContent = safeText(s.riesgo);

  // Prefer PromPer1/Promedio fields from indicators or the computed prom
  const promPer = ind['PromPer1'] ?? ind['Promedio'] ?? ind['promedio'] ?? s.prom ?? '';
  const asisPer = ind['PromAsisPer1'] ?? ind['PromAsis'] ?? ind['PromAsisPer'] ?? ind['Asistencia'] ?? s.asistencia ?? '';
  // show PromPer1 / promedio with one decimal
  document.getElementById('mdPromPer1').textContent = (promPer !== '') ? safeText(Number(promPer).toFixed(1)) : '';
  document.getElementById('mdPromAsisPer1').textContent = (asisPer !== '') ? `${safeText(Number(asisPer).toFixed(1))}%` : '';

  document.getElementById('mdInscritas').textContent = safeText(inscritas);
  document.getElementById('mdRetiradas').textContent = safeText(retiradas);

  // indicators list: show remaining indicator key-value pairs for readability
  const indListEl = document.getElementById('mdIndicators');
  indListEl.innerHTML = '';

  // Exclude noisy or redundant fields from the indicators display (case-insensitive)
  const excludeFields = new Set([
    'carnet','email_ins','email','email_inscripcion','sede','decanato','facultad_encuesta','direccion','tel_cel',
    // fields requested to be removed from indicators display
    'inscritas','retiradas','promper1','promasisper1','notatotal','prompp1','asisp1','riesgo_acad','asis_baja',
    'z_acad','v1','v2','v3','v4','v5','v6'
  ]);
  const allKeys = Object.keys(ind);

  // Keep only fields up to and including "Notaaprobar" (case-insensitive); drop fields after that
  let cutoffIndex = allKeys.findIndex(k => (k || '').toString().toLowerCase() === 'notaaprobar');
  let keptKeys;
  if (cutoffIndex === -1) {
    // if Notaaprobar not present, keep all initially
    keptKeys = allKeys.slice();
  } else {
    // include Notaaprobar itself and drop anything that comes after
    keptKeys = allKeys.slice(0, cutoffIndex + 1);
  }

  // Exclude noisy or redundant fields (case-insensitive)
  keptKeys = keptKeys.filter(k => !excludeFields.has((k || '').toString().toLowerCase()));

  // Find any additional keys that start with "Riesgo" (case-insensitive) and ensure they are included,
  // but avoid duplicates. These will be converted to percentage display below.
  const riesgoKeys = allKeys.filter(k => /^riesgo/i.test(k));
  riesgoKeys.forEach(k => {
    if (!keptKeys.includes(k) && !excludeFields.has((k || '').toString().toLowerCase())) {
      keptKeys.push(k);
    }
  });

  // limit to a reasonable number to avoid UI overflow
  const keys = keptKeys.slice(0, 40);

  if(keys.length){
    keys.forEach(k => {
      const div = document.createElement('div');
      div.className = 'ind-row';
      const label = document.createElement('div');
      label.className = 'ind-label';
      label.textContent = k;
      const val = document.createElement('div');
      val.className = 'ind-val';

      // Handle specific formatting rules:
      // - Riesgo* fields: convert numeric to percentage (value * 100) with one decimal
      // - Porcent_Rep: treat as percentage (value * 100) with one decimal
      // - Promp1: show numeric with one decimal
      if (/^riesgo/i.test(k) || /^porcent[_\s-]*rep$/i.test(k)) {
        const raw = ind[k];
        const num = Number(raw);
        if (!isNaN(num)) {
          const pct = (num * 100);
          val.textContent = `${(Math.round(pct * 10) / 10).toFixed(1)}%`.replace('.0%','%');
        } else {
          val.textContent = safeText(raw);
        }
      } else if (/^promp1$/i.test(k) || /^promper1$/i.test(k)) {
        const raw = ind[k];
        const num = Number(raw);
        if (!isNaN(num) && raw !== '') {
          val.textContent = `${(Math.round(num * 10) / 10).toFixed(1)}`;
        } else {
          val.textContent = safeText(raw);
        }
      } else {
        val.textContent = safeText(ind[k]);
      }

      div.appendChild(label);
      div.appendChild(val);
      indListEl.appendChild(div);
    });
  } else {
    indListEl.innerHTML = '<div style="color:#6b7280">No hay indicadores adicionales.</div>';
  }

  modal.classList.remove('hidden');
  // focus close button for accessibility
  const closeBtn = document.getElementById('modalCloseBtn');
  if(closeBtn) closeBtn.focus();
}

function hideStudentModal(){
  const modal = document.getElementById('studentDetailModal');
  if(modal) modal.classList.add('hidden');
}

// wire modal close events
document.addEventListener('click', (ev)=>{
  const t = ev.target;
  if(t && (t.id === 'modalCloseBtn' || t.id === 'modalCloseAction' || t.getAttribute('data-close') === 'true')){
    hideStudentModal();
  }
});
window.showStudentDetails = showStudentDetails;
window.hideStudentModal = hideStudentModal;

function drawChart(){
  const counts = { ALTO: 0, MEDIO: 0, BAJO: 0 };
  let sumProm = 0, sumAsis = 0, sumAprob = 0;

  processed.forEach(r => {
    counts[r.riesgo]++;
    sumProm += (r.prom || 0);
    sumAsis += (r.asistencia || 0);
    sumAprob += (r.aprobadas || 0);
  });

  const total = processed.length || 1;

  // otros datos relevantes
  const facultiesSet = new Set(processed.map(r => (r.facultad || '').toString().trim()).filter(f => f));
  const careersSet = new Set(processed.map(r => (r.carrera || '').toString().trim()).filter(c => c));
  const facultiesCount = facultiesSet.size;
  const careersCount = careersSet.size;

  if(chartInstance){ chartInstance.destroy(); }
  if(radarInstance){ radarInstance.destroy(); }

  chartInstance = new Chart(chartCanvas, {
    type: 'bar',
    data:{
      labels:['Alto','Medio','Bajo'],
      datasets:[{
        label: 'Número de estudiantes',
        data:[counts.ALTO, counts.MEDIO, counts.BAJO],
        backgroundColor: ['#e74c3c','#f39c12','#2ecc71']
      }]
    },
    options:{
      responsive:true,
      maintainAspectRatio:false,
      plugins:{legend:{display:false}}
    }
  });

  // Build radar chart to show frequency of textual risk labels (Alto/Medio/Bajo) per indicator column
  // Use indicator columns that start with "Cat" (as used in the students table) plus any other textual indicators
  const catIndicators = indicatorKeys.filter(k => k.startsWith('Cat'));
  // also include any other indicator that looks like categorical (string values) by checking a sample row
  const extraIndicators = indicatorKeys.filter(k => {
    if (k.startsWith('Cat')) return false;
    // sample a few rows to detect textual risk-like values
    for (let i = 0; i < Math.min(processed.length, 6); i++) {
      const val = processed[i].indicators ? processed[i].indicators[k] : processed[i][k];
      if (val === null || val === undefined) continue;
      const s = String(val).toLowerCase();
      // include if any value contains alto/medio/bajo
      if (s.includes('alto') || s.includes('medio') || s.includes('bajo')) return true;
    }
    return false;
  });

  // Exclude any column that represents the textual risk column (RiesgoT) and Sem_Z from radar
  const excludeRiesgoT = /riesgo\s*_*\s*t/i;
  const excludeSemZ = /^sem[_\s-]*z$/i;
  const visibleIndicators = [...catIndicators, ...extraIndicators]
    .filter((v, i, a) => a.indexOf(v) === i) // unique
    .filter(v => !excludeRiesgoT.test(v) && !excludeSemZ.test(v)); // remove RiesgoT-like keys and Sem_Z

  // fallback label
  const radarLabels = visibleIndicators.length ? visibleIndicators : ['Sin indicadores'];

  // For each indicator, count how many rows contain the texts "alto","medio","bajo" (case-insensitive)
  const countsPerLabel = radarLabels.map(lbl => {
    if (lbl === 'Sin indicadores') return { ALTO:0, MEDIO:0, BAJO:0 };
    const res = { ALTO:0, MEDIO:0, BAJO:0 };
    processed.forEach(row => {
      const raw = row.indicators ? row.indicators[lbl] : row[lbl];
      if (raw === null || raw === undefined) return;
      const s = String(raw).toLowerCase();
      if (s.includes('alto')) res.ALTO++;
      if (s.includes('medio')) res.MEDIO++;
      if (s.includes('bajo')) res.BAJO++;
    });
    return res;
  });

  // Build datasets for Alto / Medio / Bajo so radar shows distribution per indicator
  const altoData = countsPerLabel.map(c => c.ALTO);
  const medioData = countsPerLabel.map(c => c.MEDIO);
  const bajoData = countsPerLabel.map(c => c.BAJO);

  // create radar only if canvas exists
  if(radarCanvas){
    radarCanvas.style.height = '260px';
    radarCanvas.style.width = '100%';

    radarInstance = new Chart(radarCanvas, {
      type: 'radar',
      data: {
        labels: radarLabels,
        datasets: [
          {
            label: 'Alto',
            data: altoData,
            backgroundColor: 'rgba(231,76,60,0.12)',
            borderColor: '#e74c3c',
            pointBackgroundColor: '#e74c3c',
            pointBorderColor: '#fff',
            pointRadius: 4,
            fill: true
          },
          {
            label: 'Medio',
            data: medioData,
            backgroundColor: 'rgba(243,156,18,0.12)',
            borderColor: '#f39c12',
            pointBackgroundColor: '#f39c12',
            pointBorderColor: '#fff',
            pointRadius: 4,
            fill: true
          },
          {
            label: 'Bajo',
            data: bajoData,
            backgroundColor: 'rgba(46,204,113,0.12)',
            borderColor: '#2ecc71',
            pointBackgroundColor: '#2ecc71',
            pointBorderColor: '#fff',
            pointRadius: 4,
            fill: true
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: { top: 8, bottom: 6, left: 6, right: 6 } },
        scales: {
          r: {
            beginAtZero: true,
            ticks: { stepSize: 1 },
            grid: { color: 'rgba(15,23,42,0.06)' }
          }
        },
        plugins: {
          legend: { position: 'top' },
          tooltip: {
            callbacks: {
              label: function(ctx) {
                const val = ctx.raw;
                return `${ctx.dataset.label}: ${val}`;
              }
            }
          }
        }
      }
    });
  }

  const pct = level => ((counts[level] / total) * 100).toFixed(1);

  summaryEl.innerHTML = `
    <h3>Resumen general</h3>
    <strong>Total de estudiantes:</strong> ${total}<br>
    <strong>Riesgo alto:</strong> ${counts.ALTO} (${pct('ALTO')}%)<br>
    <strong>Riesgo medio:</strong> ${counts.MEDIO} (${pct('MEDIO')}%)<br>
    <strong>Riesgo bajo:</strong> ${counts.BAJO} (${pct('BAJO')}%)<br>
    <hr>
    <strong>Facultades representadas:</strong> ${facultiesCount}<br>
    <strong>Carreras representadas:</strong> ${careersCount}
  `;

  // Fill the additional segment with top faculties by record count
  const additionalEl = document.getElementById('additionalSummary');
  if (additionalEl) {
    const facultyCountsMap = {};
    processed.forEach(r => {
      const f = (r.facultad || 'Sin facultad').toString().trim() || 'Sin facultad';
      facultyCountsMap[f] = (facultyCountsMap[f] || 0) + 1;
    });
    const sortedFac = Object.entries(facultyCountsMap)
      .sort((a,b) => b[1] - a[1])
      .slice(0,5); // top 5

    const facHtml = sortedFac.length
      ? `<ol style="margin:6px 0 0 16px;padding:0 0 0 0;">` + sortedFac.map(f => `<li style="margin-bottom:6px">${f[0]} — ${f[1]} registro(s)</li>`).join('') + `</ol>`
      : `<div style="color:#6b7280">No hay facultades registradas.</div>`;

    additionalEl.innerHTML = `
      <div style="font-size:13px;color:#374151">
        <strong>Top facultades</strong>
        ${facHtml}
      </div>
    `;
  }
}

/* -------- Verificación: detección de errores -------- */

function runVerification() {
  const issues = [];
  if (!processed || !processed.length) return issues;
  processed.forEach((r, idx) => {
    const rowIndex = idx + 1;
    if (!r.nombre || String(r.nombre).toString().trim() === '') {
      issues.push({ row: rowIndex, level: 'error', message: 'Nombre faltante' });
    }
    if (!r.facultad || String(r.facultad).toString().trim() === '') {
      issues.push({ row: rowIndex, level: 'warn', message: 'Facultad faltante' });
    }
    if (!r.carrera || String(r.carrera).toString().trim() === '') {
      issues.push({ row: rowIndex, level: 'warn', message: 'Carrera faltante' });
    }

    // Zem_z removed from validation (no checks)

    // check Sem_Z textual column if available
    // if sem_z exists but doesn't match Alto/Medio/Bajo, mark as warn
    if (r.hasOwnProperty('sem_z')) {
      const raw = r.sem_z;
      if (raw === null || raw === undefined || String(raw).toString().trim() === '') {
        issues.push({ row: rowIndex, level: 'info', message: 'Sem_Z ausente o vacío' });
      } else {
        const txt = String(raw).toLowerCase();
        if (!(txt.includes('alto') || txt.includes('medio') || txt.includes('bajo'))) {
          issues.push({ row: rowIndex, level: 'warn', message: `Sem_Z no reconocido: "${raw}"` });
        }
      }
    }
  });
  return issues;
}

function renderVerification() {
  const el = document.getElementById('verificationList');
  if (!el) return;
  if (!processed || !processed.length) {
    el.innerHTML = '<div style="color:#6b7280">No hay datos cargados.</div>';
    return;
  }
  const issues = runVerification();
  if (!issues.length) {
    el.innerHTML = '<div style="color:#16a34a;font-weight:600">No se encontraron errores.</div>';
    return;
  }

  // Render as a 3-column grid of small item cards (CSS handles grid layout)
  const html = issues.map(i => {
    const color = i.level === 'error' ? '#e74c3c' : (i.level === 'warn' ? '#f39c12' : '#6b7280');
    return `
      <div class="verification-item">
        <strong>Fila ${i.row}</strong>
        <div class="msg" style="color:${color}">${i.message}</div>
      </div>
    `;
  }).join('');
  el.innerHTML = html;
}

/* -------- Estudiantes: filtros y listado -------- */

function populateFilterOptions() {
  if (!facultyFilter || !careerFilter || !processed.length) return;

  // preserve previously selected values
  const prevFaculty = (facultyFilter.value || '').trim();
  const prevCareer = (careerFilter.value || '').trim();

  // determine current faculty selection so careers can be limited
  const selectedFaculty = (facultyFilter.value || '').toString().trim();

  // trim values to avoid mismatches due to whitespace and remove empty entries
  const faculties = Array.from(new Set(processed.map(r => (r.facultad || '').toString().trim()).filter(f => f))).sort();

  // if a faculty is selected, only collect careers for that faculty; otherwise collect all careers
  const careersSet = new Set();
  processed.forEach(r => {
    const fac = (r.facultad || '').toString().trim();
    const car = (r.carrera || '').toString().trim();
    if (!car) return;
    if (!selectedFaculty || fac === selectedFaculty) careersSet.add(car);
  });
  const careers = Array.from(careersSet).sort();

  facultyFilter.innerHTML = '<option value="">Todas las facultades</option>' +
    faculties.map(f => `<option value="${f}">${f}</option>`).join('');

  careerFilter.innerHTML = '<option value="">Todas las carreras</option>' +
    careers.map(c => `<option value="${c}">${c}</option>`).join('');

  // restore previous selection if still available
  if (prevFaculty && Array.from(facultyFilter.options).some(o => o.value === prevFaculty)) {
    facultyFilter.value = prevFaculty;
  }
  if (prevCareer && Array.from(careerFilter.options).some(o => o.value === prevCareer)) {
    careerFilter.value = prevCareer;
  }
}

function getRiskClass(risk) {
  if (risk === 'ALTO') return 'red';
  if (risk === 'MEDIO') return 'yellow';
  return 'green';
}

function renderStudents() {
  if (!studentsList) return;

  populateFilterOptions();

  const facultyValue = facultyFilter ? facultyFilter.value : '';
  const careerValue  = careerFilter ? careerFilter.value : '';
  const riskValue    = riskFilter ? riskFilter.value : '';
  const searchValue  = studentSearch ? studentSearch.value.trim().toLowerCase() : '';

  const filtered = processed.filter(r => {
    if (facultyValue && r.facultad !== facultyValue) return false;
    if (careerValue && r.carrera !== careerValue) return false;
    if (riskValue && r.riesgo !== riskValue) return false;
    if (searchValue) {
      const name = (r.nombre || '').toString().toLowerCase();
      if (!name.includes(searchValue)) return false;
    }
    return true;
  });

  // update count display
  const countEl = document.getElementById('studentsCount');
  if (countEl) {
    countEl.textContent = `Registros: ${filtered.length}`;
  }

  if (!filtered.length) {
    studentsList.innerHTML = '<div class="students-empty">No hay estudiantes que coincidan con los filtros seleccionados.</div>';
    return;
  }

  // Only show indicator columns whose header starts with "Cat" (case-sensitive) for clarity.
  // build visible indicators: those starting with "Cat" plus Zem_z if present (case-insensitive)
  const catIndicators = indicatorKeys.filter(k => k.startsWith('Cat'));
  const zemIndicator = indicatorKeys.find(k => k.toString().toLowerCase() === 'zem_z' || k.toString().toLowerCase() === 'zemz');
  const visibleIndicators = [...catIndicators];
  if (zemIndicator && !visibleIndicators.includes(zemIndicator)) visibleIndicators.push(zemIndicator);

  // compute grid template: first column wider, then one column per visible indicator, final risk column
  const middleCount = visibleIndicators.length;
  const cols = ['2.2fr', ...Array(middleCount).fill('0.9fr'), '0.9fr'];
  const gridTemplate = cols.join(' ');

  // render header row with only visible indicator columns
  const headerHtml = `
    <div class="students-header-row" style="grid-template-columns: ${gridTemplate};">
      <div class="col-student">Estudiante</div>
      ${visibleIndicators.map(k => `<div class="col-metric">${k}</div>`).join('')}
      <div class="col-metric col-risk">Riesgo</div>
    </div>
  `;

  // helper to color categorical labels (used for indicator cells, not the risk column)
  const colorForLabel = (s) => {
    const txt = (s || '').toString().toLowerCase();
    if (txt.includes('alto')) return { color: '#e74c3c', label: 'Alto' };
    if (txt.includes('medio')) return { color: '#f39c12', label: 'Medio' };
    if (txt.includes('bajo')) return { color: '#2ecc71', label: 'Bajo' };
    return null;
  };

  // render each student row using only visible indicators
  const rowsHtml = filtered.map(r => {
    const riskClass = getRiskClass(r.riesgo);
    const indicatorsHtml = visibleIndicators.map(k => {
      let val = r.indicators ? r.indicators[k] : r[k];

      // detect if the value is a categorical risk label and color it (do NOT affect the risk column)
      if (val !== null && val !== undefined && typeof val !== 'object') {
        const labelInfo = colorForLabel(val);
        if (labelInfo) {
          // show short label with color
          return `<div class="col-metric"><div class="metric-value" style="color:${labelInfo.color};font-weight:600">${labelInfo.label}</div></div>`;
        }
      }

      if (typeof val === 'number') {
        const lower = k.toLowerCase();
        if (lower.includes('asist') || lower.includes('porcentaje') || lower.includes('%')) {
          return `<div class="col-metric"><div class="metric-value">${Number(val).toFixed(1)}%</div></div>`;
        }
        return `<div class="col-metric"><div class="metric-value">${Number(val).toFixed(2)}</div></div>`;
      } else if (!isNaN(Number(val)) && String(val).trim() !== '') {
        const num = Number(val);
        const lower = k.toLowerCase();
        if (lower.includes('asist') || lower.includes('porcentaje') || lower.includes('%')) {
          return `<div class="col-metric"><div class="metric-value">${num.toFixed(1)}%</div></div>`;
        }
        return `<div class="col-metric"><div class="metric-value">${num.toFixed(2)}</div></div>`;
      } else {
        return `<div class="col-metric"><div class="metric-value">${String(val ?? '').slice(0,30)}</div></div>`;
      }
    }).join('');

    return `
      <div class="students-row" style="grid-template-columns: ${gridTemplate};" onclick="window.showStudentDetails(${r._idx})" role="button" tabindex="0">
        <div class="col-student">
          <div class="student-name">${r.nombre || 'Sin nombre'}</div>
          <div class="student-meta">
            <span>${r.carrera || 'Carrera no registrada'}</span> ·
            <span>${r.facultad || 'Facultad no registrada'}</span>
          </div>
        </div>
        ${indicatorsHtml}
        <div class="col-metric col-risk">
          <span class="risk-pill ${riskClass}">${r.riesgo}</span>
        </div>
      </div>
    `;
  }).join('');

  studentsList.innerHTML = headerHtml + rowsHtml;
}

/* Listeners de filtros */
if (facultyFilter) {
  facultyFilter.addEventListener('change', renderStudents);
}
if (careerFilter) {
  careerFilter.addEventListener('change', renderStudents);
}
if (riskFilter) {
  riskFilter.addEventListener('change', renderStudents);
}
if (studentSearch) {
  studentSearch.addEventListener('input', renderStudents); // live filtering as user types
}

// Expose verification renderer to page scope so index.html can trigger it when showing the section
window.renderVerification = renderVerification;

/* -------- Informes: filtros, vista y PDF -------- */
const reportFaculty = document.getElementById('reportFaculty');
const reportCareer = document.getElementById('reportCareer');
const reportRisk   = document.getElementById('reportRisk');
const renderReportBtn = document.getElementById('renderReportBtn');
const reportTableBody = document.getElementById('reportTableBody');

// Helper: detect email in indicators by checking common key variants (case-insensitive)
function findEmailInIndicators(ind) {
  if (!ind || typeof ind !== 'object') return '';
  const keys = Object.keys(ind);
  const key = keys.find(k => {
    const kl = (k || '').toString().toLowerCase();
    return /(^|[^a-z])(email|correo)([_\s-]*electronico)?([_\s-]*inscrip)?($|[^a-z])/i.test(kl);
  });
  return key ? ind[key] : '';
}

function populateReportFilters() {
  if (!reportFaculty || !reportCareer || !processed.length) return;
  const faculties = Array.from(new Set(processed.map(r => (r.facultad || '').toString().trim()).filter(f => f))).sort();
  reportFaculty.innerHTML = '<option value="">Seleccione Facultad</option>' + faculties.map(f => `<option value="${f}">${f}</option>`).join('');

  // initially careers empty; will be filled on faculty selection
  reportCareer.innerHTML = '<option value="">Seleccione Carrera</option>';
  reportRisk.value = '';
}

// when faculty selected, populate careers for that faculty
if (reportFaculty) {
  reportFaculty.addEventListener('change', () => {
    const fac = reportFaculty.value;
    const careersSet = new Set();
    processed.forEach(r => {
      if (!fac || (r.facultad || '').toString().trim() === fac) {
        const car = (r.carrera || '').toString().trim();
        if (car) careersSet.add(car);
      }
    });
    const careers = Array.from(careersSet).sort();
    reportCareer.innerHTML = '<option value="">Seleccione Carrera</option>' + careers.map(c => `<option value="${c}">${c}</option>`).join('');
  });
}

// enable generate button only when all three filters have a selected value and there is at least one row
function updateGenerateState() {
  // kept for compatibility with event hooks; PDF button removed
  return;
}

// Listen to report filter changes to update generate state
if (reportCareer) reportCareer.addEventListener('change', updateGenerateState);
if (reportRisk)  reportRisk.addEventListener('change', updateGenerateState);

// build on-screen report listing
function renderReportListing() {
  if (!reportTableBody) return;
  if (!processed || !processed.length) {
    reportTableBody.innerHTML = '<tr><td colspan="7" style="padding:12px;color:#6b7280;text-align:center">No hay datos cargados.</td></tr>';
    return;
  }
  const fac = reportFaculty ? reportFaculty.value : '';
  const car = reportCareer ? reportCareer.value : '';
  const risk = reportRisk ? reportRisk.value : '';

  const rows = processed.filter(r => {
    if (fac && r.facultad !== fac) return false;
    if (car && r.carrera !== car) return false;
    if (risk && r.riesgo !== risk) return false;
    return true;
  });

  if (!rows.length) {
    reportTableBody.innerHTML = '<tr><td colspan="7" style="padding:12px;color:#6b7280;text-align:center">No se encontraron registros para los filtros seleccionados.</td></tr>';
    return;
  }

  // render each row with name, email, phone, signature blank, and three empty checkbox cells
  const html = rows.map(r => {
    const ind = r.indicators || {};
    const email = findEmailInIndicators(ind) || '';
    const tel = ind['Telefono'] || ind['telefono'] || ind['Tel'] || ind['tel'] || ind['tel_cel'] || '';
    // render a simpler row: Nombre, Email, Teléfono, Riesgo
    return `
      <tr>
        <td style="padding:8px;border-bottom:1px solid #f1f5f9">${(r.nombre || '').toString().slice(0,80)}</td>
        <td style="padding:8px;border-bottom:1px solid #f1f5f9">${safeText(email)}</td>
        <td style="padding:8px;border-bottom:1px solid #f1f5f9">${safeText(tel)}</td>
        <td style="padding:8px;border-bottom:1px solid #f1f5f9">${safeText(r.riesgo)}</td>
      </tr>
    `;
  }).join('');

  reportTableBody.innerHTML = html;
}

 // wire the "Mostrar listado" button to render the on-screen table and enable PDF if filters set
 if (renderReportBtn) {
   renderReportBtn.addEventListener('click', () => {
     renderReportListing();
     updateGenerateState();
   });
 }

 // Export Dashboard statistics to a Word (.doc) file: captures summary HTML, top faculties and chart images
 const exportStatsBtn = document.getElementById('exportStatsBtn');
 if (exportStatsBtn) {
   exportStatsBtn.addEventListener('click', async () => {
     try {
       // Ensure there is processed data
       if (!processed || !processed.length) {
         alert('No hay datos para exportar. Cargue un archivo primero.');
         return;
       }

       // Acquire HTML fragments
       const title = `Estadísticas - Risk Intelligence`;
       const now = new Date().toLocaleString();
       const summaryHtml = document.getElementById('summary') ? document.getElementById('summary').innerHTML : '';
       const topFacHtml = document.getElementById('additionalSummary') ? document.getElementById('additionalSummary').innerHTML : '';

       // Capture chart images (if present)
       const charts = [];
       try {
         if (chartCanvas && chartCanvas.toDataURL) {
           charts.push({ label: 'Distribución de riesgo', dataUrl: chartCanvas.toDataURL('image/png') });
         }
       } catch (e) { /* ignore */ }
       try {
         if (radarCanvas && radarCanvas.toDataURL) {
           charts.push({ label: 'Radar de indicadores', dataUrl: radarCanvas.toDataURL('image/png') });
         }
       } catch (e) { /* ignore */ }

       // Build a simple HTML document that Word can open
       let doc = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
         <style>
           body{font-family:Arial,Helvetica,sans-serif;color:#111827;padding:18px}
           h1{font-size:18px;margin-bottom:6px}
           h2{font-size:14px;margin:12px 0 6px}
           .muted{color:#6b7280;font-size:12px;margin-bottom:12px}
           .section{margin-bottom:14px}
           table{border-collapse:collapse;width:100%;font-size:12px}
           th,td{border:1px solid #ddd;padding:6px}
           img{max-width:100%;height:auto;margin:8px 0;border:1px solid #eee}
         </style>
       </head><body>`;

       doc += `<h1>${title}</h1><div class="muted">Generado: ${now}</div>`;

       doc += `<div class="section"><h2>Resumen general</h2>${summaryHtml}</div>`;
       doc += `<div class="section"><h2>Top facultades</h2>${topFacHtml}</div>`;

       if (charts.length) {
         doc += `<div class="section"><h2>Gráficos</h2>`;
         charts.forEach(c => {
           doc += `<div><strong>${c.label}</strong><br><img src="${c.dataUrl}" alt="${c.label}"></div>`;
         });
         doc += `</div>`;
       }

       // Add a simple note and close
       doc += `<div class="muted">Este documento contiene las estadísticas visibles en el Dashboard extraídas de la sesión actual.</div>`;
       doc += `</body></html>`;

       // Create blob and trigger download with .doc extension (Word will open HTML-based docs)
       const blob = new Blob([doc], { type: 'application/msword' });
       const url = URL.createObjectURL(blob);
       const a = document.createElement('a');
       a.href = url;
       a.download = `Estadisticas_Risk_Intelligence_${(new Date()).toISOString().slice(0,19).replace(/[:T]/g,'-')}.doc`;
       document.body.appendChild(a);
       a.click();
       setTimeout(() => {
         URL.revokeObjectURL(url);
         a.remove();
       }, 500);
     } catch (err) {
       console.error('Error exporting stats to Word', err);
       alert('Ocurrió un error al generar el documento.');
     }
   });
 }

 // Export current report listing to Excel (.xlsx)
 const exportExcelBtn = document.getElementById('exportExcelBtn');
 if (exportExcelBtn) {
   exportExcelBtn.addEventListener('click', () => {
     try {
       if (!processed || !processed.length) {
         alert('No hay datos para exportar. Cargue un archivo primero.');
         return;
       }
       // Use the same filters as renderReportListing
       const fac = reportFaculty ? reportFaculty.value : '';
       const car = reportCareer ? reportCareer.value : '';
       const risk = reportRisk ? reportRisk.value : '';

       const rows = processed.filter(r => {
         if (fac && r.facultad !== fac) return false;
         if (car && r.carrera !== car) return false;
         if (risk && r.riesgo !== risk) return false;
         return true;
       });

       if (!rows.length) {
         alert('No hay registros para los filtros seleccionados.');
         return;
       }

       // Build plain objects for Excel: Nombre, Email, Teléfono, Facultad, Carrera, Riesgo
       // plus Firma1/Seguimiento1/Observaciones1 ... Firma3/Seguimiento3/Observaciones3 if present in indicators
       const excelData = rows.map(r => {
         const ind = r.indicators || {};
         const email = findEmailInIndicators(ind) || '';
         const tel = ind['Telefono'] || ind['telefono'] || ind['Tel'] || ind['tel'] || ind['tel_cel'] || '';
         return {
           Nombre: r.nombre || '',
           Email: safeText(email),
           Telefono: safeText(tel),
           Facultad: r.facultad || '',
           Carrera: r.carrera || '',
           Riesgo: r.riesgo || '',
           Firma1: safeText(ind['Firma1'] ?? ind['Firma_1'] ?? ''),
           Seguimiento1: safeText(ind['Seguimiento1'] ?? ind['Seguimiento_1'] ?? ''),
           Observaciones1: safeText(ind['Observaciones1'] ?? ind['Observaciones_1'] ?? ''),
           Firma2: safeText(ind['Firma2'] ?? ind['Firma_2'] ?? ''),
           Seguimiento2: safeText(ind['Seguimiento2'] ?? ind['Seguimiento_2'] ?? ''),
           Observaciones2: safeText(ind['Observaciones2'] ?? ind['Observaciones_2'] ?? ''),
           Firma3: safeText(ind['Firma3'] ?? ind['Firma_3'] ?? ''),
           Seguimiento3: safeText(ind['Seguimiento3'] ?? ind['Seguimiento_3'] ?? ''),
           Observaciones3: safeText(ind['Observaciones3'] ?? ind['Observaciones_3'] ?? '')
         };
       });

       // build workbook and trigger download using XLSX (already imported)
       const ws = XLSX.utils.json_to_sheet(excelData);
       const wb = XLSX.utils.book_new();
       XLSX.utils.book_append_sheet(wb, ws, 'Listado');
       const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
       const blob = new Blob([wbout], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
       const url = URL.createObjectURL(blob);
       const a = document.createElement('a');
       a.href = url;
       a.download = `Listado_Risk_Intelligence_${(new Date()).toISOString().slice(0,19).replace(/[:T]/g,'-')}.xlsx`;
       document.body.appendChild(a);
       a.click();
       setTimeout(() => {
         URL.revokeObjectURL(url);
         a.remove();
       }, 500);
     } catch (err) {
       console.error('Error exporting Excel', err);
       alert('Ocurrió un error al generar el archivo Excel.');
     }
   });
 }

 // Generate printable report: opens a new window with a simple table and calls print
 // Safely acquire the button element (the app may intentionally hide/remove the PDF button)
 const generatePdfBtn = document.getElementById('generatePdfBtn');
 if (generatePdfBtn) {
   generatePdfBtn.addEventListener('click', () => {
     const fac = reportFaculty.value;
     const car = reportCareer.value;
     const risk = reportRisk.value;
     const rows = processed.filter(r => r.facultad === fac && r.carrera === car && r.riesgo === risk);
     const now = new Date().toLocaleString();
     const head = `
       <html><head><title>Informe - ${fac} / ${car} / ${risk}</title>
       <style>
         body{font-family:Arial,Helvetica,sans-serif;padding:18px;color:#111827}
         table{width:100%;border-collapse:collapse;font-size:12px}
         th,td{border:1px solid #ddd;padding:8px}
         th{background:#f7f7f8}
         .sig{height:36px}
         .center{text-align:center}
       </style>
       </head><body>
       <h2>Informe de seguimiento — ${fac} / ${car} / ${risk}</h2>
       <div style="font-size:12px;color:#6b7280">Generado: ${now}</div>
       <table><thead>
       <tr>
         <th>Nombre</th><th>Email</th><th>Teléfono</th><th>Firma</th><th class="center">1</th><th class="center">2</th><th class="center">3</th>
       </tr></thead><tbody>
     `;
     const body = rows.map(r => {
       const ind = r.indicators || {};
       const email = findEmailInIndicators(ind) || '';
       const tel = ind['Telefono'] || ind['telefono'] || ind['Tel'] || ind['tel'] || ind['tel_cel'] || '';
       return `<tr>
         <td>${(r.nombre || '').toString().replace(/</g,'&lt;')}</td>
         <td>${safeText(email)}</td>
         <td>${safeText(tel)}</td>
         <td class="sig"></td>
         <td class="center"></td>
         <td class="center"></td>
         <td class="center"></td>
       </tr>`;
     }).join('');
     const foot = `</tbody></table><div style="margin-top:18px;font-size:12px;color:#6b7280">Este listado corresponde a los estudiantes filtrados por Facultad, Carrera y Nivel de Riesgo.</div></body></html>`;

     const win = window.open('', '_blank', 'noopener');
     if (!win) { alert('El navegador bloqueó la apertura de la ventana para impresión. Permita ventanas emergentes.'); return; }
     win.document.write(head + body + foot);
     win.document.close();
     // wait a bit for rendering then call print
     setTimeout(() => { win.focus(); win.print(); }, 500);
   });
 }

/* -------- Login: simple client-side auth (sessionStorage) -------- */

// predefined users (username: password)
const USER_CREDENTIALS = {
  admin: 'Santori',
  vilma: 'V1lm@',
  marta: 'm@rt@',
  vidal: 'V1d@l',
  gloria: 'G1or1@',
  rocio: 'R0c1o',
  sofia: '$0f1@',
  ana: '@na26'
};

function showLoginModal() {
  const lm = document.getElementById('loginModal');
  if (lm) {
    lm.classList.remove('hidden');
    // focus username
    const u = document.getElementById('loginUser');
    if (u) { u.focus(); u.select(); }
  }
}

function hideLoginModal() {
  const lm = document.getElementById('loginModal');
  if (lm) lm.classList.add('hidden');
}

// update header username display and UI state
function setCurrentUser(username) {
  const nameEl = document.getElementById('currentUserName');
  if (nameEl) nameEl.textContent = username ? username : 'Invitado';
  // if guest, show login modal; otherwise hide it
  if (!username) {
    showLoginModal();
  } else {
    hideLoginModal();
  }
}

// login attempt
function attemptLogin() {
  const u = document.getElementById('loginUser');
  const p = document.getElementById('loginPass');
  const err = document.getElementById('loginError');
  if (!u || !p) return;
  const user = (u.value || '').toString().trim();
  const pass = (p.value || '').toString();
  if (!user || !pass) {
    if (err) { err.style.display = 'block'; err.textContent = 'Ingrese usuario y contraseña.'; }
    return;
  }
  const expected = USER_CREDENTIALS[user];
  if (expected && expected === pass) {
    // success: store session and update UI
    sessionStorage.setItem('ri_current_user', user);
    setCurrentUser(user);
    if (err) { err.style.display = 'none'; err.textContent = ''; }
  } else {
    if (err) { err.style.display = 'block'; err.textContent = 'Credenciales incorrectas.'; }
    // clear password for security
    p.value = '';
    p.focus();
  }
}

 // clear application-loaded data and UI
 function clearAppData() {
   // clear in-memory arrays
   data = [];
   processed = [];
   indicatorKeys = [];
   detectedKeys = { name: null, faculty: null, career: null };

   // destroy charts if present
   try { if (chartInstance) { chartInstance.destroy(); chartInstance = null; } } catch (e) { /* ignore */ }
   try { if (radarInstance) { radarInstance.destroy(); radarInstance = null; } } catch (e) { /* ignore */ }

   // reset DOM areas
   const studentsListEl = document.getElementById('studentsList');
   if (studentsListEl) studentsListEl.innerHTML = '';

   const summaryElLocal = document.getElementById('summary');
   if (summaryElLocal) summaryElLocal.innerHTML = '';

   const additionalEl = document.getElementById('additionalSummary');
   if (additionalEl) additionalEl.innerHTML = '';

   const verificationEl = document.getElementById('verificationList');
   if (verificationEl) verificationEl.innerHTML = '<div style="color:#6b7280">No hay datos cargados.</div>';

   // reset report filters and table
   const rf = document.getElementById('reportFaculty');
   const rc = document.getElementById('reportCareer');
   const rtb = document.getElementById('reportTableBody');
   if (rf) rf.innerHTML = '<option value="">Seleccione Facultad</option>';
   if (rc) rc.innerHTML = '<option value="">Seleccione Carrera</option>';
   if (rtb) rtb.innerHTML = '<tr><td colspan="4" style="padding:12px;color:#6b7280;text-align:center">No hay datos. Aplique filtros y pulse &quot;Mostrar listado&quot;.</td></tr>';

   // reset students filters and counts
   const facultyFilterEl = document.getElementById('facultyFilter');
   const careerFilterEl = document.getElementById('careerFilter');
   const studentsCountEl = document.getElementById('studentsCount');
   if (facultyFilterEl) facultyFilterEl.innerHTML = '<option value=\"\">Todas las facultades</option>';
   if (careerFilterEl) careerFilterEl.innerHTML = '<option value=\"\">Todas las carreras</option>';
   if (studentsCountEl) studentsCountEl.textContent = 'Registros: 0';

   // clear file input UI
   try { if (fileInput) fileInput.value = ''; } catch (e) {}
   const selName = document.getElementById('selectedFileName');
   if (selName) selName.textContent = '';

   // clear upload message if any
   const uploadMessageEl = document.getElementById('uploadMessage');
   if (uploadMessageEl) { uploadMessageEl.style.display = 'none'; uploadMessageEl.textContent = ''; }

   // ensure panels reflect empty state: show tools panel (optional)
   const toolsPanel = document.getElementById('herramientasPanel');
   const dashboardSection = document.getElementById('dashboardSection');
   const estudiantesSection = document.getElementById('estudiantesSection');
   if (toolsPanel) toolsPanel.classList.remove('hidden');
   if (dashboardSection) dashboardSection.classList.remove('hidden');
   if (estudiantesSection) estudiantesSection.classList.add('hidden');
 }

 // logout
 function logout() {
   // remove session
   sessionStorage.removeItem('ri_current_user');
   // clear all loaded data/UI
   clearAppData();
   // update UI to logged-out state and show login modal
   setCurrentUser(null);
 }

// wire login controls
document.addEventListener('click', (ev) => {
  const t = ev.target;
  if (!t) return;
  if (t.id === 'loginBtn') attemptLogin();
  if (t.id === 'logoutBtn') logout();
});

// support Enter key on login fields
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') {
    const lm = document.getElementById('loginModal');
    if (lm && !lm.classList.contains('hidden')) {
      attemptLogin();
    }
  }
});

// on load: restore session or show login
window.addEventListener('DOMContentLoaded', () => {
  const current = sessionStorage.getItem('ri_current_user');
  if (current) setCurrentUser(current);
  else showLoginModal();
});

/* -------- Populate report filters when data is loaded (hook into existing process) -------- */
const originalProcessData = processData;
processData = function() {
  originalProcessData();
  // small timeout to ensure DOM selects exist
  setTimeout(() => {
    populateReportFilters();
  }, 50);
};