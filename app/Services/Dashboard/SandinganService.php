<?php

declare(strict_types=1);

namespace App\Services\Dashboard;

use App\Support\Api;
use App\Support\Normalizer as N;
use App\Support\Rows;
use App\Support\SumberTransaksi;
use Illuminate\Support\Facades\DB;

/** Sandingan RUP vs Realisasi: RUP sebagai induk (satu baris = satu kode_rup). */
final class SandinganService
{
    private const STATUS_ORDER = ['Selesai' => 0, 'Sedang Berjalan' => 1, 'Dibatalkan' => 3];

    public function __construct(private readonly EfisiensiRowsService $efisiensi) {}

    // ── Endpoint ─────────────────────────────────────────────────

    public function list(array $p): array
    {
        $periode = $p['periode'] ?? null;
        $tahun = $p['tahun'] ?? null;
        $page = max(1, (int) ($p['page'] ?? 1));
        $perPage = max(1, min(500, (int) ($p['per_page'] ?? 50)));

        $base = $this->buildRows($periode, $tahun);
        $rows = $base['rows'];

        $satkers = N::satkerList($p['kode_satker'] ?? null);
        if ($satkers) {
            $rows = array_filter($rows, fn ($r) => in_array((string) $r['kode_satker'], $satkers, true));
        }
        foreach (['metode_pengadaan' => 'metode_pengadaan_rup', 'jenis_pengadaan' => 'jenis_pengadaan_rup', 'sumber_dana' => 'sumber_dana'] as $param => $field) {
            if (! empty($p[$param])) {
                $rows = array_filter($rows, fn ($r) => $r[$field] === $p[$param]);
            }
        }
        if (! empty($p['sumber_transaksi'])) {
            $rows = array_filter($rows, fn ($r) => SumberTransaksi::rowMatches($r, $p['sumber_transaksi']));
        }
        $rows = array_values($rows);

        // Notifikasi dihitung sebelum filter status/search supaya daftar tidak ikut menyempit
        $notif = $this->efisiensi->notifStatusSelesai($periode, $rows, [
            'kode_satker' => $p['kode_satker'] ?? null, 'sumber_transaksi' => $p['sumber_transaksi'] ?? null,
        ]);

        if (! empty($p['status_paket'])) {
            $rows = array_values(array_filter($rows, fn ($r) => $p['status_paket'] === 'Belum Berproses'
                ? ! $r['ada_realisasi']
                : $r['status_realisasi'] === $p['status_paket']));
        }
        if (! empty($p['search'])) {
            $terms = N::keywords($p['search']);
            $rows = array_values(array_filter($rows, fn ($r) => N::containsAny(
                $terms, $r['nama_paket_rup'], $r['kode_rup'], $r['nama_satker'], $r['nama_penyedia'], $r['nama_paket_realisasi']
            )));
        }

        $totalGabungan = count(array_filter($rows, fn ($r) => $r['is_realisasi_gabungan']));
        if (in_array($p['hanya_gabungan'] ?? false, [true, 'true', '1', 1], true)) {
            $rows = array_values(array_filter($rows, fn ($r) => $r['is_realisasi_gabungan']));
        }

        $this->sortRows($rows, $p['sort_by'] ?? null, ($p['sort_dir'] ?? 'desc') === 'asc' ? 1 : -1);
        $summary = $this->summarize($rows, $totalGabungan);
        $rows = $this->collapseGroups($rows);

        $total = count($rows);

        return Api::ok([
            'total' => $total, 'page' => $page, 'per_page' => $perPage,
            'total_pages' => max(1, (int) ceil($total / $perPage)),
            'summary' => $summary, 'notif_status' => $notif,
            'items' => array_slice($rows, ($page - 1) * $perPage, $perPage),
            'enums' => [
                'sumber' => $base['enumSumber'], 'satker' => $base['enumSatker'],
                'sumber_transaksi' => $base['enumSumberTransaksi'],
            ],
        ]);
    }

    // ── Data ─────────────────────────────────────────────────────

