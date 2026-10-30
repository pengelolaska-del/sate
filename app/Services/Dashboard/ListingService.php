<?php

declare(strict_types=1);

namespace App\Services\Dashboard;

use App\Support\Api;
use App\Support\Normalizer as N;
use App\Support\Rows;
use Illuminate\Database\Query\Builder;
use Illuminate\Support\Facades\DB;

/** Halaman tabel RUP (diperkaya status realisasi) dan Realisasi. */
final class ListingService
{
    /** Filter "Tender" juga mencakup "Seleksi" (sama-sama kompetitif via SPSE). */
    private const SUMBER_TRANSAKSI_GABUNGAN = ['Tender' => ['Tender', 'Seleksi']];

    public function __construct(private readonly PeriodeService $periodes) {}

    // ── RUP ──────────────────────────────────────────────────────

    public function listRup(array $p): array
    {
        $periodes = $this->resolvePeriodes($p);
        $page = max(1, (int) ($p['page'] ?? 1));
        $perPage = max(1, min(500, (int) ($p['per_page'] ?? 50)));

        // RUP semua periode terpilih (periode terbaru dulu; kode_rup duplikat → ambil yang pertama)
        $all = [];
        $seen = [];
        foreach ($periodes as $pr) {
            $rows = DB::table('rup_records')->where('periode', $pr)->orderBy('id')->get();
            foreach ($rows as $r) {
                if (count($periodes) > 1) {
                    if (isset($seen[$r->kode_rup])) {
                        continue;
                    }
                    $seen[$r->kode_rup] = true;
                }
                $all[] = Rows::cast($r);
            }
        }

        [$realByRup, $realByNama, $groupByRup] = $this->indexRealisasi($periodes);
        $all = array_map(fn (array $r) => $this->enrich($r, $realByRup, $realByNama, $groupByRup), $all);

        // Opsi dropdown dibangun dari data SEBELUM filter kriteria (hanya dibatasi periode)
        $base = $all;

        $satkers = N::satkerList($p['kode_satker'] ?? null);
        $all = array_values(array_filter($all, function (array $r) use ($p, $satkers) {
            if ($satkers && ! in_array((string) $r['kode_satker'], $satkers, true)) {
                return false;
            }
            if ($this->active($p, 'cara_pengadaan') && N::cara($r['cara_pengadaan']) !== N::cara($p['cara_pengadaan'])) {
                return false;
            }
            foreach (['metode_pengadaan', 'jenis_pengadaan', 'sumber_dana'] as $f) {
                if ($this->active($p, $f) && $r[$f] !== $p[$f]) {
                    return false;
                }
            }
            if (! empty($p['kode_rup']) && ! str_contains((string) $r['kode_rup'], (string) $p['kode_rup'])) {
                return false;
            }
            if (! empty($p['nama_paket']) && ! $this->containsAny(N::keywords($p['nama_paket']), $r['nama_paket'])) {
                return false;
            }
            if ($this->active($p, 'status_realisasi') && $r['status_realisasi'] !== $p['status_realisasi']) {
                return false;
            }

            return true;
        }));

        // Ringkasan per jenis, per cara, dan global (sebelum paginasi)
        $jenis = [];
        $cara = [];
        $g = ['selesai' => 0, 'sedang_berjalan' => 0, 'belum_berproses' => 0, 'dibatalkan' => 0, 'total_pagu' => 0.0, 'total_kontrak' => 0.0];

        foreach ($all as $r) {
            $pagu = (float) $r['pagu'];
            $kontrak = $r['ada_realisasi'] ? (float) $r['nilai_kontrak'] : 0.0;
            $st = $r['status_realisasi'];

            $jk = $r['jenis_pengadaan'] ?: 'Tidak Terklasifikasi';
            $jenis[$jk] ??= ['jenis' => $jk, 'total' => 0, 'selesai' => 0, 'sedang_berjalan' => 0, 'belum_berproses' => 0, 'dibatalkan' => 0, 'total_pagu' => 0.0, 'total_kontrak' => 0.0];
            $jenis[$jk]['total']++;
            $jenis[$jk]['total_pagu'] += $pagu;
            $jenis[$jk]['total_kontrak'] += $kontrak;

            $ck = N::cara($r['cara_pengadaan']);
            $cara[$ck] ??= ['cara_pengadaan' => $ck, 'total' => 0, 'total_pagu' => 0.0];
            $cara[$ck]['total']++;
            $cara[$ck]['total_pagu'] += $pagu;

            $bucket = match ($st) {
                'Selesai' => 'selesai',
                'Sedang Berjalan', 'Campuran' => 'sedang_berjalan',
                'Dibatalkan' => 'dibatalkan',
                default => 'belum_berproses',
            };
            $jenis[$jk][$bucket]++;
            $g[$bucket]++;
            $g['total_pagu'] += $pagu;
            $g['total_kontrak'] += $kontrak;
        }

        // Belum Berproses dulu, lalu Sedang, lalu Selesai; sisanya per nama satker
        $ord = ['Belum Berproses' => 0, 'Sedang Berjalan' => 1, 'Campuran' => 1, 'Selesai' => 2, 'Dibatalkan' => 3];
        usort($all, function (array $a, array $b) use ($ord) {
            return [$ord[$a['status_realisasi']] ?? 0, mb_strtolower((string) $a['nama_satker'])]
                <=> [$ord[$b['status_realisasi']] ?? 0, mb_strtolower((string) $b['nama_satker'])];
        });

        $total = count($all);

        return Api::ok([
            'total' => $total,
            'total_pagu' => $g['total_pagu'],
            'page' => $page,
            'per_page' => $perPage,
            'total_pages' => max(1, (int) ceil($total / $perPage)),
            'summary' => $g,
            'cara_summary' => $this->sortDesc(array_values($cara)),
            'jenis_summary' => $this->sortDesc(array_values($jenis)),
            'items' => array_slice($all, ($page - 1) * $perPage, $perPage),
            'enums' => [
                'metode' => $this->distinct($base, 'metode_pengadaan'),
                'jenis' => $this->distinct($base, 'jenis_pengadaan'),
                'sumber' => $this->distinct($base, 'sumber_dana'),
                'satker' => $this->satkerEnum($base),
            ],
        ]);
    }

