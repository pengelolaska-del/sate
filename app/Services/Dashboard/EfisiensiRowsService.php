<?php

declare(strict_types=1);

namespace App\Services\Dashboard;

use App\Support\Normalizer as N;
use App\Support\Periode;
use App\Support\SumberTransaksi;
use Illuminate\Support\Facades\DB;

/**
 * Lapisan data paling dasar untuk Efisiensi/Sandingan/Rekap:
 * satu baris = satu paket realisasi (kode_paket) yang MATCHED ke RUP, atau
 * UNMATCHED (orphan). Beberapa realisasi dengan kode_rup sama digabung jadi
 * satu baris (realisasi_list) supaya pagu RUP hanya dihitung sekali.
 */
final class EfisiensiRowsService
{
    public function __construct(private readonly PeriodeService $periodes) {}

    /** Status mentah "Belum Berproses" yang sudah punya transaksi = "Sedang Berjalan". */
    public function normalizeStatus(mixed $raw): string
    {
        $s = trim(N::str($raw));

        return $s === 'Belum Berproses' ? 'Sedang Berjalan' : $s;
    }

    /**
     * kode_paket → info paket yang sudah Selesai di periode SEBELUMNYA (tahun sama).
     * Selesai bersifat final; kalau ada di >1 periode, diambil yang terbaru.
     *
     * @return array<string,array>
     */
    public function selesaiSebelumnya(?string $periode): array
    {
        if (! $periode) {
            return [];
        }
        $tahun = explode('-', $periode)[0];
        $rows = DB::table('realisasi_records')
            ->where('periode', 'like', $tahun.'-%')->where('periode', '<', $periode)
            ->where('status_paket', 'Selesai')
            ->whereRaw("coalesce(trim(kode_paket), '') <> ''")
            ->orderBy('periode')->orderBy('id')
            ->get(['periode', 'kode_paket', 'nama_paket', 'nama_satker', 'kode_satker', 'nilai_kontrak', 'sumber_transaksi', 'status_paket_asli']);

        $map = [];
        foreach ($rows as $r) {
            $map[trim($r->kode_paket)] = [
                'periode' => $r->periode, 'nama_paket' => $r->nama_paket ?? '', 'nama_satker' => $r->nama_satker ?? '',
                'kode_satker' => $r->kode_satker, 'nilai_kontrak' => (float) $r->nilai_kontrak,
                'sumber_transaksi' => $r->sumber_transaksi ?? '', 'status_asli' => $r->status_paket_asli ?? '',
            ];
        }

        return $map;
    }

    /** @return list<string> */
    public function resolvePeriodes(?string $periode, ?string $tahun): array
    {
        $list = $periode ? [$periode] : ($tahun ? $this->periodes->availablePeriodes($tahun) : $this->periodes->availablePeriodes());
        sort($list);

        return $list;
    }

