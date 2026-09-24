import { useState, useEffect, useCallback } from 'react'
import {
  FileText, Download, RefreshCw, Monitor, Activity,
  CheckCircle2, AlertTriangle, Clock, Server, Filter,
} from 'lucide-react'
import api from '../api/client'

// ── Export helpers ─────────────────────────────────────────────────────────────

function exportCSV(rows, columns, filename) {
  const header = columns.map(c => `"${c.label}"`).join(',')
  const body = rows.map(row =>
    columns.map(c => {
      const v = c.get(row)
      return `"${String(v ?? '').replace(/"/g, '""')}"`
    }).join(',')
  ).join('\n')
  const blob = new Blob([header + '\n' + body], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  URL.revokeObjectURL(url)
}

async function exportXLSX(rows, columns, sheetName, filename) {
  await exportXLSXMulti([{ rows, columns, sheetName }], filename)
}

async function exportXLSXMulti(sheets, filename) {
  const XLSX = await import('xlsx')
  const wb = XLSX.utils.book_new()
  for (const { rows, columns, sheetName, customSheet } of sheets) {
    if (customSheet) {
      XLSX.utils.book_append_sheet(wb, customSheet, sheetName)
      continue
    }
    const wsData = [
      columns.map(c => c.label),
      ...rows.map(row => columns.map(c => c.get(row) ?? '')),
    ]
    const ws = XLSX.utils.aoa_to_sheet(wsData)
    ws['!cols'] = columns.map(c => ({ wch: Math.max(c.label.length, c.minWidth || 15) }))
    XLSX.utils.book_append_sheet(wb, ws, sheetName)
  }
  XLSX.writeFile(wb, filename)
}


async function exportYearlyMonitorReport(year, records) {
  const XLSX = await import('xlsx')
  const wb = XLSX.utils.book_new()

  // Excel serial date helper
  function toXlDate(iso) {
    return Math.round((new Date(iso + 'T00:00:00Z') - new Date('1899-12-30T00:00:00Z')) / 86400000)
  }

  // ISO week number (Mon=start)
  function isoWeek(iso) {
    const d = new Date(iso + 'T00:00:00Z')
    const day = d.getUTCDay() || 7
    d.setUTCDate(d.getUTCDate() + 4 - day)
    const jan1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
    return Math.ceil((((d - jan1) / 86400000) + 1) / 7)
  }

  function dayName(iso) {
    return new Date(iso + 'T00:00:00Z')
      .toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })
  }

  function avg(arr) {
    const valid = arr.filter(v => v != null)
    return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null
  }

  // ── Pre-compute aggregates from raw records ───────────────────────────────

  // By date: average uptime across all monitors
  const byDate = {}
  records.forEach(r => {
    if (!byDate[r.date]) byDate[r.date] = []
    if (r.uptime_pct != null) byDate[r.date].push(r.uptime_pct)
  })

  // By monitor + month: average uptime per month
  const byMonitorMonth = {}   // { monitorName: { 1: [uptimes], 2: [...], ... } }
  records.forEach(r => {
    const month = parseInt(r.date.slice(5, 7), 10)
    if (!byMonitorMonth[r.monitor_name]) byMonitorMonth[r.monitor_name] = {}
    if (!byMonitorMonth[r.monitor_name][month]) byMonitorMonth[r.monitor_name][month] = []
    if (r.uptime_pct != null) byMonitorMonth[r.monitor_name][month].push(r.uptime_pct)
  })

  // ── Sheet 3: Monitor Data (raw) ───────────────────────────────────────────
  const ws3 = XLSX.utils.aoa_to_sheet([
    ['Date','Monitor Name','Type','Category','Host',
     'Total Checks','Up Count','Down Count','Uptime %','Avg Latency (ms)']
  ])
  records.forEach((r, i) => {
    const row = i + 2
    ws3[`A${row}`] = { t: 'n', v: toXlDate(r.date), z: 'yyyy-mm-dd' }
    ws3[`B${row}`] = { t: 's', v: r.monitor_name || '' }
    ws3[`C${row}`] = { t: 's', v: r.subtype?.replace(/_/g, ' ') || r.monitor_type || '' }
    ws3[`D${row}`] = { t: 's', v: r.category || '' }
    ws3[`E${row}`] = { t: 's', v: r.host || '' }
    ws3[`F${row}`] = { t: 'n', v: r.total_checks || 0 }
    ws3[`G${row}`] = { t: 'n', v: r.up_count || 0 }
    ws3[`H${row}`] = { t: 'n', v: r.down_count || 0 }
    ws3[`I${row}`] = r.uptime_pct != null ? { t: 'n', v: r.uptime_pct, z: '0.00' } : { t: 's', v: '' }
    ws3[`J${row}`] = r.avg_latency_ms != null ? { t: 'n', v: r.avg_latency_ms, z: '0.0' } : { t: 's', v: '' }
  })
  ws3['!ref'] = `A1:J${records.length + 1}`
  ws3['!cols'] = [{wch:12},{wch:32},{wch:16},{wch:16},{wch:28},
                  {wch:13},{wch:10},{wch:10},{wch:10},{wch:16}]
  XLSX.utils.book_append_sheet(wb, ws3, 'Monitor Data')

  // ── Sheet 2: Daily Monitor ────────────────────────────────────────────────
  // Values pre-computed in JS; formulas written to formula bar for reference
  const dates = Object.keys(byDate).sort()
  const ws2 = XLSX.utils.aoa_to_sheet([['Date','Day of Week','Week No.','Avg Uptime %']])
  dates.forEach((date, i) => {
    const row     = i + 2
    const dataRow = records.findIndex(r => r.date === date) + 2  // matching row in Monitor Data
    const avgUp   = avg(byDate[date])
    ws2[`A${row}`] = { t: 'n', v: toXlDate(date), z: 'yyyy-mm-dd' }
    ws2[`B${row}`] = { t: 's', v: dayName(date),
                       f: `TEXT(A${row},"dddd")` }
    ws2[`C${row}`] = { t: 'n', v: isoWeek(date),
                       f: `WEEKNUM(A${row},2)` }
    ws2[`D${row}`] = avgUp != null
      ? { t: 'n', v: parseFloat(avgUp.toFixed(2)), z: '0.00',
          f: `AVERAGEIF('Monitor Data'!$A:$A,A${row},'Monitor Data'!$I:$I)` }
      : { t: 's', v: '' }
  })
  ws2['!ref'] = `A1:D${dates.length + 1}`
  ws2['!cols'] = [{wch:14},{wch:14},{wch:10},{wch:14}]
  XLSX.utils.book_append_sheet(wb, ws2, 'Daily Monitor')

  // ── Sheet 1: Monitor Summary ──────────────────────────────────────────────
  const monitorNames = Object.keys(byMonitorMonth).sort()
  const monthLabels  = ['Jan','Feb','Mar','Apr','May','Jun',
                        'Jul','Aug','Sep','Oct','Nov','Dec']
  const ws1 = XLSX.utils.aoa_to_sheet([['Monitor Name', ...monthLabels, 'Yearly Avg']])
  monitorNames.forEach((name, i) => {
    const row = i + 2
    ws1[`A${row}`] = { t: 's', v: name }
    const monthAvgs = []
    monthLabels.forEach((_, mIdx) => {
      const col   = String.fromCharCode(66 + mIdx)   // B=Jan … M=Dec
      const m     = mIdx + 1
      const vals  = byMonitorMonth[name][m] || []
      const mAvg  = avg(vals)
      const d1    = `DATE(${year},${m},1)`
      const d2    = m === 12 ? `DATE(${year + 1},1,1)` : `DATE(${year},${m + 1},1)`
      const f     = `IFERROR(AVERAGEIFS('Monitor Data'!$I:$I,` +
                    `'Monitor Data'!$B:$B,$A${row},` +
                    `'Monitor Data'!$A:$A,">="&${d1},` +
                    `'Monitor Data'!$A:$A,"<"&${d2}),"")`
      if (mAvg != null) {
        ws1[`${col}${row}`] = { t: 'n', v: parseFloat(mAvg.toFixed(2)), z: '0.00', f }
        monthAvgs.push(mAvg)
      } else {
        ws1[`${col}${row}`] = { t: 's', v: '' }
      }
    })
    const yAvg = avg(monthAvgs)
    ws1[`N${row}`] = yAvg != null
      ? { t: 'n', v: parseFloat(yAvg.toFixed(2)), z: '0.00',
          f: `IFERROR(AVERAGE(B${row}:M${row}),"")` }
      : { t: 's', v: '' }
  })
  // Average monthly total row — average across all monitors per month
  const avgRow = monitorNames.length + 2
  ws1[`A${avgRow}`] = { t: 's', v: 'Monthly Average' }
  const allMonthAvgs = []
  monthLabels.forEach((_, mIdx) => {
    const col   = String.fromCharCode(66 + mIdx)
    const m     = mIdx + 1
    const vals  = monitorNames.flatMap(name => byMonitorMonth[name][m] || [])
    const mAvg  = avg(vals)
    const dataCol = col  // same column letter, rows 2 to avgRow-1
    const f = `IFERROR(AVERAGE(${col}2:${col}${avgRow - 1}),"")`
    if (mAvg != null) {
      ws1[`${col}${avgRow}`] = { t: 'n', v: parseFloat(mAvg.toFixed(2)), z: '0.00', f }
      allMonthAvgs.push(mAvg)
    } else {
      ws1[`${col}${avgRow}`] = { t: 's', v: '' }
    }
  })
  const overallAvg = avg(allMonthAvgs)
  ws1[`N${avgRow}`] = overallAvg != null
    ? { t: 'n', v: parseFloat(overallAvg.toFixed(2)), z: '0.00',
        f: `IFERROR(AVERAGE(N2:N${avgRow - 1}),"")` }
    : { t: 's', v: '' }

  ws1['!ref'] = `A1:N${avgRow}`
  ws1['!cols'] = [{wch:32}, ...monthLabels.map(() => ({wch:8})), {wch:12}]
  XLSX.utils.book_append_sheet(wb, ws1, 'Monitor Summary')

  XLSX.writeFile(wb, `kifaa-yearly-monitor-${year}.xlsx`)
}

