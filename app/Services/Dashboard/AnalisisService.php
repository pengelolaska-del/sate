<?php

declare(strict_types=1);

namespace App\Services\Dashboard;

use App\Support\Api;
use App\Support\ApiException;
use App\Support\Normalizer as N;
use App\Support\Rows;
use App\Support\SumberTransaksi;
use Illuminate\Support\Facades\DB;

/** Menu Analisis: efisiensi per OPD/transaksi/metode/jenis, chart Top 10, rincian, setting metode dikecualikan. */
final class AnalisisService
{
    public function __construct(
        private readonly EfisiensiRowsService $efisiensi,
        private readonly SandinganService $sandingan,
        private readonly PeriodeService $periodes,
    ) {}

    // ── Ringkasan efisiensi ──────────────────────────────────────

    public function listEfisiensi(array $p): array
    {
        $periode = $p['periode'] ?? null;
        $tahun = $p['tahun'] ?? null;
        $built = $this->efisiensi->build($periode, $tahun);
        $all = $built['rows'];
        $rows = $this->filterRows($all, $p, true);

        $dim = ['satker' => [], 'transaksi' => [], 'metode' => [], 'jenis' => []];
        $bump = function (&$map, string $key, array $r, bool $ikut, bool $belumMatch) {
            $map ??= [];
            $map[$key] ??= ['label' => $key, 'total_pagu' => 0.0, 'total_kontrak' => 0.0, 'jumlah' => 0, 'jumlah_ikut_efisiensi' => 0, 'jumlah_belum_match_rup' => 0];
            $map[$key]['jumlah']++;
            $belumMatch && $map[$key]['jumlah_belum_match_rup']++;
            if ($ikut) {
                $map[$key]['total_pagu'] += (float) $r['pagu'];
                $map[$key]['total_kontrak'] += (float) $r['nilai_kontrak'];
                $map[$key]['jumlah_ikut_efisiensi']++;
            }
        };

        $buckets = [];
        $paguF = $kontrakF = 0.0;
        foreach ($rows as $r) {
            $ikut = empty($r['excluded_dari_efisiensi']);
            $belum = ! empty($r['is_unmatched']) && empty($r['is_manual_pagu']);
            $keys = [
                'transaksi' => ($r['sumber_transaksi'] ?? '') ?: '(Tidak Diketahui)',
                'metode' => ($r['metode_pengadaan'] ?? '') ?: '(Tidak Diketahui)',
                'jenis' => ($r['jenis_pengadaan'] ?? '') ?: '(Tidak Diketahui)',
            ];
            $which = ['all'];
            if ($r['status_realisasi'] === 'Selesai') {
                $which[] = 'selesai';
            } elseif ($r['status_realisasi'] === 'Sedang Berjalan') {
                $which[] = 'berjalan';
            }

            if ($ikut) {
                $paguF += (float) $r['pagu'];
                $kontrakF += (float) $r['nilai_kontrak'];
            }
            foreach ($which as $w) {
                foreach ($keys as $d => $k) {
                    $bump($buckets[$d][$w], $k, $r, $ikut, $belum);
                }
                $sk = (string) $r['kode_satker'];
                $bump($buckets['satker'][$w], $sk, $r, $ikut, $belum);
                $buckets['satker'][$w][$sk] += ['kode_satker' => $r['kode_satker'], 'nama_satker' => $r['nama_satker']];
            }
        }

        $toArr = function (?array $map, bool $satker = false): array {
            $out = array_map(function ($r) use ($satker) {
                if ($satker) {
                    unset($r['label']);
                }
                $efi = $r['total_pagu'] - $r['total_kontrak'];

                return $r + [
                    'efisiensi' => $efi,
                    'persen_efisiensi' => $r['total_pagu'] > 0 ? round($efi / $r['total_pagu'] * 100, 2) : 0,
                    // false = "belum ada data yang bisa dihitung", bukan efisiensi nol sungguhan
                    'ada_data_efisiensi' => $r['jumlah_ikut_efisiensi'] > 0,
                ];
            }, array_values($map ?? []));
            usort($out, fn ($a, $b) => $b['efisiensi'] <=> $a['efisiensi']);

            return $out;
        };

        $periodesAgg = $this->efisiensi->resolvePeriodes($periode, $tahun);
        $aggregate = Rows::castAll(DB::table('dashboard_aggregates')->whereIn('periode', $periodesAgg)->orderBy('periode')->get());

        // KPI efisiensi dihitung live dari semua paket Selesai (tanpa dipengaruhi dropdown filter)
        $selesaiEfi = array_filter($all, fn ($r) => $r['status_realisasi'] === 'Selesai' && empty($r['excluded_dari_efisiensi']));

        $data = [
            'aggregate' => $aggregate,
            'by_opd' => $toArr($buckets['satker']['all'] ?? null, true),
            'by_opd_selesai' => $toArr($buckets['satker']['selesai'] ?? null, true),
            'by_opd_berjalan' => $toArr($buckets['satker']['berjalan'] ?? null, true),
        ];
        foreach (['transaksi' => 'sumber_transaksi', 'metode' => 'metode', 'jenis' => 'jenis'] as $d => $name) {
            $data["by_$name"] = $toArr($buckets[$d]['all'] ?? null);
            $data["by_{$name}_selesai"] = $toArr($buckets[$d]['selesai'] ?? null);
            $data["by_{$name}_berjalan"] = $toArr($buckets[$d]['berjalan'] ?? null);
        }

        return Api::ok($data + [
            'total_pagu_filtered' => $paguF, 'total_kontrak_filtered' => $kontrakF, 'total_paket_filtered' => count($rows),
            'total_pagu_selesai_efisiensi' => array_sum(array_map(fn ($r) => (float) $r['pagu'], $selesaiEfi)),
            'total_kontrak_selesai_efisiensi' => array_sum(array_map(fn ($r) => (float) $r['nilai_kontrak'], $selesaiEfi)),
            'metode_excluded' => $this->excludedList(),
            'enums' => $built['enums'],
        ]);
    }

