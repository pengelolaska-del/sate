$body = '{"action":"listSandingan","periode":"2026-10","page":1,"per_page":5}'
Write-Host "Testing listSandingan..."
Write-Host "Start: $(Get-Date -Format 'HH:mm:ss')"
try {
    $response = Invoke-WebRequest -Uri 'https://fcshmbmregsyyffbarsh.supabase.co/functions/v1/dashboard-api' -Method POST -ContentType 'text/plain' -Body $body -TimeoutSec 120 -UseBasicParsing
    Write-Host "End: $(Get-Date -Format 'HH:mm:ss')"
    Write-Host "Status: $($response.StatusCode)"
    $json = $response.Content | ConvertFrom-Json
    Write-Host "Total items: $($json.data.total)"
    Write-Host "Summary matched: $($json.data.summary.selesai + $json.data.summary.sedang_berjalan)"
    Write-Host "Summary belum: $($json.data.summary.belum_berproses)"
    $json.data.summary | ConvertTo-Json
} catch {
    Write-Host "End: $(Get-Date -Format 'HH:mm:ss')"
    Write-Host "HTTP Error: $($_.Exception.Response.StatusCode.value__)"
    Write-Host "Error: $($_.Exception.Message)"
    try {
        $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
        $reader.BaseStream.Position = 0
        Write-Host "Body: $($reader.ReadToEnd())"
    } catch {}
}