    /** @return array{0:array,1:array,2:array} realByRup, realByNama, groupByRup */
    private function indexRealisasi(array $periodes): array
    {
        $order = ['Selesai' => 0, 'Sedang Berjalan' => 1, 'Dibatalkan' => 3];
        $better = fn (?array $old, array $cur) => $old === null
            || ($order[$cur['status_paket']] ?? 2) < ($order[$old['status_paket']] ?? 2);

        $byRup = [];
        $byNama = [];
        $group = [];

        foreach ($periodes as $pr) {
            $rows = DB::table('realisasi_records')->where('periode', $pr)->orderBy('id')
                ->get(['kode_rup', 'kode_satker', 'nama_paket', 'status_paket', 'nama_penyedia', 'nilai_kontrak', 'kode_paket']);
            foreach ($rows as $obj) {
                $r = (array) $obj;
                $kr = trim((string) $r['kode_rup']);
                $nk = $r['kode_satker'].'|'.mb_strtolower(trim((string) $r['nama_paket']));
                if ($kr !== '' && $better($byRup[$kr] ?? null, $r)) {
                    $byRup[$kr] = $r;
                }
                if ($better($byNama[$nk] ?? null, $r)) {
                    $byNama[$nk] = $r;
                }
                if ($kr !== '') {
                    $group[$kr][] = $r;
                }
            }
        }

        return [$byRup, $byNama, $group];
    }