    /** Baris Sandingan (dipakai juga oleh Rekap Laporan). */
    public function buildRows(?string $periode, ?string $tahun): array
    {
        $efi = $this->efisiensi->build($periode, $tahun);

        if ($periode) {
            $periodes = [$periode];
        } elseif ($tahun) {
            $periodes = $this->efisiensi->resolvePeriodes(null, (string) $tahun);
        } else {
            $periodes = array_slice(app(PeriodeService::class)->availablePeriodes(), 0, 1);
        }
        sort($periodes);

        $rup = [];
        foreach ($periodes as $pr) {
            foreach (DB::table('rup_records')->where('periode', $pr)->orderBy('id')->get() as $o) {
                $r = Rows::cast($o);
                $kr = trim((string) $r['kode_rup']);
                if ($kr !== '') {
                    $rup[$kr] = $r + ['_periode' => $pr]; // terakhir menang
                }
            }
        }

        $manualPagu = array_flip(array_map('trim', DB::table('manual_pagu')->pluck('kode_paket')->all()));
        $overrides = DB::table('status_overrides')->get()->keyBy('kode_rup')->map(fn ($o) => (array) $o)->all();
        $splits = DB::table('kontrak_splits')->get()->keyBy('kode_paket')->map(fn ($o) => (array) $o)->all();

        return $this->compose($efi['rows'], $rup, $efi['enums']['sumber_transaksi'], $manualPagu, $overrides, $splits);
    }

    /**
     * Murni (tanpa DB): gabungkan baris efisiensi (klaim match) ke RUP induk.
     *
     * @param  array<string,array>  $rup  kode_rup → baris RUP (urutan = urutan tampil)
     */
    public function compose(array $efiRows, array $rup, array $enumSumberTransaksi, array $manualPaguSet, array $overrides, array $splits): array
    {
        // Satu match bisa mewakili beberapa kode_rup (dipisah ';'): nilai kontrak
        // hanya dihitung di kode_rup pertama ("primary") supaya tidak dobel.
        $claimsByRup = [];
        foreach ($efiRows as $r) {
            $parts = N::splitKodeRup($r['kode_rup'] ?? null);
            foreach ($parts as $idx => $k) {
                $claimsByRup[$k][] = $r + ['_isPrimaryRup' => $idx === 0, '_rupGroupSize' => count($parts)];
            }
        }

        $enumSumber = array_values(array_unique(array_filter(array_column($rup, 'sumber_dana'))));
        sort($enumSumber);
        $satkerMap = [];
        foreach ($rup as $r) {
            $satkerMap[$r['kode_satker'].'|'.$r['nama_satker']] = ['k' => $r['kode_satker'], 'n' => $r['nama_satker']];
        }
        $enumSatker = array_values($satkerMap);
        usort($enumSatker, fn ($a, $b) => $this->cmp($a['n'], $b['n']));

        $rows = [];
        foreach ($rup as $kr => $rp) {
            $kr = (string) $kr;
            $match = $this->mergeClaims($claimsByRup[$kr] ?? [], $rp);

            $extra = [];
            if ($match && ! empty($match['realisasi_list'])) {
                [$match, $extra] = $this->applySplits($match, $rp, $kr, $splits);
            }

            $ov = ! $match ? ($overrides[$kr] ?? null) : null;
            $row = $this->makeRow($kr, $rp, $match, $manualPaguSet);
            if ($ov) {
                $row = $this->applyOverride($row, $ov);
            }
            $rows[] = $row;
            array_push($rows, ...$extra);
        }

        // Realisasi yang belum match ke RUP manapun → baris "orphan"
        foreach ($efiRows as $r) {
            if (empty($r['is_unmatched'])) {
                continue;
            }
            $rows[] = [
                'kode_rup' => 'UNMATCHED-'.$r['kode_paket'], 'kode_satker' => $r['kode_satker'], 'nama_satker' => $r['nama_satker'],
                'nama_paket_rup' => null, 'metode_pengadaan_rup' => null,
                'jenis_pengadaan_rup' => N::jenis(N::str($r['jenis_pengadaan'] ?? '')),
                'cara_pengadaan' => null, 'sumber_dana' => null, 'pagu' => (float) $r['pagu'],
                'ada_realisasi' => true, 'kode_paket' => $r['kode_paket'], 'nama_paket_realisasi' => $r['nama_paket_realisasi'],
                'metode_pengadaan' => $r['metode_pengadaan'], 'jenis_pengadaan' => $r['jenis_pengadaan'],
                'nama_penyedia' => $r['nama_penyedia'], 'sumber_transaksi' => $r['sumber_transaksi'],
                'nilai_kontrak' => (float) $r['nilai_kontrak'], 'status_realisasi' => ($r['status_realisasi'] ?? '') ?: 'Sedang Berjalan',
                'status_dipertahankan' => $r['status_dipertahankan'] ?? null,
                'is_gabungan_kode_rup' => false, 'is_realisasi_gabungan' => false, 'is_manual_rup' => false,
                'is_manual_pagu' => ! empty($r['is_manual_pagu']), 'is_manual_status' => false,
                'override_type' => null, 'keterangan_override' => null, 'is_unmatched' => true,
                'excluded_dari_efisiensi' => ! empty($r['excluded_dari_efisiensi']),
                'realisasi_list' => null, 'jumlah_transaksi' => 1,
            ];
        }

        return ['rows' => $rows, 'enumSumber' => $enumSumber, 'enumSatker' => $enumSatker, 'enumSumberTransaksi' => $enumSumberTransaksi];
    }

