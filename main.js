/*
  main.js - Versión 7.3
  ------------------------------------------------------------
  Documentación (en español) - Estructura general del archivo
  ------------------------------------------------------------
  Este archivo organiza la lógica de la aplicación en secciones claras:
  1) Constantes y configuración (CONFIG): mapeos de keywords, escala Likert y parámetros.
  2) Funciones utilitarias y de integración (p. ej. callAI): adaptadores y reintentos.
  3) Gestión de presentación tipo "reel" y análisis de encabezados (startReel, analyzeHeaders).
  4) Procesamiento de archivos y normalización (processFile): 
     - sanitiza encabezados, detecta columnas por dominio,
     - mapea respuestas Likert/texto a 1-5,
     - normaliza a 0-5, invierte según signo de la pregunta,
     - calcula promedios por dominio, aplica pesos y banderas rojas,
     - calcula score final en escala 0-10 y clasifica en niveles.
  5) Actualización de UI (updateUI, renderCharts, renderTable): actualización de KPIs,
     creación/actualización de gráficas Chart.js y tabla interactiva.
  6) Modal de estudiante y utilidades de exportación/filtrado.
  7) Exposición de funciones al scope global y listeners de eventos.
  ------------------------------------------------------------
  Comentarios: los bloques y funciones más abajo están documentados en español
  para facilitar mantenimiento y auditoría por analistas de datos y equipos TI.
*/
import * as XLSX from "xlsx";
import Chart from "chart.js";

let studentsData = [];
let categoryMap = {};
let charts = {};
let modalChartInstance = null;
let selectedStudent = null;

const CONFIG = {
  KEYWORDS: {
    academic: ["académico", "estudio", "tarea", "examen", "asignatura", "comprendo", "preparado", "nota", "promedio"],
    permanence: ["carrera", "ciclo", "abandonar", "cambiar", "continuar", "motivado", "retirarme", "pertenencia"],
    wellbeing: ["abrumado", "ansiedad", "dormir", "psicológico", "desanimado", "estrés", "concentrar", "interés"],
    socioeconomic: ["económica", "trabaj", "transporte", "internet", "gastos", "costo", "financiero", "dinero"],
    health_family: ["familia", "salud", "enfermedad", "casa", "conflicto", "apoyo", "cuidado"]
  },
  NEGATIVES: ["abandonar", "cambiar", "abrumado", "ansiedad", "estrés", "dejar", "problema", "costado", "dificult", "conflict", "desanimado", "perdido", "imprevisto", "retirarme", "cuesta", "mantenerme al día"],
  LIKERT: {
    "Totalmente en desacuerdo": 1, "En desacuerdo": 2, "Neutral": 3, "De acuerdo": 4, "Totalmente de acuerdo": 5,
    "Nunca": 1, "Rara vez": 2, "Ocasionalmente": 3, "Frecuentemente": 4, "Muy frecuentemente (siempre)": 5,
    // Unificación de respuestas binarias: "Sí" suele indicar presencia de recurso/acción positiva -> mapear a 5
    // y "No" a 1 para evitar introducir ceros que deformen medias.
    "Sí": 5, "No": 1, "No, nada": 1, "Sí, un poco": 3, "Sí, mucho": 5
  },
  // Pesos iniciales por variable en porcentaje (suman 100) - calibrado para equilibrio (20% cada dominio)
  WEIGHTS: {
    academic: 20,
    permanence: 20,
    wellbeing: 20,
    socioeconomic: 20,
    health_family: 20
  },
  // Umbrales de clasificación (valores en escala 0-10). Las comparaciones serán exclusivas (solo '>' y '<').
  THRESHOLDS: {
    medium_min: 4.00,
    medium_max: 6.90,
    // rounding: 'up'|'down' - se aplica al valor score10 antes de comparar
    rounding: 'up'
  }
};

function startReel() {
  let currentSlide = 0;
  const slides = document.querySelectorAll('.reel-slide');
  if (!slides.length) return;
  const showSlide = (n) => {
    slides.forEach(s => s.classList.remove('active'));
    if (slides[n]) slides[n].classList.add('active');
  };
  setInterval(() => { currentSlide = (currentSlide + 1) % slides.length; showSlide(currentSlide); }, 6000);
  showSlide(0);
}

function analyzeHeaders(keys) {
  categoryMap = { academic: [], permanence: [], wellbeing: [], socioeconomic: [], health_family: [] };
  keys.forEach((key) => {
    const lower = key.toLowerCase();
    for (let cat in CONFIG.KEYWORDS) {
      if (CONFIG.KEYWORDS[cat].some(kw => lower.includes(kw))) {
        const isNeg = CONFIG.NEGATIVES.some(neg => lower.includes(neg));
        categoryMap[cat].push({ key: key, isNeg: isNeg });
        break;
      }
    }
  });
}

