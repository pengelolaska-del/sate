$body = '{"action":"listRealisasi","periode":"2026-10","page":1,"per_page":1}'
try {
    $response = Invoke-RestMethod -Uri 'https://fcshmbmregsyyffbarsh.supabase.co/functions/v1/dashboard-api' -Method POST -ContentType 'text/plain' -Body $body
    $response | ConvertTo-Json -Depth 5
} catch {
    Write-Host "ERROR: $($_.Exception.Message)"
}
