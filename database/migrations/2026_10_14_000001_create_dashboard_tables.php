<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('upload_logs', function (Blueprint $t) {
            $t->id();
            $t->string('upload_id', 64)->index();
            $t->string('periode', 7)->index();
            $t->unsignedSmallInteger('bulan');
            $t->unsignedSmallInteger('tahun');
            $t->string('jenis_data', 20); // RUP | REALISASI
            $t->string('nama_file')->nullable();
            $t->unsignedInteger('jumlah_record')->default(0);
            $t->string('uploaded_by', 100)->default('Admin');
            $t->timestampTz('uploaded_at')->useCurrent();
            $t->string('status', 20)->default('SUCCESS');
            $t->text('catatan')->nullable();
        });

        Schema::create('rup_records', function (Blueprint $t) {
            $t->id();
            $t->string('upload_id', 64);
            $t->string('periode', 7);
            $t->unsignedSmallInteger('bulan');
            $t->unsignedSmallInteger('tahun');
            $t->string('kode_satker', 100);
            $t->string('nama_satker');
            $t->string('cara_pengadaan', 100)->nullable();
            $t->string('metode_pengadaan', 150)->nullable();
            $t->string('jenis_pengadaan', 150)->nullable();
            $t->text('nama_paket');
            $t->string('kode_rup', 255)->nullable();
            $t->string('sumber_dana', 100)->nullable();
            $t->string('produk_dalam_negeri', 50)->nullable();
            $t->double('pagu')->default(0);

            $t->index(['periode', 'kode_satker']);
            $t->index(['periode', 'kode_rup']);
        });

        Schema::create('realisasi_records', function (Blueprint $t) {
            $t->id();
            $t->string('upload_id', 64);
            $t->string('periode', 7);
            $t->unsignedSmallInteger('bulan');
            $t->unsignedSmallInteger('tahun');
            $t->string('kode_satker', 100);
            $t->string('nama_satker');
            $t->string('kode_paket', 100)->nullable();
            $t->string('kode_rup', 255)->nullable();
            $t->string('sumber_transaksi', 150)->nullable();
            $t->string('sumber_dana', 100)->nullable();
            $t->string('nama_penyedia')->nullable();
            $t->string('metode_pengadaan', 150)->nullable();
            $t->string('jenis_pengadaan', 150)->nullable();
            $t->text('nama_paket')->nullable();
            $t->string('status_paket_asli', 100)->nullable();
            $t->string('status_paket', 50);
            $t->double('nilai_kontrak')->default(0);
            $t->double('nilai_pdn')->default(0);

            $t->index(['periode', 'kode_satker']);
            $t->index(['periode', 'kode_rup']);
            $t->index(['periode', 'kode_paket']);
        });

        Schema::create('matching_results', function (Blueprint $t) {
            $t->id();
            $t->uuid('matching_id');
            $t->string('periode', 7);
            $t->string('kode_satker', 100);
            $t->string('nama_satker');
            $t->string('kode_rup', 255)->nullable();
            $t->string('kode_paket', 100)->nullable();
            $t->text('nama_paket_rup')->nullable();
            $t->text('nama_paket_realisasi')->nullable();
            $t->string('metode_matching', 50);
            $t->double('similarity_score')->nullable();
            $t->double('pagu_rup')->nullable();
            $t->double('nilai_kontrak')->nullable();
            $t->double('efisiensi')->nullable();
            $t->double('persen_efisiensi')->nullable();
            $t->string('status_matching', 20);
            $t->timestampTz('created_at')->useCurrent();

            $t->index(['periode', 'status_matching']);
            $t->index(['periode', 'kode_satker']);
        });

        Schema::create('dashboard_aggregates', function (Blueprint $t) {
            $t->id();
            $t->uuid('aggregate_id');
            $t->string('periode', 7)->unique();
            $t->unsignedSmallInteger('bulan');
            $t->unsignedSmallInteger('tahun');
            foreach ([
                'total_pagu', 'total_kontrak', 'total_efisiensi', 'persen_efisiensi',
                'total_nilai_pdn', 'persen_pdn',
                'total_pagu_selesai', 'total_kontrak_selesai', 'total_efisiensi_selesai', 'persen_efisiensi_selesai',
            ] as $col) {
                $t->double($col)->default(0);
            }
            foreach ([
                'jumlah_paket_rup', 'jumlah_paket_realisasi', 'jumlah_matched',
                'jumlah_unmatched_rup', 'jumlah_unmatched_realisasi',
                'jumlah_selesai', 'jumlah_sedang_berjalan', 'jumlah_belum_berproses',
            ] as $col) {
                $t->unsignedInteger($col)->default(0);
            }
            $t->timestampTz('created_at')->useCurrent();
        });

        // Alias kode_rup lama → baru (dikonfirmasi admin), dipakai matching engine
        Schema::create('kode_rup_aliases', function (Blueprint $t) {
            $t->id();
            $t->string('kode_rup_lama')->unique();
            $t->string('kode_rup_baru');
            $t->timestampTz('created_at')->useCurrent();
        });

        Schema::create('menu_notices', function (Blueprint $t) {
            $t->id();
            $t->string('menu_key', 50)->unique();
            $t->string('updated_by', 100)->default('admin');
            $t->timestampTz('updated_at')->useCurrent();
        });
    }

    public function down(): void
    {
        foreach ([
            'menu_notices', 'kode_rup_aliases', 'dashboard_aggregates',
            'matching_results', 'realisasi_records', 'rup_records', 'upload_logs',
        ] as $table) {
            Schema::dropIfExists($table);
        }
    }
};