function processFile(raw_data) {
  if (!raw_data || raw_data.length === 0) return;
  const headers = Object.keys(raw_data[0]);
  const cleanKeys = headers.map(k => k.trim());
  const sanitizedData = raw_data.map(row => {
    let newRow = {};
    headers.forEach((k, i) => { newRow[cleanKeys[i]] = row[k]; });
    return newRow;
  });

  analyzeHeaders(cleanKeys);

  const findKey = (search) => cleanKeys.find(k => k.toLowerCase().includes(search.toLowerCase()));
  const emailKey = findKey("correo electrónico") || findKey("email") || findKey("dirección") || findKey("correo") || findKey("correo electrónico");
  const facKey = findKey("facultad en que estudia") || findKey("facultad");
  const nameKey = findKey("nombre completo") || findKey("nombre");
  const carnetKey = findKey("carnet") || findKey("codigo") || findKey("id");
  const carreraExactKey = cleanKeys.find(k => k.toLowerCase() === "carrera") || cleanKeys.find(k => k.toLowerCase().includes("carrera"));

  const careerFacetHeaders = cleanKeys.filter(k => k.toLowerCase().startsWith("carr") && k.toLowerCase() !== "carrera");

  const facultyList = facKey ? [...new Set(sanitizedData.map(d => d[facKey]))].filter(f => f).sort() : [];
  const selectFac = document.getElementById('filterFacultad');
  const selectCarr = document.getElementById('filterCarrera');

  // Construir un mapa facultad -> set de carreras detectadas
  const facultyToCareers = {};
  sanitizedData.forEach(row => {
    const f = facKey && row[facKey] ? row[facKey].toString() : 'N/A';
    // intentar detectar carrera desde columna exacta o facetas de carrera
    let carreraVal = "No especificada";
    if (carreraExactKey && row[carreraExactKey] && row[carreraExactKey].toString().trim() !== "") carreraVal = row[carreraExactKey].toString().trim();
    else {
      for (let col of careerFacetHeaders) {
        if (row[col] && row[col].toString().trim() !== "") { carreraVal = row[col].toString().trim(); break; }
      }
    }
    if (!facultyToCareers[f]) facultyToCareers[f] = new Set();
    if (carreraVal) facultyToCareers[f].add(carreraVal);
  });

  if (selectFac) {
    selectFac.innerHTML = '<option value="all">Todas las Facultades</option>';
    facultyList.forEach(f => {
      const opt = document.createElement('option');
      opt.value = f; opt.textContent = f;
      selectFac.appendChild(opt);
    });
    // cuando cambie la facultad, actualizar el select de carreras limitado a la facultad seleccionada
    selectFac.addEventListener('change', () => {
      const chosen = selectFac.value;
      // limpiar y rellenar carreras según selección
      if (selectCarr) {
        selectCarr.innerHTML = '<option value="all">Todas las Carreras</option>';
        const careersSet = chosen === 'all' ? new Set([].concat(...Object.values(facultyToCareers).map(s => Array.from(s)))) : facultyToCareers[chosen] || new Set();
        Array.from(careersSet).sort().forEach(c => {
          const optC = document.createElement('option');
          optC.value = c; optC.textContent = c;
          selectCarr.appendChild(optC);
        });
      }
      renderTable();
    });
  }

  // inicializar select de carreras (todas las carreras por defecto o limitadas a 'all')
  if (selectCarr) {
    selectCarr.innerHTML = '<option value="all">Todas las Carreras</option>';
    // agregar todas las carreras encontradas si existen
    const allCareers = new Set([].concat(...Object.values(facultyToCareers).map(s => Array.from(s))));
    Array.from(allCareers).sort().forEach(c => {
      const optC = document.createElement('option');
      optC.value = c; optC.textContent = c;
      selectCarr.appendChild(optC);
    });
  }

  studentsData = sanitizedData.map((row, idx) => {
    const res = {};
    let redFlags = 0;
    // Obtener pesos activos desde CONFIG (convertir % a fracción)
    let activeWeights = {};
    for (let k in CONFIG.WEIGHTS) { activeWeights[k] = (Number(CONFIG.WEIGHTS[k]) || 0) / 100; }

    for (let cat in categoryMap) {
      let sum = 0, count = 0;
      categoryMap[cat].forEach(col => {
        let raw = row[col.key];
        if (raw === undefined || raw === null) return;
        if (typeof raw === 'string') raw = raw.replace(/^\d+\.\s*/, '').trim();
        const parsed = parseFloat(raw);
        // map recognized Likert/text to numeric 1-5 (default central 3)
        let val = CONFIG.LIKERT[raw] !== undefined ? CONFIG.LIKERT[raw] : (!isNaN(parsed) && parsed !== null ? parsed : 3);
        if (typeof val !== 'number' || isNaN(val)) val = 3;
        // ensure val sits within 1-5 (source Likert scale)
        val = Math.max(1, Math.min(5, val));

        // normalize source 1-5 to a 0-5 continuous scale (so neutral (3) -> 2.5)
        // norm = ((val - 1) / 4) * 5  => val=1 =>0, val=3 =>2.5, val=5 =>5
        const normVal = ((val - 1) / 4) * 5;

        // if column marked as negative (palabras en NEGATIVES) -> mayor valor implica mayor riesgo (keep direction)
        // if column POSITIVE (default) -> mayor valor implica menor riesgo, so invert on 0-5 scale
        let riskVal = col.isNeg ? normVal : (5 - normVal);

        // clamp to 0-5 to avoid negatives
        riskVal = Math.max(0, Math.min(5, riskVal));

        // stronger red flag detection for permanence-related critical items (use 0-5 scale threshold)
        if (riskVal >= 4.5 && (cat === 'permanence' || col.key.toLowerCase().includes('abandonar'))) redFlags++;

        sum += riskVal;
        count++;
      });
      // average category result; if no questions found assume neutral midpoint (2.5 on 0-5 scale)
      res[cat] = count > 0 ? (sum / count) : 2.5;
    }

    // compute weighted composite using explicit category values (no falsy coalescing)
    let weightedBase = 0;
    for (let cat in activeWeights) { weightedBase += (res[cat]) * activeWeights[cat]; }

    // red flags add an adjustment (each flag +0.3) on the 0-5 scale; clamp to 0-5
    let totalScoreFinal = Math.max(0, Math.min(5, weightedBase + (redFlags * 0.3)));
    // convert to 0-10 scale for display
    let score10 = totalScoreFinal * 2;

    // Aplicar redondeo configurado (operar con dos decimales) y usar comparaciones exclusivas '>' / '<'
    const roundingMode = CONFIG.THRESHOLDS.rounding === 'down' ? 'down' : 'up';
    const factor = 100; // para dos decimales
    let roundedScore = score10;
    if (roundingMode === 'up') roundedScore = Math.ceil(score10 * factor) / factor;
    else roundedScore = Math.floor(score10 * factor) / factor;

    let nivel = "Bajo";
    // Si hay 2 o más redFlags, forzamos Alto (como antes)
    if (redFlags >= 2) nivel = "Alto";
    else {
      // Usamos solo '>' y '<' y los umbrales configurables en CONFIG.THRESHOLDS
      const minM = Number(CONFIG.THRESHOLDS.medium_min);
      const maxM = Number(CONFIG.THRESHOLDS.medium_max);
      // Si está por encima del máximo de medio => Alto
      if (roundedScore > maxM) nivel = "Alto";
      // Si está estrictamente entre minM y maxM => Medio
      else if (roundedScore > minM && roundedScore < maxM) nivel = "Medio";
      // Si está por debajo del mín de medio => Bajo (queda por defecto)
    }

    let facultyVal = (facKey && row[facKey]) ? row[facKey].toString() : "N/A";
    let carrera = "No especificada";

    if (carreraExactKey && row[carreraExactKey] && row[carreraExactKey].toString().trim() !== "") {
      carrera = row[carreraExactKey].toString().trim();
    } else {
      for (let col of careerFacetHeaders) {
        if (row[col] && row[col].toString().trim() !== "") {
          carrera = row[col].toString().trim();
          break;
        }
      }
    }

    return {
      email: (emailKey && row[emailKey]) ? row[emailKey] : `anon_${idx}`,
      nombre: (nameKey && row[nameKey]) ? row[nameKey] : `Estudiante ${idx+1}`,
      facultad: facultyVal,
      carrera: carrera,
      email_display: (emailKey && row[emailKey]) ? row[emailKey] : "N/D",
      carnet: (carnetKey && row[carnetKey]) ? row[carnetKey] : "N/D",
      res, score10, nivel, redFlags
    };
  });

  document.getElementById('welcomeReel').classList.add('hidden');
  document.getElementById('statsContainer').classList.remove('hidden');
  updateUI();
}

