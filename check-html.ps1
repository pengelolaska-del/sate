$lines = Get-Content "C:\xampp\htdocs\sate\docs\index.html" -Encoding UTF8
# Cari baris rk-kpi-selesai
for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match "rk-kpi-selesai|rk-unmatched-info|total_paket_rup") {
        Write-Host "Line $($i+1): $($lines[$i])"
    }
}