async function generateExecutivePDF(dash, agents, ts) {
  const { default: jsPDF } = await import('jspdf')
  const { default: autoTable } = await import('jspdf-autotable')

  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' })
  const W = 595.28
  const M = 36
  const CW = W - M * 2

  const cats = dash.categories || {}
  const total = agents.length
  const compliantCount = agents.filter(a => a.compliant).length
  const nonCompliant = total - compliantCount
  const overall = dash.overall ?? 0
  const critCVEs = cats.vulnerability?.critical_open ?? 0
  const highCVEs = cats.vulnerability?.high_open ?? 0
  const configPass = cats.configuration?.passed ?? 0
  const configTotal = cats.configuration?.total ?? 0
  const configFail = configTotal - configPass

  // Helper: parse 6-char hex to [r,g,b]
  const rgb = h => [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)]
  const scoreColor = s => s >= 80 ? '16A34A' : s >= 60 ? 'D97706' : 'DC2626'
  const scoreLight  = s => s >= 80 ? 'F0FDF4' : s >= 60 ? 'FFFBEB' : 'FEF2F2'

  let y = 0

  // ─────────────────────────────────────────────────────────────────────
  // 1. HEADER BAR
  // ─────────────────────────────────────────────────────────────────────
  doc.setFillColor(...rgb('1E3A5F'))
  doc.rect(0, 0, W, 62, 'F')

  doc.setFontSize(17)
  doc.setFont('helvetica', 'bold')
  doc.setTextColor(255, 255, 255)
  doc.text('SECURITY COMPLIANCE', M, 26)
  doc.text('EXECUTIVE SUMMARY', M, 44)

  doc.setFontSize(8.5)
  doc.setFont('helvetica', 'normal')
  doc.setTextColor(...rgb('94A3B8'))
  doc.text('Kenyanut Limited  ·  Kifaa Security Platform', W - M, 26, { align: 'right' })
  doc.text(`${ts}  ·  CONFIDENTIAL`, W - M, 44, { align: 'right' })

  y = 74

  // ─────────────────────────────────────────────────────────────────────
  // 2. OVERALL STATUS BANNER  (gauge circle + status text)
  // ─────────────────────────────────────────────────────────────────────
  const isCompliant = dash.compliant
  const bannerBg  = isCompliant ? 'F0FDF4' : 'FEF2F2'
  const bannerBdr = isCompliant ? '16A34A' : 'DC2626'

  doc.setFillColor(...rgb(bannerBg))
  doc.roundedRect(M, y, CW, 70, 6, 6, 'F')
  doc.setDrawColor(...rgb(bannerBdr))
  doc.setLineWidth(1.5)
  doc.roundedRect(M, y, CW, 70, 6, 6, 'S')

  // Gauge: outer ring
  const cx = M + 46, cy = y + 35
  doc.setFillColor(...rgb(bannerBdr))
  doc.circle(cx, cy, 30, 'F')
  // Inner white circle
  doc.setFillColor(255, 255, 255)
  doc.circle(cx, cy, 19, 'F')
  // Score number inside
  doc.setFontSize(11)
  doc.setFont('helvetica', 'bold')
  doc.setTextColor(...rgb(bannerBdr))
  doc.text(`${overall}%`, cx, cy + 4, { align: 'center' })

  // Status label
  doc.setFontSize(20)
  doc.setFont('helvetica', 'bold')
  doc.setTextColor(...rgb(bannerBdr))
  doc.text(isCompliant ? 'COMPLIANT' : 'NON-COMPLIANT', M + 88, y + 28)

  doc.setFontSize(9)
  doc.setFont('helvetica', 'normal')
  doc.setTextColor(...rgb('475569'))
  doc.text(
    `${total} endpoints monitored  ·  ${compliantCount} compliant  ·  ${nonCompliant} require attention`,
    M + 88, y + 50
  )

  y += 82

  // ─────────────────────────────────────────────────────────────────────
  // 3. KPI TILES  (2 rows × 4 cols)
  // ─────────────────────────────────────────────────────────────────────
  const kpis = [
    { label: 'Overall Score',    value: `${overall}%`,   color: scoreColor(overall),     light: scoreLight(overall) },
    { label: 'Critical CVEs',    value: critCVEs,         color: critCVEs  === 0 ? '16A34A' : 'DC2626', light: critCVEs  === 0 ? 'F0FDF4' : 'FEF2F2' },
    { label: 'Config Failures',  value: configFail,       color: configFail === 0 ? '16A34A' : configFail <= 10 ? 'D97706' : 'DC2626', light: configFail === 0 ? 'F0FDF4' : configFail <= 10 ? 'FFFBEB' : 'FEF2F2' },
    { label: 'Non-Compliant',    value: nonCompliant,     color: nonCompliant === 0 ? '16A34A' : 'DC2626', light: nonCompliant === 0 ? 'F0FDF4' : 'FEF2F2' },
    { label: 'Total Endpoints',  value: total,            color: '1E3A5F', light: 'EFF6FF' },
    { label: 'High CVEs',        value: highCVEs,         color: highCVEs === 0 ? '16A34A' : 'D97706', light: highCVEs === 0 ? 'F0FDF4' : 'FFFBEB' },
    { label: 'Config Passed',    value: configPass,       color: configPass >= configTotal * 0.9 ? '16A34A' : 'D97706', light: configPass >= configTotal * 0.9 ? 'F0FDF4' : 'FFFBEB' },
    { label: 'Compliant',        value: compliantCount,   color: compliantCount === total ? '16A34A' : 'D97706', light: compliantCount === total ? 'F0FDF4' : 'FFFBEB' },
  ]

  const tileW = (CW - 9) / 4
  const tileH = 74

  kpis.forEach((k, i) => {
    const col = i % 4
    const row2 = Math.floor(i / 4)
    const tx = M + col * (tileW + 3)
    const ty = y + row2 * (tileH + 4)

    doc.setFillColor(...rgb(k.light))
    doc.roundedRect(tx, ty, tileW, tileH, 5, 5, 'F')
    doc.setDrawColor(...rgb('E2E8F0'))
    doc.setLineWidth(0.5)
    doc.roundedRect(tx, ty, tileW, tileH, 5, 5, 'S')

    // Colored top accent bar
    doc.setFillColor(...rgb(k.color))
    doc.roundedRect(tx, ty, tileW, 4, 2, 2, 'F')
    doc.rect(tx, ty + 2, tileW, 2, 'F')

    doc.setFontSize(24)
    doc.setFont('helvetica', 'bold')
    doc.setTextColor(...rgb(k.color))
    doc.text(String(k.value), tx + tileW / 2, ty + 44, { align: 'center' })

    doc.setFontSize(7.5)
    doc.setFont('helvetica', 'normal')
    doc.setTextColor(...rgb('64748B'))
    doc.text(k.label.toUpperCase(), tx + tileW / 2, ty + 62, { align: 'center' })
  })

  y += 2 * (tileH + 4) + 18

  // ─────────────────────────────────────────────────────────────────────
  // 4. CATEGORY SCORECARD TABLE
  // ─────────────────────────────────────────────────────────────────────
  doc.setFontSize(10)
  doc.setFont('helvetica', 'bold')
  doc.setTextColor(...rgb('1E3A5F'))
  doc.text('COMPLIANCE CATEGORY SCORECARD', M, y)
  doc.setDrawColor(...rgb('1E3A5F'))
  doc.setLineWidth(1)
  doc.line(M, y + 3, M + CW, y + 3)
  y += 10

  const catRows = [
    { name: 'Patch & Update Compliance',  key: 'patch',         weight: 35, target: cats.patch?.target ?? 95 },
    { name: 'Vulnerability Management',   key: 'vulnerability', weight: 25, target: 100 },
    { name: 'Configuration Compliance',   key: 'configuration', weight: 20, target: cats.configuration?.target ?? 90 },
    { name: 'Endpoint Protection',        key: 'protection',    weight: 10, target: 100 },
    { name: 'License Compliance',         key: 'license',       weight: 10, target: 100 },
  ]

  autoTable(doc, {
    startY: y,
    head: [['Category', 'Weight', 'Score', 'Target', 'Status', 'Contribution']],
    body: catRows.map(cat => {
      const score = cats[cat.key]?.score ?? 0
      const contrib = (score * cat.weight / 100).toFixed(1) + '%'
      return [cat.name, `${cat.weight}%`, `${score}%`, `${cat.target}%`, score >= cat.target ? 'PASS' : 'FAIL', contrib]
    }),
    foot: [['OVERALL COMPLIANCE', '100%', `${overall}%`, '80%', isCompliant ? 'COMPLIANT' : 'NON-COMPLIANT', `${overall}%`]],
    headStyles: { fillColor: rgb('1E3A5F'), textColor: [255,255,255], fontSize: 8, fontStyle: 'bold', halign: 'center' },
    bodyStyles: { fontSize: 9, textColor: rgb('1E293B'), halign: 'center' },
    footStyles: { fillColor: rgb('EFF6FF'), textColor: rgb('1E3A5F'), fontSize: 9, fontStyle: 'bold', halign: 'center' },
    alternateRowStyles: { fillColor: rgb('F8FAFC') },
    columnStyles: { 0: { cellWidth: 170, halign: 'left' }, 2: { fontStyle: 'bold' }, 4: { fontStyle: 'bold' } },
    margin: { left: M, right: M },
    didParseCell: data => {
      if (data.section !== 'body') return
      const cat = catRows[data.row.index]
      if (!cat) return
      const score = cats[cat.key]?.score ?? 0
      if (data.column.index === 2) {
        data.cell.styles.textColor = rgb(scoreColor(score))
        data.cell.styles.fontStyle = 'bold'
      }
      if (data.column.index === 4) {
        const pass = score >= cat.target
        data.cell.styles.fillColor = pass ? rgb('DCFCE7') : rgb('FEE2E2')
        data.cell.styles.textColor = pass ? rgb('166534') : rgb('991B1B')
        data.cell.styles.fontStyle = 'bold'
      }
    },
  })

  y = doc.lastAutoTable.finalY + 20

  // ─────────────────────────────────────────────────────────────────────
  // 5. SCORE PROGRESS BARS
  // ─────────────────────────────────────────────────────────────────────
  doc.setFontSize(10)
  doc.setFont('helvetica', 'bold')
  doc.setTextColor(...rgb('1E3A5F'))
  doc.text('SCORE VISUALISATION', M, y)
  doc.setDrawColor(...rgb('1E3A5F'))
  doc.setLineWidth(1)
  doc.line(M, y + 3, M + CW, y + 3)
  y += 14

  const barMaxW = CW - 220
  const barH = 16

  catRows.forEach(cat => {
    const score = cats[cat.key]?.score ?? 0
    const col = scoreColor(score)
    const fillW = Math.max(0, (score / 100) * barMaxW)
    const targetX = M + 170 + (cat.target / 100) * barMaxW

    // Label
    doc.setFontSize(8.5)
    doc.setFont('helvetica', 'normal')
    doc.setTextColor(...rgb('374151'))
    doc.text(cat.name, M, y + barH - 3)

    // BG track
    doc.setFillColor(...rgb('E2E8F0'))
    doc.roundedRect(M + 170, y, barMaxW, barH, 3, 3, 'F')

    // Fill
    if (fillW > 0) {
      doc.setFillColor(...rgb(col))
      doc.roundedRect(M + 170, y, fillW, barH, 3, 3, 'F')
    }

    // Target marker
    doc.setDrawColor(...rgb('1E3A5F'))
    doc.setLineWidth(1.5)
    doc.line(targetX, y - 3, targetX, y + barH + 3)

    // Target label (tiny, above)
    doc.setFontSize(6)
    doc.setTextColor(...rgb('64748B'))
    doc.text(`${cat.target}%`, targetX, y - 5, { align: 'center' })

    // Score text
    doc.setFontSize(8.5)
    doc.setFont('helvetica', 'bold')
    doc.setTextColor(...rgb(col))
    doc.text(`${score}%`, M + 170 + barMaxW + 10, y + barH - 3)

    y += barH + 10
  })

  y += 8

  // ─────────────────────────────────────────────────────────────────────
  // 6. FOOTER
  // ─────────────────────────────────────────────────────────────────────
  const pgH = 841.89
  doc.setFillColor(...rgb('1E3A5F'))
  doc.rect(0, pgH - 28, W, 28, 'F')
  doc.setFontSize(8)
  doc.setFont('helvetica', 'italic')
  doc.setTextColor(...rgb('94A3B8'))
  doc.text(
    `Generated by Kifaa Security Platform  ·  ${ts}  ·  CONFIDENTIAL — For executive use only`,
    W / 2, pgH - 10, { align: 'center' }
  )

  return doc
}