    /** 0/1 klaim: apa adanya. >1 klaim: digabung seperti "banyak realisasi 1 kode_rup". */
    private function mergeClaims(array $claims, array $rup): ?array
    {
        if (count($claims) <= 1) {
            return $claims[0] ?? null;
        }

        $st = array_column($claims, 'status_realisasi');
        $list = [];
        foreach ($claims as $c) {
            if (! empty($c['realisasi_list'])) {
                array_push($list, ...$c['realisasi_list']);
            } else {
                $list[] = [
                    'kode_paket' => $c['kode_paket'], 'nama_penyedia' => $c['nama_penyedia'], 'nilai_kontrak' => $c['nilai_kontrak'],
                    'status_realisasi' => $c['status_realisasi'], 'periode' => $c['periode'] ?? null,
                    'kode_satker' => $c['kode_satker'], 'nama_satker' => $c['nama_satker'],
                ];
            }
        }
        $c0 = $claims[0];

        return [
            'kode_paket' => implode(';', array_column($claims, 'kode_paket')),
            'nama_paket_realisasi' => $c0['nama_paket_realisasi'], 'metode_pengadaan' => $c0['metode_pengadaan'],
            'jenis_pengadaan' => $c0['jenis_pengadaan'], 'sumber_transaksi' => $c0['sumber_transaksi'],
            'nama_penyedia' => implode(', ', array_unique(array_filter(array_column($claims, 'nama_penyedia')))),
            'pagu' => (float) $rup['pagu'], // pagu RUP ini sendiri (bukan pagu grup) agar tidak dobel
            'nilai_kontrak' => array_sum(array_map(fn ($c) => $c['_isPrimaryRup'] ? (float) $c['nilai_kontrak'] : 0.0, $claims)),
            'status_realisasi' => ! array_diff($st, ['Selesai']) ? 'Selesai' : (! array_diff($st, ['Sedang Berjalan']) ? 'Sedang Berjalan' : 'Campuran'),
            'excluded_dari_efisiensi' => ! array_diff(array_map('boolval', array_column($claims, 'excluded_dari_efisiensi')), [true]),
            'is_manual_pagu' => (bool) array_filter(array_column($claims, 'is_manual_pagu')),
            'realisasi_list' => $list, 'periode' => $c0['periode'] ?? null,
            'status_dipertahankan' => array_values(array_filter(array_column($claims, 'status_dipertahankan')))[0] ?? null,
            '_isPrimaryRup' => true, '_rupGroupSize' => max(array_column($claims, '_rupGroupSize')),
        ];
    }