    // ── Rincian paket (tabel detail) ─────────────────────────────

    public function listEfisiensiDetail(array $p): array
    {
        $page = max(1, (int) ($p['page'] ?? 1));
        $perPage = max(1, min(500, (int) ($p['per_page'] ?? 50)));
        $manual = array_flip(array_map('trim', DB::table('manual_pagu')->pluck('kode_paket')->all()));
        $exclude = array_flip($this->excludedList());
        $satkers = N::satkerList($p['kode_satker'] ?? null);

        $dedup = [];
        foreach ($this->efisiensi->resolvePeriodes($p['periode'] ?? null, $p['tahun'] ?? null) as $pr) {
            $real = [];
            foreach (DB::table('realisasi_records')->where('periode', $pr)->get() as $o) {
                if (! empty($o->kode_paket)) {
                    $real[trim($o->kode_paket)] = (array) $o;
                }
            }
            $seen = [];
            foreach (DB::table('matching_results')->where('periode', $pr)->where('status_matching', 'MATCHED')->whereNotNull('kode_paket')->orderBy('id')->get() as $o) {
                $r = (array) $o;
                $kp = trim((string) $r['kode_paket']);
                if ($kp === '' || isset($seen[$kp])) {
                    continue;
                }
                $seen[$kp] = true;
                $re = $real[$kp] ?? [];

                if ($satkers && ! in_array((string) $r['kode_satker'], $satkers, true)) {
                    continue;
                }
                if (! empty($p['sumber_transaksi']) && ! SumberTransaksi::match($re['sumber_transaksi'] ?? null, $p['sumber_transaksi'])) {
                    continue;
                }
                if (! empty($p['metode_pengadaan']) && ($re['metode_pengadaan'] ?? '') !== $p['metode_pengadaan']) {
                    continue;
                }
                if (! empty($p['jenis_pengadaan']) && (($re['jenis_pengadaan'] ?? '') ?: '') !== $p['jenis_pengadaan']) {
                    continue;
                }
                if (! empty($p['status_paket']) && ($re['status_paket'] ?? '') !== $p['status_paket']) {
                    continue;
                }

                $pagu = (float) $r['pagu_rup'];
                $kontrak = (float) $r['nilai_kontrak'];
                $dedup[$kp] = [ // periode terbaru menimpa yang lama
                    'periode' => $pr, 'nama_satker' => $r['nama_satker'], 'kode_satker' => $r['kode_satker'],
                    'nama_penyedia' => $re['nama_penyedia'] ?? '', 'jenis_pengadaan' => ($re['jenis_pengadaan'] ?? '') ?: '',
                    'metode_pengadaan' => $re['metode_pengadaan'] ?? '', 'sumber_transaksi' => $re['sumber_transaksi'] ?? '',
                    'status_paket' => $re['status_paket'] ?? '',
                    'nama_paket' => ($r['nama_paket_realisasi'] ?: ($re['nama_paket'] ?? '')) ?: ($r['nama_paket_rup'] ?? ''),
                    'kode_paket' => $kp, 'kode_rup' => $r['kode_rup'],
                    'pagu_rup' => $pagu, 'nilai_kontrak' => $kontrak,
                    // pagu 0 = belum diketahui, bukan pemborosan riil
                    'efisiensi' => $pagu > 0 ? $pagu - $kontrak : null, 'pagu_diketahui' => $pagu > 0,
                    'is_manual_pagu' => isset($manual[$kp]),
                    'excluded_dari_efisiensi' => isset($exclude[$re['metode_pengadaan'] ?? '']),
                ];
            }
        }

        $items = array_values($dedup);
        usort($items, fn ($a, $b) => ($b['efisiensi'] ?? -INF) <=> ($a['efisiensi'] ?? -INF));
        $hitung = array_filter($items, fn ($r) => ! $r['excluded_dari_efisiensi'] && $r['pagu_diketahui']);
        $pagu = array_sum(array_column($hitung, 'pagu_rup'));
        $kontrak = array_sum(array_column($hitung, 'nilai_kontrak'));
        $total = count($items);

        return Api::ok([
            'total' => $total, 'total_pagu' => $pagu, 'total_kontrak' => $kontrak, 'total_efisiensi' => $pagu - $kontrak,
            'persen_efisiensi' => $pagu > 0 ? round(($pagu - $kontrak) / $pagu * 100, 2) : 0,
            'page' => $page, 'per_page' => $perPage, 'total_pages' => max(1, (int) ceil($total / $perPage)),
            'items' => array_slice($items, ($page - 1) * $perPage, $perPage),
        ]);
    }