function updateUI() {
  // Actualiza KPIs básicos
  document.getElementById('kpiTotal').innerText = studentsData.length;
  document.getElementById('kpiHigh').innerText = studentsData.filter(s => s.nivel === 'Alto').length;
  document.getElementById('kpiMedium').innerText = studentsData.filter(s => s.nivel === 'Medio').length;
  document.getElementById('kpiLow').innerText = studentsData.filter(s => s.nivel === 'Bajo').length;

  // Si hay datos, calcular promedios de forma segura y consistente
  if (studentsData.length > 0) {
    // 1) Calcular medias poblacionales por dominio (valores en 0-5) para trazabilidad
    const domains = ['academic','permanence','wellbeing','socioeconomic','health_family'];
    const domainMeans = {};
    domains.forEach(d => {
      const sum = studentsData.reduce((acc, s) => acc + (Number(s.res[d] ?? 2.5)), 0);
      domainMeans[d] = studentsData.length ? (sum / studentsData.length) : 2.5;
    });

    // 2) Obtener el promedio de riesgo real a partir de los scores ya calculados por estudiante (media aritmética de score10)
    const totalScores = studentsData.reduce((acc, s) => acc + (Number(s.score10) || 0), 0);
    const avgScore10 = studentsData.length ? (totalScores / studentsData.length) : 0;

    // Mostrar Riesgo promedio (0-10) con un decimal
    const elAvgRisk = document.getElementById('kpiAvgRisk');
    if (elAvgRisk) elAvgRisk.innerText = avgScore10.toFixed(1);

    // Salud Institucional = invertimos la interpretación: salud = 100 - (promedio riesgo * 10)
    const riskPercent = Math.max(0, Math.min(100, avgScore10 * 10));
    const globalPercent = Math.max(0, Math.min(100, 100 - riskPercent));
    const elAvgScore = document.getElementById('kpiAvgScore');
    if (elAvgScore) elAvgScore.innerText = `${Math.round(globalPercent)}%`;

    // Emitir trazabilidad detallada de cálculos al panel de "Algoritmos y Sucesos" para auditoría
    try {
      const lines = [];
      const domainNames = {
        academic: 'Académico',
        permanence: 'Permanencia',
        wellbeing: 'Salud Mental',
        socioeconomic: 'Económico',
        health_family: 'Entorno'
      };
      lines.push('--- CÁLCULOS: Resumen poblacional ---');
      lines.push(`Población total: ${studentsData.length}`);
      lines.push('Medias por dominio (0-5):');
      domains.forEach(d => lines.push(` - ${domainNames[d] || d}: ${Number(domainMeans[d]).toFixed(4)}`));

      // Añadir estadística basada en scores por estudiante
      const avgRedFlags = studentsData.reduce((a,b) => a + (Number(b.redFlags || 0)), 0) / studentsData.length;
      lines.push(`Promedio de redFlags por estudiante: ${avgRedFlags.toFixed(4)}`);

      lines.push(`Riesgo promedio calculado como media aritmética de score10 por estudiante: ${avgScore10.toFixed(4)}`);
      lines.push(`Riesgo% (0-100) = avgScore10 * 10: ${(avgScore10 * 10).toFixed(2)}%`);
      lines.push(`Salud Institucional = 100 - Riesgo%: ${globalPercent.toFixed(2)}%`);

      // Documentar umbrales actuales (usar sólo > y <)
      lines.push(`Umbrales aplicados para niveles por estudiante (comparaciones exclusivas):`);
      lines.push(` - Medio: > ${Number(CONFIG.THRESHOLDS.medium_min).toFixed(2)} y < ${Number(CONFIG.THRESHOLDS.medium_max).toFixed(2)}`);
      lines.push(` - Bajo: valores que no cumplen > minMed ni > maxMed en la lógica (práctica: no > minMed ni > maxMed)`);
      lines.push(` - Alto: > ${Number(CONFIG.THRESHOLDS.medium_max).toFixed(2)} o >=2 redFlags`);
      lines.push('Listado de conteos por nivel:');
      lines.push(` - Alto: ${studentsData.filter(s => s.nivel === 'Alto').length}`);
      lines.push(` - Medio: ${studentsData.filter(s => s.nivel === 'Medio').length}`);
      lines.push(` - Bajo: ${studentsData.filter(s => s.nivel === 'Bajo').length}`);
      lines.push('--- FIN CÁLCULOS ---');

      lines.forEach(l => log(l, 'calc'));
    } catch (e) {
      log('Error generando trazabilidad de cálculos: ' + (e.message || e), 'error');
    }
  } else {
    // Valores por defecto cuando no hay datos
    const elRisk = document.getElementById('kpiAvgRisk');
    if (elRisk) elRisk.innerText = "0.0";
    const elScore = document.getElementById('kpiAvgScore');
    if (elScore) elScore.innerText = "0%";
    log('No hay datos cargados para calcular indicadores.', 'info');
  }

  renderCharts();
  renderTable();
}

