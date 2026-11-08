# Test upload realisasi with just 5 rows to see if it works
$body = @{
    action = "uploadRealisasi"
    token = "Q1w2e3r4!"
    periode = "2026-10"
    session_id = [guid]::NewGuid().ToString()
    chunk_index = 0
    total_chunks = 1
    total_records = 2
    nama_file = "test.csv"
    data = @(
        @{
            nama_instansi = "KOTA SURAKARTA"
            nama_satuan_kerja = "RSUD IBU FATMAWATI SOEKARNO - 1.02.0.00.0.00.01.0019"
            kode_paket = "01M3K5N8734HMXJQV709B48ZC9"
            kode_rup = "67907900"
            tahun_anggaran = "2026"
            sumber_transaksi = "E-Katalog Versi 6.0"
            sumber_dana = "BLUD"
            nama_penyedia = "EISAI INDONESIA"
            metode_pengadaan = "E-Purchasing"
            jenis_pengadaan = "Barang"
            nama_paket = "Belanja Obat"
            status_paket = "ON PROCESS"
            tahapan_pengadaan = "Kontrak"
            total_nilai = 1435064
            nilai_pdn = 1435064
            nilai_umk = 0
        },
        @{
            nama_instansi = "KOTA SURAKARTA"
            nama_satuan_kerja = "DINAS KESEHATAN - 1.02.0.00.0.00.01.0000"
            kode_paket = "ABC123"
            kode_rup = "12345678"
            tahun_anggaran = "2026"
            sumber_transaksi = "E-Katalog Versi 6.0"
            sumber_dana = "APBD"
            nama_penyedia = "PT TEST"
            metode_pengadaan = "E-Purchasing"
            jenis_pengadaan = "Barang"
            nama_paket = "Test Paket"
            status_paket = "COMPLETED"
            tahapan_pengadaan = "Kontrak"
            total_nilai = 100000
            nilai_pdn = 100000
            nilai_umk = 0
        }
    )
} | ConvertTo-Json -Depth 5

try {
    $response = Invoke-RestMethod -Uri 'https://fcshmbmregsyyffbarsh.supabase.co/functions/v1/dashboard-api' -Method POST -ContentType 'text/plain' -Body $body -TimeoutSec 120
    $response | ConvertTo-Json -Depth 5
} catch {
    Write-Host "ERROR: $($_.Exception.Message)"
    if ($_.Exception.Response) {
        $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
        $reader.BaseStream.Position = 0
        Write-Host "Response Body: $($reader.ReadToEnd())"
    }
}
