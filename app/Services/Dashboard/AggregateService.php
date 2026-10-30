<?php

declare(strict_types=1);

namespace App\Services\Dashboard;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/** Ringkasan KPI per periode (opsional per satker). */
final class AggregateService
{
    /** @param list<string> $satkers kosong = semua satker */
    public function compute(string $periode, array $satkers = []): array
    {
        $scope = function (string $table) use ($periode, $satkers) {
            $q = DB::table($table)->where('periode', $periode);

            return $satkers ? $q->whereIn('kode_satker', $satkers) : $q;
        };

        $rup = $scope('rup_records')
            ->selectRaw('count(*) as n, coalesce(sum(pagu), 0) as pagu')->first();

        $real = $scope('realisasi_records')->selectRaw(
            "count(*) as n, coalesce(sum(nilai_pdn), 0) as pdn,
             count(*) filter (where status_paket = 'Selesai') as selesai,
             count(*) filter (where status_paket = 'Sedang Berjalan') as berjalan,
             count(*) filter (where status_paket = 'Belum Berproses') as belum"
        )->first();

        $match = $scope('matching_results')->selectRaw(
            "count(*) filter (where status_matching = 'MATCHED') as matched,
             coalesce(sum(nilai_kontrak) filter (where status_matching = 'MATCHED'), 0) as kontrak,
             count(*) filter (where status_matching = 'UNMATCHED' and coalesce(kode_rup, '') <> '' and coalesce(kode_paket, '') = '') as um_rup,
             count(*) filter (where status_matching = 'UNMATCHED' and coalesce(kode_paket, '') <> '') as um_real"
        )->first();

        // Efisiensi resmi: hanya paket MATCHED yang status realisasinya "Selesai"
        $selQ = DB::table('matching_results as m')
            ->where('m.periode', $periode)
            ->where('m.status_matching', 'MATCHED')
            ->whereRaw("coalesce(m.kode_paket, '') <> ''")
            ->whereExists(fn ($q) => $q->select(DB::raw(1))
                ->from('realisasi_records as r')
                ->whereColumn('r.periode', 'm.periode')
                ->whereColumn('r.kode_paket', 'm.kode_paket')
                ->where('r.status_paket', 'Selesai'));
        if ($satkers) {
            $selQ->whereIn('m.kode_satker', $satkers);
        }
        $sel = $selQ->selectRaw('coalesce(sum(m.pagu_rup), 0) as pagu, coalesce(sum(m.nilai_kontrak), 0) as kontrak')->first();

        $tPagu = (float) $rup->pagu;
        $tKontrak = (float) $match->kontrak;
        $tPdn = (float) $real->pdn;
        $tPaguSel = (float) $sel->pagu;
        $tKontrakSel = (float) $sel->kontrak;

        return [
            'total_pagu' => $tPagu,
            'total_kontrak' => $tKontrak,
            'total_efisiensi' => $tPagu - $tKontrak,
            'persen_efisiensi' => $tPagu > 0 ? round(($tPagu - $tKontrak) / $tPagu * 100, 2) : 0,
            'jumlah_paket_rup' => (int) $rup->n,
            'jumlah_paket_realisasi' => (int) $real->n,
            'jumlah_matched' => (int) $match->matched,
            'jumlah_unmatched_rup' => (int) $match->um_rup,
            'jumlah_unmatched_realisasi' => (int) $match->um_real,
            'jumlah_selesai' => (int) $real->selesai,
            'jumlah_sedang_berjalan' => (int) $real->berjalan,
            'jumlah_belum_berproses' => (int) $real->belum,
            'total_nilai_pdn' => $tPdn,
            'persen_pdn' => $tKontrak > 0 ? round($tPdn / $tKontrak * 100, 2) : 0,
            'total_pagu_selesai' => $tPaguSel,
            'total_kontrak_selesai' => $tKontrakSel,
            'total_efisiensi_selesai' => $tPaguSel - $tKontrakSel,
            'persen_efisiensi_selesai' => $tPaguSel > 0 ? round(($tPaguSel - $tKontrakSel) / $tPaguSel * 100, 2) : 0,
        ];
    }

    public function build(string $periode, int $bulan, int $tahun): void
    {
        DB::table('dashboard_aggregates')->updateOrInsert(
            ['periode' => $periode],
            $this->compute($periode) + [
                'aggregate_id' => (string) Str::uuid(),
                'bulan' => $bulan,
                'tahun' => $tahun,
                'created_at' => now(),
            ]
        );
    }
}