function renderCharts() {
  // Distribución por nivel
  const counts = { Alto: 0, Medio: 0, Bajo: 0 };
  studentsData.forEach(s => counts[s.nivel]++);

  if (charts.dist) charts.dist.destroy();
  charts.dist = new Chart(document.getElementById('chartDistribution'), {
    type: 'doughnut',
    data: { labels: ['Alto', 'Medio', 'Bajo'], datasets: [{ data: [counts.Alto, counts.Medio, counts.Bajo], backgroundColor: ['#ef4444', '#f59e0b', '#10b981'], borderWidth: 0 }] },
    options: { cutout: '75%', plugins: { title: { display: true, text: 'Distribución de Riesgo' } } }
  });

  // Radar de categorías
  const getAvg = (k) => {
    if (!studentsData.length) return 0;
    const avg = studentsData.reduce((a, b) => a + Math.max(0, Number(b.res[k] || 2.5)), 0) / studentsData.length;
    return Number(avg.toFixed(2));
  };
  if (charts.cat) charts.cat.destroy();
  charts.cat = new Chart(document.getElementById('chartCategories'), {
    type: 'radar',
    data: {
      labels: ['Académico', 'Permanencia', 'Salud Mental', 'Económico', 'Entorno'],
      datasets: [{ label: 'Promedio de Riesgo', data: [getAvg('academic'), getAvg('permanence'), getAvg('wellbeing'), getAvg('socioeconomic'), getAvg('health_family')], borderColor: '#fb923c', backgroundColor: 'rgba(251,146,60,0.2)', borderWidth: 3 }]
    },
    options: { scales: { r: { min: 0, max: 5 } } }
  });

  // Nuevo: gráfico horizontal por Facultad / Centro (totales y porcentajes)
  // Calcular totales por facultad ordenados
  const total = studentsData.length;
  const facultyCounts = {};
  studentsData.forEach(s => {
    const key = s.facultad || 'N/A';
    facultyCounts[key] = (facultyCounts[key] || 0) + 1;
  });
  const facultyEntries = Object.entries(facultyCounts).sort((a, b) => b[1] - a[1]);
  const labels = facultyEntries.map(e => e[0]);
  const values = facultyEntries.map(e => e[1]);
  const percentages = facultyEntries.map(e => total ? ((e[1] / total) * 100).toFixed(1) : 0);

  // Preparar dataset que muestra barras con cantidad y etiquetas de porcentaje
  if (charts.faculty) charts.faculty.destroy();
  const ctx = document.getElementById('chartByFaculty');
  charts.faculty = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [{
        label: 'Total estudiantes',
        data: values,
        backgroundColor: labels.map((l, i) => {
          // tonos alternados para legibilidad
          return i % 2 === 0 ? 'rgba(79,70,229,0.85)' : 'rgba(251,146,60,0.85)';
        })
      }]
    },
    options: {
      indexAxis: 'y',
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: function(context) {
              const count = context.parsed.x !== undefined ? context.parsed.x : context.parsed.y;
              const pct = total ? ((count / total) * 100).toFixed(1) : 0;
              return `${count} — ${pct}%`;
            }
          }
        },
        title: { display: false }
      },
      scales: {
        x: {
          beginAtZero: true,
          ticks: {
            callback: function(value) { return value; }
          }
        }
      }
    }
  });

  // Añadir etiquetas de porcentaje en el eje derecho (usando Chart.js tooltip for now)
  // (Si se quiere mostrar porcentajes en barra, se puede habilitar chartjs-plugin-datalabels; por simplicidad se usan tooltips.)
}