    // ── Chart Top 10 ─────────────────────────────────────────────

    public function charts(array $p): array
    {
        $efiRows = $this->filterRows($this->efisiensi->build($p['periode'] ?? null, $p['tahun'] ?? null)['rows'], $p, false);
        $selesai = array_filter($efiRows, fn ($r) => $r['status_realisasi'] === 'Selesai');

        $efi = [];
        foreach (array_filter($selesai, fn ($r) => empty($r['excluded_dari_efisiensi'])) as $r) {
            $k = ($r['kode_satker'] ?: $r['nama_satker']);
            $efi[$k] ??= ['kode_satker' => $r['kode_satker'], 'nama_satker' => $r['nama_satker'], 'total_pagu' => 0.0, 'total_kontrak' => 0.0];
            $efi[$k]['total_pagu'] += (float) $r['pagu'];
            $efi[$k]['total_kontrak'] += (float) $r['nilai_kontrak'];
        }
        $topEfi = array_map(fn ($r) => $r + [
            'efisiensi' => $r['total_pagu'] - $r['total_kontrak'],
            'persen_efisiensi' => $r['total_pagu'] > 0 ? round(($r['total_pagu'] - $r['total_kontrak']) / $r['total_pagu'] * 100, 2) : 0,
        ], array_values($efi));
        usort($topEfi, fn ($a, $b) => $b['efisiensi'] <=> $a['efisiensi']);

        $cnt = [];
        foreach ($selesai as $r) {
            $k = ($r['kode_satker'] ?: $r['nama_satker']);
            $cnt[$k] ??= ['kode_satker' => $r['kode_satker'], 'nama_satker' => $r['nama_satker'], 'jumlah' => 0];
            $cnt[$k]['jumlah']++;
        }
        $topPaket = array_values($cnt);
        usort($topPaket, fn ($a, $b) => $b['jumlah'] <=> $a['jumlah']);

        // Penyedia: basis Sandingan (mencakup realisasi yang belum lewat proses matching)
        $sand = $this->filterRows($this->sandingan->buildRows($p['periode'] ?? null, $p['tahun'] ?? null)['rows'], $p, false);
        $pen = [];
        foreach ($sand as $r) {
            $k = trim((string) ($r['nama_penyedia'] ?? ''));
            if (! $r['ada_realisasi'] || $k === '') {
                continue;
            }
            $pen[$k] ??= ['nama_penyedia' => $k, 'jumlah' => 0, 'total_kontrak' => 0.0];
            $pen[$k]['jumlah']++;
            $pen[$k]['total_kontrak'] += (float) $r['nilai_kontrak'];
        }
        $topPen = array_values($pen);
        usort($topPen, fn ($a, $b) => $b['jumlah'] <=> $a['jumlah']);

        return Api::ok([
            'top_opd_efisiensi' => array_slice($topEfi, 0, 10),
            'top_opd_paket' => array_slice($topPaket, 0, 10),
            'top_penyedia_paket' => array_slice($topPen, 0, 10),
        ]);
    }

