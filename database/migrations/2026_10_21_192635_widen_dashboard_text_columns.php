<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    public function up(): void
    {
        $columns = [
            'realisasi_records' => ['nama_penyedia', 'nama_satker', 'kode_rup', 'kode_paket', 'sumber_transaksi', 'metode_pengadaan', 'jenis_pengadaan', 'status_paket_asli'],
            'rup_records' => ['nama_satker', 'kode_rup', 'metode_pengadaan', 'jenis_pengadaan', 'produk_dalam_negeri'],
            'matching_results' => ['nama_satker', 'kode_rup', 'kode_paket'],
        ];

        foreach ($columns as $table => $cols) {
            foreach ($cols as $col) {
                DB::statement("ALTER TABLE \"$table\" ALTER COLUMN \"$col\" TYPE text");
            }
        }
    }

    public function down(): void
    {
        // dibiarkan kosong: melebarkan kolom bersifat satu arah
    }
};