function renderTable() {
  const body = document.getElementById('studentTableBody');
  const facF = document.getElementById('filterFacultad') ? document.getElementById('filterFacultad').value : 'all';
  const carrF = document.getElementById('filterCarrera') ? document.getElementById('filterCarrera').value : 'all';
  const riskF = document.getElementById('filterRiesgo') ? document.getElementById('filterRiesgo').value : 'all';
  const filtered = studentsData.filter(s =>
    (facF === 'all' || s.facultad === facF) &&
    (carrF === 'all' || s.carrera === carrF) &&
    (riskF === 'all' || s.nivel === riskF)
  );
  document.getElementById('studentCount').innerText = `(${filtered.length})`;
  body.innerHTML = '';
  if (!filtered.length) {
    body.innerHTML = '<tr><td colspan="8" class="p-8 text-center text-slate-400">No hay registros que coincidan.</td></tr>';
    return;
  }
  filtered.forEach(s => {
    let riskColor = s.nivel === "Alto" ? "text-red-600" : (s.nivel === "Medio" ? "text-orange-500" : "text-green-600");
    const tr = document.createElement('tr');
    tr.onclick = () => openStudentModal(s);
    tr.className = "hover:bg-slate-50 transition-all border-b group cursor-pointer";
    tr.innerHTML = `
      <td class="p-6"><div class="font-bold text-slate-800 text-sm">${s.nombre}</div><div class="text-[9px] text-slate-400 font-bold uppercase">${s.facultad}</div></td>
      <td class="p-6">${getRiskBar(s.res.academic)}</td>
      <td class="p-6">${getRiskBar(s.res.permanence)}</td>
      <td class="p-6">${getRiskBar(s.res.wellbeing)}</td>
      <td class="p-6">${getRiskBar(s.res.socioeconomic)}</td>
      <td class="p-6">${getRiskBar(s.res.health_family)}</td>
      <td class="p-6 text-center text-xs font-black text-indigo-700">${s.score10.toFixed(1)}</td>
      <td class="p-6 text-center"><span class="text-sm font-black uppercase ${riskColor}">${s.nivel}</span></td>
    `;
    body.appendChild(tr);
  });
}

function getRiskBar(val) {
  let s10 = val * 2;
  let color = "#10b981";
  if (s10 >= 7.0) color = "#ef4444";
  else if (s10 >= 4.0) color = "#f59e0b"; // usar 4.0 para consistencia con umbrales de nivel Medio
  return `<div class="mini-bar"><div class="mini-bar-fill" style="width:${(val/5)*100}%;background:${color}"></div></div>`;
}

function openStudentModal(s) {
  selectedStudent = s;
  document.getElementById('modalName').innerText = s.nombre;
  document.getElementById('modalFaculty').innerText = s.facultad;
  document.getElementById('modalCareer').innerText = s.carrera;
  document.getElementById('modalEmail').innerText = s.email_display;
  document.getElementById('modalCarnet').innerText = s.carnet;
  document.getElementById('modalRiskScoreDisplay').innerText = s.score10.toFixed(1) + "/10";

  let badgeColor = s.nivel === "Alto" ? "text-red-600" : (s.nivel === "Medio" ? "text-orange-500" : "text-green-600");
  const badge = document.getElementById('modalRiskBadge');
  badge.innerText = s.nivel;
  badge.className = `inline-block px-5 py-2 rounded-full text-sm font-black uppercase ${badgeColor}`;

  const details = document.getElementById('modalIndicatorsDetails');

  // Construir lista de tarjetas incluyendo una primera tarjeta de "Riesgo Promedio" del estudiante
  const indicators = [
    { label: "Riesgo Promedio", val: s.score10 / 10, desc: "Promedio global de riesgo del estudiante en escala 0–10.", isRiskSummary: true },
    { label: "Académico", val: s.res.academic, desc: "Hábitos y organización de estudio." },
    { label: "Permanencia", val: s.res.permanence, desc: "Análisis de intención de deserción." },
    { label: "Salud Mental", val: s.res.wellbeing, desc: "Psicología y carga emocional." },
    { label: "Economía", val: s.res.socioeconomic, desc: "Vulnerabilidad de pagos." },
    { label: "Entorno", val: s.res.health_family, desc: "Soporte en el hogar." }
  ];

  details.innerHTML = '';
  indicators.forEach(i => {
    // si es la tarjeta resumen de riesgo mostramos el valor directamente en /10 y un breve subtítulo específico
    if (i.isRiskSummary) {
      const scoreDisplay = s.score10.toFixed(1);
      const colorClass = scoreDisplay >= 7.0 ? "text-red-600" : (scoreDisplay >= 4.0 ? "text-orange-600" : "text-green-600");
      details.innerHTML += `
        <div class="p-5 bg-white rounded-3xl border shadow-sm text-xs col-span-1">
          <div class="flex justify-between items-start mb-2">
            <div>
              <span class="font-black text-slate-500 uppercase">${i.label}</span>
              <div class="text-[11px] text-slate-400 italic mt-1">${i.desc}</div>
            </div>
            <div class="text-right">
              <div class="text-2xl font-black ${colorClass}">${scoreDisplay}/10</div>
              <div class="text-[10px] text-slate-400 mt-1">RedFlags: <span class="font-bold text-slate-700">${s.redFlags}</span></div>
            </div>
          </div>
          <div class="mini-bar mt-3"><div class="mini-bar-fill" style="width:${(s.score10/10)*100}%;background:${colorClass === 'text-red-600' ? '#ef4444' : (colorClass === 'text-orange-600' ? '#f59e0b' : '#10b981')}"></div></div>
        </div>
      `;
      return;
    }

    let ic = (i.val*2) >= 7.0 ? "text-red-600" : ((i.val*2) >= 4.0 ? "text-orange-600" : "text-green-600");
    details.innerHTML += `<div class="p-5 bg-slate-50 rounded-3xl border shadow-sm text-xs"><div class="flex justify-between items-center mb-1"><span class="font-black text-slate-500 uppercase">${i.label}</span><span class="font-black ${ic}">${(i.val*2).toFixed(1)}/10</span></div><p class="opacity-60 text-[10px] leading-tight italic">${i.desc}</p></div>`;
  });

  // removed reference to non-existent aiPlanContainer (no AI plan button in current UI)

  if (modalChartInstance) modalChartInstance.destroy();
  modalChartInstance = new Chart(document.getElementById('modalRadarChart'), {
    type: 'radar',
    data: { labels: ['Académico','Permanencia','Salud Mental','Económico','Entorno'], datasets: [{ data: [Math.max(0, s.res.academic), Math.max(0, s.res.permanence), Math.max(0, s.res.wellbeing), Math.max(0, s.res.socioeconomic), Math.max(0, s.res.health_family)], backgroundColor: 'rgba(79,70,229,0.2)', borderColor: '#4338ca', borderWidth: 2 }] },
    // enforce non-negative radial axis baseline
    options: { scales: { r: { min: 0, max: 5 } }, plugins: { legend: { display: false } } }
  });

  document.getElementById('studentModal').classList.add('show');
}

