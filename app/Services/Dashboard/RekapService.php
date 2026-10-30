<?php

declare(strict_types=1);

namespace App\Services\Dashboard;

use App\Support\Api;
use App\Support\Normalizer as N;
use App\Support\SumberTransaksi;
use Illuminate\Support\Facades\DB;

/** Menu Rekap Laporan: ringkasan gaya laporan bulanan BPBJ (sumber data = baris Sandingan). */
final class RekapService
{
    private const METODE_NON_TENDER = ['Pengadaan Langsung', 'Penunjukan Langsung', 'Seleksi', 'Dikecualikan'];

    public function __construct(
        private readonly SandinganService $sandingan,
        private readonly EfisiensiRowsService $efisiensi,
    ) {}

    public function laporanRekap(array $p): array
    {
        $periode = $p['periode'] ?? null;
        $tahun = $p['tahun'] ?? null;
        $rows = $this->sandingan->buildRows($periode, $tahun)['rows'];
        $sum = fn (array $set, string $f) => array_sum(array_map(fn ($r) => (float) $r[$f], $set));
        $desc = fn (string $key) => fn ($a, $b) => $b[$key] <=> $a[$key];

        // Tahap mentah (status_paket_asli) per kode_paket untuk kolom "Proses/Tahap"
        $tahap = [];
        foreach ($this->efisiensi->resolvePeriodes($periode, $tahun) as $pr) {
            foreach (DB::table('realisasi_records')->where('periode', $pr)->orderBy('id')->get(['kode_paket', 'status_paket_asli']) as $r) {
                if (trim((string) $r->kode_paket) !== '') {
                    $tahap[trim($r->kode_paket)] = $r->status_paket_asli ?? '';
                }
            }
        }

        // a) Cara Pengadaan
        $cara = [];
        foreach ($rows as $r) {
            $k = N::cara($r['cara_pengadaan']) ?: 'Tidak Diketahui';
            $cara[$k] ??= ['cara_pengadaan' => $k, 'jumlah_paket' => 0, 'nilai' => 0.0];
            $cara[$k]['jumlah_paket']++;
            $cara[$k]['nilai'] += (float) $r['pagu'];
        }
        $rekapCara = array_values($cara);
        usort($rekapCara, $desc('nilai'));

        // b) Jenis Pengadaan + status proses
        $jenis = [];
        foreach ($rows as $r) {
            $k = ($r['jenis_pengadaan_rup'] ?? null) ?: 'Tidak Terklasifikasi';
            $jenis[$k] ??= ['jenis_pengadaan' => $k, 'jumlah_paket' => 0, 'nilai' => 0.0, 'sudah_berproses' => 0, 'belum_berproses' => 0, 'jumlah_manual' => 0, 'nilai_manual' => 0.0];
            $jenis[$k]['jumlah_paket']++;
            $jenis[$k]['nilai'] += (float) $r['pagu'];
            $r['ada_realisasi'] ? $jenis[$k]['sudah_berproses']++ : $jenis[$k]['belum_berproses']++;
            if (! empty($r['is_manual_rup'])) {
                $jenis[$k]['jumlah_manual']++;
                $jenis[$k]['nilai_manual'] += (float) $r['pagu'];
            }
        }
        $rekapJenis = array_map(fn ($r) => $r + [
            'progress' => $r['jumlah_paket'] > 0 ? round($r['sudah_berproses'] / $r['jumlah_paket'] * 100, 2) : 0,
        ], array_values($jenis));
        usort($rekapJenis, $desc('jumlah_paket'));
        $manual = array_filter($rows, fn ($r) => ! empty($r['is_manual_rup']));

        // c) Metode Pemilihan (hanya paket Penyedia)
        $metode = [];
        foreach ($rows as $r) {
            if (N::cara($r['cara_pengadaan']) !== 'Penyedia') {
                continue;
            }
            $k = ($r['metode_pengadaan_rup'] ?? null) ?: 'Tidak Diketahui';
            $metode[$k] ??= ['metode_pengadaan' => $k, 'total' => 0, 'belum' => 0, 'on_process' => 0, 'selesai' => 0];
            $metode[$k]['total']++;
            if (! $r['ada_realisasi']) {
                $metode[$k]['belum']++;
            } elseif ($r['status_realisasi'] === 'Selesai') {
                $metode[$k]['selesai']++;
            } elseif ($r['status_realisasi'] === 'Sedang Berjalan') {
                $metode[$k]['on_process']++;
            } // 'Dibatalkan' hanya terhitung di total
        }
        $rekapMetode = array_values($metode);
        usort($rekapMetode, $desc('total'));

        // c.1) Sumber Transaksi (kanal realisasi aktual)
        $tr = [];
        foreach ($rows as $r) {
            $k = $r['ada_realisasi']
                ? (($r['sumber_transaksi'] ?? '') ?: 'Tidak Diketahui')
                : (SumberTransaksi::groupLabel($r['metode_pengadaan_rup'] ?? null) ?: 'Belum Ada Transaksi');
            $tr[$k] ??= ['sumber_transaksi' => $k, 'total' => 0, 'belum' => 0, 'on_process' => 0, 'selesai' => 0, 'nilai_pagu' => 0.0, 'nilai_kontrak' => 0.0, 'tidak_match' => 0];
            $tr[$k]['total']++;
            $tr[$k]['nilai_pagu'] += (float) $r['pagu'];
            if ($r['is_unmatched']) {
                $tr[$k]['tidak_match']++;
            }
            if (! $r['ada_realisasi']) {
                $tr[$k]['belum']++;
            } else {
                $tr[$k]['nilai_kontrak'] += (float) $r['nilai_kontrak'];
                if ($r['status_realisasi'] === 'Selesai') {
                    $tr[$k]['selesai']++;
                } elseif ($r['status_realisasi'] === 'Sedang Berjalan') {
                    $tr[$k]['on_process']++;
                }
            }
        }
        $rekapTransaksi = array_values($tr);
        usort($rekapTransaksi, $desc('total'));

        // d) Paket berjalan non-tender, lengkap dengan tahap mentah
        $berjalan = array_values(array_map(fn ($r) => [
            'opd' => $r['nama_satker'], 'nama_paket' => $r['nama_paket_rup'], 'metode_pengadaan' => $r['metode_pengadaan_rup'],
            'proses_tahap' => ($tahap[trim((string) $r['kode_paket'])] ?? '') ?: '—',
        ], array_filter($rows, fn ($r) => $r['status_realisasi'] === 'Sedang Berjalan' && in_array($r['metode_pengadaan_rup'], self::METODE_NON_TENDER, true))));
        usort($berjalan, fn ($a, $b) => strcmp(mb_strtolower((string) $a['opd']), mb_strtolower((string) $b['opd'])));

        // e) Tender selesai — basis sumber_transaksi (kanal realisasi), bukan metode di RUP
        $tender = array_values(array_map(fn ($r) => [
            'opd' => $r['nama_satker'], 'nama_paket' => $r['nama_paket_rup'], 'pagu_rup' => (float) $r['pagu'],
            'realisasi' => (float) $r['nilai_kontrak'], 'efisiensi' => (float) $r['pagu'] - (float) $r['nilai_kontrak'],
            'pemenang' => ($r['nama_penyedia'] ?? '') ?: '—',
        ], array_filter($rows, fn ($r) => SumberTransaksi::match($r['sumber_transaksi'] ?? null, 'Tender') && $r['status_realisasi'] === 'Selesai')));
        usort($tender, $desc('efisiensi'));

        return Api::ok([
            'total_paket' => count($rows), 'total_nilai' => $sum($rows, 'pagu'),
            'total_manual' => count($manual), 'total_nilai_manual' => $sum($manual, 'pagu'),
            'rekap_cara' => $rekapCara, 'rekap_jenis' => $rekapJenis, 'rekap_metode' => $rekapMetode,
            'rekap_transaksi' => $rekapTransaksi, 'paket_berjalan' => $berjalan, 'tender_selesai' => $tender,
        ]);
    }

