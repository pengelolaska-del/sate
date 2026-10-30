<?php

declare(strict_types=1);

namespace App\Services\Dashboard;

use App\Support\Api;
use App\Support\ApiException;
use App\Support\Rows;
use Illuminate\Support\Facades\DB;

final class PeriodeService
{
    /** @return list<string> periode terbaru lebih dulu */
    public function availablePeriodes(?string $tahun = null): array
    {
        $q = DB::table('rup_records')->distinct()->orderByDesc('periode');
        if ($tahun) {
            $q->where('periode', 'like', $tahun.'-%');
        }

        return $q->pluck('periode')->all();
    }

    public function listPeriode(array $p): array
    {
        $periodes = $this->availablePeriodes();
        $latest = $periodes[0] ?? '';

        $satker = $latest === '' ? [] : DB::table('rup_records')
            ->where('periode', $latest)
            ->selectRaw('kode_satker, min(nama_satker) as nama_satker')
            ->groupBy('kode_satker')
            ->orderBy('nama_satker')
            ->get()
            ->map(fn ($r) => (array) $r)
            ->all();

        return Api::ok([
            'periodes' => $periodes,
            'latest_periode' => $latest,
            'satker_list' => $satker,
        ]);
    }

    public function getUploadLog(array $p): array
    {
        $q = DB::table('upload_logs')->orderByDesc('uploaded_at')->limit(200);
        if (! empty($p['periode'])) {
            $q->where('periode', $p['periode']);
        }

        return Api::ok(Rows::castAll($q->get()));
    }

    public function deletePeriode(array $p): array
    {
        $periode = $p['periode'] ?? null;
        if (! $periode) {
            throw new ApiException('Periode wajib.');
        }

        DB::transaction(function () use ($periode) {
            foreach (['rup_records', 'realisasi_records', 'matching_results', 'dashboard_aggregates', 'upload_logs'] as $t) {
                DB::table($t)->where('periode', $periode)->delete();
            }
        });

        return Api::ok(null, "Periode $periode berhasil dihapus.");
    }

    public function deleteByLog(array $p): array
    {
        $items = $p['items'] ?? null;
        if (! is_array($items) || $items === []) {
            throw new ApiException('Tidak ada item dipilih.');
        }

        DB::transaction(function () use ($items) {
            foreach ($items as $item) {
                $periode = $item['periode'] ?? null;
                $jenis = $item['jenis_data'] ?? null;
                if (! $periode || ! in_array($jenis, ['RUP', 'REALISASI'], true)) {
                    continue;
                }
                DB::table($jenis === 'RUP' ? 'rup_records' : 'realisasi_records')->where('periode', $periode)->delete();
                DB::table('matching_results')->where('periode', $periode)->delete();
                DB::table('dashboard_aggregates')->where('periode', $periode)->delete();
                DB::table('upload_logs')->where(['periode' => $periode, 'jenis_data' => $jenis])->delete();
            }
        });

        return Api::ok(null, count($items).' item berhasil dihapus.');
    }
}