function closeModal(e) { if (!e || e.target === document.getElementById('studentModal')) document.getElementById('studentModal').classList.remove('show'); }
function showSection(id) {
  document.querySelectorAll('.tab-content').forEach(s => s.classList.add('hidden'));
  document.querySelectorAll('.sidebar-item').forEach(b => b.classList.remove('active'));
  const sec = document.getElementById(`section-${id}`);
  const btn = document.getElementById(`btn-${id}`);
  if (sec) sec.classList.remove('hidden');
  if (btn) btn.classList.add('active');
}
function toggleTools() { document.getElementById('toolsDropdown').classList.toggle('show'); }
const log = (msg, type = 'info') => {
  const c = document.getElementById('consoleLog');
  if (!c) return;
  // Etiquetas de tipo en español
  const typeMap = {
    info: 'INFO',
    error: 'ERROR',
    success: 'ÉXITO',
    calc: 'CÁLCULO'
  };
  const label = typeMap[type] || type.toUpperCase();
  // Timestamp breve HH:MM:SS
  const now = new Date();
  const ts = now.toLocaleTimeString('es-ES', { hour12: false });
  // Escapar contenido mínimo para evitar inyección accidental
  const safeMsg = String(msg).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  c.innerHTML += `<div class="text-xs"><span class="text-slate-400">[${ts}]</span> <strong>[${label}]</strong> ${safeMsg}</div>`;
  c.scrollTop = c.scrollHeight;
};

/* ------------------------------------------------------------
   Inicialización y nota de versión en consola
   ------------------------------------------------------------
   A continuación se asegura que el log inicial muestre la versión actual
   (actualizado a 7.3) para que la trazabilidad quede explícita en el UI.
*/
function clearConsole() { document.getElementById('consoleLog').innerHTML = '› Consola limpiada.'; }

document.getElementById('fileInput').addEventListener('change', (e) => {
  const file = e.target.files[0]; if (!file) return;
  document.getElementById('toolsDropdown').classList.remove('show');
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const workbook = XLSX.read(new Uint8Array(ev.target.result), { type: 'array' });
      const sheetName = workbook.SheetNames[0];
      const json = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: null });
      processFile(json);
      showSection('dashboard');
      log(`Datos analizados: ${file.name}`, 'success');
    } catch (err) {
      log("Error procesando archivo: " + (err.message || err), 'error');
    }
  };
  reader.readAsArrayBuffer(file);
});

/* ------------------------------------------------------------
   Control de UI de Pesos: leer/actualizar inputs y aplicar pesos
   ------------------------------------------------------------ */
function updateWeightsUI() {
  const ids = ['academic','permanence','wellbeing','socioeconomic','health_family'];
  let sum = 0;
  ids.forEach(id => {
    const el = document.getElementById('weight_' + id);
    if (el) {
      el.value = Number(CONFIG.WEIGHTS[id]) || 0;
      sum += Number(el.value) || 0;
    }
  });
  const sumEl = document.getElementById('weightsSum');
  if (sumEl) sumEl.innerText = `${sum}%`;
}

function applyWeightsFromUI() {
  const ids = ['academic','permanence','wellbeing','socioeconomic','health_family'];
  let sum = 0;
  ids.forEach(id => {
    const el = document.getElementById('weight_' + id);
    if (el) {
      const v = Math.max(0, Math.min(100, Number(el.value) || 0));
      CONFIG.WEIGHTS[id] = v;
      sum += v;
    }
  });
  // if sum is zero, restore balanced defaults to avoid division by zero
  if (sum === 0) {
    CONFIG.WEIGHTS = { academic: 20, permanence: 20, wellbeing: 20, socioeconomic: 20, health_family: 20 };
  }
  updateWeightsUI();
  // re-run UI calculations if data already loaded
  if (studentsData.length) {
    // Recalcular puntajes en base a los nuevos pesos utilizando los valores ya normalizados en s.res (0-5)
    studentsData = studentsData.map(s => {
      let weightedBase = 0;
      for (let cat in CONFIG.WEIGHTS) {
        weightedBase += (Number(s.res[cat] || 2.5)) * (CONFIG.WEIGHTS[cat] / 100);
      }
      let totalScoreFinal = Math.max(0, Math.min(5, weightedBase + (s.redFlags * 0.3)));
      s.score10 = totalScoreFinal * 2;

      // Aplicar umbrales configurables y redondeo (usar solo '>' y '<')
      const roundingMode = CONFIG.THRESHOLDS.rounding === 'down' ? 'down' : 'up';
      const factor = 100;
      let roundedScore = s.score10;
      if (roundingMode === 'up') roundedScore = Math.ceil(s.score10 * factor) / factor;
      else roundedScore = Math.floor(s.score10 * factor) / factor;

      const minM = Number(CONFIG.THRESHOLDS.medium_min);
      const maxM = Number(CONFIG.THRESHOLDS.medium_max);

      if (s.redFlags >= 2) s.nivel = "Alto";
      else if (roundedScore > maxM) s.nivel = "Alto";
      else if (roundedScore > minM && roundedScore < maxM) s.nivel = "Medio";
      else s.nivel = "Bajo";

      return s;
    });
    updateUI();
  }
}