// ── Executive Dashboard XLSX (ExcelJS – full styling) ─────────────────────────
// extras = { vulns:[], misconfigs:[], licenses:[], highRisk:[] }
async function generateExecutiveDashboardXLSX(dash, agents, ts, extras, allSheets, filename) {
  const ExcelJS = await import('exceljs')
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Kifaa Security Platform'
  wb.created = new Date()

  const cats = dash.categories || {}
  const total = agents.length
  const compliantCount = agents.filter(a => a.compliant).length
  const nonCompliant = total - compliantCount
  const overall = dash.overall ?? 0
  const critCVEs = cats.vulnerability?.critical_open ?? 0
  const highCVEs = cats.vulnerability?.high_open ?? 0
  const configPass = cats.configuration?.passed ?? 0
  const configTotal = cats.configuration?.total ?? 0
  const configFail = configTotal - configPass
  const isCompliant = dash.compliant

  // ── Colour helpers ────────────────────────────────────────────────────────
  const scoreCol  = s => s >= 80 ? '16A34A' : s >= 60 ? 'D97706' : 'DC2626'
  const scoreBg   = s => s >= 80 ? 'DCFCE7' : s >= 60 ? 'FEF3C7' : 'FEE2E2'
  const argb = h => `FF${h.toUpperCase()}`

  const NAVY      = argb('1E3A5F')
  const NAVY_MID  = argb('2D5F8A')
  const SLATE_BG  = argb('F8FAFC')
  const WHITE     = argb('FFFFFF')
  const RED_BG    = argb('FEF2F2')
  const RED_TEXT  = argb('DC2626')
  const GREEN_BG  = argb('F0FDF4')
  const GREEN_TXT = argb('16A34A')
  const SLATE_TXT = argb('64748B')
  const DARK_TXT  = argb('1E293B')

  const fill = (hex) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: hex } })
  const font = (bold, sz, hex, italic = false) => ({ bold, size: sz, color: { argb: hex }, name: 'Calibri', italic })
  const align = (h = 'left', v = 'middle', wrap = false) => ({ horizontal: h, vertical: v, wrapText: wrap })
  const border = (style = 'thin', hex = 'E2E8F0') => ({ style, color: { argb: argb(hex) } })
  const allBorder = (style = 'thin', hex = 'E2E8F0') => ({
    top: border(style, hex), bottom: border(style, hex),
    left: border(style, hex), right: border(style, hex),
  })

  const applyCell = (ws, addr, value, opts = {}) => {
    const c = ws.getCell(addr)
    c.value = value
    if (opts.fill) c.fill = opts.fill
    if (opts.font) c.font = opts.font
    if (opts.align) c.alignment = opts.align
    if (opts.border) c.border = opts.border
    if (opts.numFmt) c.numFmt = opts.numFmt
    return c
  }

  // ── SHEET 1: Executive Dashboard ─────────────────────────────────────────
  const ws = wb.addWorksheet('Executive Dashboard', { views: [{ showGridLines: false }] })

  // Column widths
  ws.columns = [
    { key: 'A', width: 3 },   // margin
    { key: 'B', width: 28 },
    { key: 'C', width: 14 },
    { key: 'D', width: 14 },
    { key: 'E', width: 14 },
    { key: 'F', width: 14 },
    { key: 'G', width: 14 },
    { key: 'H', width: 14 },
    { key: 'I', width: 14 },
    { key: 'J', width: 3 },   // margin
  ]

  let r = 1

  // ── ROW 1-2: Header bar ──────────────────────────────────────────────────
  ws.getRow(r).height = 22
  ws.mergeCells(`A${r}:J${r}`)
  applyCell(ws, `A${r}`, null, { fill: fill(NAVY) })
  r++
  ws.getRow(r).height = 28
  ws.mergeCells(`B${r}:F${r}`)
  applyCell(ws, `B${r}`, 'SECURITY COMPLIANCE EXECUTIVE SUMMARY', {
    fill: fill(NAVY), font: font(true, 16, WHITE), align: align('left', 'middle'),
  })
  ws.mergeCells(`G${r}:I${r}`)
  applyCell(ws, `G${r}`, 'Kenyanut Limited  ·  Kifaa Security Platform', {
    fill: fill(NAVY), font: font(false, 8, '94A3B8'), align: align('right', 'middle'),
  })
  applyCell(ws, `A${r}`, null, { fill: fill(NAVY) })
  applyCell(ws, `J${r}`, null, { fill: fill(NAVY) })
  r++
  ws.getRow(r).height = 18
  ws.mergeCells(`B${r}:F${r}`)
  applyCell(ws, `B${r}`, 'Prepared by Kifaa Security Platform', {
    fill: fill(NAVY), font: font(false, 8, '94A3B8'), align: align('left', 'middle'),
  })
  ws.mergeCells(`G${r}:I${r}`)
  applyCell(ws, `G${r}`, `${ts}  ·  CONFIDENTIAL`, {
    fill: fill(NAVY), font: font(false, 8, 'EF4444'), align: align('right', 'middle'),
  })
  applyCell(ws, `A${r}`, null, { fill: fill(NAVY) })
  applyCell(ws, `J${r}`, null, { fill: fill(NAVY) })
  r++

  // ── ROW: Spacer ──────────────────────────────────────────────────────────
  ws.getRow(r).height = 8
  r++

  // ── STATUS BANNER ────────────────────────────────────────────────────────
  const bannerBg  = isCompliant ? GREEN_BG  : RED_BG
  const bannerTxt = isCompliant ? GREEN_TXT : RED_TEXT
  ws.getRow(r).height = 16
  ws.mergeCells(`B${r}:I${r}`)
  applyCell(ws, `B${r}`, null, { fill: fill(bannerBg) })
  r++

  ws.getRow(r).height = 40
  // Score circle (simulated with colored cell)
  applyCell(ws, `B${r}`, `${overall}%`, {
    fill: fill(argb(isCompliant ? '16A34A' : 'DC2626')),
    font: font(true, 16, WHITE), align: align('center', 'middle'),
    border: allBorder('medium', isCompliant ? '16A34A' : 'DC2626'),
  })
  ws.mergeCells(`C${r}:E${r}`)
  applyCell(ws, `C${r}`, isCompliant ? 'COMPLIANT' : 'NON-COMPLIANT', {
    fill: fill(bannerBg),
    font: font(true, 20, isCompliant ? '16A34A' : 'DC2626'),
    align: align('left', 'middle'),
  })
  ws.mergeCells(`F${r}:I${r}`)
  applyCell(ws, `F${r}`, `${total} endpoints  ·  ${compliantCount} compliant  ·  ${nonCompliant} require attention`, {
    fill: fill(bannerBg), font: font(false, 9, '475569'), align: align('right', 'middle'),
  })
  r++

  ws.getRow(r).height = 16
  ws.mergeCells(`B${r}:I${r}`)
  applyCell(ws, `B${r}`, null, { fill: fill(bannerBg) })
  r++

  // ── ROW: Spacer ──────────────────────────────────────────────────────────
  ws.getRow(r).height = 8
  r++

  // ── KPI TILES – ROW 1 ────────────────────────────────────────────────────
  const kpis1 = [
    { label: 'OVERALL SCORE',    value: `${overall}%`,   color: scoreCol(overall),  bg: scoreBg(overall) },
    { label: 'CRITICAL CVEs',    value: critCVEs,         color: critCVEs  === 0 ? '16A34A' : 'DC2626',  bg: critCVEs  === 0 ? 'DCFCE7' : 'FEE2E2' },
    { label: 'CONFIG FAILURES',  value: configFail,       color: configFail === 0 ? '16A34A' : configFail <= 10 ? 'D97706' : 'DC2626', bg: configFail === 0 ? 'DCFCE7' : configFail <= 10 ? 'FEF3C7' : 'FEE2E2' },
    { label: 'NON-COMPLIANT',    value: nonCompliant,     color: nonCompliant === 0 ? '16A34A' : 'DC2626', bg: nonCompliant === 0 ? 'DCFCE7' : 'FEE2E2' },
  ]
  const kpis2 = [
    { label: 'TOTAL ENDPOINTS',  value: total,            color: '1E3A5F', bg: 'EFF6FF' },
    { label: 'HIGH CVEs',        value: highCVEs,         color: highCVEs === 0 ? '16A34A' : 'D97706',  bg: highCVEs === 0 ? 'DCFCE7' : 'FEF3C7' },
    { label: 'CONFIG PASSED',    value: configPass,       color: configPass >= configTotal * 0.9 ? '16A34A' : 'D97706', bg: configPass >= configTotal * 0.9 ? 'DCFCE7' : 'FEF3C7' },
    { label: 'COMPLIANT',        value: compliantCount,   color: compliantCount === total ? '16A34A' : 'D97706', bg: compliantCount === total ? 'DCFCE7' : 'FEF3C7' },
  ]

  const tileColumns = ['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']

  const drawKpiRow = (kpis, startRow) => {
    const cols = ['B', 'D', 'F', 'H']
    // Accent top border row
    ws.getRow(startRow).height = 5
    kpis.forEach((k, i) => {
      applyCell(ws, `${cols[i]}${startRow}`, null, {
        fill: fill(argb(k.color)),
      })
      ws.mergeCells(`${cols[i]}${startRow}:${String.fromCharCode(cols[i].charCodeAt(0)+1)}${startRow}`)
    })
    // Value row
    ws.getRow(startRow + 1).height = 38
    kpis.forEach((k, i) => {
      ws.mergeCells(`${cols[i]}${startRow+1}:${String.fromCharCode(cols[i].charCodeAt(0)+1)}${startRow+1}`)
      applyCell(ws, `${cols[i]}${startRow+1}`, k.value, {
        fill: fill(argb(k.bg)),
        font: font(true, 22, k.color),
        align: align('center', 'middle'),
        border: { left: border('thin', 'E2E8F0'), right: border('thin', 'E2E8F0') },
      })
    })
    // Label row
    ws.getRow(startRow + 2).height = 16
    kpis.forEach((k, i) => {
      ws.mergeCells(`${cols[i]}${startRow+2}:${String.fromCharCode(cols[i].charCodeAt(0)+1)}${startRow+2}`)
      applyCell(ws, `${cols[i]}${startRow+2}`, k.label, {
        fill: fill(argb(k.bg)),
        font: font(false, 7.5, '64748B'),
        align: align('center', 'middle'),
        border: { left: border('thin', 'E2E8F0'), right: border('thin', 'E2E8F0'), bottom: border('thin', 'E2E8F0') },
      })
    })
    return startRow + 3
  }

  r = drawKpiRow(kpis1, r)
  ws.getRow(r).height = 6; r++
  r = drawKpiRow(kpis2, r)

  // ── ROW: Spacer ──────────────────────────────────────────────────────────
  ws.getRow(r).height = 12; r++

  // ── SECTION: Category Scorecard ──────────────────────────────────────────
  ws.getRow(r).height = 18
  ws.mergeCells(`B${r}:I${r}`)
  applyCell(ws, `B${r}`, 'COMPLIANCE CATEGORY SCORECARD', {
    fill: fill(NAVY), font: font(true, 9, WHITE), align: align('left', 'middle'),
    border: allBorder('thin', '1E3A5F'),
  })
  r++

  // Table header
  ws.getRow(r).height = 16
  const scorecardHeaders = ['Category', 'Weight', 'Score', 'Target', 'Status', 'Contribution']
  const scorecardCols    = ['B',        'D',      'E',     'F',      'G',      'H']
  const scorecardSpan    = [2,           1,        1,       1,        1,        2]
  scorecardHeaders.forEach((h, i) => {
    const c = scorecardCols[i]
    const span = scorecardSpan[i]
    if (span > 1) {
      ws.mergeCells(`${c}${r}:${String.fromCharCode(c.charCodeAt(0)+span-1)}${r}`)
    }
    applyCell(ws, `${c}${r}`, h, {
      fill: fill(NAVY_MID), font: font(true, 8, WHITE), align: align('center', 'middle'),
      border: allBorder('thin', '1E3A5F'),
    })
  })
  r++

  const catDefs = [
    { name: 'Patch & Update Compliance',  key: 'patch',         weight: 35, target: cats.patch?.target ?? 95 },
    { name: 'Vulnerability Management',   key: 'vulnerability', weight: 25, target: 100 },
    { name: 'Configuration Compliance',   key: 'configuration', weight: 20, target: cats.configuration?.target ?? 90 },
    { name: 'Endpoint Protection',        key: 'protection',    weight: 10, target: 100 },
    { name: 'License Compliance',         key: 'license',       weight: 10, target: 100 },
  ]

  catDefs.forEach((cat, idx) => {
    const score = cats[cat.key]?.score ?? 0
    const contrib = (score * cat.weight / 100).toFixed(1) + '%'
    const pass = score >= cat.target
    const rowBg = idx % 2 === 0 ? SLATE_BG : WHITE
    const scoreFg = argb(scoreCol(score))
    const statusBg = pass ? argb('DCFCE7') : argb('FEE2E2')
    const statusFg = pass ? argb('166534') : argb('991B1B')

    ws.getRow(r).height = 16
    ws.mergeCells(`B${r}:C${r}`)
    applyCell(ws, `B${r}`, cat.name, { fill: fill(rowBg), font: font(false, 9, DARK_TXT), align: align('left', 'middle'), border: allBorder() })
    applyCell(ws, `D${r}`, `${cat.weight}%`, { fill: fill(rowBg), font: font(false, 9, SLATE_TXT), align: align('center', 'middle'), border: allBorder() })
    applyCell(ws, `E${r}`, `${score}%`, { fill: fill(rowBg), font: font(true, 9, scoreFg), align: align('center', 'middle'), border: allBorder() })
    applyCell(ws, `F${r}`, `${cat.target}%`, { fill: fill(rowBg), font: font(false, 9, SLATE_TXT), align: align('center', 'middle'), border: allBorder() })
    applyCell(ws, `G${r}`, pass ? '✓ PASS' : '✗ FAIL', { fill: fill(statusBg), font: font(true, 9, statusFg), align: align('center', 'middle'), border: allBorder() })
    ws.mergeCells(`H${r}:I${r}`)
    applyCell(ws, `H${r}`, contrib, { fill: fill(argb('EFF6FF')), font: font(true, 9, NAVY), align: align('center', 'middle'), border: allBorder() })
    r++
  })

  // Total row
  ws.getRow(r).height = 18
  ws.mergeCells(`B${r}:C${r}`)
  applyCell(ws, `B${r}`, 'OVERALL COMPLIANCE SCORE', { fill: fill(argb('EFF6FF')), font: font(true, 9, NAVY), align: align('left', 'middle'), border: allBorder('medium', '1E3A5F') })
  applyCell(ws, `D${r}`, '100%', { fill: fill(argb('EFF6FF')), font: font(true, 9, NAVY), align: align('center', 'middle'), border: allBorder('medium', '1E3A5F') })
  applyCell(ws, `E${r}`, `${overall}%`, { fill: fill(argb('EFF6FF')), font: font(true, 11, argb(scoreCol(overall))), align: align('center', 'middle'), border: allBorder('medium', '1E3A5F') })
  applyCell(ws, `F${r}`, '80%', { fill: fill(argb('EFF6FF')), font: font(true, 9, NAVY), align: align('center', 'middle'), border: allBorder('medium', '1E3A5F') })
  const totalPass = isCompliant
  ws.mergeCells(`G${r}:I${r}`)
  applyCell(ws, `G${r}`, totalPass ? '✓ COMPLIANT' : '✗ NON-COMPLIANT', {
    fill: fill(totalPass ? argb('DCFCE7') : argb('FEE2E2')),
    font: font(true, 10, totalPass ? argb('166534') : argb('991B1B')),
    align: align('center', 'middle'), border: allBorder('medium', '1E3A5F'),
  })
  r++

  // ── ROW: Spacer ──────────────────────────────────────────────────────────
  ws.getRow(r).height = 12; r++

  // ── SECTION: Score Visualisation ─────────────────────────────────────────
  ws.getRow(r).height = 18
  ws.mergeCells(`B${r}:I${r}`)
  applyCell(ws, `B${r}`, 'SCORE VISUALISATION', {
    fill: fill(NAVY), font: font(true, 9, WHITE), align: align('left', 'middle'),
    border: allBorder('thin', '1E3A5F'),
  })
  r++

  catDefs.forEach(cat => {
    const score = cats[cat.key]?.score ?? 0
    const col = scoreCol(score)
    const filled = Math.min(7, Math.round((score / 100) * 7))  // 7 bar cells (C-I)
    const target = cat.target
    const targetCell = Math.round((target / 100) * 7)  // which cell has target line

    ws.getRow(r).height = 16
    // Name
    ws.mergeCells(`B${r}:B${r}`)
    applyCell(ws, `B${r}`, cat.name, { fill: fill(SLATE_BG), font: font(false, 8, DARK_TXT), align: align('left', 'middle'), border: allBorder() })

    // 7 bar cells C-I
    const barLetters = ['C','D','E','F','G','H','I']
    barLetters.forEach((ltr, i) => {
      const isFilled = i < filled
      const isTarget = i === targetCell - 1
      applyCell(ws, `${ltr}${r}`, isFilled ? ' ' : ' ', {
        fill: fill(isFilled ? argb(col) : argb('E2E8F0')),
        border: {
          top: border('thin', 'FFFFFF'), bottom: border('thin', 'FFFFFF'),
          left: border('thin', isTarget ? '1E3A5F' : 'FFFFFF'),
          right: border('thin', i === 6 ? 'E2E8F0' : 'FFFFFF'),
        },
      })
    })

    // Score label after bars
    // Put score in the last merged area or beside
    applyCell(ws, `I${r}`, `${score}%`, {
      fill: fill(SLATE_BG),
      font: font(true, 8, col),
      align: align('right', 'middle'),
      border: allBorder(),
    })
    r++
  })

  // ── ROW: Spacer ──────────────────────────────────────────────────────────
  ws.getRow(r).height = 12; r++

  // ── SECTION: Non-Compliant Endpoints (Attention Required) ────────────────
  const attnAgents = agents.filter(a => !a.compliant)
  if (attnAgents.length > 0) {
    ws.getRow(r).height = 18
    ws.mergeCells(`B${r}:I${r}`)
    applyCell(ws, `B${r}`, `⚠  ATTENTION REQUIRED — ${nonCompliant} NON-COMPLIANT ENDPOINT${nonCompliant !== 1 ? 'S' : ''}`, {
      fill: fill(RED_BG), font: font(true, 9, RED_TEXT), align: align('left', 'middle'),
      border: allBorder('thin', 'DC2626'),
    })
    r++
    ws.getRow(r).height = 14
    ;['Hostname', 'IP Address', 'Patch', 'Vuln', 'Config', 'Protection', 'License', 'Overall'].forEach((h, i) => {
      const c = ['B','C','D','E','F','G','H','I'][i]
      applyCell(ws, `${c}${r}`, h, { fill: fill(NAVY_MID), font: font(true, 7.5, WHITE), align: align('center', 'middle'), border: allBorder() })
    })
    r++
    attnAgents.forEach((a, idx) => {
      ws.getRow(r).height = 14
      const rowBg = idx % 2 === 0 ? RED_BG : WHITE
      const sc = v => v != null ? `${v}%` : '—'
      const sf = v => font(false, 8, v != null ? argb(scoreCol(v)) : SLATE_TXT)
      applyCell(ws, `B${r}`, a.display_name || a.hostname, { fill: fill(rowBg), font: font(true, 8, DARK_TXT), align: align('left', 'middle'), border: allBorder() })
      applyCell(ws, `C${r}`, a.ip_address || '', { fill: fill(rowBg), font: font(false, 7.5, SLATE_TXT), align: align('left', 'middle'), border: allBorder() })
      applyCell(ws, `D${r}`, sc(a.patch_score), { fill: fill(rowBg), font: sf(a.patch_score), align: align('center', 'middle'), border: allBorder() })
      applyCell(ws, `E${r}`, sc(a.vuln_score), { fill: fill(rowBg), font: sf(a.vuln_score), align: align('center', 'middle'), border: allBorder() })
      applyCell(ws, `F${r}`, sc(a.config_score), { fill: fill(rowBg), font: sf(a.config_score), align: align('center', 'middle'), border: allBorder() })
      applyCell(ws, `G${r}`, sc(a.protection_score), { fill: fill(rowBg), font: sf(a.protection_score), align: align('center', 'middle'), border: allBorder() })
      applyCell(ws, `H${r}`, sc(a.license_score), { fill: fill(rowBg), font: sf(a.license_score), align: align('center', 'middle'), border: allBorder() })
      const oFg = argb(scoreCol(a.overall_score))
      applyCell(ws, `I${r}`, `${a.overall_score}%`, { fill: fill(argb('FEE2E2')), font: font(true, 8, oFg), align: align('center', 'middle'), border: allBorder() })
      r++
    })
    ws.getRow(r).height = 8; r++
  }

  // ── SECTION: Critical CVEs ────────────────────────────────────────────────
  const critVulns = (extras?.vulns || []).filter(v => v.severity === 'critical' && v.status === 'open').slice(0, 8)
  if (critVulns.length > 0) {
    ws.getRow(r).height = 18
    ws.mergeCells(`B${r}:I${r}`)
    applyCell(ws, `B${r}`, `🔴  CRITICAL VULNERABILITIES — IMMEDIATE ACTION REQUIRED (${critVulns.length} shown)`, {
      fill: fill(argb('FFF1F2')), font: font(true, 9, RED_TEXT), align: align('left', 'middle'),
      border: allBorder('thin', 'DC2626'),
    })
    r++
    ws.getRow(r).height = 14
    ;['CVE ID', 'Hostname', 'Software', 'Version', 'CVSS', 'Status', 'Detected', 'Days Open'].forEach((h, i) => {
      const c = ['B','C','D','E','F','G','H','I'][i]
      applyCell(ws, `${c}${r}`, h, { fill: fill(argb('7F1D1D')), font: font(true, 7.5, WHITE), align: align('center', 'middle'), border: allBorder() })
    })
    r++
    critVulns.forEach((v, idx) => {
      ws.getRow(r).height = 13
      const rowBg = idx % 2 === 0 ? argb('FFF1F2') : WHITE
      const daysOpen = v.detected_at ? Math.floor((Date.now() - new Date(v.detected_at)) / 86400000) : '—'
      applyCell(ws, `B${r}`, v.cve_id || '', { fill: fill(rowBg), font: font(true, 8, RED_TEXT), align: align('left', 'middle'), border: allBorder() })
      applyCell(ws, `C${r}`, v.hostname || '', { fill: fill(rowBg), font: font(false, 8, DARK_TXT), align: align('left', 'middle'), border: allBorder() })
      applyCell(ws, `D${r}`, v.software_name || '', { fill: fill(rowBg), font: font(false, 8, DARK_TXT), align: align('left', 'middle'), border: allBorder() })
      applyCell(ws, `E${r}`, v.software_version || '—', { fill: fill(rowBg), font: font(false, 7.5, SLATE_TXT), align: align('center', 'middle'), border: allBorder() })
      applyCell(ws, `F${r}`, v.cvss_score ?? '—', { fill: fill(rowBg), font: font(true, 8, RED_TEXT), align: align('center', 'middle'), border: allBorder() })
      applyCell(ws, `G${r}`, v.status || '', { fill: fill(rowBg), font: font(false, 7.5, SLATE_TXT), align: align('center', 'middle'), border: allBorder() })
      applyCell(ws, `H${r}`, v.detected_at ? new Date(v.detected_at).toLocaleDateString() : '—', { fill: fill(rowBg), font: font(false, 7.5, SLATE_TXT), align: align('center', 'middle'), border: allBorder() })
      applyCell(ws, `I${r}`, daysOpen, { fill: fill(typeof daysOpen === 'number' && daysOpen > 14 ? argb('FEE2E2') : rowBg), font: font(true, 8, typeof daysOpen === 'number' && daysOpen > 14 ? RED_TEXT : DARK_TXT), align: align('center', 'middle'), border: allBorder() })
      r++
    })
    ws.getRow(r).height = 8; r++
  }

  // ── SECTION: License Alerts ───────────────────────────────────────────────
  const now = Date.now()
  const expiringLicenses = (extras?.licenses || []).filter(l => {
    if (!l.expiry_date) return false
    const days = (new Date(l.expiry_date) - now) / 86400000
    return days > 0 && days <= 30
  })
  const expiredLicenses = (extras?.licenses || []).filter(l => l.expiry_date && new Date(l.expiry_date) < now)
  const notActivated = (extras?.licenses || []).filter(l => l.activation_status === 'not_activated' || l.activation_status === 'grace_period')

  if (expiringLicenses.length > 0 || expiredLicenses.length > 0 || notActivated.length > 0) {
    ws.getRow(r).height = 18
    ws.mergeCells(`B${r}:I${r}`)
    applyCell(ws, `B${r}`, `🔑  LICENSE ALERTS — ${expiredLicenses.length} expired · ${expiringLicenses.length} expiring within 30 days · ${notActivated.length} not activated`, {
      fill: fill(argb('FFFBEB')), font: font(true, 9, argb('92400E')), align: align('left', 'middle'),
      border: allBorder('thin', 'D97706'),
    })
    r++
    ws.getRow(r).height = 14
    ;['Hostname', 'IP Address', 'Software', 'License Type', 'Status', 'Expiry Date', 'Days Left', 'Alert'].forEach((h, i) => {
      const c = ['B','C','D','E','F','G','H','I'][i]
      applyCell(ws, `${c}${r}`, h, { fill: fill(argb('78350F')), font: font(true, 7.5, WHITE), align: align('center', 'middle'), border: allBorder() })
    })
    r++
    const alertLics = [...expiredLicenses, ...expiringLicenses, ...notActivated].slice(0, 10)
    alertLics.forEach((l, idx) => {
      ws.getRow(r).height = 13
      const isExpired = l.expiry_date && new Date(l.expiry_date) < now
      const daysLeft = l.expiry_date ? Math.ceil((new Date(l.expiry_date) - now) / 86400000) : null
      const rowBg = isExpired ? argb('FEF2F2') : argb('FFFBEB')
      const alertTxt = isExpired ? 'EXPIRED' : daysLeft != null ? `${daysLeft}d left` : 'NOT ACTIVATED'
      const alertBg = isExpired ? argb('FEE2E2') : argb('FEF3C7')
      const alertFg = isExpired ? RED_TEXT : argb('92400E')
      applyCell(ws, `B${r}`, l.display_name || l.hostname || '', { fill: fill(rowBg), font: font(false, 8, DARK_TXT), align: align('left', 'middle'), border: allBorder() })
      applyCell(ws, `C${r}`, l.ip_address || '', { fill: fill(rowBg), font: font(false, 7.5, SLATE_TXT), align: align('left', 'middle'), border: allBorder() })
      applyCell(ws, `D${r}`, l.software_name || '', { fill: fill(rowBg), font: font(false, 8, DARK_TXT), align: align('left', 'middle'), border: allBorder() })
      applyCell(ws, `E${r}`, l.license_type || '—', { fill: fill(rowBg), font: font(false, 7.5, SLATE_TXT), align: align('center', 'middle'), border: allBorder() })
      applyCell(ws, `F${r}`, l.activation_status || '—', { fill: fill(rowBg), font: font(false, 7.5, SLATE_TXT), align: align('center', 'middle'), border: allBorder() })
      applyCell(ws, `G${r}`, l.expiry_date ? new Date(l.expiry_date).toLocaleDateString() : 'Perpetual', { fill: fill(rowBg), font: font(false, 7.5, SLATE_TXT), align: align('center', 'middle'), border: allBorder() })
      applyCell(ws, `H${r}`, daysLeft ?? 'N/A', { fill: fill(rowBg), font: font(true, 8, isExpired ? RED_TEXT : argb('92400E')), align: align('center', 'middle'), border: allBorder() })
      applyCell(ws, `I${r}`, alertTxt, { fill: fill(alertBg), font: font(true, 7.5, alertFg), align: align('center', 'middle'), border: allBorder() })
      r++
    })
    ws.getRow(r).height = 8; r++
  }

  // ── SECTION: Top Critical Misconfigurations ───────────────────────────────
  const critMisconfigs = (extras?.misconfigs || []).filter(m => m.severity === 'critical' && m.status === 'fail').slice(0, 8)
  if (critMisconfigs.length > 0) {
    ws.getRow(r).height = 18
    ws.mergeCells(`B${r}:I${r}`)
    applyCell(ws, `B${r}`, `⚙  CRITICAL MISCONFIGURATIONS (${critMisconfigs.length} shown)`, {
      fill: fill(argb('FFF7ED')), font: font(true, 9, argb('C2410C')), align: align('left', 'middle'),
      border: allBorder('thin', 'EA580C'),
    })
    r++
    ws.getRow(r).height = 14
    ;['Hostname', 'IP Address', 'Rule / Finding', 'Category', 'Actual Value', 'Expected', 'Detected', 'Severity'].forEach((h, i) => {
      const c = ['B','C','D','E','F','G','H','I'][i]
      applyCell(ws, `${c}${r}`, h, { fill: fill(argb('7C2D12')), font: font(true, 7.5, WHITE), align: align('center', 'middle'), border: allBorder() })
    })
    r++
    critMisconfigs.forEach((m, idx) => {
      ws.getRow(r).height = 13
      const rowBg = idx % 2 === 0 ? argb('FFF7ED') : WHITE
      applyCell(ws, `B${r}`, m.hostname || '', { fill: fill(rowBg), font: font(false, 8, DARK_TXT), align: align('left', 'middle'), border: allBorder() })
      applyCell(ws, `C${r}`, m.ip_address || '', { fill: fill(rowBg), font: font(false, 7.5, SLATE_TXT), align: align('left', 'middle'), border: allBorder() })
      applyCell(ws, `D${r}`, m.title || m.rule_id || '', { fill: fill(rowBg), font: font(true, 8, DARK_TXT), align: align('left', 'middle'), border: allBorder() })
      applyCell(ws, `E${r}`, m.category || '', { fill: fill(rowBg), font: font(false, 7.5, SLATE_TXT), align: align('center', 'middle'), border: allBorder() })
      applyCell(ws, `F${r}`, m.actual_value || '—', { fill: fill(rowBg), font: font(false, 7.5, SLATE_TXT), align: align('center', 'middle'), border: allBorder() })
      applyCell(ws, `G${r}`, m.expected_value || '—', { fill: fill(rowBg), font: font(false, 7.5, SLATE_TXT), align: align('center', 'middle'), border: allBorder() })
      applyCell(ws, `H${r}`, m.detected_at ? new Date(m.detected_at).toLocaleDateString() : '—', { fill: fill(rowBg), font: font(false, 7.5, SLATE_TXT), align: align('center', 'middle'), border: allBorder() })
      applyCell(ws, `I${r}`, (m.severity || '').toUpperCase(), { fill: fill(argb('FEE2E2')), font: font(true, 7.5, RED_TEXT), align: align('center', 'middle'), border: allBorder() })
      r++
    })
    ws.getRow(r).height = 8; r++
  }

  // ── FOOTER ────────────────────────────────────────────────────────────────
  ws.mergeCells(`A${r}:J${r}`)
  ws.getRow(r).height = 20
  applyCell(ws, `A${r}`, `Generated by Kifaa Security Platform  ·  ${ts}  ·  CONFIDENTIAL — For executive use only`, {
    fill: fill(NAVY), font: font(true, 8, '94A3B8', true), align: align('center', 'middle'),
  })

  // ── SHEET 2: Full Endpoint Health Status ─────────────────────────────────
  const ehs = wb.addWorksheet('Endpoint Health Status', { views: [{ state: 'frozen', ySplit: 3, showGridLines: false }] })
  ehs.columns = [
    { width: 3 },   // A margin
    { width: 26 },  // B Hostname
    { width: 20 },  // C Description
    { width: 14 },  // D IP
    { width: 22 },  // E OS
    { width: 10 },  // F Online
    { width: 10 },  // G Patch%
    { width: 10 },  // H Vuln%
    { width: 10 },  // I Config%
    { width: 12 },  // J Protection%
    { width: 10 },  // K License%
    { width: 10 },  // L Overall%
    { width: 12 },  // M Status
    { width: 10 },  // N Pending
    { width: 10 },  // O Crit CVEs
    { width: 10 },  // P Config Fail
    { width: 12 },  // Q AV
    { width: 12 },  // R Firewall
    { width: 3 },   // S margin
  ]

  // EHS Header row 1
  ehs.getRow(1).height = 22
  ehs.mergeCells('A1:S1')
  applyCell(ehs, 'A1', null, { fill: fill(NAVY) })

  ehs.getRow(2).height = 26
  ehs.mergeCells('B2:K2')
  applyCell(ehs, 'B2', 'ENDPOINT HEALTH STATUS — FULL REVIEW', {
    fill: fill(NAVY), font: font(true, 14, WHITE), align: align('left', 'middle'),
  })
  ehs.mergeCells('L2:R2')
  applyCell(ehs, 'L2', `${total} endpoints  ·  ${compliantCount} compliant  ·  ${nonCompliant} non-compliant  ·  ${ts}`, {
    fill: fill(NAVY), font: font(false, 8, '94A3B8'), align: align('right', 'middle'),
  })
  applyCell(ehs, 'A2', null, { fill: fill(NAVY) })
  applyCell(ehs, 'S2', null, { fill: fill(NAVY) })

  // EHS column headers
  ehs.getRow(3).height = 18
  const ehsHeaders = [
    ['B', 'Hostname'],['C', 'Description / Function'],['D', 'IP Address'],['E', 'OS'],
    ['F', 'Agent'],['G', 'Patch %'],['H', 'Vuln %'],['I', 'Config %'],
    ['J', 'Protection %'],['K', 'License %'],['L', 'Overall %'],['M', 'Compliant'],
    ['N', 'Pending\nPatches'],['O', 'Critical\nCVEs'],['P', 'Config\nFails'],
    ['Q', 'Antivirus'],['R', 'Firewall'],
  ]
  ehsHeaders.forEach(([c, label]) => {
    applyCell(ehs, `${c}3`, label, {
      fill: fill(NAVY_MID), font: font(true, 8, WHITE), align: align('center', 'middle', true),
      border: allBorder('thin', '1E3A5F'),
    })
  })

  // EHS data rows — ALL agents sorted: non-compliant first, then by overall score
  const sortedAgents = [...agents].sort((a, b) => {
    if (a.compliant !== b.compliant) return a.compliant ? 1 : -1
    return (a.overall_score ?? 0) - (b.overall_score ?? 0)
  })

  sortedAgents.forEach((a, idx) => {
    const rowNum = idx + 4
    ehs.getRow(rowNum).height = 15
    const isOnline = a.status === 'online'
    const rowBg = a.compliant
      ? (idx % 2 === 0 ? SLATE_BG : WHITE)
      : (idx % 2 === 0 ? argb('FFF5F5') : argb('FFFAFA'))

    const sc = v => v != null ? `${v}%` : '—'
    const scoreFill = (v) => {
      if (v == null) return fill(rowBg)
      return fill(v >= 80 ? argb('DCFCE7') : v >= 60 ? argb('FEF3C7') : argb('FEE2E2'))
    }
    const scoreFont = (v) => font(true, 8, v != null ? argb(scoreCol(v)) : SLATE_TXT)

    applyCell(ehs, `B${rowNum}`, a.display_name || a.hostname, { fill: fill(rowBg), font: font(true, 8.5, DARK_TXT), align: align('left', 'middle'), border: allBorder() })
    applyCell(ehs, `C${rowNum}`, a.description || '—', { fill: fill(rowBg), font: font(false, 8, SLATE_TXT), align: align('left', 'middle'), border: allBorder() })
    applyCell(ehs, `D${rowNum}`, a.ip_address || '', { fill: fill(rowBg), font: font(false, 8, SLATE_TXT), align: align('left', 'middle'), border: allBorder() })
    applyCell(ehs, `E${rowNum}`, a.os_name || '—', { fill: fill(rowBg), font: font(false, 8, SLATE_TXT), align: align('left', 'middle'), border: allBorder() })
    applyCell(ehs, `F${rowNum}`, isOnline ? '● ONLINE' : '○ OFFLINE', {
      fill: fill(isOnline ? argb('DCFCE7') : argb('F1F5F9')),
      font: font(true, 7.5, isOnline ? argb('166534') : SLATE_TXT),
      align: align('center', 'middle'), border: allBorder(),
    })
    applyCell(ehs, `G${rowNum}`, sc(a.patch_score), { fill: scoreFill(a.patch_score), font: scoreFont(a.patch_score), align: align('center', 'middle'), border: allBorder() })
    applyCell(ehs, `H${rowNum}`, sc(a.vuln_score), { fill: scoreFill(a.vuln_score), font: scoreFont(a.vuln_score), align: align('center', 'middle'), border: allBorder() })
    applyCell(ehs, `I${rowNum}`, sc(a.config_score), { fill: scoreFill(a.config_score), font: scoreFont(a.config_score), align: align('center', 'middle'), border: allBorder() })
    applyCell(ehs, `J${rowNum}`, sc(a.protection_score), { fill: scoreFill(a.protection_score), font: scoreFont(a.protection_score), align: align('center', 'middle'), border: allBorder() })
    applyCell(ehs, `K${rowNum}`, sc(a.license_score), { fill: scoreFill(a.license_score), font: scoreFont(a.license_score), align: align('center', 'middle'), border: allBorder() })
    const overallFg = argb(scoreCol(a.overall_score ?? 0))
    applyCell(ehs, `L${rowNum}`, sc(a.overall_score), {
      fill: fill(a.compliant ? argb('DCFCE7') : argb('FEE2E2')),
      font: font(true, 9, overallFg), align: align('center', 'middle'), border: allBorder(),
    })
    applyCell(ehs, `M${rowNum}`, a.compliant ? '✓ YES' : '✗ NO', {
      fill: fill(a.compliant ? argb('DCFCE7') : argb('FEE2E2')),
      font: font(true, 8, a.compliant ? argb('166534') : argb('991B1B')),
      align: align('center', 'middle'), border: allBorder(),
    })
    const pendingPct = a.critical_patches ?? a.total_pending ?? a.critical_pending ?? '—'
    applyCell(ehs, `N${rowNum}`, pendingPct, {
      fill: fill(typeof pendingPct === 'number' && pendingPct > 0 ? argb('FEF3C7') : rowBg),
      font: font(typeof pendingPct === 'number' && pendingPct > 0, 8, typeof pendingPct === 'number' && pendingPct > 0 ? RED_TEXT : DARK_TXT), align: align('center', 'middle'), border: allBorder(),
    })
    const cv = a.crit_vulns ?? 0
    applyCell(ehs, `O${rowNum}`, cv, {
      fill: fill(cv > 0 ? argb('FEE2E2') : rowBg),
      font: font(cv > 0, 8, cv > 0 ? RED_TEXT : DARK_TXT), align: align('center', 'middle'), border: allBorder(),
    })
    const cf = a.config_fail ?? '—'
    applyCell(ehs, `P${rowNum}`, cf, {
      fill: fill(typeof cf === 'number' && cf > 0 ? argb('FEF3C7') : rowBg),
      font: font(false, 8, DARK_TXT), align: align('center', 'middle'), border: allBorder(),
    })
    const avOk = a.av_status === 'pass'
    const avTxt = a.av_status === 'pass' ? '✓ Active' : a.av_status === 'fail' ? '✗ Missing' : '—'
    applyCell(ehs, `Q${rowNum}`, avTxt, {
      fill: fill(avOk ? argb('DCFCE7') : a.av_status === 'fail' ? argb('FEE2E2') : rowBg),
      font: font(true, 7.5, avOk ? argb('166534') : a.av_status === 'fail' ? RED_TEXT : SLATE_TXT),
      align: align('center', 'middle'), border: allBorder(),
    })
    const fwOk = a.fw_status === 'pass'
    const fwTxt = a.fw_status === 'pass' ? '✓ Enabled' : a.fw_status === 'fail' ? '✗ Disabled' : '—'
    applyCell(ehs, `R${rowNum}`, fwTxt, {
      fill: fill(fwOk ? argb('DCFCE7') : a.fw_status === 'fail' ? argb('FEE2E2') : rowBg),
      font: font(true, 7.5, fwOk ? argb('166534') : a.fw_status === 'fail' ? RED_TEXT : SLATE_TXT),
      align: align('center', 'middle'), border: allBorder(),
    })
    applyCell(ehs, `A${rowNum}`, null, { fill: fill(rowBg) })
    applyCell(ehs, `S${rowNum}`, null, { fill: fill(rowBg) })
  })

  // EHS footer
  const ehsFooterRow = sortedAgents.length + 4
  ehs.mergeCells(`A${ehsFooterRow}:S${ehsFooterRow}`)
  ehs.getRow(ehsFooterRow).height = 18
  applyCell(ehs, `A${ehsFooterRow}`, `Generated by Kifaa Security Platform  ·  ${ts}  ·  CONFIDENTIAL`, {
    fill: fill(NAVY), font: font(false, 8, '94A3B8', true), align: align('center', 'middle'),
  })

  // ── ADDITIONAL DATA SHEETS ────────────────────────────────────────────────
  for (const { rows, columns, sheetName } of allSheets) {
    const dws = wb.addWorksheet(sheetName)
    // Header row
    const headerRow = dws.addRow(columns.map(c => c.label))
    headerRow.height = 18
    headerRow.eachCell(cell => {
      cell.fill = fill(NAVY)
      cell.font = font(true, 9, WHITE)
      cell.alignment = align('left', 'middle')
      cell.border = allBorder('thin', '2D5F8A')
    })
    dws.columns = columns.map(c => ({ width: Math.max(c.label.length + 2, c.minWidth || 14) }))
    // Data rows
    rows.forEach((row, idx) => {
      const dr = dws.addRow(columns.map(c => c.get(row) ?? ''))
      dr.height = 15
      dr.eachCell(cell => {
        cell.fill = fill(idx % 2 === 0 ? SLATE_BG : WHITE)
        cell.font = font(false, 8.5, DARK_TXT)
        cell.alignment = align('left', 'middle')
        cell.border = allBorder()
      })
    })
    // Freeze header
    dws.views = [{ state: 'frozen', ySplit: 1, showGridLines: false }]
  }

  // ── Write to buffer and trigger download ──────────────────────────────────
  const buf = await wb.xlsx.writeBuffer()
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  URL.revokeObjectURL(url)
}