    /** "✂ Pisahkan": anggota yang sudah dipisah admin keluar dari match, jadi baris sendiri. */
    private function applySplits(array $match, array $rup, string $kr, array $splits): array
    {
        $split = $normal = [];
        foreach ($match['realisasi_list'] as $x) {
            isset($splits[trim((string) $x['kode_paket'])]) ? $split[] = $x : $normal[] = $x;
        }
        if (! $split) {
            return [$match, []];
        }

        $extra = array_map(function ($x) use ($splits, $rup, $kr, $match) {
            $sp = $splits[trim((string) $x['kode_paket'])];
            $pagu = (float) $sp['pagu'];

            return [
                'kode_rup' => $kr, 'periode' => ($x['periode'] ?? null) ?: ($match['periode'] ?? null),
                'kode_satker' => ($x['kode_satker'] ?? null) ?: $rup['kode_satker'], 'nama_satker' => ($x['nama_satker'] ?? null) ?: $rup['nama_satker'],
                'nama_paket_rup' => $rup['nama_paket'], 'metode_pengadaan_rup' => $rup['metode_pengadaan'],
                'jenis_pengadaan_rup' => N::jenisRupLabel($rup['jenis_pengadaan']), 'cara_pengadaan' => $rup['cara_pengadaan'],
                'sumber_dana' => $rup['sumber_dana'], 'pagu' => $pagu, 'pagu_efisiensi' => $pagu,
                'ada_realisasi' => true, 'kode_paket' => $x['kode_paket'],
                'nama_paket_realisasi' => ($x['nama_paket_realisasi'] ?? null) ?: ($match['nama_paket_realisasi'] ?? ''),
                'metode_pengadaan' => $match['metode_pengadaan'], 'jenis_pengadaan' => $match['jenis_pengadaan'],
                'nama_penyedia' => $x['nama_penyedia'] ?? '', 'sumber_transaksi' => $match['sumber_transaksi'],
                'nilai_kontrak' => (float) $x['nilai_kontrak'], 'status_realisasi' => ($x['status_realisasi'] ?? '') ?: 'Sedang Berjalan',
                'is_primary_gabungan' => false, 'is_gabungan_kode_rup' => false, 'is_realisasi_gabungan' => false,
                'is_manual_rup' => false, 'is_manual_pagu' => false, 'is_split_kontrak' => true,
                'pagu_split_sumber' => ($sp['sumber_pagu'] ?? null) ?: ($pagu > 0 ? 'LPSE' : 'Kosong'),
                'is_manual_status' => false, 'override_type' => null, 'keterangan_override' => null, 'is_unmatched' => false,
                'realisasi_list' => null, 'excluded_dari_efisiensi' => false, 'jumlah_transaksi' => 1,
            ];
        }, $split);

        if (! $normal) {
            return [null, $extra]; // semua dipisah → induk jadi "belum berproses"
        }

        $keep = ['metode_pengadaan', 'jenis_pengadaan', 'sumber_transaksi', 'excluded_dari_efisiensi', 'is_manual_pagu'];
        $new = array_intersect_key($match, array_flip($keep)) + ['pagu' => (float) $rup['pagu'], '_isPrimaryRup' => true, '_rupGroupSize' => 1];

        if (count($normal) === 1) {
            $o = $normal[0];
            $new += [
                'kode_paket' => $o['kode_paket'], 'nama_paket_realisasi' => ($o['nama_paket_realisasi'] ?? null) ?: $match['nama_paket_realisasi'],
                'nama_penyedia' => $o['nama_penyedia'], 'nilai_kontrak' => (float) $o['nilai_kontrak'],
                'status_realisasi' => $o['status_realisasi'], 'realisasi_list' => null,
                'periode' => ($o['periode'] ?? null) ?: ($match['periode'] ?? null),
            ];
        } else {
            $st = array_column($normal, 'status_realisasi');
            $new += [
                'kode_paket' => implode(';', array_column($normal, 'kode_paket')),
                'nama_paket_realisasi' => $match['nama_paket_realisasi'],
                'nama_penyedia' => implode(', ', array_unique(array_filter(array_column($normal, 'nama_penyedia')))),
                'nilai_kontrak' => array_sum(array_map(fn ($x) => (float) $x['nilai_kontrak'], $normal)),
                'status_realisasi' => ! array_diff($st, ['Selesai']) ? 'Selesai' : (! array_diff($st, ['Sedang Berjalan']) ? 'Sedang Berjalan' : 'Campuran'),
                'realisasi_list' => $normal, 'periode' => $match['periode'] ?? null,
            ];
        }

        return [$new, $extra];
    }