    private function enrich(array $r, array $byRup, array $byNama, array $group): array
    {
        $kr = trim((string) $r['kode_rup']);
        $nk = $r['kode_satker'].'|'.mb_strtolower(trim((string) $r['nama_paket']));
        $grp = $kr !== '' ? ($group[$kr] ?? null) : null;

        if ($grp && count($grp) > 1) {
            // >1 realisasi berbagi kode_rup: jumlahkan kontrak, agregasi status
            $statuses = array_column($grp, 'status_paket');
            $allSelesai = ! array_diff($statuses, ['Selesai']);
            $allBerjalan = ! array_diff($statuses, ['Sedang Berjalan']);

            return $r + [
                'ada_realisasi' => true,
                'status_realisasi' => $allSelesai ? 'Selesai' : ($allBerjalan ? 'Sedang Berjalan' : 'Campuran'),
                'nama_penyedia' => implode(', ', array_unique(array_filter(array_column($grp, 'nama_penyedia')))),
                'nilai_kontrak' => array_sum(array_map(fn ($x) => (float) $x['nilai_kontrak'], $grp)),
                'kode_paket' => implode(';', array_filter(array_column($grp, 'kode_paket'))),
                'is_realisasi_gabungan' => true,
                'jumlah_realisasi' => count($grp),
                'realisasi_list' => array_map(fn ($x) => [
                    'kode_paket' => $x['kode_paket'], 'nama_penyedia' => $x['nama_penyedia'],
                    'nilai_kontrak' => (float) $x['nilai_kontrak'], 'status_realisasi' => $x['status_paket'],
                ], $grp),
            ];
        }

        $real = $byRup[$kr] ?? $byNama[$nk] ?? null;

        return $r + [
            'ada_realisasi' => $real !== null,
            'status_realisasi' => $real ? ($real['status_paket'] ?: 'Sedang Berjalan') : 'Belum Berproses',
            'nama_penyedia' => $real ? ($real['nama_penyedia'] ?: '') : null,
            'nilai_kontrak' => $real ? (float) $real['nilai_kontrak'] : null,
            'kode_paket' => $real ? ($real['kode_paket'] ?: '') : null,
            'is_realisasi_gabungan' => false,
            'jumlah_realisasi' => $real ? 1 : 0,
            'realisasi_list' => null,
        ];
    }

    // ── Realisasi ────────────────────────────────────────────────

    public function listRealisasi(array $p): array
    {
        $periodes = $this->resolvePeriodes($p);
        $page = max(1, (int) ($p['page'] ?? 1));
        $perPage = max(1, min(500, (int) ($p['per_page'] ?? 50)));

        // Berapa realisasi yang berbagi kode_rup yang sama (sebelum filter)
        $shared = DB::table('realisasi_records')->whereIn('periode', $periodes)
            ->whereRaw("coalesce(trim(kode_rup), '') <> ''")
            ->selectRaw('trim(kode_rup) as k, count(*) as n')->groupByRaw('trim(kode_rup)')->havingRaw('count(*) > 1')
            ->pluck('n', 'k')->all();

        $q = DB::table('realisasi_records')->whereIn('periode', $periodes);
        $this->filterRealisasi($q, $p);

        $total = (clone $q)->count();
        $totalNilai = (float) (clone $q)->sum('nilai_kontrak');
        $items = $q->orderBy('id')->offset(($page - 1) * $perPage)->limit($perPage)->get()
            ->map(function ($r) use ($shared) {
                $row = Rows::cast($r);
                $kr = trim((string) $row['kode_rup']);
                $row['jumlah_realisasi_kode_rup'] = $kr !== '' ? (int) ($shared[$kr] ?? 0) : 0;

                return $row;
            })->all();

        $enum = function (string $col) use ($periodes, $p) {
            $e = DB::table('realisasi_records')->whereIn('periode', $periodes);
            $this->filterRealisasi($e, $p);

            return $e->whereNotNull($col)->where($col, '<>', '')->distinct()->orderBy($col)->pluck($col)->all();
        };

        $satkerQ = DB::table('realisasi_records')->whereIn('periode', $periodes);
        $this->filterRealisasi($satkerQ, $p);
        $satkerEnum = $satkerQ->selectRaw('kode_satker as k, min(nama_satker) as n')->groupBy('kode_satker')->orderBy('n')->get()
            ->map(fn ($r) => ['k' => $r->k, 'n' => $r->n])->all();

        return Api::ok([
            'total' => $total, 'total_nilai' => $totalNilai, 'page' => $page, 'per_page' => $perPage,
            'total_pages' => (int) ceil($total / $perPage),
            'items' => $items,
            'enums' => [
                'transaksi' => $enum('sumber_transaksi'), 'sumber' => $enum('sumber_dana'),
                'status' => $enum('status_paket'), 'metode' => $enum('metode_pengadaan'),
                'jenis' => $enum('jenis_pengadaan'), 'satker' => $satkerEnum,
            ],
        ]);
    }