    // ── Rincian drill-down dari chart/badge ──────────────────────

    public function analisisDetail(array $p): array
    {
        $tipe = $p['tipe'] ?? '';
        $page = max(1, (int) ($p['page'] ?? 1));
        $perPage = max(1, min(500, (int) ($p['per_page'] ?? 50)));
        $periode = $p['periode'] ?? null;
        $tahun = $p['tahun'] ?? null;
        $satkers = N::satkerList($p['kode_satker'] ?? null);

        if ($tipe === 'opd_efisiensi' || $tipe === 'opd_paket') {
            // Paket metode "dikecualikan" TETAP tampil di rincian (hanya tidak ikut SUM efisiensi)
            $rows = array_filter($this->efisiensi->build($periode, $tahun)['rows'], fn ($r) => $this->inSatker($r, $satkers) && $r['status_realisasi'] === 'Selesai');
        } elseif ($tipe === 'penyedia_paket') {
            $nama = trim((string) ($p['nama_penyedia'] ?? ''));
            $rows = array_filter($this->sandingan->buildRows($periode, $tahun)['rows'], fn ($r) => $r['ada_realisasi'] && trim((string) $r['nama_penyedia']) === $nama);
        } elseif ($tipe === 'dim_unmatched') {
            $field = ['satker' => 'kode_satker', 'transaksi' => 'sumber_transaksi', 'metode' => 'metode_pengadaan', 'jenis' => 'jenis_pengadaan'][$p['dim'] ?? ''] ?? null;
            if (! $field) {
                throw new ApiException('Parameter dim tidak dikenali.');
            }
            $statusFilter = ($p['status'] ?? '') === 'berjalan' ? 'Sedang Berjalan' : 'Selesai';
            $rows = array_filter($this->efisiensi->build($periode, $tahun)['rows'], fn ($r) => $r['status_realisasi'] === $statusFilter
                && ! empty($r['is_unmatched']) && empty($r['is_manual_pagu'])
                && ((string) ($r[$field] ?? '') ?: '(Tidak Diketahui)') === ($p['value'] ?? null));
        } else {
            throw new ApiException('Parameter tipe tidak dikenali.');
        }

        $rows = array_values($rows);
        $total = count($rows);
        $items = array_map(function ($r) {
            $known = (float) $r['pagu'] > 0; // pagu 0 = belum diketahui → efisiensi null, bukan negatif palsu

            return [
                'kode_rup' => $r['kode_rup'], 'kode_paket' => $r['kode_paket'], 'kode_satker' => $r['kode_satker'],
                'periode' => $r['periode'] ?? null, 'nama_satker' => $r['nama_satker'],
                'nama_paket' => ($r['nama_paket_realisasi'] ?? null) ?: ($r['nama_paket_rup'] ?? null),
                'nama_penyedia' => $r['nama_penyedia'], 'metode_pengadaan' => $r['metode_pengadaan'],
                'pagu' => (float) $r['pagu'], 'nilai_kontrak' => (float) $r['nilai_kontrak'],
                'efisiensi' => $known ? (float) $r['pagu'] - (float) $r['nilai_kontrak'] : null, 'pagu_diketahui' => $known,
                'status_realisasi' => $r['status_realisasi'], 'excluded_dari_efisiensi' => ! empty($r['excluded_dari_efisiensi']),
            ];
        }, array_slice($rows, ($page - 1) * $perPage, $perPage));

        return Api::ok(['total' => $total, 'page' => $page, 'per_page' => $perPage, 'total_pages' => max(1, (int) ceil($total / $perPage)), 'items' => $items]);
    }

