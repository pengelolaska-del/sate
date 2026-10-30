<?php

declare(strict_types=1);

namespace App\Services\Dashboard;

use App\Support\Api;
use App\Support\ApiException;
use App\Support\Normalizer as N;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/** Upload CSV per-chunk (frontend mengirim ±500 baris per request). */
final class UploadService
{
    public function __construct(
        private readonly MatchingService $matching,
        private readonly AggregateService $aggregate,
    ) {}

    public function uploadRup(array $p): array
    {
        [$periode, $bulan, $tahun, $uploadId, $isFirst, $isLast, $rows] = $this->prepare($p);

        if ($isFirst) {
            $this->assertColumns($rows, ['Nama Satuan Kerja', 'Cara Pengadaan', 'Nama Paket', 'Kode RUP', 'Total Nilai (Rp)']);
        }

        $records = array_map(function (array $row) use ($uploadId, $periode, $bulan, $tahun) {
            [$namaSatker, $kodeSatker] = N::parseSatker(N::str($row['Nama Satuan Kerja'] ?? ''));
            $cara = N::cara($row['Cara Pengadaan'] ?? '');
            $metode = N::str($row['Metode Pengadaan'] ?? '');
            $jenis = N::str($row['Jenis Pengadaan'] ?? '');
            $metode = $metode === '' ? '-' : trim($metode);
            $jenis = $jenis === '' ? '-' : trim($jenis);
            if ($cara === 'Swakelola') {
                $metode = $jenis = 'Swakelola';
            }

            return [
                'upload_id' => $uploadId, 'periode' => $periode, 'bulan' => $bulan, 'tahun' => $tahun,
                'kode_satker' => $kodeSatker, 'nama_satker' => $namaSatker,
                'cara_pengadaan' => $cara, 'metode_pengadaan' => $metode, 'jenis_pengadaan' => $jenis,
                'nama_paket' => N::str($row['Nama Paket'] ?? ''),
                'kode_rup' => N::str($row['Kode RUP'] ?? ''),
                'sumber_dana' => N::sumberDana(N::str($row['Sumber Dana'] ?? '')),
                'produk_dalam_negeri' => N::str($row['Produk Dalam Negeri'] ?? ''),
                'pagu' => N::number($row['Total Nilai (Rp)'] ?? 0),
            ];
        }, $rows);

        if ($isFirst) {
            DB::table('rup_records')->where('periode', $periode)->delete();
            DB::table('upload_logs')->where(['periode' => $periode, 'jenis_data' => 'RUP'])->delete();
        }
        $this->insertChunks('rup_records', $records);
        if ($isLast) {
            $this->writeLog($uploadId, $periode, $bulan, $tahun, 'RUP', $p, count($records));
        }

        return Api::ok(['jumlah_record' => count($records), 'is_last' => $isLast], 'Chunk RUP OK.');
    }