    private function makeRow(string $kr, array $rup, ?array $m, array $manualPaguSet): array
    {
        $primary = $m && ! empty($m['_isPrimaryRup']);
        $size = $m['_rupGroupSize'] ?? 1;

        return [
            'kode_rup' => $kr, 'periode' => $m['periode'] ?? null,
            'kode_satker' => $rup['kode_satker'], 'nama_satker' => $rup['nama_satker'],
            'nama_paket_rup' => $rup['nama_paket'], 'metode_pengadaan_rup' => $rup['metode_pengadaan'],
            'jenis_pengadaan_rup' => N::jenisRupLabel($rup['jenis_pengadaan']),
            'cara_pengadaan' => $rup['cara_pengadaan'], 'sumber_dana' => $rup['sumber_dana'],
            'pagu' => (float) $rup['pagu'],
            'ada_realisasi' => $m !== null,
            'kode_paket' => $m ? ($m['kode_paket'] ?: '') : null,
            'nama_paket_realisasi' => $m ? (($m['nama_paket_realisasi'] ?? '') ?: '') : null,
            'metode_pengadaan' => $m ? (($m['metode_pengadaan'] ?? '') ?: '') : null,
            'jenis_pengadaan' => $m ? (($m['jenis_pengadaan'] ?? '') ?: '') : null,
            'nama_penyedia' => $m ? (($m['nama_penyedia'] ?? '') ?: '') : null,
            'sumber_transaksi' => $m ? (($m['sumber_transaksi'] ?? '') ?: '') : null,
            // nilai kontrak hanya di kode_rup "primary" supaya tidak dobel
            'nilai_kontrak' => $m ? ($primary ? (float) $m['nilai_kontrak'] : 0.0) : 0.0,
            'pagu_efisiensi' => $m ? (float) ($m['pagu'] ?? 0) : (float) $rup['pagu'],
            'is_primary_gabungan' => $primary && $size > 1,
            'status_realisasi' => $m ? (($m['status_realisasi'] ?? '') ?: 'Sedang Berjalan') : null,
            'status_dipertahankan' => $m['status_dipertahankan'] ?? null,
            'is_gabungan_kode_rup' => $m !== null && $size > 1,
            'is_realisasi_gabungan' => $m !== null && count($m['realisasi_list'] ?? []) > 1,
            'is_manual_rup' => false,
            'is_manual_pagu' => $m && ! empty($m['kode_paket']) ? isset($manualPaguSet[trim((string) $m['kode_paket'])]) : false,
            'is_manual_status' => false, 'override_type' => null, 'keterangan_override' => null, 'is_unmatched' => false,
            'realisasi_list' => $m['realisasi_list'] ?? null,
            'excluded_dari_efisiensi' => $m ? ! empty($m['excluded_dari_efisiensi']) : false,
            'jumlah_transaksi' => ! $m ? 0 : (! $primary ? 0 : (isset($m['realisasi_list']) ? count($m['realisasi_list']) : 1)),
        ];
    }

    private function applyOverride(array $row, array $ov): array
    {
        $row['is_manual_status'] = true;
        $row['override_type'] = (string) $ov['override_type'];
        $row['keterangan_override'] = (string) ($ov['keterangan'] ?? '');

        if ($ov['override_type'] === 'Dibatalkan') {
            $row['status_realisasi'] = 'Dibatalkan';
        } elseif ($ov['override_type'] === 'Manual') {
            $kp = (string) ($ov['kode_paket_manual'] ?? '');
            $row['ada_realisasi'] = true;
            $row['kode_paket'] = $kp !== '' ? $kp : $row['kode_paket'];
            $row['nama_paket_realisasi'] = ($ov['nama_paket_manual'] ?? '') !== '' ? $ov['nama_paket_manual'] : $row['nama_paket_realisasi'];
            $row['nama_penyedia'] = (string) ($ov['nama_penyedia_manual'] ?? '');
            $row['nilai_kontrak'] = (float) ($ov['nilai_kontrak_manual'] ?? 0);
            $row['status_realisasi'] = ($ov['status_manual'] ?? '') ?: 'Selesai';
            $row['sumber_transaksi'] = $kp !== '' ? 'Realisasi (Disandingkan Manual)' : 'Manual';
            $row['jumlah_transaksi'] = $kp !== '' ? 1 : 0;
        }

        return $row;
    }