    private function filterRealisasi(Builder $q, array $p): void
    {
        if ($s = N::satkerList($p['kode_satker'] ?? null)) {
            $q->whereIn('kode_satker', $s);
        }
        if ($this->active($p, 'sumber_transaksi')) {
            $group = self::SUMBER_TRANSAKSI_GABUNGAN[$p['sumber_transaksi']] ?? null;
            $group ? $q->whereIn('sumber_transaksi', $group) : $q->where('sumber_transaksi', $p['sumber_transaksi']);
        }
        foreach (['sumber_dana', 'status_paket', 'metode_pengadaan', 'jenis_pengadaan'] as $f) {
            if ($this->active($p, $f)) {
                $q->where($f, $p[$f]);
            }
        }
        if (! empty($p['nama_penyedia'])) {
            $q->where('nama_penyedia', 'ilike', $this->like($p['nama_penyedia']));
        }
        if (! empty($p['nama_paket']) && ($terms = N::keywords($p['nama_paket']))) {
            $q->where(function (Builder $w) use ($terms) {
                foreach ($terms as $t) {
                    $w->orWhere('nama_paket', 'ilike', $this->like($t));
                }
            });
        }
        if (! empty($p['kode_paket'])) {
            $q->where('kode_paket', 'like', $this->like($p['kode_paket']));
        }
    }

    // ── helpers ──────────────────────────────────────────────────

    /** @return list<string> */
    private function resolvePeriodes(array $p): array
    {
        if (! empty($p['periode'])) {
            return [$p['periode']];
        }
        if (! empty($p['tahun'])) {
            return $this->periodes->availablePeriodes((string) $p['tahun']);
        }

        return array_slice($this->periodes->availablePeriodes(), 0, 1);
    }

    private function active(array $p, string $key): bool
    {
        return ! empty($p[$key]) && $p[$key] !== 'Semua';
    }

    private function like(mixed $text): string
    {
        return '%'.addcslashes((string) $text, '%_\\').'%';
    }

    private function containsAny(array $terms, mixed $field): bool
    {
        $hay = mb_strtolower((string) $field);
        foreach ($terms as $t) {
            if (str_contains($hay, $t)) {
                return true;
            }
        }

        return $terms === [];
    }

    private function distinct(array $rows, string $key): array
    {
        $vals = array_values(array_unique(array_filter(array_column($rows, $key))));
        sort($vals);

        return $vals;
    }

    private function satkerEnum(array $rows): array
    {
        $map = [];
        foreach ($rows as $r) {
            $map[$r['kode_satker'].'|'.$r['nama_satker']] = ['k' => $r['kode_satker'], 'n' => $r['nama_satker']];
        }
        $out = array_values($map);
        usort($out, fn ($a, $b) => strcmp((string) $a['n'], (string) $b['n']));

        return $out;
    }

    private function sortDesc(array $rows): array
    {
        usort($rows, fn ($a, $b) => $b['total'] <=> $a['total']);

        return $rows;
    }
}