    public function recapJenisPengadaan(array $p): array
    {
        $maxList = max(1, (int) ($p['max_list'] ?? 200)); // batasi payload per kelompok
        $rows = $this->sandingan->buildRows($p['periode'] ?? null, $p['tahun'] ?? null)['rows'];

        $satkers = N::satkerList($p['kode_satker'] ?? null);
        $rows = array_filter($rows, fn ($r) => (! $satkers || in_array((string) $r['kode_satker'], $satkers, true))
            && (empty($p['metode_pengadaan']) || $r['metode_pengadaan_rup'] === $p['metode_pengadaan'])
            && (empty($p['sumber_dana']) || $r['sumber_dana'] === $p['sumber_dana']));

        $grup = [];
        foreach ($rows as $r) {
            $j = ($r['jenis_pengadaan_rup'] ?? null) ?: 'Tidak Terklasifikasi';
            $paket = [
                'kode_rup' => $r['kode_rup'], 'nama_paket' => $r['nama_paket_rup'], 'nama_satker' => $r['nama_satker'],
                'kode_satker' => $r['kode_satker'], 'metode_pengadaan' => $r['metode_pengadaan_rup'], 'pagu' => (float) $r['pagu'],
                'status_realisasi' => $r['status_realisasi'], 'nilai_kontrak' => (float) $r['nilai_kontrak'],
            ];
            $grup[$j][$r['ada_realisasi'] ? 'sudah' : 'belum'][] = $paket;
        }

        $jenis = [];
        foreach ($grup as $nama => $g) {
            $sudah = $g['sudah'] ?? [];
            $belum = $g['belum'] ?? [];
            $total = count($sudah) + count($belum);
            $jenis[] = [
                'jenis_pengadaan' => (string) $nama, 'total' => $total,
                'sudah_berproses' => count($sudah), 'belum_berproses' => count($belum),
                'persen_progress' => $total > 0 ? round(count($sudah) / $total * 100, 2) : 0,
                'pagu_sudah' => array_sum(array_column($sudah, 'pagu')), 'pagu_belum' => array_sum(array_column($belum, 'pagu')),
                'paket_sudah' => array_slice($sudah, 0, $maxList), 'paket_belum' => array_slice($belum, 0, $maxList),
            ];
        }
        usort($jenis, fn ($a, $b) => $b['total'] <=> $a['total']);

        $sudahAll = count(array_filter($rows, fn ($r) => $r['ada_realisasi']));

        return Api::ok(['jenis' => $jenis, 'total_keseluruhan' => [
            'total' => count($rows), 'sudah_berproses' => $sudahAll, 'belum_berproses' => count($rows) - $sudahAll,
        ]]);
    }
}
