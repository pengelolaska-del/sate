<?php

use App\Http\Controllers\DashboardApiController;
use Illuminate\Support\Facades\Route;

Route::get('/', fn () => response()->file(
    resource_path('dashboard/index.html'),
    ['Content-Type' => 'text/html; charset=UTF-8']
));

Route::post('/dashboard-api', DashboardApiController::class)->middleware('throttle:120,1');