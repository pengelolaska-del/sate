$body = @{
    action = "uploadRealisasi"
    token = "Q1w2e3r4!"
    periode = "2026-10"
    session_id = [guid]::NewGuid().ToString()
    chunk_index = 0
    total_chunks = 2
    total_records = 3
    nama_file = "test_small.csv"
    data = @(
        @{
            nama_satuan_kerja = "RSUD IBU FATMAWATI SOEKARNO - 1.02.0.00.0.00.01.0019"
            kode_paket = "TEST001"
            kode_rup = "67907900"
            sumber_transaksi = "E-Katalog Versi 6.0"
            sumber_dana = "BLUD"
            nama_penyedia = "EISAI INDONESIA"
            metode_pengadaan = "E-Purchasing"
            jenis_pengadaan = "Barang"
            nama_paket = "Belanja Obat"
            status_paket = "ON PROCESS"
            total_nilai = 1435064
            nilai_pdn = 1435064
        }
    )
} | ConvertTo-Json -Depth 5 -Compress

Write-Host "Request body size: $($body.Length) bytes"
Write-Host "Sending request..."

try {
    $response = Invoke-WebRequest -Uri 'https://fcshmbmregsyyffbarsh.supabase.co/functions/v1/dashboard-api' -Method POST -ContentType 'text/plain' -Body $body -TimeoutSec 120 -UseBasicParsing
    Write-Host "Status: $($response.StatusCode)"
    Write-Host "Response: $($response.Content)"
} catch {
    Write-Host "HTTP Error: $($_.Exception.Response.StatusCode.value__)"
    Write-Host "Error: $($_.Exception.Message)"
    try {
        $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
        $reader.BaseStream.Position = 0
        Write-Host "Response body: $($reader.ReadToEnd())"
    } catch {
        Write-Host "Could not read response body"
    }
}
