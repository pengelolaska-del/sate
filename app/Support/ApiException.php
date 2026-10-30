<?php

declare(strict_types=1);

namespace App\Support;

use RuntimeException;

final class ApiException extends RuntimeException
{
    public function __construct(string $message, private readonly int $apiCode = 400)
    {
        parent::__construct($message);
    }

    public function apiCode(): int
    {
        return $this->apiCode;
    }
}