document.getElementById('applyWeightsBtn')?.addEventListener('click', () => {
  applyWeightsFromUI();
  document.getElementById('toolsDropdown').classList.remove('show');
});

// Umbrales: interacción con UI para aplicar/leer valores
function updateThresholdsUI() {
  const minEl = document.getElementById('threshold_medium_min');
  const maxEl = document.getElementById('threshold_medium_max');
  const upEl = document.getElementById('round_up');
  const downEl = document.getElementById('round_down');
  if (minEl) minEl.value = Number(CONFIG.THRESHOLDS.medium_min).toFixed(2);
  if (maxEl) maxEl.value = Number(CONFIG.THRESHOLDS.medium_max).toFixed(2);
  if (upEl) upEl.checked = CONFIG.THRESHOLDS.rounding === 'up';
  if (downEl) downEl.checked = CONFIG.THRESHOLDS.rounding === 'down';
}

function applyThresholdsFromUI() {
  const minEl = document.getElementById('threshold_medium_min');
  const maxEl = document.getElementById('threshold_medium_max');
  const roundEl = document.querySelector('input[name="threshold_round"]:checked');
  if (minEl) CONFIG.THRESHOLDS.medium_min = Math.max(0, Math.min(10, Number(minEl.value) || 0)).toFixed(2) * 1;
  if (maxEl) CONFIG.THRESHOLDS.medium_max = Math.max(0, Math.min(10, Number(maxEl.value) || 0)).toFixed(2) * 1;
  if (roundEl) CONFIG.THRESHOLDS.rounding = roundEl.value === 'down' ? 'down' : 'up';

  // Ensure logical ordering: if min >= max, swap to keep consistency
  if (Number(CONFIG.THRESHOLDS.medium_min) >= Number(CONFIG.THRESHOLDS.medium_max)) {
    const a = Number(CONFIG.THRESHOLDS.medium_min), b = Number(CONFIG.THRESHOLDS.medium_max);
    CONFIG.THRESHOLDS.medium_min = Math.min(a, b);
    CONFIG.THRESHOLDS.medium_max = Math.max(a, b);
  }

  updateThresholdsUI();

  // Re-evaluar niveles si hay datos
  if (studentsData.length) {
    studentsData = studentsData.map(s => {
      // recompute nivel using same logic as applyWeightsFromUI
      const roundingMode = CONFIG.THRESHOLDS.rounding === 'down' ? 'down' : 'up';
      const factor = 100;
      let roundedScore = s.score10;
      if (roundingMode === 'up') roundedScore = Math.ceil(s.score10 * factor) / factor;
      else roundedScore = Math.floor(s.score10 * factor) / factor;

      const minM = Number(CONFIG.THRESHOLDS.medium_min);
      const maxM = Number(CONFIG.THRESHOLDS.medium_max);

      if (s.redFlags >= 2) s.nivel = "Alto";
      else if (roundedScore > maxM) s.nivel = "Alto";
      else if (roundedScore > minM && roundedScore < maxM) s.nivel = "Medio";
      else s.nivel = "Bajo";
      return s;
    });
    updateUI();
  }
}

document.getElementById('applyThresholdsBtn')?.addEventListener('click', () => {
  applyThresholdsFromUI();
  document.getElementById('toolsDropdown').classList.remove('show');
});
document.getElementById('resetThresholdsBtn')?.addEventListener('click', () => {
  CONFIG.THRESHOLDS = { medium_min: 4.00, medium_max: 6.90, rounding: 'up' };
  updateThresholdsUI();
});

document.getElementById('resetWeightsBtn')?.addEventListener('click', () => {
  CONFIG.WEIGHTS = { academic: 20, permanence: 20, wellbeing: 20, socioeconomic: 20, health_family: 20 };
  updateWeightsUI();
});

const facEl = document.getElementById('filterFacultad');
const carrEl = document.getElementById('filterCarrera');
const riskEl = document.getElementById('filterRiesgo');

if (facEl && !facEl._hasSimpleListener) { facEl.addEventListener('change', renderTable); facEl._hasSimpleListener = true; }
if (carrEl) carrEl.addEventListener('change', renderTable);
if (riskEl) riskEl.addEventListener('change', renderTable);

window.onclick = (e) => { if (!e.target.closest('#toolsDropdown') && !e.target.closest('button')) document.getElementById('toolsDropdown').classList.remove('show'); };

function exportToExcel() {
  if (!studentsData.length) return;
  const ws = XLSX.utils.json_to_sheet(studentsData.map(s => ({ Nombre: s.nombre, Correo: s.email, Carrera: s.carrera, Facultad: s.facultad, Riesgo: s.nivel, Score_Global: s.score10.toFixed(2) })));
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Resultados");
  XLSX.writeFile(wb, "Reporte_ITCPO_Permanencia.xlsx");
}

/* Expose functions used by inline HTML handlers to global scope (module -> window) */
window.toggleTools = toggleTools;
window.showSection = showSection;
window.openStudentModal = openStudentModal;
window.closeModal = closeModal;
window.exportToExcel = exportToExcel;
window.clearConsole = clearConsole;
// Expose modal for average risk details (used by KPI onclick in HTML)
window.openAvgRiskModal = openAvgRiskModal;
window.closeAvgRiskModal = closeAvgRiskModal;

