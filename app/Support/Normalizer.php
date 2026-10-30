<?php

declare(strict_types=1);

namespace App\Support;

/** Normalisasi data CSV SIRUP/SPSE (alias header, status, jenis, sumber dana, dst). */
final class Normalizer
{
    /** header CSV (variasi apa pun) → nama standar internal */
    private const HEADER_ALIAS = [
        'nama_instansi' => 'Nama Instansi',
        'nama_satuan_kerja' => 'Nama Satuan Kerja',
        'tahun_anggaran' => 'Tahun Anggaran',
        'cara_pengadaan' => 'Cara Pengadaan',
        'metode_pengadaan' => 'Metode Pengadaan',
        'jenis_pengadaan' => 'Jenis Pengadaan',
        'nama_paket' => 'Nama Paket',
        'kode_rup' => 'Kode RUP',
        'sumber_dana' => 'Sumber Dana',
        'produk_dalam_negeri' => 'Produk Dalam Negeri',
        'total_nilai' => 'Total Nilai (Rp)',
        'nilai_pagu' => 'Total Nilai (Rp)',
        'pagu' => 'Total Nilai (Rp)',
        'kode_paket' => 'Kode Paket',
        'sumber_transaksi' => 'Sumber Transaksi',
        'nama_penyedia' => 'Nama Penyedia',
        'status_paket' => 'Status Paket',
        'nilai_pdn' => 'Nilai PDN (Rp)',
        'nilai_umk' => 'Nilai UMK (Rp)',
        'nilai_kontrak' => 'Total Nilai (Rp)',
    ];

    /** @var array<string,string>|null */
    private static ?array $aliasIndex = null;

    public static function canonKey(string $s): string
    {
        return preg_replace('/[^a-z0-9]/', '', strtolower(trim($s))) ?? '';
    }

    /** @return array<string,string> */
    private static function aliasIndex(): array
    {
        if (self::$aliasIndex === null) {
            $idx = [];
            foreach (self::HEADER_ALIAS as $alias => $target) {
                $idx[self::canonKey($alias)] = $target;
                $idx[self::canonKey($target)] = $target;
            }
            self::$aliasIndex = $idx;
        }

        return self::$aliasIndex;
    }

    public static function normalizeHeaders(array $row): array
    {
        $idx = self::aliasIndex();
        $out = [];
        foreach ($row as $k => $v) {
            $out[$idx[self::canonKey((string) $k)] ?? trim((string) $k)] = $v;
        }

        return $out;
    }

    /** String(v || '') versi JS */
    public static function str(mixed $v): string
    {
        return ($v === null || $v === false) ? '' : (string) $v;
    }

    public static function number(mixed $v): float
    {
        return is_numeric($v) ? (float) $v : 0.0;
    }

    public static function cara(mixed $v): string
    {
        $v = trim(self::str($v));
        if (preg_match('/swakelola/i', $v)) {
            return 'Swakelola';
        }
        if (preg_match('/penyedia/i', $v)) {
            return 'Penyedia';
        }

        return $v !== '' ? $v : 'Tidak Diketahui';
    }

    public static function sumberDana(string $raw): string
    {
        if ($raw === '' || $raw === 'null') {
            return 'Tidak Diketahui';
        }
        $v = trim($raw);

        return match ($v) {
            'APBD;APBDP', 'APBD,APBDP', 'APBDP;APBD' => 'APBD+APBDP',
            'APBD;BLUD', 'BLUD;APBD' => 'APBD+BLUD',
            default => $v !== '' ? $v : 'Tidak Diketahui',
        };
    }

    public static function jenis(string $raw): string
    {
        $v = trim($raw);
        if ($v === '') {
            return 'Tidak Terklasifikasi';
        }
        if ($v === 'Barang' || $v === 'Pengadaan Barang') {
            return 'Barang';
        }
        if (str_starts_with($v, 'Jasa Konsultansi')) {
            return 'Jasa Konsultansi';
        }

        return match ($v) {
            'Jasa Lainnya', 'Pekerjaan Konstruksi', 'Terintegrasi' => $v,
            default => 'Tidak Terklasifikasi',
        };
    }

    public static function status(?string $raw): string
    {
        if ($raw === null || $raw === '') {
            return 'Belum Berproses';
        }
        $v = strtoupper(trim($raw));
        $map = [
            'COMPLETED' => 'Selesai', 'SELESAI' => 'Selesai', 'PAKET SELESAI' => 'Selesai',
            'KONTRAK SELESAI' => 'Selesai', 'PAYMENT OUTSIDE SYSTEM' => 'Selesai',
            'PAKET SEDANG BERJALAN' => 'Sedang Berjalan', 'KONTRAK SEDANG BERJALAN' => 'Sedang Berjalan',
            'ON PROCESS' => 'Sedang Berjalan', 'BERLANGSUNG' => 'Sedang Berjalan', 'ON ADDENDUM' => 'Sedang Berjalan',
        ];
        if (isset($map[$v])) {
            return $map[$v];
        }
        if (str_contains($v, 'BELUM')) {
            return 'Belum Berproses';
        }
        if (str_contains($v, 'SELESAI') || str_contains($v, 'COMPLETE')) {
            return 'Selesai';
        }
        foreach (['BERJALAN', 'PROCESS', 'BERLANGSUNG', 'ADDENDUM'] as $needle) {
            if (str_contains($v, $needle)) {
                return 'Sedang Berjalan';
            }
        }

        return 'Belum Berproses';
    }

    /** "Dinas X - 12345" → ["Dinas X", "12345"] */
    public static function parseSatker(string $raw): array
    {
        $s = trim($raw);
        $i = strrpos($s, ' - ');

        return $i === false ? [$s, ''] : [trim(substr($s, 0, $i)), trim(substr($s, $i + 3))];
    }

    /** @return list<string> */
    public static function splitKodeRup(?string $raw): array
    {
        if ($raw === null || $raw === '') {
            return [];
        }

        return array_values(array_filter(array_map('trim', explode(';', $raw)), fn ($s) => $s !== ''));
    }

    /** Filter satker multi-pilih: "A,B" | array | kosong → semua */
    public static function satkerList(mixed $raw): array
    {
        if ($raw === null || $raw === '' || $raw === []) {
            return [];
        }
        $str = is_array($raw) ? implode(',', $raw) : (string) $raw;

        return array_values(array_filter(array_map('trim', explode(',', $str)), fn ($s) => $s !== ''));
    }

    /** @return list<string> */
    public static function keywords(mixed $text): array
    {
        $parts = preg_split('/[,;|\n]+/', strtolower(self::str($text))) ?: [];

        return array_values(array_filter(array_map('trim', $parts), fn ($s) => $s !== ''));
    }

    public static function jenisRupLabel(mixed $raw): string
    {
        $v = trim(self::str($raw));

        return ($v === '' || $v === '-') ? 'Tidak Terklasifikasi' : $v;
    }

    /** @param list<string> $terms */
    public static function containsAny(array $terms, mixed ...$fields): bool
    {
        if ($terms === []) {
            return true;
        }
        foreach ($fields as $f) {
            $hay = mb_strtolower(self::str($f));
            foreach ($terms as $t) {
                if (str_contains($hay, $t)) {
                    return true;
                }
            }
        }

        return false;
    }
}
