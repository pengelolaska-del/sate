<?php

declare(strict_types=1);

namespace App\Services\Dashboard;

use App\Support\Api;
use App\Support\ApiException;
use App\Support\Normalizer as N;
use App\Support\Rows;
use Illuminate\Database\Query\Builder;
use Illuminate\Support\Facades\DB;

/** Endpoint ringkasan dashboard (KPI, chart per OPD/metode/status/dst). */
final class DashboardQueryService
{
    public function __construct(private readonly AggregateService $aggregate) {}

    public function kpi(array $p): array
    {
        $periode = $this->periode($p);
        $satkers = N::satkerList($p['kode_satker'] ?? null);

        if (! $satkers) {
            $row = DB::table('dashboard_aggregates')->where('periode', $periode)->first();
            if (! $row) {
                throw new ApiException('Data tidak ditemukan.', 404);
            }

            return Api::ok(Rows::cast($row));
        }

        return Api::ok(['periode' => $periode, 'kode_satker' => $p['kode_satker']] + $this->aggregate->compute($periode, $satkers));
    }

    public function opd(array $p): array
    {
        $periode = $this->periode($p);

        $match = DB::table('matching_results')->where('periode', $periode)
            ->selectRaw(
                "kode_satker,
                 count(*) filter (where coalesce(kode_paket, '') <> '') as jumlah_real,
                 count(*) filter (where status_matching = 'MATCHED') as jumlah_matched,
                 coalesce(sum(nilai_kontrak) filter (where status_matching = 'MATCHED'), 0) as total_kontrak"
            )->groupBy('kode_satker')->get()->keyBy('kode_satker');

        $rows = DB::table('rup_records')->where('periode', $periode)
            ->selectRaw('kode_satker, min(nama_satker) as nama_satker, coalesce(sum(pagu), 0) as total_pagu, count(*) as jumlah_rup')
            ->groupBy('kode_satker')->get()
            ->map(function ($r) use ($match) {
                $m = $match[$r->kode_satker] ?? null;
                $pagu = (float) $r->total_pagu;
                $kontrak = (float) ($m->total_kontrak ?? 0);

                return [
                    'kode_satker' => $r->kode_satker, 'nama_satker' => $r->nama_satker,
                    'total_pagu' => $pagu, 'total_kontrak' => $kontrak,
                    'jumlah_rup' => (int) $r->jumlah_rup,
                    'jumlah_real' => (int) ($m->jumlah_real ?? 0),
                    'jumlah_matched' => (int) ($m->jumlah_matched ?? 0),
                    'efisiensi' => $pagu - $kontrak,
                    'persen_efisiensi' => $pagu > 0 ? round(($pagu - $kontrak) / $pagu * 100, 2) : 0,
                ];
            })->sortByDesc('total_pagu')->values()->all();

        return Api::ok($rows);
    }

    public function metode(array $p): array
    {
        $periode = $this->periode($p);
        $s = N::satkerList($p['kode_satker'] ?? null);

        return Api::ok([
            'metode_rup' => $this->group('rup_records', 'metode_pengadaan', 'pagu', $periode, $s),
            'jenis_rup' => $this->group('rup_records', 'jenis_pengadaan', 'pagu', $periode, $s),
            'metode_real' => $this->group('realisasi_records', 'metode_pengadaan', 'nilai_kontrak', $periode, $s),
            'jenis_real' => $this->group('realisasi_records', 'jenis_pengadaan', 'nilai_kontrak', $periode, $s),
        ]);
    }

    public function status(array $p): array
    {
        $periode = $this->periode($p);
        $s = N::satkerList($p['kode_satker'] ?? null);
        $dist = $this->group('realisasi_records', 'status_paket', null, $periode, $s);
        $count = fn (string $label) => (int) ($this->findValue($dist, $label));

        return Api::ok([
            'distribusi' => array_map(fn ($d) => ['label' => $d['label'], 'value' => $d['value']], $dist),
            'total' => array_sum(array_column($dist, 'value')),
            'selesai' => $count('Selesai'),
            'sedang_berjalan' => $count('Sedang Berjalan'),
            'belum_berproses' => $count('Belum Berproses'),
        ]);
    }

    public function sumber(array $p): array
    {
        $periode = $this->periode($p);
        $s = N::satkerList($p['kode_satker'] ?? null);
        $strip = fn (array $g) => array_map(fn ($d) => ['label' => $d['label'], 'value' => $d['value']], $g);

        return Api::ok([
            'sumber_dana' => $strip($this->group('realisasi_records', 'sumber_dana', null, $periode, $s)),
            'sumber_transaksi' => $strip($this->group('realisasi_records', 'sumber_transaksi', null, $periode, $s)),
        ]);
    }