async function exportPDF(rows, columns, title, filename, options = {}) {
  const { default: jsPDF } = await import('jspdf')
  const { default: autoTable } = await import('jspdf-autotable')
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' })

  const pageW = doc.internal.pageSize.getWidth()
  doc.setFontSize(16)
  doc.setTextColor(30, 30, 30)
  doc.text(title, 40, 40)

  doc.setFontSize(9)
  doc.setTextColor(120, 120, 120)
  doc.text(`Generated: ${new Date().toLocaleString()}  ·  ${rows.length} records`, 40, 58)

  // Build per-column styles: honour explicit cellWidth on the column definition
  const columnStyles = {}
  columns.forEach((c, i) => { if (c.pdfWidth) columnStyles[i] = { cellWidth: c.pdfWidth } })
  Object.assign(columnStyles, options.columnStyles || {})

  autoTable(doc, {
    startY: 72,
    head: [columns.map(c => c.label)],
    body: rows.map(row => columns.map(c => String(c.get(row) ?? '—'))),
    headStyles: { fillColor: [30, 41, 59], textColor: 255, fontSize: options.fontSize || 8 },
    bodyStyles: { fontSize: options.fontSize || 8, textColor: [51, 65, 85] },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    margin: { left: 40, right: 40 },
    tableWidth: pageW - 80,
    columnStyles,
    styles: { overflow: 'ellipsize' },
  })

  doc.save(filename)
}

