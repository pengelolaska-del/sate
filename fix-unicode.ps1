$file = "C:\xampp\htdocs\sate\docs\index.html"
$content = [System.IO.File]::ReadAllText($file, [System.Text.Encoding]::UTF8)

# Replace broken escapes with actual characters
$check = [char]::ConvertFromUtf32(0x2705)  # ✅
$dash = [char]::ConvertFromUtf32(0x2014)   # —

$content = $content.Replace("u{2705}", $check)
$content = $content.Replace("u{2014}", $dash)

[System.IO.File]::WriteAllText($file, $content, [System.Text.Encoding]::UTF8)
Write-Host "Fixed. Check mark = [$check], Dash = [$dash]"