    /** @return array{rows:list<array>,enums:array} */
    public function build(?string $periode, ?string $tahun): array
    {
        $periodes = $this->resolvePeriodes($periode, $tahun);
        $excludeSet = array_flip(DB::table('efisiensi_exclude_metode')->pluck('metode')->all());
        $prev = $periode ? $this->selesaiSebelumnya($periode) : [];
        $manualPagu = DB::table('manual_pagu')->pluck('pagu', 'kode_paket')->all();

        $statusFinal = function (string $kp, mixed $raw) use ($prev): string {
            $st = $this->normalizeStatus($raw);

            return ($st !== 'Selesai' && $st !== 'Dibatalkan' && isset($prev[$kp])) ? 'Selesai' : $st;
        };
        $flagDipertahankan = function (string $kp, array $real) use ($prev): ?array {
            $st = $this->normalizeStatus($real['status_paket'] ?? '');
            if (! isset($prev[$kp]) || $st === 'Selesai' || $st === 'Dibatalkan') {
                return null;
            }

            return ['dari_periode' => $prev[$kp]['periode'], 'status_sekarang' => ($real['status_paket_asli'] ?? '') ?: ($real['status_paket'] ?? '')];
        };

        $enumSumberTr = $enumMetode = $enumStatus = [];
        $enumSatker = [];
        $seenGlobal = [];
        $rows = [];
        $matchedRaw = [];

        foreach ($periodes as $pr) {
            $matching = DB::table('matching_results')->where('periode', $pr)->orderBy('id')->get();
            if ($matching->isEmpty()) {
                continue;
            }

            $realMap = [];
            foreach (DB::table('realisasi_records')->where('periode', $pr)->orderBy('id')->get() as $o) {
                $r = (array) $o;
                if (! empty($r['kode_paket'])) {
                    $realMap[trim($r['kode_paket'])] = $r;
                }
                if (! empty($r['sumber_transaksi'])) {
                    $enumSumberTr[$r['sumber_transaksi']] = true;
                }
                if (! empty($r['metode_pengadaan'])) {
                    $enumMetode[$r['metode_pengadaan']] = true;
                }
                if (! empty($r['status_paket'])) {
                    $enumStatus[$r['status_paket']] = true;
                }
            }

            foreach ($matching as $o) {
                $r = (array) $o;
                if (empty($r['kode_paket']) || ! in_array($r['status_matching'], ['MATCHED', 'UNMATCHED'], true)) {
                    continue;
                }
                $kp = trim($r['kode_paket']);
                $enumSatker[$r['kode_satker']] ??= ['k' => $r['kode_satker'], 'n' => $r['nama_satker']];

                if (isset($seenGlobal[$kp])) {
                    continue; // satu kode_paket hanya dihitung sekali lintas periode
                }
                $seenGlobal[$kp] = true;
                $real = $realMap[$kp] ?? [];
                $metode = (string) ($real['metode_pengadaan'] ?? '');

                if ($r['status_matching'] === 'MATCHED') {
                    $matchedRaw[] = [
                        'periode' => $pr, 'kode_rup' => $r['kode_rup'], 'kode_paket' => $kp,
                        'kode_satker' => $r['kode_satker'], 'nama_satker' => $r['nama_satker'],
                        'nama_paket_rup' => $r['nama_paket_rup'], 'nama_paket_realisasi' => $r['nama_paket_realisasi'],
                        'nama_penyedia' => $real['nama_penyedia'] ?? '', 'metode_pengadaan' => $metode,
                        'jenis_pengadaan' => ($real['jenis_pengadaan'] ?? '') ?: '',
                        'sumber_transaksi' => $real['sumber_transaksi'] ?? '',
                        'pagu_rup' => (float) $r['pagu_rup'], 'nilai_kontrak' => (float) $r['nilai_kontrak'],
                        'status_realisasi' => $statusFinal($kp, $real['status_paket'] ?? null),
                        'status_dipertahankan' => $flagDipertahankan($kp, $real),
                        'excluded_dari_efisiensi' => isset($excludeSet[$metode]),
                        'is_manual_pagu' => false,
                    ];
                    continue;
                }

                // UNMATCHED yang sudah ada transaksinya: tetap dihitung sebagai paket,
                // tapi pagu tidak diketahui → dikecualikan dari efisiensi (kecuali pagu manual).
                $hasManual = array_key_exists($kp, $manualPagu);
                $rows[] = [
                    'kode_rup' => $r['kode_rup'] ?: null, 'kode_paket' => $kp, 'periode' => $pr,
                    'kode_satker' => $r['kode_satker'], 'nama_satker' => $r['nama_satker'],
                    'nama_paket_rup' => null,
                    'nama_paket_realisasi' => ($r['nama_paket_realisasi'] ?: ($real['nama_paket'] ?? '')) ?: '',
                    'nama_penyedia' => $real['nama_penyedia'] ?? '', 'metode_pengadaan' => $metode,
                    'jenis_pengadaan' => $real['jenis_pengadaan'] ?? '', 'sumber_transaksi' => $real['sumber_transaksi'] ?? '',
                    'pagu' => $hasManual ? (float) $manualPagu[$kp] : 0.0,
                    'nilai_kontrak' => (float) $r['nilai_kontrak'],
                    'status_realisasi' => $statusFinal($kp, $real['status_paket'] ?? null),
                    'status_dipertahankan' => $flagDipertahankan($kp, $real),
                    'excluded_dari_efisiensi' => $hasManual ? isset($excludeSet[$metode]) : true,
                    'is_unmatched' => true, 'is_manual_pagu' => $hasManual,
                    'realisasi_list' => null,
                ];
            }
        }

        // Grup baris MATCHED per kode_rup (1 RUP bisa dipecah jadi banyak transaksi)
        $groups = [];
        foreach ($matchedRaw as $r) {
            $groups[$r['kode_rup'] ?: '__NOKEY__'.$r['kode_paket']][] = $r;
        }
        foreach ($groups as $group) {
            $g0 = $group[0];
            if (count($group) === 1) {
                $rows[] = [
                    'kode_rup' => $g0['kode_rup'], 'kode_paket' => $g0['kode_paket'], 'kode_satker' => $g0['kode_satker'],
                    'nama_satker' => $g0['nama_satker'], 'nama_paket_rup' => $g0['nama_paket_rup'],
                    'nama_paket_realisasi' => $g0['nama_paket_realisasi'], 'nama_penyedia' => $g0['nama_penyedia'],
                    'metode_pengadaan' => $g0['metode_pengadaan'], 'jenis_pengadaan' => $g0['jenis_pengadaan'],
                    'sumber_transaksi' => $g0['sumber_transaksi'], 'pagu' => $g0['pagu_rup'], 'nilai_kontrak' => $g0['nilai_kontrak'],
                    'status_realisasi' => $g0['status_realisasi'], 'excluded_dari_efisiensi' => $g0['excluded_dari_efisiensi'],
                    'is_unmatched' => false, 'realisasi_list' => null, 'is_manual_pagu' => $g0['is_manual_pagu'],
                    'periode' => $g0['periode'], 'status_dipertahankan' => $g0['status_dipertahankan'],
                ];
                continue;
            }

            $statuses = array_column($group, 'status_realisasi');
            $rows[] = [
                'kode_rup' => $g0['kode_rup'],
                'kode_paket' => implode(';', array_column($group, 'kode_paket')),
                'kode_satker' => $g0['kode_satker'], 'nama_satker' => $g0['nama_satker'],
                'nama_paket_rup' => $g0['nama_paket_rup'],
                'nama_paket_realisasi' => implode(' | ', array_unique(array_filter(array_column($group, 'nama_paket_realisasi')))),
                'nama_penyedia' => implode(', ', array_unique(array_filter(array_column($group, 'nama_penyedia')))),
                'metode_pengadaan' => $g0['metode_pengadaan'], 'jenis_pengadaan' => $g0['jenis_pengadaan'],
                'sumber_transaksi' => $g0['sumber_transaksi'],
                'pagu' => $g0['pagu_rup'],
                'nilai_kontrak' => array_sum(array_column($group, 'nilai_kontrak')),
                'status_realisasi' => ! array_diff($statuses, ['Selesai']) ? 'Selesai' : (! array_diff($statuses, ['Sedang Berjalan']) ? 'Sedang Berjalan' : 'Campuran'),
                'excluded_dari_efisiensi' => (bool) array_filter(array_column($group, 'excluded_dari_efisiensi')),
                'is_unmatched' => false,
                'is_manual_pagu' => (bool) array_filter(array_column($group, 'is_manual_pagu')),
                'periode' => $g0['periode'],
                'status_dipertahankan' => array_values(array_filter(array_column($group, 'status_dipertahankan')))[0] ?? null,
                'realisasi_list' => array_map(fn ($r) => [
                    'kode_paket' => $r['kode_paket'], 'nama_penyedia' => $r['nama_penyedia'],
                    'nilai_kontrak' => $r['nilai_kontrak'], 'status_realisasi' => $r['status_realisasi'],
                    'nama_paket_realisasi' => $r['nama_paket_realisasi'], 'periode' => $r['periode'],
                    'kode_satker' => $r['kode_satker'], 'nama_satker' => $r['nama_satker'],
                ], $group),
            ];
        }

        $sortKeys = function (array $set): array {
            $k = array_map('strval', array_keys($set));
            sort($k);

            return $k;
        };
        $satker = array_values($enumSatker);
        usort($satker, fn ($a, $b) => strcmp(mb_strtolower((string) $a['n']), mb_strtolower((string) $b['n'])));

        return ['rows' => $rows, 'enums' => [
            'sumber_transaksi' => $sortKeys($enumSumberTr), 'metode_pengadaan' => $sortKeys($enumMetode),
            'status_paket' => $sortKeys($enumStatus), 'satker' => $satker,
        ]];
    }