    // ── Sort, ringkasan, gabung grup ─────────────────────────────

    private function cmp(mixed $a, mixed $b): int
    {
        return strcmp(mb_strtolower((string) $a), mb_strtolower((string) $b));
    }

    private function statusRank(mixed $status): int
    {
        return self::STATUS_ORDER[$status] ?? 2;
    }

    private function sortRows(array &$rows, ?string $sortBy, int $dir): void
    {
        if (! $sortBy) {
            usort($rows, fn ($a, $b) => $this->statusRank($a['status_realisasi']) <=> $this->statusRank($b['status_realisasi'])
                ?: $this->cmp($a['nama_satker'], $b['nama_satker']));

            return;
        }

        $pagu = fn ($r) => ! $r['is_unmatched'] || (float) $r['pagu'] > 0;
        $val = fn ($r) => match ($sortBy) {
            'satker' => mb_strtolower((string) $r['nama_satker']),
            'paket' => mb_strtolower((string) (($r['nama_paket_rup'] ?? null) ?: ($r['nama_paket_realisasi'] ?? ''))),
            'kode_rup' => mb_strtolower((string) $r['kode_rup']),
            'metode' => mb_strtolower((string) (($r['metode_pengadaan_rup'] ?? null) ?: ($r['metode_pengadaan'] ?? ''))),
            'jenis' => mb_strtolower((string) (($r['jenis_pengadaan_rup'] ?? null) ?: ($r['jenis_pengadaan'] ?? ''))),
            'pagu' => (float) $r['pagu'],
            'status' => $this->statusRank($r['status_realisasi']),
            'penyedia' => mb_strtolower((string) $r['nama_penyedia']),
            'kontrak' => (float) $r['nilai_kontrak'],
            'efisiensi' => ($r['ada_realisasi'] && $r['status_realisasi'] === 'Selesai' && $pagu($r)) ? (float) $r['pagu'] - (float) $r['nilai_kontrak'] : null,
            default => 0,
        };

        usort($rows, function ($a, $b) use ($val, $dir) {
            $va = $val($a);
            $vb = $val($b);
            if ($va === null && $vb === null) {
                return $this->cmp($a['nama_satker'], $b['nama_satker']);
            }
            if ($va === null) {
                return 1;
            }
            if ($vb === null) {
                return -1;
            }
            if (is_string($va)) {
                return strcmp($va, (string) $vb) * $dir;
            }

            return (($va <=> $vb) * $dir) ?: $this->cmp($a['nama_satker'], $b['nama_satker']);
        });
    }