    public function penyedia(array $p): array
    {
        $periode = $this->periode($p);
        $q = DB::table('realisasi_records')->where('periode', $periode)
            ->whereRaw("coalesce(trim(nama_penyedia), '') <> ''");
        $this->applySatker($q, N::satkerList($p['kode_satker'] ?? null));

        $rows = $q->selectRaw('trim(nama_penyedia) as nama_penyedia, count(*) as jumlah, coalesce(sum(nilai_kontrak), 0) as total_nilai')
            ->groupByRaw('trim(nama_penyedia)')->orderByDesc('total_nilai')->limit(10)->get();

        return Api::ok(Rows::castAll($rows));
    }

    public function efisiensi(array $p): array
    {
        $periode = $this->periode($p);
        $q = DB::table('matching_results')->where('periode', $periode)->where('status_matching', 'MATCHED');
        $this->applySatker($q, N::satkerList($p['kode_satker'] ?? null));

        $rows = $q->selectRaw('kode_satker, min(nama_satker) as nama_satker, coalesce(sum(pagu_rup), 0) as total_pagu, coalesce(sum(nilai_kontrak), 0) as total_kontrak')
            ->groupBy('kode_satker')->get()
            ->map(function ($r) {
                $pagu = (float) $r->total_pagu;
                $kontrak = (float) $r->total_kontrak;

                return [
                    'kode_satker' => $r->kode_satker, 'nama_satker' => $r->nama_satker,
                    'total_pagu' => $pagu, 'total_kontrak' => $kontrak,
                    'efisiensi' => $pagu - $kontrak,
                    'persen_efisiensi' => $pagu > 0 ? round(($pagu - $kontrak) / $pagu * 100, 2) : 0,
                ];
            })->sortByDesc('efisiensi')->values()->all();

        return Api::ok($rows);
    }

    public function tren(array $p): array
    {
        return Api::ok(Rows::castAll(DB::table('dashboard_aggregates')->orderBy('periode')->get()));
    }

    public function detailPaket(array $p): array
    {
        $periode = $this->periode($p);
        $page = max(1, (int) ($p['page'] ?? 1));
        $perPage = max(1, min(500, (int) ($p['per_page'] ?? 50)));

        $q = DB::table('matching_results')->where('periode', $periode);
        $this->applySatker($q, N::satkerList($p['kode_satker'] ?? null));

        if (! empty($p['search'])) {
            $like = '%'.addcslashes((string) $p['search'], '%_\\').'%';
            $q->where(fn (Builder $w) => $w
                ->where('nama_paket_rup', 'ilike', $like)
                ->orWhere('nama_satker', 'ilike', $like)
                ->orWhere('kode_rup', 'like', $like));
        }

        $total = (clone $q)->count();
        $items = $q->orderBy('id')->offset(($page - 1) * $perPage)->limit($perPage)->get();

        return Api::ok([
            'total' => $total, 'page' => $page, 'per_page' => $perPage,
            'total_pages' => (int) ceil($total / $perPage),
            'items' => Rows::castAll($items),
        ]);
    }

    // ── helpers ──────────────────────────────────────────────────

    /** Periode dari payload, atau periode terbaru bila kosong. */
    private function periode(array $p): string
    {
        return $p['periode'] ?? (string) DB::table('rup_records')->max('periode');
    }

    private function applySatker(Builder $q, array $satkers): void
    {
        if ($satkers) {
            $q->whereIn('kode_satker', $satkers);
        }
    }

    /** @return list<array{label:string,value:int,total_nilai:float}> urut jumlah desc */
    private function group(string $table, string $col, ?string $sumCol, string $periode, array $satkers): array
    {
        $q = DB::table($table)->where('periode', $periode);
        $this->applySatker($q, $satkers);
        $sum = $sumCol ? "coalesce(sum($sumCol), 0)" : '0';

        return $q->selectRaw("coalesce(nullif($col, ''), 'Tidak Diketahui') as label, count(*) as value, $sum as total_nilai")
            ->groupByRaw("coalesce(nullif($col, ''), 'Tidak Diketahui')")
            ->orderByDesc('value')->get()
            ->map(fn ($r) => ['label' => $r->label, 'value' => (int) $r->value, 'total_nilai' => (float) $r->total_nilai])
            ->all();
    }

    private function findValue(array $group, string $label): int
    {
        foreach ($group as $g) {
            if ($g['label'] === $label) {
                return $g['value'];
            }
        }

        return 0;
    }
}