    // ── Setting: metode dikecualikan dari efisiensi ──────────────

    public function listExcludeMetode(array $p): array
    {
        // opsi = metode yang benar-benar muncul di realisasi semua periode
        $options = DB::table('realisasi_records')->whereNotNull('metode_pengadaan')->where('metode_pengadaan', '<>', '')
            ->distinct()->orderBy('metode_pengadaan')->pluck('metode_pengadaan')->all();

        return Api::ok(['metode_options' => $options, 'excluded' => $this->excludedList()]);
    }

    public function saveExcludeMetode(array $p): array
    {
        if (! is_array($p['excluded'] ?? null)) {
            throw new ApiException('Parameter excluded harus berupa array metode_pengadaan.');
        }
        $uniq = array_values(array_unique(array_filter(array_map(fn ($m) => trim((string) $m), $p['excluded']), fn ($m) => $m !== '')));

        DB::transaction(function () use ($uniq) {
            DB::table('efisiensi_exclude_metode')->delete(); // setting global → ganti semua
            if ($uniq) {
                DB::table('efisiensi_exclude_metode')->insert(array_map(fn ($m) => ['metode' => $m], $uniq));
            }
        });

        return Api::ok(['excluded' => $uniq], 'Setting metode dikecualikan dari efisiensi berhasil disimpan.');
    }

    public function listManualPagu(array $p): array
    {
        return Api::ok(Rows::castAll(DB::table('manual_pagu')->orderBy('id')->get()));
    }

    // ── helpers ──────────────────────────────────────────────────

    /** @return list<string> */
    private function excludedList(): array
    {
        return array_values(array_filter(array_map('trim', DB::table('efisiensi_exclude_metode')->pluck('metode')->all()), fn ($m) => $m !== ''));
    }

    private function inSatker(array $r, array $satkers): bool
    {
        return ! $satkers || in_array((string) $r['kode_satker'], $satkers, true);
    }

    /** Filter dropdown halaman Analisis. $withJenis = filter jenis ikut berlaku (listEfisiensi saja). */
    private function filterRows(array $rows, array $p, bool $withJenis): array
    {
        $satkers = N::satkerList($p['kode_satker'] ?? null);

        return array_values(array_filter($rows, function ($r) use ($p, $satkers, $withJenis) {
            return $this->inSatker($r, $satkers)
                && SumberTransaksi::match($r['sumber_transaksi'] ?? null, $p['sumber_transaksi'] ?? null)
                && (empty($p['metode_pengadaan']) || ($r['metode_pengadaan'] ?? null) === $p['metode_pengadaan'])
                && (! $withJenis || empty($p['jenis_pengadaan']) || ($r['jenis_pengadaan'] ?? null) === $p['jenis_pengadaan'])
                && (empty($p['status_paket']) || $r['status_realisasi'] === $p['status_paket']);
        }));
    }
}
