$body = Get-Content 'C:\xampp\htdocs\sate\test-req.json' -Raw
$result = Invoke-RestMethod -Method POST -Uri 'https://fcshmbmregsyyffbarsh.supabase.co/functions/v1/dashboard-api' -ContentType 'text/plain' -Body $body
$result | ConvertTo-Json -Depth 5
