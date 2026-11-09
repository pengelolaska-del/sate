$files = Get-ChildItem "D:\BPBJ\datainaprocCSV\" -Filter "*.csv"
foreach ($f in $files) {
    $mb = [math]::Round($f.Length / 1MB, 2)
    Write-Host "$($f.Name) | $($f.Length) bytes | $mb MB"
}
