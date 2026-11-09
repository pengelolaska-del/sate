$file = "C:\xampp\htdocs\sate\docs\index.html"
$content = Get-Content $file -Raw -Encoding UTF8

# Pattern yang ada di file (dengan unicode ──)
$oldJs = "    // \u2500\u2500 KPI \u2500\u2500`r`n    document.getElementById('rk-total-paket').textContent = fmt(d.total_paket || 0);`r`n    document.getElementById('rk-total-nilai').textContent = IDR(d.total_nilai || 0);`r`n    document.getElementById('rk-tender-selesai').textContent = fmt((d.tender_selesai||[]).length);"

$newJs = "    // \u2500\u2500 KPI (sinkron Sandingan RUP) \u2500\u2500`r`n    document.getElementById('rk-total-paket').textContent = fmt(d.total_paket_rup || d.total_paket || 0);`r`n    document.getElementById('rk-total-nilai').textContent = IDR(d.total_nilai || 0);`r`n    document.getElementById('rk-tender-selesai').textContent = fmt((d.tender_selesai||[]).length);`r`n    // Info orphan (unmatched)`r`n    const unEl = document.getElementById('rk-unmatched-info');`r`n    if (unEl && d.total_paket_unmatched > 0) unEl.textContent = '+ '+fmt(d.total_paket_unmatched)+' belum match RUP';`r`n    else if (unEl) unEl.textContent = '';`r`n    // KPI baris 2: Status & Efisiensi`r`n    const rkSelesai = document.getElementById('rk-kpi-selesai');`r`n    const rkStatusSub = document.getElementById('rk-kpi-status-sub');`r`n    const rkEfi = document.getElementById('rk-kpi-efisiensi');`r`n    const rkEfiSub = document.getElementById('rk-kpi-efisiensi-sub');`r`n    const rkKontrak = document.getElementById('rk-kpi-kontrak');`r`n    if (rkSelesai) rkSelesai.textContent = fmt(d.jumlah_selesai || 0) + ' paket';`r`n    if (rkStatusSub) rkStatusSub.textContent = fmt(d.jumlah_berjalan||0)+' Sedang Berjalan \u00b7 '+fmt(d.jumlah_belum||0)+' Belum Berproses';`r`n    const efiRp = d.efisiensi_selesai || 0;`r`n    const efiPct = (d.persen_efisiensi_selesai || 0);`r`n    if (rkEfi) { rkEfi.textContent = IDRf(efiRp); rkEfi.style.color = efiRp < 0 ? '#DC2626' : '#1D4ED8'; }`r`n    if (rkEfiSub) rkEfiSub.textContent = efiPct.toFixed(2) + '% dari pagu paket selesai yg match RUP';`r`n    if (rkKontrak) rkKontrak.textContent = IDR(d.kontrak_selesai || 0);"

if ($content.Contains($oldJs)) {
    $newContent = $content.Replace($oldJs, $newJs)
    Set-Content $file -Value $newContent -Encoding UTF8 -NoNewline
    Write-Host "SUCCESS: KPI JS replaced"
} else {
    # Fallback: regex dengan .*? antara // ── KPI ── dan tender-selesai
    $m = [regex]::Match($content, '// \u2500+ KPI \u2500+\r?\n(    document\.getElementById.*?\r?\n){3}', [System.Text.RegularExpressions.RegexOptions]::Singleline)
    if ($m.Success) {
        $newContent = $content.Replace($m.Value, $newJs + "`r`n")
        Set-Content $file -Value $newContent -Encoding UTF8 -NoNewline
        Write-Host "SUCCESS via regex"
    } else {
        Write-Host "GAGAL: Tidak ditemukan"
    }
}
