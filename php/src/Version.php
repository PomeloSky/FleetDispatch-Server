<?php

declare(strict_types=1);

namespace FleetDispatch;

/** 伺服器版本（三種實作一致；`GET /info` 的 serverVersion，對應 core/src/version.ts）。 */
final class Version
{
    public const SERVER_VERSION = '1.1.0';
}