/* Modal control for average risk details */
function openAvgRiskModal() {
  const el = document.getElementById('avgRiskDetails');
  if (!el) return;
  if (!studentsData.length) {
    el.innerText = 'No hay datos cargados. Cargue un archivo XLSX para ver el detalle del cálculo.';
    document.getElementById('avgRiskModal').classList.remove('hidden');
    return;
  }

  const domains = ['academic','permanence','wellbeing','socioeconomic','health_family'];
  const domainNames = {
    academic: 'Académico',
    permanence: 'Permanencia',
    wellbeing: 'Salud Mental',
    socioeconomic: 'Económico',
    health_family: 'Entorno'
  };

  // 1) medias por dominio (0-5)
  const domainMeans = {};
  domains.forEach(d => {
    const sum = studentsData.reduce((acc, s) => acc + (Number(s.res[d] ?? 2.5)), 0);
    domainMeans[d] = studentsData.length ? (sum / studentsData.length) : 2.5;
  });

  // 2) promedio de score10
  const totalScores = studentsData.reduce((acc, s) => acc + (Number(s.score10) || 0), 0);
  const avgScore10 = studentsData.length ? (totalScores / studentsData.length) : 0;

  // 3) promedio de redFlags
  const avgRedFlags = studentsData.reduce((a,b) => a + (Number(b.redFlags || 0)), 0) / studentsData.length;

  // 4) conteo por nivel
  const counts = { Alto: 0, Medio: 0, Bajo: 0 };
  studentsData.forEach(s => counts[s.nivel]++);

  // 5) Documentar pasos y fórmulas usadas (coherente con procesamiento)
  const lines = [];
  lines.push('Resumen paso a paso del cálculo de "Riesgo promedio":');
  lines.push('');
  lines.push(`Población analizada: ${studentsData.length} estudiantes`);
  lines.push('');
  lines.push('1) Normalización de ítems:');
  lines.push(' - Respuestas tipo Likert o numéricas se normalizan a escala 0–5 (1→0, 3→2.5, 5→5).');
  lines.push(' - Preguntas detectadas como "negativas" mantienen la dirección (mayor valor → mayor riesgo).');
  lines.push(' - Preguntas positivas se invierten en la escala 0–5 (5→0 riesgo).');
  lines.push('');
  lines.push('2) Promedio por dominio (0–5):');
  domains.forEach(d => lines.push(` - ${domainNames[d]}: ${domainMeans[d].toFixed(4)} (media 0–5)`));
  lines.push('');
  lines.push('3) Pesos aplicados a cada dominio:');
  Object.keys(CONFIG.WEIGHTS).forEach(k => lines.push(` - ${domainNames[k] || k}: ${CONFIG.WEIGHTS[k]}%`));
  lines.push('');
  lines.push('4) Cálculo compuesto (0–5):');
  lines.push(' - Para cada estudiante: compuesto = suma( valor_dominio * peso_dominio )  (pesos en fracción)');
  lines.push(' - Se suman ajustes por redFlags: cada redFlag suma +0.3 al compuesto (antes de la unión).');
  lines.push(' - compuesto final = unión(0,5, compuesto + 0.3 * redFlags)');
  lines.push('');
  lines.push('5) Conversión a escala 0–10 y redondeo:');
  lines.push(' - score10 = composite_final * 2');
  lines.push(` - Modo de redondeo actual: "${CONFIG.THRESHOLDS.rounding}" (se aplica a dos decimales).`);
  lines.push('');
  lines.push(`6) Estadísticas poblacionales calculadas:`);
  lines.push(` - Promedio de score (0–10) = ${avgScore10.toFixed(4)}`);
  lines.push(` - Promedio de redFlags por estudiante = ${avgRedFlags.toFixed(4)}`);
  lines.push('');
  lines.push('7) Clasificación por umbrales (comparaciones exclusivas > y <):');
  lines.push(` - Medio: > ${Number(CONFIG.THRESHOLDS.medium_min).toFixed(2)} y < ${Number(CONFIG.THRESHOLDS.medium_max).toFixed(2)}`);
  lines.push(` - Alto: > ${Number(CONFIG.THRESHOLDS.medium_max).toFixed(2)} o >= 2 redFlags`);
  lines.push(` - Bajo: valores que no cumplen las condiciones anteriores`);
  lines.push('');
  lines.push('Conteos por nivel:');
  lines.push(` - Alto: ${counts.Alto}`);
  lines.push(` - Medio: ${counts.Medio}`);
  lines.push(` - Bajo: ${counts.Bajo}`);
  lines.push('');
  lines.push(`Riesgo promedio mostrado en KPI = media aritmética de score10 por estudiante = ${avgScore10.toFixed(4)} → mostrado con 1 decimal: ${avgScore10.toFixed(1)}`);
  lines.push('');
  lines.push('Notas:');
  lines.push(' - Las comparaciones para niveles usan > y < exclusivamente; el redondeo puede afectar en el borde de umbrales.');
  lines.push(' - Si cambia pesos o umbrales, vuelva a aplicar y revise el detalle nuevamente.');

  el.innerText = lines.join('\n');
  document.getElementById('avgRiskModal').classList.remove('hidden');
}

function closeAvgRiskModal(e) {
  if (!e || e.target === document.getElementById('avgRiskModal')) {
    document.getElementById('avgRiskModal').classList.add('hidden');
  }
}

 // Backwards compatibility: callAI disponible globalmente
// Provide a safe stub for callAI so pages expecting it won't throw.
// If a real AI integration is added later, replace this stub with the actual implementation.
window.callAI = async function(prompt, opts = {}) {
  try {
    log('callAI no disponible en este entorno; petición ignorada.', 'info');
  } catch (e) {
    // swallow any logging errors
    console.warn('callAI stub invoked');
  }
  return null;
};

window.addEventListener('load', () => {
  startReel();
  showSection('dashboard');
  updateWeightsUI();
  updateThresholdsUI();
  // Mensaje inicial en consola con versión actualizada
  log('Risk Intelligence cargado y activo. Listo para trabajar.', 'info');
});