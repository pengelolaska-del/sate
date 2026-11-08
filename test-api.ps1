$body = '{"action":"runMatching","token":"Q1w2e3r4!","periode":"2026-10"}'
Write-Host "Testing runMatching..."
Write-Host "Start: $(Get-Date -Format 'HH:mm:ss')"
try {
    $response = Invoke-WebRequest -Uri 'https://fcshmbmregsyyffbarsh.supabase.co/functions/v1/dashboard-api' -Method POST -ContentType 'text/plain' -Body $body -TimeoutSec 180 -UseBasicParsing
    Write-Host "End: $(Get-Date -Format 'HH:mm:ss')"
    Write-Host "Status: $($response.StatusCode)"
    $json = $response.Content | ConvertFrom-Json
    $json | ConvertTo-Json -Depth 3
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
