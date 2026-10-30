<?php

use App\Services\Dashboard\AggregateService;
use App\Services\Dashboard\AnalisisService;
use App\Services\Dashboard\DashboardQueryService;
use App\Services\Dashboard\ListingService;
use App\Services\Dashboard\MatchingService;
use App\Services\Dashboard\MenuNoticeService;
use App\Services\Dashboard\PeriodeService;
use App\Services\Dashboard\RekapService;
use App\Services\Dashboard\SandinganService;
use App\Services\Dashboard\UploadService;
use App\Support\DashboardAuth;

return [
    'admin_token' => env('DASHBOARD_ADMIN_TOKEN'),
    'similarity_threshold' => (float) env('DASHBOARD_SIMILARITY_THRESHOLD', 0.75),

    'menu_list' => [
        ['key' => 'rup',       'label' => 'Rencana (RUP)'],
        ['key' => 'realisasi', 'label' => 'Realisasi'],
        ['key' => 'sandingan', 'label' => 'Sandingan RUP'],
        ['key' => 'efisiensi', 'label' => 'Analisis'],
        ['key' => 'rekap',     'label' => 'Rekap Laporan'],
        ['key' => 'upload',    'label' => 'Upload Data'],
        ['key' => 'kualitas',  'label' => 'Kualitas Data'],
    ],

    /**
     * action => [class, method, butuh_token_admin]
     * Action yang belum terdaftar dijawab "belum tersedia" (tidak ada lagi
     * proxy ke Google Apps Script).
     */
    'actions' => [
        'verifyToken'        => [DashboardAuth::class,       'verify',           false],
        'listPeriode'        => [PeriodeService::class,      'listPeriode',      false],
        'getUploadLog'       => [PeriodeService::class,      'getUploadLog',     false],
        'deletePeriode'      => [PeriodeService::class,      'deletePeriode',    true],
        'deleteByLog'        => [PeriodeService::class,      'deleteByLog',      true],

        'uploadRUP'          => [UploadService::class,       'uploadRup',        true],
        'uploadRealisasi'    => [UploadService::class,       'uploadRealisasi',  true],
        'runMatching'        => [MatchingService::class,     'handleRun',        true],

        'listRUP'            => [ListingService::class,      'listRup',          false],
        'listRealisasi'      => [ListingService::class,      'listRealisasi',    false],

        'kpiDashboard'       => [DashboardQueryService::class, 'kpi',            false],
        'dashboardOPD'       => [DashboardQueryService::class, 'opd',            false],
        'dashboardMetode'    => [DashboardQueryService::class, 'metode',         false],
        'dashboardStatus'    => [DashboardQueryService::class, 'status',         false],
        'dashboardSumber'    => [DashboardQueryService::class, 'sumber',         false],
        'dashboardPenyedia'  => [DashboardQueryService::class, 'penyedia',       false],
        'dashboardEfisiensi' => [DashboardQueryService::class, 'efisiensi',      false],
        'dashboardTren'      => [DashboardQueryService::class, 'tren',           false],
        'detailPaket'        => [DashboardQueryService::class, 'detailPaket',    false],

        'listSandingan'      => [SandinganService::class,    'list',             false],

        'listEfisiensi'            => [AnalisisService::class, 'listEfisiensi',        false],
        'listEfisiensiDetail'      => [AnalisisService::class, 'listEfisiensiDetail',  false],
        'dashboardAnalisisCharts'  => [AnalisisService::class, 'charts',               false],
        'dashboardAnalisisDetail'  => [AnalisisService::class, 'analisisDetail',       false],
        'listEfisiensiExcludeMetode' => [AnalisisService::class, 'listExcludeMetode',  false],
        'saveEfisiensiExcludeMetode' => [AnalisisService::class, 'saveExcludeMetode',  true],
        'listManualPagu'           => [AnalisisService::class, 'listManualPagu',       false],

        'laporanRekap'             => [RekapService::class,    'laporanRekap',         false],
        'recapJenisPengadaan'      => [RekapService::class,    'recapJenisPengadaan',  false],

        'listMenuNotice'     => [MenuNoticeService::class,   'list',             false],
        'saveMenuNotice'     => [MenuNoticeService::class,   'save',             true],
    ],
];