    private function summarize(array $rows, int $totalGabungan): array
    {
        $sum = fn (array $set, string $f) => array_sum(array_map(fn ($r) => (float) $r[$f], $set));
        $pct = fn (float $pagu, float $kontrak) => $pagu > 0 ? round(($pagu - $kontrak) / $pagu * 100, 2) : 0;

        $matched = array_filter($rows, fn ($r) => $r['ada_realisasi']);
        $selesai = array_filter($rows, fn ($r) => $r['status_realisasi'] === 'Selesai');
        $berjalan = array_filter($rows, fn ($r) => in_array($r['status_realisasi'], ['Sedang Berjalan', 'Campuran'], true));
        $known = fn ($r) => ! $r['is_unmatched'] || (float) $r['pagu'] > 0;
        $selesaiEfi = array_filter($selesai, $known);
        $berjalanEfi = array_filter($berjalan, $known);

        $paguSel = $sum($selesaiEfi, 'pagu');
        $kontrakSel = $sum($selesaiEfi, 'nilai_kontrak');
        $paguJln = $sum($berjalanEfi, 'pagu');
        $kontrakJln = $sum($berjalanEfi, 'nilai_kontrak');

        $orphan = array_values(array_filter($rows, fn ($r) => $r['is_unmatched']));
        $splitByRup = [];
        foreach ($rows as $r) {
            if (! empty($r['is_split_kontrak'])) {
                $splitByRup[$r['kode_rup']][] = $r;
            }
        }
        $paketRup = array_values(array_filter($rows, fn ($r) => ! $r['is_unmatched'] && empty($r['is_split_kontrak'])));

        $cnt = ['Selesai' => 0, 'Sedang Berjalan' => 0, 'Dibatalkan' => 0, 'Belum' => 0];
        foreach ($paketRup as $r) {
            if ($r['ada_realisasi']) {
                $s = $r['status_realisasi'] === 'Campuran' ? 'Sedang Berjalan' : $r['status_realisasi'];
            } elseif (isset($splitByRup[$r['kode_rup']])) {
                $s = ! array_diff(array_column($splitByRup[$r['kode_rup']], 'status_realisasi'), ['Selesai']) ? 'Selesai' : 'Sedang Berjalan';
            } else {
                $s = $r['status_realisasi'] === 'Dibatalkan' ? 'Dibatalkan' : 'Belum';
            }
            $cnt[$s] = ($cnt[$s] ?? 0) + 1;
        }
        $orphanSelesai = count(array_filter($orphan, fn ($r) => $r['status_realisasi'] === 'Selesai'));
        $orphanJalan = count($orphan) - $orphanSelesai;

        return [
            'total_gabungan' => $totalGabungan,
            'total_paket_rup' => count($paketRup), 'total_paket_semua' => count($paketRup) + count($orphan),
            'selesai' => $cnt['Selesai'] + $orphanSelesai, 'sedang_berjalan' => $cnt['Sedang Berjalan'] + $orphanJalan,
            'belum_berproses' => $cnt['Belum'], 'dibatalkan' => $cnt['Dibatalkan'],
            'selesai_belum_match' => $orphanSelesai, 'berjalan_belum_match' => $orphanJalan, 'jumlah_unmatched' => count($orphan),
            'total_pagu' => $sum($paketRup, 'pagu'),
            'total_kontrak' => $sum(array_filter($matched, fn ($r) => ! $r['is_unmatched']), 'nilai_kontrak'),
            'pagu_selesai' => $paguSel, 'kontrak_selesai' => $kontrakSel,
            'total_efisiensi_selesai' => $paguSel - $kontrakSel, 'persen_efisiensi_selesai' => $pct($paguSel, $kontrakSel),
            'pagu_berjalan' => $paguJln, 'kontrak_berjalan' => $kontrakJln,
            'total_efisiensi_berjalan' => $paguJln - $kontrakJln, 'persen_efisiensi_berjalan' => $pct($paguJln, $kontrakJln),
            'transaksi_selesai' => (int) $sum($selesai, 'jumlah_transaksi'),
            'transaksi_berjalan' => (int) $sum($berjalan, 'jumlah_transaksi'),
            'transaksi_total' => (int) $sum($matched, 'jumlah_transaksi'),
        ];
    }

    /** Anggota grup "1 realisasi → banyak kode_rup" dilipat ke baris primary-nya. */
    private function collapseGroups(array $rows): array
    {
        $byPaket = [];
        foreach ($rows as $i => $r) {
            if ($r['is_gabungan_kode_rup'] && $r['kode_paket']) {
                $byPaket[$r['kode_paket']][] = $i;
            }
        }
        foreach ($byPaket as $idxs) {
            $primary = null;
            foreach ($idxs as $i) {
                if ($rows[$i]['is_primary_gabungan']) {
                    $primary = $i;
                    break;
                }
            }
            if ($primary === null) {
                continue;
            }
            $rows[$primary]['group_members'] = array_values(array_map(fn ($i) => [
                'kode_rup' => $rows[$i]['kode_rup'], 'nama_paket_rup' => $rows[$i]['nama_paket_rup'],
                'metode_pengadaan_rup' => $rows[$i]['metode_pengadaan_rup'], 'jenis_pengadaan_rup' => $rows[$i]['jenis_pengadaan_rup'],
                'pagu' => $rows[$i]['pagu'], 'is_manual_pagu' => $rows[$i]['is_manual_pagu'],
            ], array_filter($idxs, fn ($i) => $i !== $primary)));
        }

        return array_values(array_filter($rows, fn ($r) => ! ($r['is_gabungan_kode_rup'] && ! $r['is_primary_gabungan'])));
    }
}
