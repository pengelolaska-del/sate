$file = "C:\xampp\htdocs\sate\docs\index.html"
$lines = [System.IO.File]::ReadAllLines($file)

# Find line 4602 (0-indexed: 4601) which has "const d=r.lastRes"
# Replace lines 4602-4609 with new code

$newLines = @(
    "    const d=r.lastRes?.data||{};"
    "    // Upload selesai, jalankan matching terpisah agar tidak timeout"
    "    if(d.need_matching) {"
    "      document.getElementById('prog-real-lbl').textContent='Menjalankan Matching...';"
    "      try {"
    "        const mRes = await api({action:'runMatching', token:S.adminToken, periode});"
    "        const md = mRes.data||{};"
    "        Swal.fire('\u2705 Upload & Matching Berhasil',"
    "          '<b>'+r.total.toLocaleString('id-ID')+'</b> record diproses.<br>' +"
    "          'Matched: <b>'+(md.matched||'\u2014')+'</b> | Unmatched: <b>'+(md.unmatched||'\u2014')+'</b> | Orphan: <b>'+(md.orphan||'\u2014')+'</b>',"
    "          'success');"
    "      } catch(me) {"
    "        Swal.fire('\u26A0\uFE0F Upload Berhasil, Matching Gagal',"
    "          '<b>'+r.total.toLocaleString('id-ID')+'</b> record berhasil diupload.<br>' +"
    "          'Matching error: '+me.message+'<br>Gunakan tombol <b>Jalankan Ulang Matching</b> di halaman Sandingan.',"
    "          'warning');"
    "      }"
    "    } else {"
    "      Swal.fire('\u2705 Chunk OK', r.total.toLocaleString('id-ID')+' record diproses.', 'success');"
    "    }"
    "    realFile=null; document.getElementById('lbl-real').textContent='Klik atau drag file CSV di sini';"
    "    document.getElementById('prog-real-wrap').classList.add('hidden'); btn.disabled=true;"
    "    await init();"
)

# Lines to replace: from index 4601 (line 4602) to index 4608 (line 4609)
# That's 8 lines being replaced
$before = $lines[0..4600]
$after = $lines[4609..($lines.Length-1)]
$result = $before + $newLines + $after

[System.IO.File]::WriteAllLines($file, $result)
Write-Host "Patched $file successfully. Old line count: $($lines.Length), New line count: $($result.Length)"