    public function uploadRealisasi(array $p): array
    {
        [$periode, $bulan, $tahun, $uploadId, $isFirst, $isLast, $rows] = $this->prepare($p);

        if ($isFirst) {
            $this->assertColumns($rows, ['Nama Satuan Kerja', 'Kode Paket', 'Sumber Transaksi', 'Total Nilai (Rp)']);
        }

        $records = array_map(function (array $row) use ($uploadId, $periode, $bulan, $tahun) {
            [$namaSatker, $kodeSatker] = N::parseSatker(N::str($row['Nama Satuan Kerja'] ?? ''));
            $statusAsli = trim(N::str($row['Status Paket'] ?? ''));
            $kodeRup = N::str($row['Kode RUP'] ?? '');
            $namaPenyedia = N::str($row['Nama Penyedia'] ?? '');
            $metode = N::str($row['Metode Pengadaan'] ?? '');
            $namaPaket = N::str($row['Nama Paket'] ?? '');

            return [
                'upload_id' => $uploadId, 'periode' => $periode, 'bulan' => $bulan, 'tahun' => $tahun,
                'kode_satker' => $kodeSatker, 'nama_satker' => $namaSatker,
                'kode_paket' => N::str($row['Kode Paket'] ?? ''),
                'kode_rup' => $kodeRup !== '' ? trim((string) preg_replace('/\.0/', '', $kodeRup, 1)) : null,
                'sumber_transaksi' => N::str($row['Sumber Transaksi'] ?? ''),
                'sumber_dana' => N::sumberDana(N::str($row['Sumber Dana'] ?? '')),
                'nama_penyedia' => $namaPenyedia !== '' ? $namaPenyedia : null,
                'metode_pengadaan' => $metode !== '' ? $metode : null,
                'jenis_pengadaan' => N::jenis(N::str($row['Jenis Pengadaan'] ?? '')),
                'nama_paket' => $namaPaket !== '' ? $namaPaket : null,
                'status_paket_asli' => $statusAsli !== '' ? $statusAsli : null,
                'status_paket' => N::status($statusAsli !== '' ? $statusAsli : null),
                'nilai_kontrak' => N::number($row['Total Nilai (Rp)'] ?? 0),
                'nilai_pdn' => N::number($row['Nilai PDN (Rp)'] ?? 0),
            ];
        }, $rows);

        if ($isFirst) {
            DB::table('realisasi_records')->where('periode', $periode)->delete();
            DB::table('upload_logs')->where(['periode' => $periode, 'jenis_data' => 'REALISASI'])->delete();
            DB::table('matching_results')->where('periode', $periode)->delete();
        }
        $this->insertChunks('realisasi_records', $records);
        if ($isLast) {
            $this->writeLog($uploadId, $periode, $bulan, $tahun, 'REALISASI', $p, count($records));
        }

        $result = null;
        if ($isLast) {
            $result = $this->matching->run($periode);
            $this->aggregate->build($periode, $bulan, $tahun);
        }

        return Api::ok([
            'jumlah_record' => count($records),
            'is_last' => $isLast,
            'matched' => $result['matched'] ?? null,
            'unmatched' => $result['unmatched'] ?? null,
            'orphan' => $result['orphan'] ?? null,
        ], $isLast ? 'Upload Realisasi & matching selesai.' : 'Chunk OK.');
    }

    /** @return array{0:string,1:int,2:int,3:string,4:bool,5:bool,6:list<array>} */
    private function prepare(array $p): array
    {
        $periode = $p['periode'] ?? null;
        $data = $p['data'] ?? null;
        if (! is_string($periode) || ! preg_match('/^\d{4}-\d{2}$/', $periode) || ! is_array($data)) {
            throw new ApiException('Periode (YYYY-MM) dan data wajib ada.');
        }

        [$tahun, $bulan] = array_map('intval', explode('-', $periode));
        $chunk = (int) ($p['chunk_index'] ?? 0);
        $total = (int) ($p['total_chunks'] ?? 1);

        return [
            $periode, $bulan, $tahun,
            (string) ($p['session_id'] ?? Str::uuid()),
            $chunk === 0,
            $chunk === $total - 1,
            array_map(fn ($r) => N::normalizeHeaders((array) $r), $data),
        ];
    }

    /** @param list<array> $rows */
    private function assertColumns(array $rows, array $required): void
    {
        if ($rows === []) {
            return;
        }
        $missing = array_values(array_diff($required, array_keys($rows[0])));
        if ($missing) {
            throw new ApiException('Kolom tidak lengkap: '.implode(', ', $missing));
        }
    }

    private function insertChunks(string $table, array $records): void
    {
        foreach (array_chunk($records, 500) as $chunk) {
            DB::table($table)->insert($chunk);
        }
    }

    private function writeLog(string $uploadId, string $periode, int $bulan, int $tahun, string $jenis, array $p, int $fallbackCount): void
    {
        $chunks = (int) ($p['total_chunks'] ?? 1);
        DB::table('upload_logs')->insert([
            'upload_id' => $uploadId, 'periode' => $periode, 'bulan' => $bulan, 'tahun' => $tahun,
            'jenis_data' => $jenis,
            'nama_file' => $p['nama_file'] ?? ($jenis === 'RUP' ? 'data_rup.csv' : 'data_realisasi.csv'),
            'jumlah_record' => (int) ($p['total_records'] ?? $fallbackCount),
            'uploaded_by' => 'Admin', 'uploaded_at' => now(), 'status' => 'SUCCESS',
            'catatan' => 'Upload selesai'.($chunks > 1 ? " ($chunks chunk)" : ''),
        ]);
    }
}