// ── Column definitions ─────────────────────────────────────────────────────────

const AGENT_COLS = [
  { label: 'Hostname',              get: r => r.hostname },
  { label: 'Description / Function', get: r => r.description || '' },
  { label: 'IP Address',            get: r => r.ip_address },
  { label: 'OS',                    get: r => r.os_name },
  { label: 'OS Version',            get: r => r.os_version },
  { label: 'Architecture',          get: r => r.os_arch },
  { label: 'Status',                get: r => r.status },
  { label: 'Agent Version',         get: r => r.agent_version },
  { label: 'Agent Type',      get: r => r.agent_type },
  { label: 'CPU',             get: r => r.hardware?.cpu_model },
  { label: 'CPU Cores',       get: r => r.hardware?.cpu_cores },
  { label: 'RAM (GB)',        get: r => r.hardware?.ram_total_gb ? Number(r.hardware.ram_total_gb).toFixed(1) : '' },
  { label: 'Software Count',  get: r => r.software_count },
  { label: 'Service Count',   get: r => r.service_count },
  { label: 'Last Seen',       get: r => r.last_seen ? new Date(r.last_seen).toLocaleString() : 'Never' },
  { label: 'Registered',      get: r => r.registered_at ? new Date(r.registered_at).toLocaleString() : '' },
]

const MONITOR_COLS = [
  { label: 'Date',              get: r => r.report_date ?? '', minWidth: 22, pdfWidth: 78 },
  { label: 'Name',              get: r => r.name },
  { label: 'Type',              get: r => r.subtype?.replace(/_/g, ' ') || r.monitor_type },
  { label: 'Category',          get: r => r.category },
  { label: 'Host',              get: r => r.host },
  { label: 'Port',              get: r => r.port },
  { label: 'Current Status',    get: r => r.last_status },
  { label: 'Checks',            get: r => r.total_checks ?? '' },
  { label: 'Up',                get: r => r.up_count ?? '' },
  { label: 'Down',              get: r => r.down_count ?? '' },
  { label: 'Uptime %',          get: r => r.uptime_pct != null ? `${r.uptime_pct}%` : 'No data' },
  { label: 'Avg Latency (ms)',  get: r => r.avg_latency_ms ?? '' },
  { label: 'Min Latency (ms)',  get: r => r.min_latency_ms ?? '' },
  { label: 'Max Latency (ms)',  get: r => r.max_latency_ms ?? '' },
]

const AGENT_REPORT_COLS = [
  { label: 'Hostname',               get: r => r.hostname },
  { label: 'Description / Function', get: r => r.description || '' },
  { label: 'IP Address',             get: r => r.ip_address },
  { label: 'OS',                     get: r => `${r.os_name || ''} ${r.os_version || ''}`.trim() },
  { label: 'Architecture',           get: r => r.os_arch },
  { label: 'Status',                 get: r => r.status },
  { label: 'Agent Version',          get: r => r.agent_version },
  { label: 'CPU',             get: r => r.hardware?.cpu_model ? `${r.hardware.cpu_model} (${r.hardware.cpu_cores || '?'}c)` : '' },
  { label: 'RAM (GB)',        get: r => r.hardware?.ram_total_gb ? Number(r.hardware.ram_total_gb).toFixed(1) : '' },
  { label: 'Disk Count',      get: r => r.hardware?.disks?.length || '' },
  { label: 'Serial Number',   get: r => r.hardware?.serial_number || '' },
  { label: 'Software Count',  get: r => r.software_count ?? '' },
  { label: 'Service Count',   get: r => r.service_count ?? '' },
  { label: 'Stopped Services',get: r => r.stopped_services ?? '' },
  { label: 'Last Seen',       get: r => r.last_seen ? new Date(r.last_seen).toLocaleString() : 'Never' },
  { label: 'Registered',      get: r => r.registered_at ? new Date(r.registered_at).toLocaleString() : '' },
]

const DISK_REPORT_COLS = [
  { label: 'Hostname',    get: r => r.hostname,   minWidth: 22 },
  { label: 'IP Address',  get: r => r.ip_address, minWidth: 14 },
  { label: 'OS',          get: r => `${r.os_name || ''} ${r.os_version || ''}`.trim() },
  { label: 'Status',      get: r => r.status },
  { label: 'Device',      get: r => r.device,     minWidth: 18 },
  { label: 'Filesystem',  get: r => r.filesystem, minWidth: 10 },
  { label: 'Total (GB)',  get: r => r.size_gb != null ? Number(r.size_gb).toFixed(1) : '' },
  { label: 'Free (GB)',   get: r => r.free_gb  != null ? Number(r.free_gb).toFixed(1) : '' },
  { label: 'Used %',      get: r => r.used_pct != null ? `${r.used_pct}%` : '' },
]

const PENDING_PATCH_COLS = [
  { label: 'Hostname',          get: r => r.hostname,          minWidth: 22 },
  { label: 'IP Address',        get: r => r.ip_address,        minWidth: 14 },
  { label: 'OS',                get: r => `${r.os_name || ''} ${r.os_version || ''}`.trim() },
  { label: 'Status',            get: r => r.status },
  { label: 'Severity',          get: r => r.severity,          minWidth: 12 },
  { label: 'Package',           get: r => r.package_name,      minWidth: 30 },
  { label: 'Current Version',   get: r => r.current_version,   minWidth: 16 },
  { label: 'Available Version', get: r => r.available_version, minWidth: 16 },
  { label: 'Category',          get: r => r.category,          minWidth: 12 },
  { label: 'Description',       get: r => r.description,       minWidth: 30 },
  { label: 'Last Scanned',      get: r => r.scanned_at ? new Date(r.scanned_at).toLocaleString() : '', minWidth: 20 },
]

const PATCH_HISTORY_COLS = [
  { label: 'Hostname',      get: r => r.hostname,     minWidth: 22 },
  { label: 'IP Address',    get: r => r.ip_address,   minWidth: 14 },
  { label: 'OS',            get: r => r.os_name || '' },
  { label: 'Severity',      get: r => r.severity,     minWidth: 12 },
  { label: 'Title',         get: r => r.title,        minWidth: 40 },
  { label: 'KB',            get: r => r.kb || '',     minWidth: 12 },
  { label: 'Category',      get: r => r.category,     minWidth: 12 },
  { label: 'Result',        get: r => r.result },
  { label: 'Installed At',  get: r => r.installed_at ? new Date(r.installed_at).toLocaleString() : '', minWidth: 20 },
]

const COMPLIANCE_COLS = [
  { label: 'Hostname',          get: r => r.hostname,                    minWidth: 22 },
  { label: 'IP Address',        get: r => r.ip_address,                  minWidth: 14 },
  { label: 'OS',                get: r => `${r.os_name || ''} ${r.os_version || ''}`.trim() },
  { label: 'Agent Status',      get: r => r.status },
  { label: 'Zero Day Pending',  get: r => r.zero_day_pending ?? 0 },
  { label: 'Critical Pending',  get: r => r.critical_pending ?? 0 },
  { label: 'Medium Pending',    get: r => r.medium_pending ?? 0 },
  { label: 'Total Pending',     get: r => r.total_pending ?? 0 },
  { label: 'Installed',         get: r => r.installed ?? 0 },
  { label: 'Patch %',           get: r => r.patch_pct != null ? `${r.patch_pct}%` : 'N/A', minWidth: 10 },
  { label: 'Compliant',         get: r => r.compliant ? 'Yes' : 'No',   minWidth: 10 },
]

// ── Compliance Report column definitions ──────────────────────────────────────

const COMP_SUMMARY_COLS = [
  { label: 'Category',      get: r => r.category, minWidth: 35 },
  { label: 'Score / Value', get: r => r.value,    minWidth: 20 },
  { label: 'Target',        get: r => r.target,   minWidth: 12 },
  { label: 'Status',        get: r => r.status,   minWidth: 15 },
]

const COMP_VULN_REPORT_COLS = [
  { label: 'Hostname',      get: r => r.hostname,   minWidth: 22 },
  { label: 'IP Address',    get: r => r.ip_address, minWidth: 14 },
  { label: 'OS',            get: r => r.os_name || '' },
  { label: 'Critical CVEs', get: r => r.crit_vulns ?? 0 },
  { label: 'High CVEs',     get: r => r.high_vulns ?? 0 },
  { label: 'Vuln Score',    get: r => r.vuln_score != null ? `${r.vuln_score}%` : '—' },
  { label: 'Overall Score', get: r => `${r.overall_score}%` },
  { label: 'Compliant',     get: r => r.compliant ? 'Yes' : 'No' },
]

const COMP_CVE_DETAIL_COLS = [
  { label: 'CVE ID',     get: r => r.cve_id,            minWidth: 18 },
  { label: 'Hostname',   get: r => r.hostname,           minWidth: 22 },
  { label: 'Software',   get: r => r.software_name },
  { label: 'Version',    get: r => r.software_version || '' },
  { label: 'Severity',   get: r => r.severity,           minWidth: 12 },
  { label: 'CVSS Score', get: r => r.cvss_score ?? '' },
  { label: 'Zero Day',   get: r => r.is_zero_day ? 'Yes' : 'No' },
  { label: 'Status',     get: r => r.status },
  { label: 'Detected',   get: r => r.detected_at ? new Date(r.detected_at).toLocaleDateString() : '', minWidth: 14 },
  { label: 'Days Open',  get: r => r.detected_at ? Math.floor((Date.now() - new Date(r.detected_at)) / 86400000) : '' },
]

const COMP_CONFIG_COLS = [
  { label: 'Hostname',       get: r => r.hostname,   minWidth: 22 },
  { label: 'IP Address',     get: r => r.ip_address, minWidth: 14 },
  { label: 'OS',             get: r => r.os_name || '' },
  { label: 'Checks Passed',  get: r => r.config_pass ?? '—' },
  { label: 'Checks Failed',  get: r => r.config_fail ?? '—' },
  { label: 'Total Checks',   get: r => r.config_total ?? '—' },
  { label: 'Config Score',   get: r => r.config_score != null ? `${r.config_score}%` : '—' },
  { label: 'Status',         get: r => r.config_score != null ? (r.config_score >= 80 ? 'Pass' : 'Fail') : '—' },
]

const COMP_MISCONFIG_COLS = [
  { label: 'Hostname',       get: r => r.hostname,       minWidth: 22 },
  { label: 'IP Address',     get: r => r.ip_address,     minWidth: 14 },
  { label: 'Rule',           get: r => r.title,          minWidth: 30 },
  { label: 'Category',       get: r => r.category,       minWidth: 15 },
  { label: 'Severity',       get: r => r.severity,       minWidth: 12 },
  { label: 'Status',         get: r => r.status },
  { label: 'Actual Value',   get: r => r.actual_value || '' },
  { label: 'Expected Value', get: r => r.expected_value || '' },
  { label: 'Detected',       get: r => r.detected_at ? new Date(r.detected_at).toLocaleDateString() : '', minWidth: 14 },
]

const COMP_HIGH_RISK_COLS = [
  { label: 'Hostname',   get: r => r.hostname,         minWidth: 22 },
  { label: 'IP Address', get: r => r.ip_address,       minWidth: 14 },
  { label: 'Software',   get: r => r.software_name,    minWidth: 30 },
  { label: 'Version',    get: r => r.software_version || '' },
  { label: 'Type',       get: r => r.match_type,       minWidth: 15 },
  { label: 'Severity',   get: r => r.severity,         minWidth: 12 },
  { label: 'Detected',   get: r => r.detected_at ? new Date(r.detected_at).toLocaleDateString() : '', minWidth: 14 },
]

const COMP_PORTS_COLS = [
  { label: 'Hostname',     get: r => r.hostname,      minWidth: 22 },
  { label: 'IP Address',   get: r => r.ip_address,    minWidth: 14 },
  { label: 'Port',         get: r => r.port },
  { label: 'Protocol',     get: r => r.protocol },
  { label: 'Process',      get: r => r.process_name || '' },
  { label: 'PID',          get: r => r.process_pid ?? '' },
  { label: 'Bind Address', get: r => r.bind_address || '' },
  { label: 'State',        get: r => r.state || '' },
]

const COMP_ENDPOINT_COLS = [
  { label: 'Hostname',         get: r => r.hostname,   minWidth: 22 },
  { label: 'IP Address',       get: r => r.ip_address, minWidth: 14 },
  { label: 'OS',               get: r => r.os_name || '' },
  { label: 'Firewall',         get: r => r.fw_status === 'pass' ? 'Enabled' : r.fw_status === 'fail' ? 'Disabled' : '—' },
  { label: 'Antivirus',        get: r => r.av_status === 'pass' ? 'Installed' : r.av_status === 'fail' ? 'Missing' : '—' },
  { label: 'Protection Score', get: r => r.protection_score != null ? `${r.protection_score}%` : '—' },
  { label: 'Overall Score',    get: r => `${r.overall_score}%` },
  { label: 'Compliant',        get: r => r.compliant ? 'Yes' : 'No' },
]

const COMP_LICENSE_COLS = [
  { label: 'Hostname',          get: r => r.hostname,           minWidth: 22 },
  { label: 'IP Address',        get: r => r.ip_address,         minWidth: 14 },
  { label: 'Software',          get: r => r.software_name,      minWidth: 30 },
  { label: 'License Type',      get: r => r.license_type || '' },
  { label: 'Activation Status', get: r => r.activation_status },
  { label: 'Partial Key',       get: r => r.partial_key || '' },
  { label: 'Expires',           get: r => r.expiry_date ? new Date(r.expiry_date).toLocaleDateString() : '' },
]

// ── Score colour helper ────────────────────────────────────────────────────────

function scoreColor(s) {
  if (s == null) return 'text-slate-500'
  return s >= 80 ? 'text-green-400' : s >= 60 ? 'text-yellow-400' : 'text-red-400'
}

// ── Export Button Group ────────────────────────────────────────────────────────

function ExportButtons({ onExport, disabled }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-slate-500">Export:</span>
      {['csv', 'xlsx', 'pdf'].map(fmt => (
        <button key={fmt} onClick={() => onExport(fmt)} disabled={disabled}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-700 hover:bg-slate-600 disabled:opacity-40 border border-slate-600 text-slate-200 rounded-lg transition-colors uppercase">
          <Download size={11} /> {fmt}
        </button>
      ))}
    </div>
  )
}