    /** Paket yang Selesai di bulan lalu tapi data bulan ini belum (dipertahankan) / hilang dari data. */
    public function notifStatusSelesai(?string $periode, array $rows, array $f): array
    {
        $out = ['periode_lalu' => null, 'dipertahankan' => [], 'hilang' => []];
        if (! $periode) {
            return $out;
        }

        $seen = [];
        foreach ($rows as $r) {
            if (empty($r['status_dipertahankan'])) {
                continue;
            }
            $key = ($r['kode_paket'] ?? null) ?: ($r['kode_rup'] ?? '');
            if (isset($seen[$key])) {
                continue;
            }
            $seen[$key] = true;
            $out['dipertahankan'][] = [
                'kode_rup' => $r['kode_rup'], 'kode_paket' => $r['kode_paket'], 'nama_satker' => $r['nama_satker'],
                'nama_paket' => ($r['nama_paket_rup'] ?? null) ?: ($r['nama_paket_realisasi'] ?? ''),
                'nilai_kontrak' => $r['nilai_kontrak'], 'dari_periode' => $r['status_dipertahankan']['dari_periode'],
                'status_sekarang' => $r['status_dipertahankan']['status_sekarang'],
            ];
        }

        $kpNow = array_flip(array_map('trim', DB::table('realisasi_records')->where('periode', $periode)->pluck('kode_paket')->all()));
        $satkers = N::satkerList($f['kode_satker'] ?? null);
        foreach ($this->selesaiSebelumnya($periode) as $kp => $info) {
            if (isset($kpNow[$kp])) {
                continue;
            }
            if ($satkers && ! in_array((string) $info['kode_satker'], $satkers, true)) {
                continue;
            }
            if (! empty($f['sumber_transaksi']) && ! SumberTransaksi::match($info['sumber_transaksi'], $f['sumber_transaksi'])) {
                continue;
            }
            $out['hilang'][] = [
                'kode_paket' => (string) $kp, 'nama_satker' => $info['nama_satker'], 'nama_paket' => $info['nama_paket'],
                'nilai_kontrak' => $info['nilai_kontrak'], 'dari_periode' => $info['periode'],
            ];
        }
        $out['periode_lalu'] = $out['dipertahankan'][0]['dari_periode'] ?? $out['hilang'][0]['dari_periode'] ?? Periode::prev($periode);

        return $out;
    }
}