// ── Status badge ───────────────────────────────────────────────────────────────

function StatusBadge({ status, type = 'agent' }) {
  if (type === 'agent') {
    const map = {
      online:  'bg-green-900/40 text-green-400 border-green-800',
      offline: 'bg-slate-700 text-slate-400 border-slate-600',
      warning: 'bg-yellow-900/40 text-yellow-400 border-yellow-800',
    }
    return <span className={`px-2 py-0.5 rounded-full text-xs border font-medium ${map[status] || map.offline}`}>{status}</span>
  }
  const map = {
    up:      'bg-green-900/40 text-green-400 border-green-800',
    down:    'bg-red-900/40 text-red-400 border-red-800',
    timeout: 'bg-yellow-900/40 text-yellow-400 border-yellow-800',
    unknown: 'bg-slate-700 text-slate-400 border-slate-600',
  }
  return <span className={`px-2 py-0.5 rounded-full text-xs border font-medium ${map[status] || map.unknown}`}>{status || '—'}</span>
}

// ── Agents Report ─────────────────────────────────────────────────────────────

function AgentsReport() {
  const [agents, setAgents] = useState([])
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [statusFilter, setStatusFilter] = useState('all')
  const [search, setSearch] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await api.get('/agents/report')
      setAgents(r.data)
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const filtered = agents.filter(a => {
    const matchStatus = statusFilter === 'all' || a.status === statusFilter
    const matchSearch = !search ||
      a.hostname.toLowerCase().includes(search.toLowerCase()) ||
      (a.ip_address || '').includes(search) ||
      (a.os_name || '').toLowerCase().includes(search.toLowerCase())
    return matchStatus && matchSearch
  })

  async function doExport(fmt) {
    setExporting(true)
    const ts = new Date().toISOString().slice(0, 10)
    try {
      if (fmt === 'csv') {
        exportCSV(filtered, AGENT_REPORT_COLS, `kifaa-agents-${ts}.csv`)
      } else if (fmt === 'pdf') {
        await exportPDF(filtered, AGENT_REPORT_COLS, 'Kifaa — Agent Report', `kifaa-agents-${ts}.pdf`)
      } else if (fmt === 'xlsx') {
        // Build disk rows: one row per disk per agent
        const diskRows = []
        for (const a of filtered) {
          for (const d of (a.hardware?.disks || [])) {
            const usedPct = d.size_gb > 0 ? Math.round(((d.size_gb - d.free_gb) / d.size_gb) * 100) : null
            diskRows.push({
              hostname: a.hostname, ip_address: a.ip_address,
              os_name: a.os_name, os_version: a.os_version, status: a.status,
              device: d.name, filesystem: d.filesystem,
              size_gb: d.size_gb, free_gb: d.free_gb, used_pct: usedPct,
            })
          }
        }
        // Fetch patch data: pending (Windows only), history, compliance
        const [pendingRes, winHistRes, linHistRes, complianceRes] = await Promise.all([
          api.get('/patches/report/pending', { params: { os_type: 'windows' } }),
          api.get('/patches/report/history', { params: { os_type: 'windows' } }),
          api.get('/patches/report/history', { params: { os_type: 'linux' } }),
          api.get('/patches/report/compliance'),
        ])
        // Enrich compliance rows with zero_day (critical patches ≤ 7 days old)
        // We don't track age on pending patches, so zero_day = critical_pending here
        // as a conservative proxy (all unpatched security = potential zero-day exposure)
        const complianceRows = complianceRes.data.map(r => ({
          ...r,
          zero_day_pending: r.critical_pending, // security patches = highest urgency
        }))
        await exportXLSXMulti([
          { rows: filtered,          columns: AGENT_REPORT_COLS,   sheetName: 'Agents' },
          { rows: diskRows,          columns: DISK_REPORT_COLS,    sheetName: 'Disk Space' },
          { rows: pendingRes.data,   columns: PENDING_PATCH_COLS,  sheetName: 'Pending Patches (Windows)' },
          { rows: winHistRes.data,   columns: PATCH_HISTORY_COLS,  sheetName: 'Patch History - Windows' },
          { rows: linHistRes.data,   columns: PATCH_HISTORY_COLS,  sheetName: 'Patch History - Linux' },
          { rows: complianceRows,    columns: COMPLIANCE_COLS,     sheetName: 'Patching Compliance' },
        ], `kifaa-agents-${ts}.xlsx`)
      }
    } finally { setExporting(false) }
  }

  const online = agents.filter(a => a.status === 'online').length
  const offline = agents.filter(a => a.status === 'offline').length

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
          <div className="text-2xl font-bold text-white">{agents.length}</div>
          <div className="text-xs text-slate-400 mt-1 flex items-center gap-1"><Server size={11}/> Total Agents</div>
        </div>
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
          <div className="text-2xl font-bold text-green-400">{online}</div>
          <div className="text-xs text-slate-400 mt-1 flex items-center gap-1"><CheckCircle2 size={11}/> Online</div>
        </div>
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
          <div className="text-2xl font-bold text-slate-400">{offline}</div>
          <div className="text-xs text-slate-400 mt-1 flex items-center gap-1"><Clock size={11}/> Offline</div>
        </div>
      </div>

      {/* Filters + export */}
      <div className="flex items-center gap-3 flex-wrap">
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search hostname, IP, OS..."
          className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white w-56 focus:outline-none focus:ring-2 focus:ring-blue-500" />
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
          className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none">
          <option value="all">All Status</option>
          <option value="online">Online</option>
          <option value="offline">Offline</option>
          <option value="warning">Warning</option>
        </select>
        <div className="flex-1" />
        <span className="text-xs text-slate-500">{filtered.length} records</span>
        <ExportButtons onExport={doExport} disabled={exporting || filtered.length === 0} />
      </div>

      {/* Table */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-auto">
        <table className="w-full text-sm min-w-[900px]">
          <thead>
            <tr className="border-b border-slate-700 text-xs text-slate-400 uppercase bg-slate-800/60">
              <th className="px-4 py-3 text-left">Hostname</th>
              <th className="px-4 py-3 text-left">Description / Function</th>
              <th className="px-4 py-3 text-left">IP</th>
              <th className="px-4 py-3 text-left">OS</th>
              <th className="px-4 py-3 text-left">CPU</th>
              <th className="px-4 py-3 text-left">RAM</th>
              <th className="px-4 py-3 text-left">Disks</th>
              <th className="px-4 py-3 text-left">Status</th>
              <th className="px-4 py-3 text-left">SW</th>
              <th className="px-4 py-3 text-left">Svcs</th>
              <th className="px-4 py-3 text-left">Stopped</th>
              <th className="px-4 py-3 text-left">Last Seen</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {loading ? (
              <tr><td colSpan={11} className="py-12 text-center text-slate-500">Loading...</td></tr>
            ) : filtered.map(a => (
              <tr key={a.id} className="hover:bg-slate-700/30">
                <td className="px-4 py-2.5 font-medium text-white">{a.hostname}</td>
                <td className="px-4 py-2.5 text-xs text-slate-400 max-w-[180px] truncate" title={a.description}>{a.description || <span className="text-slate-600 italic">—</span>}</td>
                <td className="px-4 py-2.5 font-mono text-xs text-slate-300">{a.ip_address || '—'}</td>
                <td className="px-4 py-2.5 text-xs text-slate-300">
                  {a.os_name || '—'}{a.os_version ? ` ${a.os_version}` : ''}
                  {a.os_arch ? <span className="text-slate-500 ml-1">({a.os_arch})</span> : null}
                </td>
                <td className="px-4 py-2.5 text-xs text-slate-400 max-w-36 truncate" title={a.hardware?.cpu_model}>
                  {a.hardware?.cpu_model ? `${a.hardware.cpu_model} (${a.hardware.cpu_cores || '?'}c)` : '—'}
                </td>
                <td className="px-4 py-2.5 text-xs text-slate-400">
                  {a.hardware?.ram_total_gb ? `${Number(a.hardware.ram_total_gb).toFixed(1)} GB` : '—'}
                </td>
                <td className="px-4 py-2.5 text-xs text-slate-400">
                  {a.hardware?.disks?.length
                    ? <span title={a.hardware.disks.map(d => `${d.model || d.device}: ${d.size_gb ? Math.round(d.size_gb)+'GB' : ''}`).join(', ')}>
                        {a.hardware.disks.length} disk{a.hardware.disks.length !== 1 ? 's' : ''}
                      </span>
                    : '—'}
                </td>
                <td className="px-4 py-2.5"><StatusBadge status={a.status} type="agent" /></td>
                <td className="px-4 py-2.5 text-xs text-slate-400">{a.software_count ?? '—'}</td>
                <td className="px-4 py-2.5 text-xs text-slate-400">{a.service_count ?? '—'}</td>
                <td className="px-4 py-2.5 text-xs">
                  {a.stopped_services > 0
                    ? <span className="text-amber-400 font-medium">{a.stopped_services}</span>
                    : <span className="text-slate-600">0</span>}
                </td>
                <td className="px-4 py-2.5 text-xs text-slate-500">
                  {a.last_seen ? new Date(a.last_seen).toLocaleString() : 'Never'}
                </td>
              </tr>
            ))}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={11} className="py-12 text-center text-slate-500">No agents match filters</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Monitors Report ────────────────────────────────────────────────────────────

const DATE_RANGES = [
  { value: 'today',      label: 'Today' },
  { value: 'yesterday',  label: 'Yesterday' },
  { value: '7d',         label: 'Last 7 Days' },
  { value: '30d',        label: 'Last 30 Days' },
  { value: 'month',      label: 'This Month' },
  { value: 'last_month', label: 'Last Month' },
  { value: 'custom',     label: 'Custom Period' },
]

function MonitorsReport() {
  const [monitors, setMonitors] = useState([])
  const [rangeLabel, setRangeLabel] = useState('Yesterday')
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [statusFilter, setStatusFilter] = useState('all')
  const [catFilter, setCatFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [dateRange, setDateRange] = useState('yesterday')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')

  const load = useCallback(async (range = dateRange, cf = customFrom, ct = customTo) => {
    setLoading(true)
    try {
      let url = `/monitoring/report/daily?range=${range}`
      if (range === 'custom' && cf && ct) url += `&from_date=${cf}&to_date=${ct}`
      const r = await api.get(url)
      const label = r.data.label || range

      // Build a compact date string for the "Date" column.
      // Non-custom ranges return `to` as midnight (exclusive) — subtract 1 day.
      // Custom ranges return `to` as 23:59:59 (inclusive) — use as-is.
      const fromDt = r.data.from ? new Date(r.data.from) : null
      const toDt   = r.data.to   ? new Date(r.data.to)   : null
      const fromIso = fromDt ? fromDt.toISOString().slice(0, 10) : ''
      let toIso = ''
      if (toDt) {
        const isExclusive = toDt.getUTCHours() === 0 && toDt.getUTCMinutes() === 0 && toDt.getUTCSeconds() === 0
        toIso = isExclusive
          ? new Date(toDt.getTime() - 86400000).toISOString().slice(0, 10)
          : toDt.toISOString().slice(0, 10)
      }
      const reportDate = !toIso || fromIso === toIso
        ? fromIso
        : `${fromIso} 00:00:00 to ${toIso} 23:59:59`

      // Tag every row with the report date so exports include it
      const rows = (r.data.monitors || []).map(m => ({ ...m, report_date: reportDate }))
      setMonitors(rows)
      setRangeLabel(label)
    } finally { setLoading(false) }
  }, [dateRange, customFrom, customTo])

  function handleRangeChange(val) {
    setDateRange(val)
    if (val !== 'custom') load(val, customFrom, customTo)
  }

  function applyCustom() {
    if (customFrom && customTo) load('custom', customFrom, customTo)
  }

  useEffect(() => { load('yesterday') }, [])

  const categories = [...new Set(monitors.map(m => m.category).filter(Boolean))]

  const filtered = monitors.filter(m => {
    const matchStatus = statusFilter === 'all' || m.last_status === statusFilter
    const matchCat = catFilter === 'all' || m.category === catFilter
    const matchSearch = !search ||
      m.name.toLowerCase().includes(search.toLowerCase()) ||
      (m.host || '').includes(search) ||
      (m.category || '').toLowerCase().includes(search.toLowerCase())
    return matchStatus && matchCat && matchSearch
  })

  const up = monitors.filter(m => m.last_status === 'up').length
  const down = monitors.filter(m => ['down', 'timeout'].includes(m.last_status)).length
  const unknown = monitors.filter(m => !m.last_status || m.last_status === 'unknown').length
  const withData = monitors.filter(m => m.total_checks > 0).length
  const avgUptime = withData
    ? (monitors.filter(m => m.uptime_pct != null).reduce((s, m) => s + m.uptime_pct, 0) / withData).toFixed(1)
    : null

  async function doExport(fmt) {
    setExporting(true)
    const reportDate = monitors[0]?.report_date || new Date().toISOString().slice(0, 10)
    const safeDate = reportDate.replace(/[^a-z0-9]/gi, '-')

    // Build summary stats from all monitors (not just filtered)
    const withData = monitors.filter(m => m.total_checks > 0)
    const uptimeVals = monitors.filter(m => m.uptime_pct != null).map(m => m.uptime_pct)
    const avgUp = uptimeVals.length ? (uptimeVals.reduce((s, v) => s + v, 0) / uptimeVals.length).toFixed(1) : '—'
    const avgDown = uptimeVals.length ? (100 - parseFloat(avgUp)).toFixed(1) : '—'
    const summary = {
      'Report Period': reportDate,
      'Monitors Tracked': monitors.length,
      'Average Uptime': avgUp !== '—' ? `${avgUp}%` : '—',
      'Average Downtime': avgDown !== '—' ? `${avgDown}%` : '—',
      'Total Checks': monitors.reduce((s, m) => s + (m.total_checks || 0), 0),
      'Total Up': monitors.reduce((s, m) => s + (m.up_count || 0), 0),
      'Total Down': monitors.reduce((s, m) => s + (m.down_count || 0), 0),
    }

    try {
      if (fmt === 'csv') {
        const summaryLines = Object.entries(summary).map(([k, v]) => `"${k}","${v}"`).join('\n')
        const header = MONITOR_COLS.map(c => `"${c.label}"`).join(',')
        const body = filtered.map(row =>
          MONITOR_COLS.map(c => `"${String(c.get(row) ?? '').replace(/"/g, '""')}"`).join(',')
        ).join('\n')
        const blob = new Blob([summaryLines + '\n\n' + header + '\n' + body], { type: 'text/csv;charset=utf-8;' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a'); a.href = url; a.download = `kifaa-monitors-${safeDate}.csv`; a.click()
        URL.revokeObjectURL(url)
      } else if (fmt === 'xlsx') {
        const XLSX = await import('xlsx')
        const wb = XLSX.utils.book_new()
        // Summary sheet
        const summaryData = Object.entries(summary).map(([k, v]) => [k, v])
        const wsSummary = XLSX.utils.aoa_to_sheet([['MONITOR AVAILABILITY REPORT'], [], ...summaryData])
        wsSummary['!cols'] = [{ wch: 22 }, { wch: 20 }]
        XLSX.utils.book_append_sheet(wb, wsSummary, 'Summary')
        // Data sheet
        const wsData = [
          MONITOR_COLS.map(c => c.label),
          ...filtered.map(row => MONITOR_COLS.map(c => c.get(row) ?? '')),
        ]
        const ws = XLSX.utils.aoa_to_sheet(wsData)
        ws['!cols'] = MONITOR_COLS.map(c => ({ wch: Math.max(c.label.length, c.minWidth || 15) }))
        XLSX.utils.book_append_sheet(wb, ws, 'Monitors')
        XLSX.writeFile(wb, `kifaa-monitors-${safeDate}.xlsx`)
      } else if (fmt === 'pdf') {
        const { default: jsPDF } = await import('jspdf')
        const { default: autoTable } = await import('jspdf-autotable')
        const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' })
        const pageW = doc.internal.pageSize.getWidth()

        // Title banner
        doc.setFillColor(29, 78, 216)
        doc.rect(0, 0, pageW, 44, 'F')
        doc.setFontSize(15); doc.setTextColor(255, 255, 255)
        doc.text('Kifaa — Monitor Availability Report', 40, 28)

        // Summary block — draw directly to avoid autoTable alternating-row colour bug
        const summaryEntries = Object.entries(summary)
        const ROW_H = 18, COL1_X = 40, COL2_X = 180, COL3_X = 360, COL4_X = 500
        let sy = 56
        // background rect
        doc.setFillColor(30, 41, 59)
        doc.rect(COL1_X, sy - 12, pageW - 80, ROW_H * Math.ceil(summaryEntries.length / 2) + 8, 'F')
        // draw pairs side-by-side
        const pairs = []
        for (let i = 0; i < summaryEntries.length; i += 2) {
          pairs.push([summaryEntries[i], summaryEntries[i + 1] || null])
        }
        pairs.forEach(([left, right]) => {
          doc.setFontSize(8)
          doc.setFont('helvetica', 'bold')
          doc.setTextColor(147, 197, 253)
          doc.text(left[0] + ':', COL1_X + 4, sy)
          doc.setFont('helvetica', 'normal')
          doc.setTextColor(241, 245, 249)
          doc.text(String(left[1] ?? '—'), COL2_X, sy)
          if (right) {
            doc.setFont('helvetica', 'bold')
            doc.setTextColor(147, 197, 253)
            doc.text(right[0] + ':', COL3_X, sy)
            doc.setFont('helvetica', 'normal')
            doc.setTextColor(241, 245, 249)
            doc.text(String(right[1] ?? '—'), COL4_X, sy)
          }
          sy += ROW_H
        })

        // Data table
        autoTable(doc, {
          startY: sy + 6,
          head: [MONITOR_COLS.map(c => c.label)],
          body: filtered.map(row => MONITOR_COLS.map(c => String(c.get(row) ?? '—'))),
          headStyles: { fillColor: [15, 23, 42], textColor: 255, fontSize: 7 },
          bodyStyles: { fontSize: 7, textColor: [51, 65, 85] },
          alternateRowStyles: { fillColor: [248, 250, 252] },
          margin: { left: 40, right: 40 },
          tableWidth: pageW - 80,
          styles: { overflow: 'ellipsize' },
        })
        doc.save(`kifaa-monitors-${safeDate}.pdf`)
      }
    } finally { setExporting(false) }
  }

  const currentYear = new Date().getFullYear()
  const [yearlyYear, setYearlyYear] = useState(currentYear)
  const [yearlyLoading, setYearlyLoading] = useState(false)

  async function doYearlyExport() {
    setYearlyLoading(true)
    try {
      const r = await api.get(`/monitoring/report/yearly?year=${yearlyYear}`)
      await exportYearlyMonitorReport(yearlyYear, r.data.records || [])
    } catch (e) {
      alert(e.response?.data?.detail || 'Failed to generate yearly report')
    } finally { setYearlyLoading(false) }
  }

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="grid grid-cols-5 gap-4">
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
          <div className="text-2xl font-bold text-white">{monitors.length}</div>
          <div className="text-xs text-slate-400 mt-1 flex items-center gap-1"><Activity size={11}/> Total</div>
        </div>
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
          <div className="text-2xl font-bold text-green-400">{up}</div>
          <div className="text-xs text-slate-400 mt-1 flex items-center gap-1"><CheckCircle2 size={11}/> Currently Up</div>
        </div>
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
          <div className="text-2xl font-bold text-red-400">{down}</div>
          <div className="text-xs text-slate-400 mt-1 flex items-center gap-1"><AlertTriangle size={11}/> Currently Down</div>
        </div>
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
          <div className="text-2xl font-bold text-slate-400">{unknown}</div>
          <div className="text-xs text-slate-400 mt-1 flex items-center gap-1"><Clock size={11}/> Pending</div>
        </div>
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
          <div className="text-2xl font-bold text-blue-400">{avgUptime != null ? `${avgUptime}%` : '—'}</div>
          <div className="text-xs text-slate-400 mt-1">Avg Uptime ({monitors[0]?.report_date || rangeLabel})</div>
        </div>
      </div>
      {/* Date range picker */}
      <div className="flex items-center gap-3 flex-wrap bg-slate-800/50 border border-slate-700 rounded-xl px-4 py-3">
        <Clock size={14} className="text-blue-400 flex-shrink-0" />
        <span className="text-xs text-slate-400 font-medium">Report Period:</span>
        <select
          value={dateRange}
          onChange={e => handleRangeChange(e.target.value)}
          className="bg-slate-900 border border-slate-600 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"
        >
          {DATE_RANGES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
        </select>
        {dateRange === 'custom' && (
          <>
            <input
              type="date"
              value={customFrom}
              onChange={e => setCustomFrom(e.target.value)}
              className="bg-slate-900 border border-slate-600 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"
            />
            <span className="text-slate-500 text-xs">to</span>
            <input
              type="date"
              value={customTo}
              onChange={e => setCustomTo(e.target.value)}
              className="bg-slate-900 border border-slate-600 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"
            />
            <button
              onClick={applyCustom}
              disabled={!customFrom || !customTo}
              className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white text-xs rounded-lg"
            >
              Apply
            </button>
          </>
        )}
        {rangeLabel && (
          <span className="text-xs text-slate-400 ml-auto">
            Showing: <strong className="text-white">{rangeLabel}</strong>
          </span>
        )}
      </div>

      {/* Filters + export */}
      <div className="flex items-center gap-3 flex-wrap">
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search name, host..."
          className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white w-52 focus:outline-none focus:ring-2 focus:ring-blue-500" />
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
          className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none">
          <option value="all">All Status</option>
          <option value="up">Up</option>
          <option value="down">Down</option>
          <option value="timeout">Timeout</option>
          <option value="unknown">Unknown</option>
        </select>
        <select value={catFilter} onChange={e => setCatFilter(e.target.value)}
          className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none">
          <option value="all">All Categories</option>
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <div className="flex-1" />
        <span className="text-xs text-slate-500">{filtered.length} records</span>
        <ExportButtons onExport={doExport} disabled={exporting || filtered.length === 0} />
      </div>


      {/* Yearly report */}
      <div className="flex items-center gap-3 px-4 py-3 bg-slate-800/50 border border-slate-700 rounded-xl">
        <FileText size={14} className="text-emerald-400 flex-shrink-0" />
        <span className="text-xs text-slate-300 font-medium">Yearly Report</span>
        <span className="text-xs text-slate-500">— monthly uptime summary, daily breakdown &amp; raw data (3-sheet XLSX)</span>
        <div className="flex items-center gap-2 ml-auto">
          <select
            value={yearlyYear}
            onChange={e => setYearlyYear(Number(e.target.value))}
            className="bg-slate-900 border border-slate-600 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"
          >
            {[currentYear, currentYear - 1, currentYear - 2].map(y => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
          <button
            onClick={doYearlyExport}
            disabled={yearlyLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white text-sm rounded-lg"
          >
            <Download size={14} />
            {yearlyLoading ? 'Building…' : 'Export XLSX'}
          </button>
        </div>
      </div>
      {/* Table */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-auto">
        <table className="w-full text-sm min-w-[900px]">
          <thead>
            <tr className="border-b border-slate-700 text-xs text-slate-400 uppercase bg-slate-800/60">
              <th className="px-4 py-3 text-left">Date</th>
              <th className="px-4 py-3 text-left">Name</th>
              <th className="px-4 py-3 text-left">Type</th>
              <th className="px-4 py-3 text-left">Category</th>
              <th className="px-4 py-3 text-left">Host</th>
              <th className="px-4 py-3 text-left">Current</th>
              <th className="px-4 py-3 text-left">Checks</th>
              <th className="px-4 py-3 text-left">Up / Down</th>
              <th className="px-4 py-3 text-left">Uptime %</th>
              <th className="px-4 py-3 text-left">Avg Latency</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {loading ? (
              <tr><td colSpan={10} className="py-12 text-center text-slate-500">Loading…</td></tr>
            ) : filtered.map(m => (
              <tr key={m.id} className="hover:bg-slate-700/30">
                <td className="px-4 py-2.5 text-xs font-mono text-slate-400 whitespace-nowrap">
                  {m.report_date || '—'}
                </td>
                <td className="px-4 py-2.5 font-medium text-white">{m.name}</td>
                <td className="px-4 py-2.5">
                  <span className="text-xs bg-slate-700 text-slate-300 px-2 py-0.5 rounded capitalize">
                    {m.subtype?.replace(/_/g, ' ') || m.monitor_type}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-xs text-slate-400 capitalize">{m.category}</td>
                <td className="px-4 py-2.5 font-mono text-xs text-slate-300">
                  {m.host}{m.port ? `:${m.port}` : ''}
                </td>
                <td className="px-4 py-2.5"><StatusBadge status={m.last_status} type="monitor" /></td>
                <td className="px-4 py-2.5 text-xs text-slate-400">
                  {m.total_checks > 0 ? m.total_checks : <span className="text-slate-600">—</span>}
                </td>
                <td className="px-4 py-2.5 text-xs">
                  {m.total_checks > 0
                    ? <><span className="text-green-400">{m.up_count}</span> / <span className="text-red-400">{m.down_count}</span></>
                    : <span className="text-slate-600">—</span>}
                </td>
                <td className="px-4 py-2.5 text-xs">
                  {m.uptime_pct != null
                    ? <span className={m.uptime_pct >= 99 ? 'text-green-400 font-medium' : m.uptime_pct >= 90 ? 'text-yellow-400' : 'text-red-400'}>
                        {m.uptime_pct}%
                      </span>
                    : <span className="text-slate-600">No data</span>}
                </td>
                <td className="px-4 py-2.5 text-xs text-slate-400">
                  {m.avg_latency_ms != null ? `${m.avg_latency_ms} ms` : '—'}
                </td>
              </tr>
            ))}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={10} className="py-12 text-center text-slate-500">No monitors match filters</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Compliance Report ─────────────────────────────────────────────────────────

function ComplianceReport() {
  const [perAgent, setPerAgent] = useState([])
  const [dashboard, setDashboard] = useState(null)
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [dashRes, perAgentRes] = await Promise.all([
        api.get('/compliance/dashboard'),
        api.get('/compliance/per-agent'),
      ])
      setDashboard(dashRes.data)
      setPerAgent(perAgentRes.data)
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  async function doExport(fmt) {
    setExporting(true)
    const ts = new Date().toISOString().slice(0, 10)
    try {
      if (fmt === 'csv') {
        exportCSV(perAgent, COMP_ENDPOINT_COLS, `kifaa-compliance-${ts}.csv`)
      } else if (fmt === 'pdf') {
        await exportPDF(perAgent, COMP_ENDPOINT_COLS, 'Kifaa — Compliance Report', `kifaa-compliance-${ts}.pdf`, { fontSize: 7 })
      } else if (fmt === 'xlsx') {
        // Fetch all compliance data in parallel
        const [
          dashRes, perAgentRes, vulnRes, misconfigRes,
          highRiskRes, portsRes, licenseRes,
          pendingRes, winHistRes, linHistRes, patchComplianceRes,
        ] = await Promise.all([
          api.get('/compliance/dashboard'),
          api.get('/compliance/per-agent'),
          api.get('/threats/vulnerabilities'),
          api.get('/threats/misconfigs'),
          api.get('/threats/high-risk'),
          api.get('/threats/ports'),
          api.get('/licenses'),
          api.get('/patches/report/pending', { params: { os_type: 'windows' } }),
          api.get('/patches/report/history', { params: { os_type: 'windows' } }),
          api.get('/patches/report/history', { params: { os_type: 'linux' } }),
          api.get('/patches/report/compliance'),
        ])

        const dash = dashRes.data
        const agents = perAgentRes.data
        const patchComplianceRows = patchComplianceRes.data.map(r => ({ ...r, zero_day_pending: r.critical_pending }))
        const extrasData = { vulns: vulnRes.data, misconfigs: misconfigRes.data, licenses: licenseRes.data }

        // Single ExcelJS workbook: Executive Dashboard + Endpoint Health + all data sheets
        await generateExecutiveDashboardXLSX(dash, agents, ts, extrasData, [
          { rows: patchComplianceRows, columns: COMPLIANCE_COLS,       sheetName: 'Patch Compliance' },
          { rows: agents,              columns: COMP_VULN_REPORT_COLS,  sheetName: 'Vulnerability Report' },
          { rows: vulnRes.data,        columns: COMP_CVE_DETAIL_COLS,   sheetName: 'CVE Detail' },
          { rows: agents,              columns: COMP_CONFIG_COLS,        sheetName: 'Configuration Compliance' },
          { rows: misconfigRes.data,   columns: COMP_MISCONFIG_COLS,    sheetName: 'Misconfigurations' },
          { rows: highRiskRes.data,    columns: COMP_HIGH_RISK_COLS,    sheetName: 'High Risk Software' },
          { rows: portsRes.data,       columns: COMP_PORTS_COLS,        sheetName: 'Open Ports' },
          { rows: agents,              columns: COMP_ENDPOINT_COLS,     sheetName: 'Endpoint Protection' },
          { rows: licenseRes.data,     columns: COMP_LICENSE_COLS,      sheetName: 'License Status' },
          { rows: pendingRes.data,     columns: PENDING_PATCH_COLS,     sheetName: 'Pending Patches (Windows)' },
          { rows: winHistRes.data,     columns: PATCH_HISTORY_COLS,     sheetName: 'Patch History - Windows' },
          { rows: linHistRes.data,     columns: PATCH_HISTORY_COLS,     sheetName: 'Patch History - Linux' },
        ], `kifaa-compliance-report-${ts}.xlsx`)
      }
    } finally { setExporting(false) }
  }

  const cats = dashboard?.categories || {}
  const compliantCount = perAgent.filter(a => a.compliant).length

  return (
    <div className="space-y-4">
      {/* Summary cards */}
      <div className="grid grid-cols-4 gap-4">
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
          <div className={`text-2xl font-bold ${dashboard?.compliant ? 'text-green-400' : 'text-red-400'}`}>
            {dashboard?.overall ?? '—'}%
          </div>
          <div className="text-xs text-slate-400 mt-1">Overall Score</div>
          <div className="text-xs text-slate-500 mt-0.5">{dashboard?.compliant ? 'Compliant' : 'Non-Compliant'}</div>
        </div>
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
          <div className="text-2xl font-bold text-green-400">{compliantCount}</div>
          <div className="text-xs text-slate-400 mt-1">Compliant Agents</div>
          <div className="text-xs text-slate-500 mt-0.5">of {perAgent.length} total</div>
        </div>
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
          <div className="text-2xl font-bold text-red-400">{cats.vulnerability?.critical_open ?? '—'}</div>
          <div className="text-xs text-slate-400 mt-1">Critical CVEs Open</div>
          <div className="text-xs text-slate-500 mt-0.5">Target: 0</div>
        </div>
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
          <div className="text-2xl font-bold text-blue-400">{cats.configuration?.passed ?? '—'}</div>
          <div className="text-xs text-slate-400 mt-1">Config Checks Passed</div>
          <div className="text-xs text-slate-500 mt-0.5">of {cats.configuration?.total ?? '—'} total</div>
        </div>
      </div>

      {/* Export row */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <p className="text-sm text-slate-400">
          {loading ? 'Loading…' : `${perAgent.length} agents · XLSX exports all 13 sheets`}
          {exporting && <span className="ml-2 text-blue-400">Generating…</span>}
        </p>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Executive PDF standalone */}
          <button
            disabled={exporting || loading || perAgent.length === 0}
            onClick={async () => {
              setExporting(true)
              const ts = new Date().toISOString().slice(0, 10)
              try {
                const [dashRes, perAgentRes] = await Promise.all([
                  api.get('/compliance/dashboard'),
                  api.get('/compliance/per-agent'),
                ])
                const doc = await generateExecutivePDF(dashRes.data, perAgentRes.data, ts)
                doc.save(`kifaa-executive-summary-${ts}.pdf`)
              } finally { setExporting(false) }
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-700 hover:bg-slate-600 disabled:opacity-40 border border-slate-600 text-slate-200 rounded-lg transition-colors"
          >
            <Download size={11} /> Executive PDF
          </button>
          {/* Executive Dashboard XLSX (ExcelJS styled) */}
          <button
            disabled={exporting || loading || perAgent.length === 0}
            onClick={async () => {
              setExporting(true)
              const ts = new Date().toISOString().slice(0, 10)
              try {
                const [dashRes, perAgentRes, vulnRes, misconfigRes, licenseRes] = await Promise.all([
                  api.get('/compliance/dashboard'),
                  api.get('/compliance/per-agent'),
                  api.get('/threats/vulnerabilities'),
                  api.get('/threats/misconfigs'),
                  api.get('/licenses'),
                ])
                await generateExecutiveDashboardXLSX(
                  dashRes.data, perAgentRes.data, ts,
                  { vulns: vulnRes.data, misconfigs: misconfigRes.data, licenses: licenseRes.data },
                  [],
                  `kifaa-executive-dashboard-${ts}.xlsx`
                )
              } finally { setExporting(false) }
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-green-700 hover:bg-green-600 disabled:opacity-40 border border-green-600 text-white rounded-lg transition-colors"
          >
            <Download size={11} /> Executive XLSX
          </button>
          {/* Full 13-sheet compliance report */}
          <ExportButtons onExport={doExport} disabled={exporting || loading || perAgent.length === 0} />
        </div>
      </div>

      {/* Per-agent table */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-auto">
        <table className="w-full text-sm min-w-[1000px]">
          <thead>
            <tr className="border-b border-slate-700 text-xs text-slate-400 uppercase bg-slate-800/60">
              <th className="px-4 py-3 text-left">Host</th>
              <th className="px-4 py-3 text-left">OS</th>
              <th className="px-4 py-3 text-left">Patch</th>
              <th className="px-4 py-3 text-left">Vuln</th>
              <th className="px-4 py-3 text-left">Config</th>
              <th className="px-4 py-3 text-left">Protection</th>
              <th className="px-4 py-3 text-left">License</th>
              <th className="px-4 py-3 text-left">Overall</th>
              <th className="px-4 py-3 text-left">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {loading ? (
              <tr><td colSpan={9} className="py-12 text-center text-slate-500">Loading compliance data…</td></tr>
            ) : perAgent.map(a => (
              <tr key={a.id} className="hover:bg-slate-700/30">
                <td className="px-4 py-2.5 text-white">
                  <div className="font-medium">{a.display_name || a.hostname}</div>
                  <div className="text-xs text-slate-400">{a.ip_address}</div>
                </td>
                <td className="px-4 py-2.5 text-xs text-slate-300">{a.os_name || '—'}</td>
                <td className={`px-4 py-2.5 font-mono text-sm ${scoreColor(a.patch_score)}`}>{a.patch_score}%</td>
                <td className={`px-4 py-2.5 font-mono text-sm ${scoreColor(a.vuln_score)}`}>{a.vuln_score}%</td>
                <td className={`px-4 py-2.5 font-mono text-sm ${scoreColor(a.config_score)}`}>
                  {a.config_score != null ? `${a.config_score}%` : '—'}
                </td>
                <td className={`px-4 py-2.5 font-mono text-sm ${scoreColor(a.protection_score)}`}>{a.protection_score}%</td>
                <td className={`px-4 py-2.5 font-mono text-sm ${scoreColor(a.license_score)}`}>
                  {a.license_score != null ? `${a.license_score}%` : '—'}
                </td>
                <td className={`px-4 py-2.5 font-mono font-bold text-sm ${scoreColor(a.overall_score)}`}>{a.overall_score}%</td>
                <td className="px-4 py-2.5">
                  {a.compliant
                    ? <span className="text-xs px-2 py-0.5 rounded-full border bg-green-900/40 text-green-300 border-green-700">Compliant</span>
                    : <span className="text-xs px-2 py-0.5 rounded-full border bg-red-900/40 text-red-300 border-red-700">Non-Compliant</span>
                  }
                </td>
              </tr>
            ))}
            {!loading && perAgent.length === 0 && (
              <tr><td colSpan={9} className="py-12 text-center text-slate-500">No compliance data yet</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Server Inventory Report ────────────────────────────────────────────────────

function ServerInventoryReport() {
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState(null)
  const [preview, setPreview] = useState(null)   // summary counts shown after load

  const handleGenerate = async () => {
    setGenerating(true)
    setError(null)
    try {
      const res = await api.get('/reports/server-inventory')
      const data = res.data
      const { servers, utilization, licenses, generated_at } = data

      const XLSX = await import('xlsx')

      function makeSheet(headers, rows) {
        const wsData = [headers, ...rows]
        const ws = XLSX.utils.aoa_to_sheet(wsData)
        ws['!cols'] = headers.map(h => ({ wch: Math.max(h.length + 2, 18) }))
        return ws
      }

      const dateStr = new Date(generated_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })

      // ── Sheet 1: Server Specs (includes disk usage columns)
      const specHeaders = [
        'Server Name', 'Hostname', 'IP Address', 'OS Type', 'OS Name', 'OS Version', 'Arch',
        'CPU Model', 'CPU Cores', 'CPU Threads', 'RAM Total (GB)',
        'Disk Total (GB)', 'Disk Used (GB)', 'Disk Free (GB)', 'Disk Used %', 'Storage Health',
        'Serial Number', 'Asset Tag', 'Asset Type',
        'BIOS Vendor', 'BIOS Version', 'BIOS Date',
        'Motherboard', 'Default Gateway', 'NIC Count', 'Primary MAC',
        'Status', 'Last Seen', 'Registered'
      ]
      const specRows = servers.map(s => {
        const storHealth = s.disk_used_pct >= 90 ? 'Critical' : s.disk_used_pct >= 75 ? 'Warning' : s.disk_used_pct != null ? 'Healthy' : ''
        return [
          s.name, s.name !== s.hostname ? s.hostname : '',
          s.ip_address, s.os_type, s.os_name, s.os_version, s.os_arch,
          s.cpu_model, s.cpu_cores, s.cpu_threads, s.ram_total_gb,
          s.disk_total_gb, s.disk_used_gb, s.disk_free_gb, s.disk_used_pct, storHealth,
          s.serial_number, s.asset_tag, s.asset_type,
          s.bios_vendor, s.bios_version, s.bios_date,
          [s.motherboard_vendor, s.motherboard_model].filter(Boolean).join(' '),
          s.default_gateway, s.nic_count, s.primary_mac,
          s.status,
          s.last_seen ? new Date(s.last_seen).toLocaleString() : '',
          s.registered_at ? new Date(s.registered_at).toLocaleDateString() : '',
        ]
      })

      // ── Sheet 2: CPU & RAM Utilization (24h) — same name as Server Specs
      const utilHeaders = [
        'Server Name',
        'CPU Avg % (24h)', 'CPU Peak % (24h)', 'CPU Status',
        'RAM Avg % (24h)', 'RAM Peak % (24h)', 'RAM Status',
        'Swap Avg % (24h)',
      ]
      const utilRows = utilization.map(u => {
        const cpuStatus = u.cpu_avg_pct >= 85 ? 'High' : u.cpu_avg_pct >= 60 ? 'Moderate' : 'Normal'
        const ramStatus = u.ram_avg_pct >= 85 ? 'High' : u.ram_avg_pct >= 70 ? 'Moderate' : 'Normal'
        return [
          u.name,
          u.cpu_avg_pct, u.cpu_peak_pct, cpuStatus,
          u.ram_avg_pct, u.ram_peak_pct, ramStatus,
          u.swap_avg_pct,
        ]
      }).sort((a, b) => (a[0] || '').localeCompare(b[0] || ''))

      // ── Sheet 3: Licenses (OS, software, database — no Ubuntu Pro)
      const licHeaders = [
        'Server Name', 'Software / Product', 'Source', 'License Type',
        'Activation Status', 'License Key', 'Expiry Date', 'Channel',
        'Version', 'Publisher', 'Install Date', 'Detected'
      ]
      const licRows = licenses.map(l => [
        l.name,
        l.software_name,
        l.source || '',
        l.license_type || '',
        l.activation_status || '',
        l.license_key || '',
        l.expiry_date ? new Date(l.expiry_date).toLocaleDateString() : '',
        l.license_channel || '',
        l.version || '',
        l.publisher || '',
        l.install_date || '',
        l.detected_at ? new Date(l.detected_at).toLocaleDateString() : '',
      ])

      // ── Sheet 4: Summary
      const criticalServers = servers.filter(s => s.disk_used_pct >= 90).length
      const highCpu = utilRows.filter(r => r[3] === 'High').length
      const highRam = utilRows.filter(r => r[6] === 'High').length
      const expiredLic = licenses.filter(l => l.expiry_date && new Date(l.expiry_date) < new Date()).length
      const summaryData = [
        ['Server Inventory Report', ''],
        ['Generated', dateStr],
        ['', ''],
        ['SERVERS', ''],
        ['Total Servers', servers.length],
        ['Online', servers.filter(s => s.status === 'online').length],
        ['Offline', servers.filter(s => s.status === 'offline').length],
        ['', ''],
        ['STORAGE (from live metrics)', ''],
        ['Servers with Critical Disk (>90%)', criticalServers],
        ['Servers with Warning Disk (>75%)', servers.filter(s => s.disk_used_pct >= 75 && s.disk_used_pct < 90).length],
        ['Servers with no disk data', servers.filter(s => s.disk_used_pct == null).length],
        ['', ''],
        ['UTILIZATION (24h avg)', ''],
        ['Servers with High CPU (>85%)', highCpu],
        ['Servers with High RAM (>85%)', highRam],
        ['', ''],
        ['LICENSES', ''],
        ['Total License Entries', licenses.length],
        ['OS / Software Licenses', licenses.filter(l => l.source === 'OS / Software').length],
        ['Database Licenses (MSSQL)', licenses.filter(l => l.source === 'Database').length],
        ['Expired', expiredLic],
      ]

      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summaryData), 'Summary')
      XLSX.utils.book_append_sheet(wb, makeSheet(specHeaders, specRows),      'Server Specs')
      XLSX.utils.book_append_sheet(wb, makeSheet(utilHeaders, utilRows),      'CPU & RAM (24h)')
      XLSX.utils.book_append_sheet(wb, makeSheet(licHeaders,  licRows),       'Licenses')

      const filename = `Server_Inventory_Report_${new Date().toISOString().slice(0, 10)}.xlsx`
      XLSX.writeFile(wb, filename)

      setPreview({
        servers: servers.length,
        online: servers.filter(s => s.status === 'online').length,
        critical: criticalServers,
        licenses: licenses.length,
        db_licenses: licenses.filter(l => l.source === 'Database').length,
        expired: expiredLic,
        generated_at: dateStr,
      })
    } catch (e) {
      setError(e.response?.data?.detail || e.message || 'Failed to generate report')
    } finally {
      setGenerating(false)
    }
  }

  const sheets = [
    { name: 'Summary',        desc: 'Counts — servers online/offline, storage health, license totals' },
    { name: 'Server Specs',   desc: 'CPU, RAM, OS, BIOS, serial, disk total/used/free/%, health' },
    { name: 'CPU & RAM (24h)',desc: '24-hour avg & peak CPU %, RAM %, swap % — same server names' },
    { name: 'Licenses',       desc: 'OS licenses, Windows editions, SUSE, MSSQL database installs — excludes Ubuntu Pro' },
  ]

  return (
    <div className="space-y-5">
      {/* What's included */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {sheets.map(s => (
          <div key={s.name} className="bg-slate-800 border border-slate-700 rounded-lg p-3">
            <div className="text-xs font-semibold text-green-400 mb-0.5">Sheet: {s.name}</div>
            <div className="text-xs text-slate-400">{s.desc}</div>
          </div>
        ))}
      </div>

      {/* Last generated preview */}
      {preview && (
        <div className="bg-slate-800/60 border border-slate-700 rounded-lg p-4 grid grid-cols-3 md:grid-cols-6 gap-4 text-center text-xs">
          {[
            { label: 'Servers',       val: preview.servers },
            { label: 'Online',        val: preview.online,       cls: 'text-green-400' },
            { label: 'Critical Disk', val: preview.critical,     cls: preview.critical > 0 ? 'text-red-400' : 'text-green-400' },
            { label: 'Licenses',      val: preview.licenses },
            { label: 'DB Licenses',   val: preview.db_licenses,  cls: 'text-blue-400' },
            { label: 'Expired',       val: preview.expired,      cls: preview.expired > 0 ? 'text-yellow-400' : 'text-green-400' },
          ].map(item => (
            <div key={item.label}>
              <div className={`text-xl font-bold ${item.cls || 'text-white'}`}>{item.val}</div>
              <div className="text-slate-500">{item.label}</div>
            </div>
          ))}
          <div className="col-span-3 md:col-span-6 text-slate-500 text-xs mt-1">Generated {preview.generated_at} — file downloaded</div>
        </div>
      )}

      {error && (
        <div className="bg-red-900/30 border border-red-700 text-red-300 rounded-lg px-4 py-3 text-sm">{error}</div>
      )}

      <button
        onClick={handleGenerate}
        disabled={generating}
        className="flex items-center gap-2 px-5 py-2.5 bg-green-700 hover:bg-green-600 text-white text-sm font-semibold rounded-lg disabled:opacity-50 transition-colors"
      >
        <Download size={15} className={generating ? 'animate-bounce' : ''} />
        {generating ? 'Generating Report…' : 'Generate & Download Server Report'}
      </button>
      <p className="text-xs text-slate-500">Downloads as a 4-sheet Excel workbook (.xlsx). Data is pulled live at generation time.</p>
    </div>
  )
}

// ── Main Reports Page ──────────────────────────────────────────────────────────

const REPORT_TYPES = [
  { key: 'agents',     label: 'Agent Report',      icon: Monitor,  desc: 'Inventory, hardware, status and last-seen for all registered agents' },
  { key: 'monitors',  label: 'Monitor Report',    icon: Activity, desc: 'Status, availability, latency and check history for all monitors' },
  { key: 'compliance', label: 'Compliance Report', icon: FileText, desc: '13-sheet XLSX: compliance scores, CVEs, misconfigs, licenses, patches' },
  { key: 'server',     label: 'Server Report',     icon: Server,   desc: '4-sheet XLSX: specs with disk usage, CPU/RAM (24h), OS/DB/SUSE licenses' },
]

export default function Reports() {
  const [active, setActive] = useState('agents')
  const activeReport = REPORT_TYPES.find(r => r.key === active)

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-white flex items-center gap-2">
          <FileText size={20} className="text-blue-400" /> Reports
        </h1>
        <p className="text-sm text-slate-400 mt-0.5">Generate and export reports for agents and monitors</p>
      </div>

      {/* Report type selector */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {REPORT_TYPES.map(rt => (
          <button key={rt.key} onClick={() => setActive(rt.key)}
            className={`flex items-start gap-3 p-4 rounded-xl border-2 text-left transition-all ${
              active === rt.key
                ? 'border-blue-500 bg-blue-600/10'
                : 'border-slate-700 bg-slate-800 hover:border-slate-500'
            }`}>
            <rt.icon size={20} className={active === rt.key ? 'text-blue-400 mt-0.5' : 'text-slate-400 mt-0.5'} />
            <div>
              <div className={`font-medium text-sm ${active === rt.key ? 'text-white' : 'text-slate-300'}`}>{rt.label}</div>
              <div className="text-xs text-slate-500 mt-0.5">{rt.desc}</div>
            </div>
          </button>
        ))}
      </div>

      {/* Report content */}
      <div className="bg-slate-900 border border-slate-700 rounded-xl p-5">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2">
            <activeReport.icon size={16} className="text-blue-400" />
            <h2 className="font-semibold text-white">{activeReport.label}</h2>
          </div>
          <div className="text-xs text-slate-500">
            {new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
          </div>
        </div>
        {active === 'agents'     && <AgentsReport />}
        {active === 'monitors'   && <MonitorsReport />}
        {active === 'compliance' && <ComplianceReport />}
        {active === 'server'     && <ServerInventoryReport />}
      </div>
    </div>
  )
}
